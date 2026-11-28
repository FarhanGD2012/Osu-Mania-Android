'use strict';
/**
 * Room multiplayer di server (jalur "Server" di aplikasi, selain Wi-Fi/hotspot dan MQTT).
 *
 * Prinsip: server HANYA menjadi perantara status room. Seluruh perhitungan note / timing / skor tetap berjalan lokal
 * di tiap HP (GameView), jadi ketukan tidak bergantung pada ping. Server cuma:
 *   - mengelola room (buat, gabung, siap, pilih lagu, pengaturan, keluarkan pemain, ganti host otomatis),
 *   - menetapkan waktu mulai bersama (aba-aba "start at" + sinkron jam lewat ping/pong, sama seperti jalur lain),
 *   - menyiarkan skor/progres pemain ~4x per detik (hanya untuk papan skor di layar),
 *   - menyusun peringkat akhir.
 * Pesan JSON-nya SAMA dengan yang dipakai MpHub di HP host, jadi layar Multiplayer di aplikasi tidak perlu tahu bedanya.
 *
 * Room hanya hidup di memori (tidak menulis ke database -> tidak memakai jatah tulis Turso). Bila server restart / tidur,
 * room hilang dan pemain mendapat pesan "room ditutup".
 *
 * Alamat WebSocket: wss://<server>/ws/rooms . Pesan pertama dari klien wajib {t:"create"|"join", token, ...}.
 * Daftar room publik: GET /api/rooms
 */
const crypto = require('node:crypto');
const { accept } = require('./wsmini');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const START_DELAY_MS = 5000;

const DEFAULT_LIMITS = {
  maxRooms: Number(process.env.ROOM_MAX_ROOMS) || 60,
  maxPlayers: Number(process.env.ROOM_MAX_PLAYERS) || 16, // batas keras per room (siaran skor tumbuh ~ kuadrat jumlah pemain)
  maxConnections: Number(process.env.ROOM_MAX_CONNECTIONS) || 300,
  maxConnPerIp: Number(process.env.ROOM_MAX_CONN_PER_IP) || 20, // longgar: banyak pemain seluler berbagi satu IP (CGNAT)
  maxQueue: 20,
  msgBurst: 60, // ember token: lonjakan pesan maksimum
  msgPerSec: 40, // pengisian ulang
  authTimeoutMs: 10000,
  idleMs: 30000, // tanpa pesan sebanyak ini = pemain dianggap putus
  maxRoundMs: 30 * 60000, // ronde yang macet lebih lama dari ini dipaksa selesai
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toInt = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clean = (s, n) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, n);
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const samePw = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function attachRooms({ server, route, HttpError, rateLimit, clientIp, authToken, limits }) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const rooms = new Map(); // code -> Room
  const byUser = new Map(); // userId -> Player (satu room aktif per akun)
  const connPerIp = new Map();
  let connCount = 0;
  let seq = 1;

  function newCode() {
    for (let t = 0; t < 50; t++) {
      let c = 'S'; // huruf S = room server (A/B/C dipakai broker MQTT)
      for (let i = 0; i < 5; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }

  class Room {
    constructor(code, st) {
      this.code = code;
      this.st = st;
      this.players = new Map();
      this.queue = [];
      this.hostId = '';
      this.state = 'lobby';
      this.round = 0;
      this.dirty = false;
      this.participants = new Set();
      this.finished = new Map();
      this.cdAt = 0;
      this.cdToken = 0;
      this.roundStart = 0;
      this.roomDirty = false;
      this.lastRoomAt = 0;
      this.closed = false;
      this.tickN = 0;
      this.timer = setInterval(() => this.tick(), 250);
      this.timer.unref();
    }

    // ---------------------------------------------------------------- kirim
    sendTo(p, o) {
      try {
        p.ws.send(JSON.stringify(o));
      } catch (e) {
        /* putus */
      }
    }

    broadcast(o) {
      const s = JSON.stringify(o);
      for (const p of this.players.values()) {
        try {
          p.ws.send(s);
        } catch (e) {
          /* putus */
        }
      }
    }

    err(p, msg, fatal) {
      this.sendTo(p, { t: 'error', msg, fatal: !!fatal });
    }

    roomJson() {
      const arr = [];
      for (const p of this.players.values()) {
        arr.push({ id: p.id, n: p.name, tm: p.team, mu: false, rd: p.ready, s: p.state, sc: p.score, ac: p.acc, cb: p.combo, hp: p.hp, pr: p.prog });
      }
      return {
        t: 'room',
        code: this.code,
        name: this.st.name,
        host: this.hostId,
        st: this.state,
        mt: this.st.matchType,
        qm: this.st.queueMode,
        wc: this.st.winCond,
        as: this.st.autoStart,
        mx: this.st.maxPlayers,
        pw: this.st.password.length > 0,
        ls: this.st.listed,
        vc: false, // voice chat tidak tersedia di room server (hanya LAN / MQTT)
        net: true,
        round: this.round,
        players: arr,
        queue: this.queue.map((c) => ({ ck: c.ck, sid: c.sid, ti: c.ti, ar: c.ar, cr: c.cr, v: c.v, k: c.k, n: c.n, o: c.o, on: c.on, oi: '' })),
      };
    }

    /** Siaran status digabung: perubahan pertama langsung, perubahan beruntun ~1x per 200 ms. */
    broadcastRoom(force) {
      if (this.closed) return;
      const now = Date.now();
      if (force || now - this.lastRoomAt >= 200) {
        this.roomDirty = false;
        this.lastRoomAt = now;
        this.broadcast(this.roomJson());
      } else this.roomDirty = true;
    }

    info() {
      const c = this.queue[0];
      return {
        code: this.code,
        name: this.st.name,
        host: (this.players.get(this.hostId) || {}).name || '',
        pl: this.players.size,
        mx: this.st.maxPlayers,
        mt: this.st.matchType,
        qm: this.st.queueMode,
        wc: this.st.winCond,
        pw: this.st.password.length > 0,
        st: this.state,
        ch: c ? `${c.ar} - ${c.ti} [${c.v}]` : '',
        k: c ? c.k : 0,
      };
    }

    // ---------------------------------------------------------------- masuk / keluar
    admit(ws, user, pw) {
      if (this.st.password && !samePw(pw || '', this.st.password)) return { error: 'Password room salah' };
      if (this.players.size >= this.st.maxPlayers) return { error: 'Room penuh' };
      const t0 = [...this.players.values()].filter((x) => x.team === 0).length;
      const t1 = this.players.size - t0;
      const p = {
        id: 'p' + seq++,
        userId: user.id,
        name: clean(user.username, 24) || 'Pemain',
        ws,
        team: t0 <= t1 ? 0 : 1,
        ready: false,
        state: 'lobby',
        score: 0,
        acc: 100,
        combo: 0,
        hp: 1,
        prog: 0,
        lastSeen: Date.now(),
        tokens: L.msgBurst,
        tokAt: Date.now(),
      };
      this.players.set(p.id, p);
      if (!this.hostId) this.hostId = p.id;
      byUser.set(user.id, p);
      this.sendTo(p, { t: 'welcome', id: p.id, code: this.code, now: Date.now(), vp: 0 });
      this.broadcastRoom(true);
      return { player: p };
    }

    drop(p, why) {
      if (this.players.get(p.id) !== p) return;
      this.players.delete(p.id);
      if (byUser.get(p.userId) === p) byUser.delete(p.userId);
      try {
        p.ws.close(1000, why || '');
      } catch (e) {
        /* sudah putus */
      }
      if (this.players.size === 0) {
        this.destroy(false);
        return;
      }
      if (this.state === 'playing' && this.participants.has(p.id) && p.state === 'playing') {
        p.state = 'finished';
        const r = { id: p.id, name: p.name, team: p.team, score: p.score, acc: p.acc, maxCombo: p.combo, failed: true, left: true };
        p.result = r;
        this.finished.set(p.id, r);
      }
      this.participants.delete(p.id);
      if (this.hostId === p.id) this.hostId = this.players.keys().next().value; // host pindah ke pemain tertua
      this.broadcastRoom(true);
      this.checkAllFinished();
      this.evalAutoStart();
    }

    destroy(notify) {
      if (this.closed) return;
      if (notify) this.broadcast({ t: 'closed' });
      this.closed = true;
      clearInterval(this.timer);
      rooms.delete(this.code);
      for (const p of this.players.values()) {
        if (byUser.get(p.userId) === p) byUser.delete(p.userId);
        try {
          p.ws.close(1001, 'room ditutup');
        } catch (e) {
          /* sudah putus */
        }
      }
      this.players.clear();
    }

    // ---------------------------------------------------------------- pesan pemain
    handle(p, m) {
      if (this.closed) return;
      p.lastSeen = Date.now();
      const isHost = p.id === this.hostId;
      switch (String(m.t)) {
        case 'ping':
          this.sendTo(p, { t: 'pong', c: toNum(m.c), s: Date.now() });
          break;
        case 'hello':
          break; // nama mengikuti nama akun; abaikan
        case 'leave':
          this.sendTo(p, { t: 'left' });
          this.drop(p, 'keluar');
          break;
        case 'ready':
          if (this.state !== 'lobby') return;
          p.ready = !!m.ready;
          this.broadcastRoom();
          this.evalAutoStart();
          break;
        case 'team':
          if (this.state !== 'lobby' || this.st.matchType !== 1) return;
          p.team = toInt(m.team) === 1 ? 1 : 0;
          this.broadcastRoom();
          break;
        case 'chart':
          this.addChart(p, m);
          break;
        case 'unq': {
          if (this.state !== 'lobby') return;
          const i = toInt(m.i, -1);
          if (i < 0 || i >= this.queue.length) return;
          if (!isHost && this.queue[i].o !== p.id) return;
          this.queue.splice(i, 1);
          this.chartsChanged();
          break;
        }
        case 'settings':
          if (isHost && this.state === 'lobby') this.applySettings(m);
          break;
        case 'kick': {
          if (!isHost) return;
          const v = this.players.get(String(m.id));
          if (!v || v === p) return;
          this.sendTo(v, { t: 'kicked' });
          this.drop(v, 'dikeluarkan');
          break;
        }
        case 'mute':
          break; // tidak ada voice chat di room server
        case 'start':
          if (isHost) this.startRound();
          break;
        case 'score':
          if (this.state !== 'playing' || p.state !== 'playing') return;
          p.score = clamp(toInt(m.score, p.score), 0, 2000000);
          p.acc = clamp(toNum(m.acc, p.acc), 0, 100);
          p.combo = clamp(toInt(m.combo, p.combo), 0, 1000000);
          p.hp = clamp(toNum(m.hp, p.hp), 0, 1);
          p.prog = clamp(toNum(m.prog, p.prog), 0, 1);
          this.dirty = true;
          break;
        case 'finish': {
          if (this.state !== 'playing' || p.state !== 'playing') return;
          p.state = 'finished';
          p.score = clamp(toInt(m.score, p.score), 0, 2000000);
          p.acc = clamp(toNum(m.acc, p.acc), 0, 100);
          const counts = Array.isArray(m.counts) ? m.counts.slice(0, 10).map((x) => clamp(toInt(x), 0, 1000000)) : [];
          const r = { id: p.id, name: p.name, team: p.team, score: p.score, acc: p.acc, maxCombo: clamp(toInt(m.maxCombo), 0, 1000000), failed: !!m.failed, left: false, counts };
          p.result = r;
          this.finished.set(p.id, r);
          this.dirty = true;
          this.checkAllFinished();
          break;
        }
        default:
          break;
      }
    }

    addChart(p, m) {
      if (this.state !== 'lobby') return;
      const item = {
        ck: clean(m.ck, 40),
        sid: clamp(toInt(m.sid), 0, 1e9),
        ti: clean(m.ti, 120),
        ar: clean(m.ar, 120),
        cr: clean(m.cr, 60),
        v: clean(m.v, 120),
        k: clamp(toInt(m.k, 4), 1, 10),
        n: clamp(toInt(m.n), 0, 1e7),
        o: p.id,
        on: p.name,
      };
      if (!item.ck) return;
      if (this.st.queueMode === 0) {
        if (p.id !== this.hostId) return this.err(p, 'Hanya host yang boleh memilih chart');
        this.queue = [item];
      } else {
        if (this.queue.some((c) => c.ck === item.ck)) return;
        if (this.queue.length >= L.maxQueue) return this.err(p, 'Antrean chart penuh');
        this.queue.push(item);
        if (this.st.queueMode === 2) this.roundRobinSort();
      }
      this.chartsChanged();
    }

    /** Bergiliran: chart ke-1 tiap pemain dulu, lalu ke-2, dst (urutan tambah dipertahankan). */
    roundRobinSort() {
      if (this.queue.length < 2) return;
      const first = this.queue[0];
      const count = new Map([[first.o, 1]]);
      const keyed = this.queue.slice(1).map((c, idx) => {
        const n = count.get(c.o) || 0;
        count.set(c.o, n + 1);
        return { n, idx, c };
      });
      keyed.sort((a, b) => a.n - b.n || a.idx - b.idx);
      this.queue = [first, ...keyed.map((x) => x.c)];
    }

    chartsChanged() {
      for (const p of this.players.values()) p.ready = false;
      this.cancelCountdown();
      this.broadcastRoom(true);
    }

    applySettings(m) {
      const st = this.st;
      if ('name' in m) st.name = clean(m.name, 40) || st.name;
      if ('pw' in m) st.password = clean(m.pw, 24);
      if ('mt' in m) st.matchType = clamp(toInt(m.mt), 0, 1);
      if ('qm' in m) {
        const q = clamp(toInt(m.qm), 0, 2);
        if (q !== st.queueMode) {
          st.queueMode = q;
          if (q === 0 && this.queue.length > 1) this.queue.length = 1;
          if (q === 2) this.roundRobinSort();
        }
      }
      if ('wc' in m) st.winCond = clamp(toInt(m.wc), 0, 2);
      if ('as' in m) st.autoStart = clamp(toInt(m.as), 0, 120);
      if ('mx' in m) {
        const mx = toInt(m.mx);
        st.maxPlayers = mx <= 0 ? L.maxPlayers : clamp(mx, Math.max(2, this.players.size), L.maxPlayers);
      }
      if ('ls' in m) st.listed = !!m.ls;
      if (st.matchType === 1) {
        let i = 0;
        for (const p of this.players.values()) p.team = i++ % 2;
      }
      this.broadcastRoom(true);
      this.evalAutoStart();
    }

    // ---------------------------------------------------------------- ronde
    startRound() {
      const host = this.players.get(this.hostId);
      if (this.state !== 'lobby' || this.queue.length === 0) {
        if (host) this.err(host, 'Pilih chart dulu');
        return;
      }
      this.cancelCountdown();
      this.participants.clear();
      for (const p of this.players.values()) if (p.ready || p.id === this.hostId) this.participants.add(p.id);
      this.state = 'playing';
      this.round++;
      this.finished.clear();
      for (const p of this.players.values()) {
        p.result = null;
        p.score = 0;
        p.acc = 100;
        p.combo = 0;
        p.hp = 1;
        p.prog = 0;
        p.state = this.participants.has(p.id) ? 'playing' : 'lobby';
      }
      const at = Date.now() + START_DELAY_MS;
      this.roundStart = at;
      this.broadcast({ t: 'start', at, now: Date.now(), round: this.round, parts: [...this.participants] });
      this.broadcastRoom(true);
    }

    checkAllFinished() {
      if (this.state !== 'playing') return;
      for (const id of this.participants) {
        const p = this.players.get(id);
        if (p && p.state !== 'finished') return;
      }
      this.finishRound();
    }

    finishRound() {
      const list = [...this.finished.values()];
      const wc = this.st.winCond;
      const metric = (o) => (wc === 1 ? toNum(o.acc) : wc === 2 ? toInt(o.maxCombo) : toInt(o.score));
      list.sort((a, b) => {
        if (!!a.failed !== !!b.failed) return a.failed ? 1 : -1;
        const c = metric(b) - metric(a);
        return c !== 0 ? c : toInt(b.score) - toInt(a.score);
      });
      const res = { t: 'results', round: this.round, wc, mt: this.st.matchType, ranking: list };
      if (this.st.matchType === 1) {
        const tot = [0, 0];
        const cnt = [0, 0];
        for (const r of list) {
          const t = clamp(toInt(r.team), 0, 1);
          cnt[t]++;
          tot[t] += metric(r);
        }
        if (wc === 1) for (let t = 0; t < 2; t++) if (cnt[t] > 0) tot[t] /= cnt[t];
        res.teams = tot;
      }
      this.state = 'lobby';
      this.participants.clear();
      for (const p of this.players.values()) {
        p.ready = false;
        p.state = 'lobby';
      }
      if (this.st.queueMode !== 0 && this.queue.length) this.queue.shift();
      this.broadcast(res);
      this.broadcastRoom(true);
    }

    // ---------------------------------------------------------------- mulai otomatis
    cancelCountdown() {
      if (this.cdAt !== 0) {
        this.cdAt = 0;
        this.cdToken++;
        this.broadcast({ t: 'cd', at: 0 });
      }
    }

    evalAutoStart() {
      const none = this.st.autoStart <= 0 || this.state !== 'lobby' || this.queue.length === 0 || ![...this.players.values()].some((p) => p.ready);
      if (none) {
        if (this.cdAt !== 0) this.cancelCountdown();
        return;
      }
      if (this.cdAt !== 0) return;
      this.cdAt = Date.now() + this.st.autoStart * 1000;
      const tok = ++this.cdToken;
      this.broadcast({ t: 'cd', at: this.cdAt, now: Date.now() });
      setTimeout(() => {
        if (this.closed || this.cdToken !== tok || this.cdAt === 0 || this.state !== 'lobby') return;
        this.cdAt = 0;
        this.startRound();
      }, this.st.autoStart * 1000).unref();
    }

    // ---------------------------------------------------------------- detak
    tick() {
      if (this.closed) return;
      const now = Date.now();
      if (this.roomDirty) this.broadcastRoom(true);
      if (this.dirty && this.state === 'playing') {
        this.dirty = false;
        const a = [];
        for (const p of this.players.values()) {
          if (!this.participants.has(p.id)) continue;
          a.push([p.id, p.score, Math.round(p.acc * 100) / 100, p.combo, Math.round(p.hp * 100) / 100, Math.round(p.prog * 1000) / 1000, p.state === 'finished' ? 1 : 0]);
        }
        this.broadcast({ t: 'scores', p: a });
      }
      if (this.state === 'playing' && this.roundStart && now - this.roundStart > L.maxRoundMs) {
        // ronde macet: paksa selesai, pemain yang belum selesai dianggap gagal
        for (const id of this.participants) {
          const p = this.players.get(id);
          if (p && p.state !== 'finished') {
            p.state = 'finished';
            this.finished.set(p.id, { id: p.id, name: p.name, team: p.team, score: p.score, acc: p.acc, maxCombo: p.combo, failed: true, left: false });
          }
        }
        this.checkAllFinished();
      }
      if (++this.tickN % 12 === 0) {
        // ~3 detik: buang pemain yang tidak mengirim apa pun (ping klien tiap 5 detik)
        for (const p of [...this.players.values()]) if (now - p.lastSeen > L.idleMs) this.drop(p, 'timeout');
      }
    }
  }

  // ------------------------------------------------------------------- koneksi WebSocket
  function takeToken(p) {
    const now = Date.now();
    p.tokens = Math.min(L.msgBurst, p.tokens + ((now - p.tokAt) / 1000) * L.msgPerSec);
    p.tokAt = now;
    if (p.tokens < 1) return false;
    p.tokens -= 1;
    return true;
  }

  function fatal(ws, msg) {
    try {
      ws.send(JSON.stringify({ t: 'error', msg, fatal: true }));
    } catch (e) {
      /* putus */
    }
    ws.close(1008, 'ditolak');
  }

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch (e) {
      /* abaikan */
    }
    if (pathname !== '/ws/rooms') {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    const perIp = connPerIp.get(ip) || 0;
    if (connCount >= L.maxConnections || perIp >= L.maxConnPerIp) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = accept(req, socket, head, 16 * 1024);
    if (!ws) return;
    connCount++;
    connPerIp.set(ip, perIp + 1);
    let room = null;
    let player = null;
    let authed = false;
    let authing = false;
    const pending = [];

    const authTimer = setTimeout(() => {
      if (!authed) fatal(ws, 'Waktu masuk ke room habis');
    }, L.authTimeoutMs);
    authTimer.unref();

    ws.on('close', () => {
      clearTimeout(authTimer);
      connCount--;
      const n = (connPerIp.get(ip) || 1) - 1;
      if (n <= 0) connPerIp.delete(ip);
      else connPerIp.set(ip, n);
      if (room && player) room.drop(player, 'putus');
    });

    async function first(m) {
      authing = true;
      try {
        const kind = String(m.t);
        if (kind !== 'create' && kind !== 'join') return fatal(ws, 'Perintah awal tidak dikenal');
        rateLimit('roomauth:' + ip, 60, 600000);
        const user = await authToken(m.token);
        if (!user) return fatal(ws, 'Sesi habis. Silakan masuk lagi.');
        // satu akun = satu room aktif: sambungan lama dikeluarkan
        const old = byUser.get(user.id);
        if (old) {
          const oldRoom = [...rooms.values()].find((r) => r.players.get(old.id) === old);
          if (oldRoom) {
            oldRoom.sendTo(old, { t: 'error', msg: 'Akunmu masuk dari tempat lain', fatal: true });
            oldRoom.drop(old, 'masuk di tempat lain');
          }
        }
        if (ws.closed) return;
        if (kind === 'create') {
          rateLimit('roomcreate:' + user.id, 12, 3600000);
          if (rooms.size >= L.maxRooms) return fatal(ws, 'Server sedang penuh, coba lagi nanti');
          const code = newCode();
          if (!code) return fatal(ws, 'Gagal membuat kode room');
          const s = m.settings && typeof m.settings === 'object' ? m.settings : {};
          const st = {
            name: clean(s.name, 40) || user.username + "'s room",
            password: clean(s.pw, 24),
            matchType: clamp(toInt(s.mt), 0, 1),
            queueMode: clamp(toInt(s.qm), 0, 2),
            winCond: clamp(toInt(s.wc), 0, 2),
            autoStart: clamp(toInt(s.as), 0, 120),
            maxPlayers: toInt(s.mx) <= 0 ? L.maxPlayers : clamp(toInt(s.mx), 2, L.maxPlayers),
            listed: s.ls === undefined ? true : !!s.ls,
          };
          room = new Room(code, st);
          rooms.set(code, room);
        } else {
          room = rooms.get(String(m.code || '').toUpperCase());
          if (!room) return fatal(ws, 'Room tidak ditemukan (mungkin sudah ditutup)');
        }
        const r = room.admit(ws, user, m.pw);
        if (r.error) {
          const wasNew = kind === 'create';
          if (wasNew) room.destroy(false);
          room = null;
          return fatal(ws, r.error);
        }
        player = r.player;
        authed = true;
        clearTimeout(authTimer);
      } catch (e) {
        if (e && e.status === 429) fatal(ws, e.message);
        else {
          console.error('galat room:', e);
          fatal(ws, 'Galat di server');
        }
      } finally {
        authing = false;
      }
      // pesan yang datang selagi menunggu pemeriksaan sesi
      for (const t of pending.splice(0)) onMsg(t);
    }

    function onMsg(text) {
      let m;
      try {
        m = JSON.parse(text);
      } catch (e) {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (!authed) {
        if (authing) pending.push(text);
        else first(m);
        return;
      }
      if (!player || !room) return;
      if (!takeToken(player)) {
        // banjir pesan: abaikan; bila terus-menerus, putuskan
        player.flood = (player.flood || 0) + 1;
        if (player.flood > 200) {
          room.err(player, 'Terlalu banyak pesan', true);
          room.drop(player, 'banjir');
        }
        return;
      }
      room.handle(player, m);
    }
    ws.on('message', onMsg);
  });

  // Jaga koneksi hidup di balik proxy hosting (proxy menutup koneksi diam) dan buang soket yang mati.
  const pinger = setInterval(() => {
    for (const r of rooms.values()) {
      for (const p of r.players.values()) {
        if (p.ws.alive === false && Date.now() - p.lastSeen > L.idleMs) p.ws.terminate();
        else p.ws.ping();
      }
    }
  }, 20000);
  pinger.unref();

  // ------------------------------------------------------------------- HTTP: daftar room publik
  route('GET', /^\/api\/rooms$/, async () => {
    const out = [];
    for (const r of rooms.values()) if (r.st.listed) out.push(r.info());
    out.sort((a, b) => b.pl - a.pl);
    return { rooms: out.slice(0, 50), total: rooms.size };
  });

  return {
    rooms,
    stats: () => ({ rooms: rooms.size, connections: connCount }),
    /** Dipanggil saat server akan mati (deploy ulang / tidur): beri tahu pemain supaya tidak menggantung. */
    shutdown() {
      for (const r of [...rooms.values()]) r.destroy(true);
      clearInterval(pinger);
    },
  };
}

module.exports = { attachRooms };
