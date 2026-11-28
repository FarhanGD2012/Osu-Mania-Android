'use strict';
/**
 * Nova Beat server: akun (Argon2id), profil, teman, leaderboard, dan room multiplayer (lihat rooms.js).
 * Database: libSQL (SQLite-compatible). Di produksi pakai Turso (gratis, data TIDAK hilang walau server di-restart / tidur):
 *   TURSO_DATABASE_URL=libsql://nama-db.turso.io   TURSO_AUTH_TOKEN=...
 * Tanpa variabel itu, dipakai file lokal ./data/novabeat.db (untuk uji coba di komputer).
 *
 * Aturan PP (ala level rated Geometry Dash): satu map hanya memberi PP SEKALI per akun, yaitu saat pertama kali
 * ditamatkan. Penanda ada di tabel map_completions dengan UNIQUE(user_id, map_id). Tamat ulang hanya memperbarui
 * skor / akurasi terbaik di tabel scores, tidak menambah PP.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const argon2 = require('argon2');
const { attachRooms } = require('./rooms');

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }; // rekomendasi OWASP
const SESSION_DAYS = 180;
const MAX_BODY = 200 * 1024;
const MAX_AVATAR = 80 * 1024;
const MAX_PP_PER_MAP = 2000; // batas kewajaran; klien yang menghitung PP, server hanya membatasi
const AVATAR_COOLDOWN_MS = 7 * 86400000; // foto profil hanya boleh diganti 1x per 7 hari (dicatat di database, tahan restart)
const MAX_RATE_KEYS = 50000; // batas jumlah kunci pembatas laju di memori (cegah memori membengkak)

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const MAPID_RE = /^[A-Za-z0-9:_.\-]{1,64}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    avatar        BLOB,
    avatar_at     INTEGER NOT NULL DEFAULT 0,
    avatar_changed_at INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
  )`,
  // Penanda "map sudah pernah ditamatkan / PP sudah diklaim".
  `CREATE TABLE IF NOT EXISTS map_completions (
    user_id      INTEGER NOT NULL,
    map_id       TEXT NOT NULL,
    pp_awarded   REAL NOT NULL,
    completed_at INTEGER NOT NULL,
    stars        REAL NOT NULL DEFAULT 0,
    UNIQUE (user_id, map_id)
  )`,
  // Skor terbaik tiap pemain per map (satu baris per pemain per map).
  `CREATE TABLE IF NOT EXISTS scores (
    user_id     INTEGER NOT NULL,
    map_id      TEXT NOT NULL,
    map_title   TEXT NOT NULL DEFAULT '',
    score       INTEGER NOT NULL,
    accuracy    REAL NOT NULL,
    max_combo   INTEGER NOT NULL DEFAULT 0,
    achieved_at INTEGER NOT NULL,
    plays       INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, map_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_scores_map ON scores (map_id, score DESC)',
  'CREATE INDEX IF NOT EXISTS idx_comp_user ON map_completions (user_id)',
  `CREATE TABLE IF NOT EXISTS friendships (
    requester_id INTEGER NOT NULL,
    addressee_id INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at   INTEGER NOT NULL,
    UNIQUE (requester_id, addressee_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_friend_addr ON friendships (addressee_id)',
  // Hitungan gagal-masuk yang TAHAN RESTART (hanya ditulis saat login GAGAL, jadi hemat jatah tulis Turso).
  `CREATE TABLE IF NOT EXISTS auth_fails (
    k        TEXT PRIMARY KEY,
    n        INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
];

class HttpError extends Error {
  constructor(status, code, message, extra, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
    this.headers = headers || {};
  }
}

/** "3 hari 5 jam" / "5 jam 12 menit" / "8 menit" / "kurang dari semenit". */
function durasiIndonesia(ms) {
  const menitTotal = Math.max(0, Math.ceil(ms / 60000));
  const hari = Math.floor(menitTotal / 1440);
  const jam = Math.floor((menitTotal % 1440) / 60);
  const menit = menitTotal % 60;
  const out = [];
  if (hari) out.push(hari + ' hari');
  if (jam) out.push(jam + ' jam');
  if (menit && hari === 0) out.push(menit + ' menit');
  return out.length ? out.join(' ') : 'kurang dari semenit';
}

/** Tanggal & jam dalam WIB, contoh "Sabtu, 5 Desember 2026 pukul 14.30 WIB". Aplikasi menampilkannya ulang di zona waktu HP. */
function tanggalWib(ms) {
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${g('weekday')}, ${g('day')} ${g('month')} ${g('year')} pukul ${g('hour')}.${g('minute')} WIB`;
  } catch (e) {
    return new Date(ms).toISOString();
  }
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const round2 = (x) => Math.round(Number(x) * 100) / 100;

/** Bungkus client / transaksi libSQL menjadi get / all / run dengan baris berbentuk objek biasa. */
function wrap(x) {
  const exec = async (sql, args) => x.execute({ sql, args: args || [] });
  const toObj = (r, row) => {
    const o = {};
    r.columns.forEach((c, i) => {
      o[c] = row[i];
    });
    return o;
  };
  return {
    async all(sql, args) {
      const r = await exec(sql, args);
      return r.rows.map((row) => toObj(r, row));
    },
    async get(sql, args) {
      const r = await exec(sql, args);
      return r.rows.length ? toObj(r, r.rows[0]) : undefined;
    },
    async run(sql, args) {
      const r = await exec(sql, args);
      return { changes: Number(r.rowsAffected || 0), lastInsertRowid: Number(r.lastInsertRowid || 0) };
    },
  };
}

const USER_COLS = 'id, username, password_hash, bio, avatar_at, avatar_changed_at, created_at'; // tanpa kolom avatar (BLOB) supaya ringan lewat jaringan

/** Semua kueri. [d] = executor (client atau transaksi yang sudah dibungkus [wrap]). */
function makeQ(d) {
  return {
    userByName: (n) => d.get(`SELECT ${USER_COLS} FROM users WHERE username = ?`, [n]),
    userById: (id) => d.get(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]),
    avatarOf: (id) => d.get('SELECT avatar FROM users WHERE id = ?', [id]),
    insertUser: (n, h, now) => d.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [n, h, now]),
    updatePw: (h, id) => d.run('UPDATE users SET password_hash = ? WHERE id = ?', [h, id]),
    updateBio: (b, id) => d.run('UPDATE users SET bio = ? WHERE id = ?', [b, id]),
    // Hapus foto: selalu boleh, dan TIDAK mengubah avatar_changed_at (supaya "hapus lalu unggah" tidak menembus batas 7 hari).
    clearAvatar: (id) => d.run('UPDATE users SET avatar = NULL, avatar_at = 0 WHERE id = ?', [id]),
    // Ganti foto secara ATOMIK: baris hanya berubah bila sudah genap 7 hari. Dua permintaan bersamaan tidak bisa sama-sama lolos.
    claimAvatar: (buf, now, id, cutoff) =>
      d.run('UPDATE users SET avatar = ?, avatar_at = ?, avatar_changed_at = ? WHERE id = ? AND avatar_changed_at <= ?', [buf, now, now, id, cutoff]),
    failGet: (k) => d.get('SELECT n, reset_at FROM auth_fails WHERE k = ?', [k]),
    failBump: (k, now, windowMs) =>
      d.run(
        `INSERT INTO auth_fails (k, n, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset_at < ? THEN 1 ELSE n + 1 END,
                                      reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END`,
        [k, now + windowMs, now, now, now + windowMs]
      ),
    failClear: (k) => d.run('DELETE FROM auth_fails WHERE k = ?', [k]),
    purgeFails: (now) => d.run('DELETE FROM auth_fails WHERE reset_at < ?', [now]),
    insertSession: (th, uid, now) => d.run('INSERT INTO sessions (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)', [th, uid, now, now]),
    sessionUser: (th, minLast) =>
      d.get(
        `SELECT u.id, u.username, u.password_hash, u.bio, u.avatar_at, u.avatar_changed_at, u.created_at, s.last_used AS sess_last
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.last_used > ?`,
        [th, minLast]
      ),
    touchSession: (now, th) => d.run('UPDATE sessions SET last_used = ? WHERE token_hash = ?', [now, th]),
    delSession: (th) => d.run('DELETE FROM sessions WHERE token_hash = ?', [th]),
    delUserSessions: (uid) => d.run('DELETE FROM sessions WHERE user_id = ?', [uid]),
    purgeSessions: (before) => d.run('DELETE FROM sessions WHERE last_used < ?', [before]),
    insertCompletion: (uid, map, pp, now, stars) =>
      d.run('INSERT OR IGNORE INTO map_completions (user_id, map_id, pp_awarded, completed_at, stars) VALUES (?, ?, ?, ?, ?)', [uid, map, pp, now, stars]),
    getCompletion: (uid, map) => d.get('SELECT pp_awarded, completed_at FROM map_completions WHERE user_id = ? AND map_id = ?', [uid, map]),
    getScore: (uid, map) => d.get('SELECT * FROM scores WHERE user_id = ? AND map_id = ?', [uid, map]),
    insertScore: (uid, map, title, score, acc, combo, at) =>
      d.run('INSERT INTO scores (user_id, map_id, map_title, score, accuracy, max_combo, achieved_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [uid, map, title, score, acc, combo, at]),
    updateScoreBest: (title, score, acc, combo, at, uid, map) =>
      d.run('UPDATE scores SET map_title = ?, score = ?, accuracy = ?, max_combo = ?, achieved_at = ?, plays = plays + 1 WHERE user_id = ? AND map_id = ?', [title, score, acc, combo, at, uid, map]),
    bumpPlays: (uid, map) => d.run('UPDATE scores SET plays = plays + 1 WHERE user_id = ? AND map_id = ?', [uid, map]),
    totalPp: (uid) => d.get('SELECT COALESCE(SUM(pp_awarded), 0) AS t, COUNT(*) AS n FROM map_completions WHERE user_id = ?', [uid]),
    globalRankOf: (pp) => d.get('SELECT COUNT(*) + 1 AS r FROM (SELECT user_id FROM map_completions GROUP BY user_id HAVING SUM(pp_awarded) > ?)', [pp]),
    mapRankOf: (map, score, at) =>
      d.get('SELECT COUNT(*) + 1 AS r FROM scores WHERE map_id = ? AND (score > ? OR (score = ? AND achieved_at < ?))', [map, score, score, at]),
    userStats: (uid) =>
      d.get(
        `SELECT COUNT(*) AS maps, COALESCE(SUM(plays), 0) AS plays, COALESCE(AVG(accuracy), 0) AS avg_acc, COALESCE(MAX(score), 0) AS best,
                COALESCE(MAX(accuracy), 0) AS best_acc, COALESCE(MAX(max_combo), 0) AS best_combo, COALESCE(SUM(score), 0) AS total_score,
                COALESCE(SUM(accuracy >= 95), 0) AS s_count
         FROM scores WHERE user_id = ?`,
        [uid]
      ),
    hardest: (uid) =>
      d.get(
        `SELECT c.map_id, c.stars, c.pp_awarded AS pp, c.completed_at,
                COALESCE((SELECT map_title FROM scores s WHERE s.user_id = c.user_id AND s.map_id = c.map_id), '') AS title
         FROM map_completions c WHERE c.user_id = ? ORDER BY c.stars DESC, c.pp_awarded DESC LIMIT 1`,
        [uid]
      ),
    recent: (uid) =>
      d.all(
        `SELECT s.map_id, s.map_title, s.score, s.accuracy, s.achieved_at, COALESCE(c.pp_awarded, 0) AS pp
         FROM scores s LEFT JOIN map_completions c ON c.user_id = s.user_id AND c.map_id = s.map_id
         WHERE s.user_id = ? ORDER BY s.achieved_at DESC LIMIT 5`,
        [uid]
      ),
    search: (like, meId, prefix) =>
      d.all(
        `SELECT u.id, u.username, u.avatar_at,
                COALESCE((SELECT SUM(pp_awarded) FROM map_completions WHERE user_id = u.id), 0) AS total_pp
         FROM users u WHERE u.username LIKE ? ESCAPE '\\' AND u.id != ?
         ORDER BY (u.username LIKE ? ESCAPE '\\') DESC, u.username COLLATE NOCASE LIMIT 30`,
        [like, meId, prefix]
      ),
    friendRow: (a, b) => d.get('SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ?', [a, b]),
    friendRowsOf: (me) => d.all('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?', [me, me]),
    insertFriend: (a, b, now) => d.run("INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES (?, ?, 'pending', ?)", [a, b, now]),
    acceptFriend: (a, b) => d.run("UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?", [a, b]),
    delFriend: (a, b) => d.run('DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ?', [a, b]),
    friendsAccepted: (me) =>
      d.all(
        `SELECT u.id, u.username, u.avatar_at,
                COALESCE((SELECT SUM(pp_awarded) FROM map_completions WHERE user_id = u.id), 0) AS total_pp
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
         WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?) ORDER BY u.username COLLATE NOCASE`,
        [me, me, me]
      ),
    friendsIncoming: (me) =>
      d.all(
        `SELECT u.id, u.username, u.avatar_at FROM friendships f JOIN users u ON u.id = f.requester_id
         WHERE f.addressee_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
        [me]
      ),
    friendsOutgoing: (me) =>
      d.all(
        `SELECT u.id, u.username, u.avatar_at FROM friendships f JOIN users u ON u.id = f.addressee_id
         WHERE f.requester_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`,
        [me]
      ),
    friendCount: (uid) =>
      d.get("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)", [uid, uid]),
    globalBoard: (limit, offset) =>
      d.all(
        `SELECT u.id AS user_id, u.username, u.avatar_at,
                SUM(c.pp_awarded) AS total_pp, COUNT(c.map_id) AS maps,
                (SELECT COALESCE(AVG(accuracy), 0) FROM scores s WHERE s.user_id = u.id) AS accuracy,
                (SELECT MAX(achieved_at) FROM scores s WHERE s.user_id = u.id) AS last_at
         FROM map_completions c JOIN users u ON u.id = c.user_id
         GROUP BY u.id ORDER BY total_pp DESC, u.id ASC LIMIT ? OFFSET ?`,
        [limit, offset]
      ),
    globalMe: (uid) =>
      d.get(
        `SELECT COALESCE(SUM(c.pp_awarded), 0) AS total_pp, COUNT(c.map_id) AS maps,
                (SELECT COALESCE(AVG(accuracy), 0) FROM scores WHERE user_id = ?) AS accuracy,
                (SELECT MAX(achieved_at) FROM scores WHERE user_id = ?) AS last_at
         FROM map_completions c WHERE c.user_id = ?`,
        [uid, uid, uid]
      ),
    mapBoard: (map, limit, byPp) =>
      d.all(
        `SELECT s.user_id, u.username, u.avatar_at, s.score, s.accuracy, s.max_combo, s.achieved_at, COALESCE(c.pp_awarded, 0) AS pp
         FROM scores s JOIN users u ON u.id = s.user_id
         LEFT JOIN map_completions c ON c.user_id = s.user_id AND c.map_id = s.map_id
         WHERE s.map_id = ? ORDER BY ${byPp ? 'pp DESC, s.score DESC' : 's.score DESC'}, s.achieved_at ASC LIMIT ?`,
        [map, limit]
      ),
    mapTitle: (map) => d.get('SELECT map_title FROM scores WHERE map_id = ? ORDER BY achieved_at DESC LIMIT 1', [map]),
    mapMine: (uid, map) =>
      d.get(
        `SELECT s.score, s.accuracy, s.max_combo, s.achieved_at, COALESCE(c.pp_awarded, 0) AS pp
         FROM scores s LEFT JOIN map_completions c ON c.user_id = s.user_id AND c.map_id = s.map_id
         WHERE s.user_id = ? AND s.map_id = ?`,
        [uid, map]
      ),
    mapCount: (map) => d.get('SELECT COUNT(*) AS n FROM scores WHERE map_id = ?', [map]),
    deleteUserAll: async (uid) => {
      await d.run('DELETE FROM sessions WHERE user_id = ?', [uid]);
      await d.run('DELETE FROM scores WHERE user_id = ?', [uid]);
      await d.run('DELETE FROM map_completions WHERE user_id = ?', [uid]);
      await d.run('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', [uid, uid]);
      await d.run('DELETE FROM users WHERE id = ?', [uid]);
    },
  };
}

async function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  let url = opts.dbUrl || process.env.TURSO_DATABASE_URL || '';
  if (!url) {
    fs.mkdirSync(dataDir, { recursive: true });
    url = 'file:' + path.join(dataDir, 'novabeat.db');
  }
  const client = createClient({ url, authToken: opts.authToken || process.env.TURSO_AUTH_TOKEN || undefined });
  const db = wrap(client);
  for (const sql of SCHEMA) await client.execute(sql);
  // migrasi database lama: kolom bintang kesulitan (untuk "map tersulit" di profil)
  try {
    await client.execute('ALTER TABLE map_completions ADD COLUMN stars REAL NOT NULL DEFAULT 0');
  } catch (e) {
    /* kolom sudah ada */
  }
  // migrasi database lama: catatan waktu terakhir GANTI foto (terpisah dari avatar_at yang jadi 0 saat foto dihapus)
  try {
    await client.execute('ALTER TABLE users ADD COLUMN avatar_changed_at INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    /* kolom sudah ada */
  }
  await client.execute('UPDATE users SET avatar_changed_at = avatar_at WHERE avatar_changed_at = 0 AND avatar_at > 0');
  const q = makeQ(db);
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  await q.purgeSessions(Date.now() - SESSION_DAYS * 86400000);
  await q.purgeFails(Date.now());

  // ---- pembatas laju (di memori) ----
  // Dipakai untuk lalu lintas "panas" (semua permintaan per IP, daftar, skor, dst.) karena murah: tanpa akses database.
  // Konsekuensinya: hitungan hilang saat server restart / tidur, dan tidak dibagi bila server dijalankan > 1 instans.
  // Untuk serangan tebak-sandi, hitungan gagal-masuk disimpan di DATABASE (tabel auth_fails) agar tahan restart.
  const hits = new Map();
  function evictRateKeys(now) {
    for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
    if (hits.size >= MAX_RATE_KEYS) {
      let n = Math.ceil(MAX_RATE_KEYS * 0.1);
      for (const k of hits.keys()) {
        hits.delete(k);
        if (--n <= 0) break;
      }
    }
  }
  function rateLimit(key, max, windowMs) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) {
      if (hits.size >= MAX_RATE_KEYS) evictRateKeys(now);
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.n++;
    if (h.n > max) {
      const secs = Math.max(1, Math.ceil((h.reset - now) / 1000));
      throw new HttpError(429, 'terlalu_cepat', `Terlalu banyak percobaan. Coba lagi dalam ${secs} detik.`, { retry_after_seconds: secs }, { 'Retry-After': String(secs) });
    }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
    q.purgeFails(now).catch(() => {});
  }, 60000).unref();

  // Alamat IP pemain. Di belakang proxy hosting, header X-Forwarded-For bisa DIPALSUKAN pemain bila diambil dari sisi kiri,
  // jadi yang dipakai adalah entri dari KANAN sebanyak TRUST_PROXY_HOPS (jumlah proxy tepercaya di depan server, bawaan 1).
  // Bila hosting menyediakan header khusus yang tidak bisa dipalsukan, isi IP_HEADER (mis. cf-connecting-ip).
  // Cek hasilnya dengan GET /api/whoami (lihat server/README.md).
  const ipHeader = String(opts.ipHeader ?? process.env.IP_HEADER ?? '').toLowerCase();
  const hops = Math.max(1, Number(opts.trustProxyHops ?? process.env.TRUST_PROXY_HOPS) || 1);
  function clientIp(req) {
    if (ipHeader) {
      const v = String(req.headers[ipHeader] || '').split(',')[0].trim();
      if (v) return v;
    }
    if (trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - hops)];
    }
    return req.socket.remoteAddress || '?';
  }

  // ---- penguncian login yang tahan restart ----
  // Tiga kunci: (nama + IP) ketat; nama saja longgar (serangan terdistribusi); IP saja longgar.
  // Kunci "nama + IP" mencegah orang iseng mengunci akun korban dari IP lain.
  const FAIL_WINDOW = 15 * 60000;
  const failKeys = (name, ip) => [
    { k: 'ui:' + name + '|' + ip, max: 8, win: FAIL_WINDOW },
    { k: 'u:' + name, max: 60, win: 3600000 },
    { k: 'ip:' + ip, max: 40, win: FAIL_WINDOW },
  ];
  async function assertNotLocked(keys) {
    const now = Date.now();
    const rows = await Promise.all(keys.map((x) => q.failGet(x.k)));
    let wait = 0;
    rows.forEach((r, i) => {
      if (r && r.reset_at > now && r.n >= keys[i].max) wait = Math.max(wait, r.reset_at - now);
    });
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      throw new HttpError(429, 'login_terkunci', `Terlalu banyak percobaan masuk yang gagal. Coba lagi dalam ${durasiIndonesia(wait)}.`, { retry_after_seconds: secs }, { 'Retry-After': String(secs) });
    }
    return rows;
  }

  // ---- akun ----
  let dummyHash = null; // dipakai agar waktu respons sama untuk nama yang tidak ada
  async function getDummy() {
    if (!dummyHash) dummyHash = await argon2.hash(crypto.randomBytes(16).toString('hex'), ARGON_OPTS);
    return dummyHash;
  }

  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await q.insertSession(sha256(token), userId, Date.now());
    return token;
  }

  async function authUser(req, required = true) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h);
    if (m) {
      const th = sha256(m[1]);
      const now = Date.now();
      const u = await q.sessionUser(th, now - SESSION_DAYS * 86400000);
      if (u) {
        if (now - u.sess_last > 3600000) await q.touchSession(now, th); // cukup sejam sekali: hemat panggilan database
        return { user: u, tokenHash: th };
      }
    }
    if (required) throw new HttpError(401, 'belum_masuk', 'Sesi habis. Silakan masuk lagi.');
    return null;
  }

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'sandi_pendek', 'Kata sandi minimal 6 karakter');
    if (pw.length > 128) throw new HttpError(400, 'sandi_panjang', 'Kata sandi maksimal 128 karakter');
  }

  function checkUsername(n) {
    if (typeof n !== 'string' || !USERNAME_RE.test(n)) {
      throw new HttpError(400, 'nama_tidak_valid', 'Nama 3–20 karakter: huruf, angka, titik, strip, atau garis bawah');
    }
  }

  const publicUser = (u) => ({ id: u.id, username: u.username, avatar_at: u.avatar_at || 0 });

  async function totalsOf(userId) {
    const t = await q.totalPp(userId);
    return { total_pp: round2(t.t), maps_cleared: t.n };
  }

  const nextAvatarAt = (u) => {
    const t = u.avatar_changed_at ? u.avatar_changed_at + AVATAR_COOLDOWN_MS : 0;
    return t > Date.now() ? t : 0; // 0 = boleh ganti foto sekarang
  };

  async function selfJson(u) {
    return {
      id: u.id,
      username: u.username,
      bio: u.bio,
      created_at: u.created_at,
      avatar_at: u.avatar_at || 0,
      avatar_next_change_at: nextAvatarAt(u),
      avatar_cooldown_ms: AVATAR_COOLDOWN_MS,
      ...(await totalsOf(u.id)),
    };
  }

  function relationFrom(meId, otherId, rows) {
    if (meId === otherId) return 'self';
    const out = rows.find((r) => r.requester_id === meId && r.addressee_id === otherId);
    const inc = rows.find((r) => r.requester_id === otherId && r.addressee_id === meId);
    if ((out && out.status === 'accepted') || (inc && inc.status === 'accepted')) return 'friend';
    if (inc) return 'incoming'; // dia mengirim permintaan ke saya
    if (out) return 'outgoing';
    return 'none';
  }

  async function relationOf(meId, otherId) {
    if (meId === otherId) return 'self';
    const [a, b] = await Promise.all([q.friendRow(meId, otherId), q.friendRow(otherId, meId)]);
    return relationFrom(meId, otherId, [a, b].filter(Boolean));
  }

  // ---- endpoint ----
  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route('GET', /^\/api\/health$/, async () => ({ ok: true, time: Date.now() }));
  // Untuk memeriksa pengaturan TRUST_PROXY_HOPS / IP_HEADER: menampilkan IP yang dipakai server untuk batas laju.
  route('GET', /^\/api\/whoami$/, async (ctx) => ({
    ip: ctx.ip,
    socket: ctx.req.socket.remoteAddress || '',
    x_forwarded_for: String(ctx.req.headers['x-forwarded-for'] || ''),
    trust_proxy: trustProxy,
    hops,
    ip_header: ipHeader,
  }));

  route('POST', /^\/api\/register$/, async (ctx) => {
    rateLimit('reg:' + ctx.ip, 8, 3600000);
    const { username, password } = ctx.body;
    checkUsername(username);
    checkPassword(password);
    if (await q.userByName(username)) throw new HttpError(409, 'nama_dipakai', 'Nama itu sudah dipakai orang lain');
    const hash = await argon2.hash(password, ARGON_OPTS); // Argon2id + salt acak otomatis
    let id;
    try {
      id = (await q.insertUser(username, hash, Date.now())).lastInsertRowid;
    } catch (e) {
      throw new HttpError(409, 'nama_dipakai', 'Nama itu sudah dipakai orang lain');
    }
    const user = await q.userById(id);
    return { token: await newSession(user.id), user: await selfJson(user) };
  });

  route('POST', /^\/api\/login$/, async (ctx) => {
    rateLimit('login:' + ctx.ip, 30, 600000);
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) {
      throw new HttpError(400, 'data_salah', 'Nama dan kata sandi wajib diisi');
    }
    const lname = username.trim().toLowerCase().slice(0, 40);
    const keys = failKeys(lname, ctx.ip);
    const prior = await assertNotLocked(keys); // 429 bila terlalu banyak gagal (tersimpan di database, tahan restart)
    const user = await q.userByName(username.trim());
    // Selalu jalankan verify (pada hash palsu bila nama tidak ada) supaya waktu respons tidak membocorkan nama yang ada.
    const ok = await argon2.verify(user ? user.password_hash : await getDummy(), password).catch(() => false);
    if (!user || !ok) {
      const now = Date.now();
      await Promise.all(keys.map((x) => q.failBump(x.k, now, x.win))).catch(() => {});
      throw new HttpError(401, 'login_gagal', 'Nama atau kata sandi salah');
    }
    if (prior[0]) await q.failClear(keys[0].k).catch(() => {}); // berhasil: hapus hitungan nama+IP ini
    if (argon2.needsRehash(user.password_hash, ARGON_OPTS)) await q.updatePw(await argon2.hash(password, ARGON_OPTS), user.id);
    return { token: await newSession(user.id), user: await selfJson(user) };
  });

  route('POST', /^\/api\/logout$/, async (ctx) => {
    const a = await authUser(ctx.req);
    await q.delSession(a.tokenHash);
    return { ok: true };
  });

  route('GET', /^\/api\/me$/, async (ctx) => ({ user: await selfJson((await authUser(ctx.req)).user) }));

  route('POST', /^\/api\/me\/profile$/, async (ctx) => {
    const { user } = await authUser(ctx.req);
    await q.updateBio(cleanText(ctx.body.bio, 120), user.id);
    return { user: await selfJson(await q.userById(user.id)) };
  });

  route('POST', /^\/api\/me\/password$/, async (ctx) => {
    const { user } = await authUser(ctx.req);
    rateLimit('pw:' + user.id, 10, 600000);
    const { old_password, new_password } = ctx.body;
    if (typeof old_password !== 'string' || !(await argon2.verify(user.password_hash, old_password).catch(() => false))) {
      throw new HttpError(403, 'sandi_lama_salah', 'Kata sandi lama salah');
    }
    checkPassword(new_password);
    await q.updatePw(await argon2.hash(new_password, ARGON_OPTS), user.id);
    await q.delUserSessions(user.id); // semua perangkat harus masuk ulang
    return { token: await newSession(user.id), ok: true };
  });

  route('POST', /^\/api\/me\/delete$/, async (ctx) => {
    const { user } = await authUser(ctx.req);
    rateLimit('del:' + user.id, 5, 600000);
    const pw = ctx.body.password;
    if (typeof pw !== 'string' || !(await argon2.verify(user.password_hash, pw).catch(() => false))) {
      throw new HttpError(403, 'sandi_salah', 'Kata sandi salah');
    }
    const tx = await client.transaction('write');
    try {
      await makeQ(wrap(tx)).deleteUserAll(user.id); // hapus semua data akun ini
      await tx.commit();
    } catch (e) {
      try {
        await tx.rollback();
      } catch (x) {
        /* sudah selesai */
      }
      throw e;
    } finally {
      tx.close();
    }
    return { ok: true };
  });

  function avatarLimited(last, now) {
    const until = last + AVATAR_COOLDOWN_MS;
    const wait = until - now;
    const secs = Math.max(1, Math.ceil(wait / 1000));
    return new HttpError(
      429,
      'avatar_dibatasi',
      `Foto profil hanya bisa diganti 1 kali setiap 7 hari. Kamu bisa menggantinya lagi dalam sekitar ${durasiIndonesia(wait)}, yaitu pada ${tanggalWib(until)}. Menghapus foto tetap boleh kapan saja.`,
      { retry_at: until, retry_after_seconds: secs },
      { 'Retry-After': String(secs) }
    );
  }

  route('POST', /^\/api\/me\/avatar$/, async (ctx) => {
    const { user } = await authUser(ctx.req);
    rateLimit('avatar:' + user.id, 30, 3600000);
    // Menghapus foto SELALU boleh dan tidak mengubah catatan waktu ganti foto.
    if (ctx.body.remove) {
      await q.clearAvatar(user.id);
      return { ok: true, avatar_at: 0, avatar_next_change_at: nextAvatarAt(user) };
    }
    const now = Date.now();
    const last = user.avatar_changed_at || 0;
    if (last > 0 && now - last < AVATAR_COOLDOWN_MS) throw avatarLimited(last, now); // pemeriksaan murah dulu, sebelum memproses gambar
    const b64 = ctx.body.jpeg_base64;
    if (typeof b64 !== 'string') throw new HttpError(400, 'data_salah', 'Gambar tidak ada');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > MAX_AVATAR) throw new HttpError(413, 'gambar_besar', 'Foto terlalu besar (maksimal 80 KB)');
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new HttpError(400, 'bukan_jpeg', 'Foto harus JPEG');
    // Pembaruan atomik di database: hanya berhasil bila catatan waktu terakhir sudah >= 7 hari lalu.
    const r = await q.claimAvatar(buf, now, user.id, now - AVATAR_COOLDOWN_MS);
    if (r.changes === 0) {
      const fresh = await q.userById(user.id); // dua permintaan bersamaan: yang kalah mendapat 429
      throw avatarLimited(fresh ? fresh.avatar_changed_at || now : now, now);
    }
    return { ok: true, avatar_at: now, avatar_next_change_at: now + AVATAR_COOLDOWN_MS };
  });

  route('GET', /^\/api\/users\/(\d+)\/avatar$/, async (ctx, m) => {
    const row = await q.avatarOf(Number(m[1]));
    if (!row || !row.avatar) throw new HttpError(404, 'tidak_ada', 'Tidak ada foto');
    return { raw: Buffer.from(row.avatar), type: 'image/jpeg', cache: 'public, max-age=86400' };
  });

  route('GET', /^\/api\/users\/search$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    const term = cleanText(ctx.url.searchParams.get('q'), 30);
    if (term.length < 1) return { users: [] };
    const esc = term.replace(/[\\%_]/g, (c) => '\\' + c);
    const [rows, fr] = await Promise.all([q.search('%' + esc + '%', me.id, esc + '%'), q.friendRowsOf(me.id)]);
    return { users: rows.map((r) => ({ ...publicUser(r), total_pp: round2(r.total_pp), relation: relationFrom(me.id, r.id, fr) })) };
  });

  route('GET', /^\/api\/users\/(\d+)$/, async (ctx, m) => {
    const me = await authUser(ctx.req, false);
    const u = await q.userById(Number(m[1]));
    if (!u) throw new HttpError(404, 'tidak_ada', 'Pemain tidak ditemukan');
    const [tot, st, hd, fc, recent, relation] = await Promise.all([
      totalsOf(u.id),
      q.userStats(u.id),
      q.hardest(u.id),
      q.friendCount(u.id),
      q.recent(u.id),
      me ? relationOf(me.user.id, u.id) : 'none',
    ]);
    return {
      user: {
        id: u.id,
        username: u.username,
        bio: u.bio,
        created_at: u.created_at,
        avatar_at: u.avatar_at || 0,
        total_pp: tot.total_pp,
        maps_cleared: tot.maps_cleared,
        global_rank: tot.maps_cleared > 0 ? (await q.globalRankOf(tot.total_pp)).r : 0,
        plays: st.plays,
        avg_accuracy: round2(st.avg_acc),
        best_score: st.best,
        best_accuracy: round2(st.best_acc),
        max_combo: st.best_combo,
        total_score: st.total_score,
        s_ranks: st.s_count,
        hardest: hd ? { map_id: hd.map_id, title: hd.title, stars: round2(hd.stars), pp: round2(hd.pp), completed_at: hd.completed_at } : null,
        friends: fc.n,
        relation,
        recent: recent.map((r) => ({ ...r, accuracy: round2(r.accuracy), pp: round2(r.pp) })),
      },
    };
  });

  // ---- teman ----
  route('GET', /^\/api\/friends$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    const f = (r) => ({ ...publicUser(r), total_pp: round2(r.total_pp || 0) });
    const [a, b, c] = await Promise.all([q.friendsAccepted(me.id), q.friendsIncoming(me.id), q.friendsOutgoing(me.id)]);
    return { friends: a.map(f), incoming: b.map(f), outgoing: c.map(f) };
  });

  async function targetUser(body, me) {
    const id = Number(body.user_id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'data_salah', 'Pemain tidak valid');
    if (id === me.id) throw new HttpError(400, 'diri_sendiri', 'Tidak bisa berteman dengan diri sendiri');
    const u = await q.userById(id);
    if (!u) throw new HttpError(404, 'tidak_ada', 'Pemain tidak ditemukan');
    return u;
  }

  route('POST', /^\/api\/friends\/request$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    rateLimit('freq:' + me.id, 40, 3600000);
    const t = await targetUser(ctx.body, me);
    const rel = await relationOf(me.id, t.id);
    if (rel === 'friend') return { relation: 'friend' };
    if (rel === 'outgoing') return { relation: 'outgoing' };
    if (rel === 'incoming') {
      await q.acceptFriend(t.id, me.id); // dia sudah meminta lebih dulu: langsung jadi teman
      return { relation: 'friend' };
    }
    await q.insertFriend(me.id, t.id, Date.now());
    return { relation: 'outgoing' };
  });

  route('POST', /^\/api\/friends\/accept$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    const t = await targetUser(ctx.body, me);
    const row = await q.friendRow(t.id, me.id);
    if (!row || row.status !== 'pending') throw new HttpError(404, 'tidak_ada', 'Tidak ada permintaan dari pemain itu');
    await q.acceptFriend(t.id, me.id);
    return { relation: 'friend' };
  });

  // tolak permintaan masuk, batalkan permintaan keluar, atau hapus teman
  route('POST', /^\/api\/friends\/remove$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    const t = await targetUser(ctx.body, me);
    await q.delFriend(me.id, t.id);
    await q.delFriend(t.id, me.id);
    return { relation: 'none' };
  });

  // ---- skor & PP ----
  route('POST', /^\/api\/scores$/, async (ctx) => {
    const me = (await authUser(ctx.req)).user;
    rateLimit('score:' + me.id, 120, 3600000);
    const b = ctx.body;
    const mapId = String(b.map_id || '');
    if (!MAPID_RE.test(mapId)) throw new HttpError(400, 'map_tidak_valid', 'ID map tidak valid');
    const score = Math.round(Number(b.score));
    const acc = Number(b.accuracy);
    const combo = Math.round(Number(b.max_combo || 0));
    let pp = Number(b.pp);
    let stars = Number(b.stars);
    if (!Number.isFinite(stars) || stars < 0) stars = 0;
    stars = round2(Math.min(stars, 15));
    if (!Number.isFinite(score) || score < 0 || score > 1000000) throw new HttpError(400, 'skor_tidak_valid', 'Skor tidak valid');
    if (!Number.isFinite(acc) || acc < 0 || acc > 100) throw new HttpError(400, 'akurasi_tidak_valid', 'Akurasi tidak valid');
    if (!Number.isFinite(pp) || pp < 0) pp = 0;
    pp = round2(Math.min(pp, MAX_PP_PER_MAP));
    const title = cleanText(b.map_title, 120);
    const now = Date.now();

    // Satu transaksi: penanda tamat + skor terbaik berubah bersama-sama atau tidak sama sekali.
    const tx = await client.transaction('write');
    const tq = makeQ(wrap(tx));
    let first = false;
    let newBest = false;
    try {
      // Tanda "sudah ditamatkan": INSERT OR IGNORE pada UNIQUE(user_id, map_id). changes = 1 hanya pada tamat pertama.
      first = (await tq.insertCompletion(me.id, mapId, pp, now, stars)).changes === 1;
      const prev = await tq.getScore(me.id, mapId);
      if (!prev) {
        await tq.insertScore(me.id, mapId, title, score, acc, Math.max(0, combo), now);
        newBest = true;
      } else if (score > prev.score) {
        await tq.updateScoreBest(title || prev.map_title, score, acc, Math.max(0, combo), now, me.id, mapId);
        newBest = true;
      } else {
        await tq.bumpPlays(me.id, mapId);
      }
      await tx.commit();
    } catch (e) {
      try {
        await tx.rollback();
      } catch (x) {
        /* sudah selesai */
      }
      throw e;
    } finally {
      tx.close();
    }
    if (first) boardCache.clear(); // total PP berubah: papan global harus segar
    const [comp, mine, totals] = await Promise.all([q.getCompletion(me.id, mapId), q.getScore(me.id, mapId), totalsOf(me.id)]);
    const out = {
      ok: true,
      first_clear: first,
      pp_awarded: first ? comp.pp_awarded : 0,
      pp_claimed: comp.pp_awarded,
      already_claimed: !first,
      new_best: newBest,
      best_score: mine.score,
      best_accuracy: round2(mine.accuracy),
      map_rank: (await q.mapRankOf(mapId, mine.score, mine.achieved_at)).r,
      ...totals,
    };
    out.global_rank = (await q.globalRankOf(out.total_pp)).r;
    return out;
  });

  const rowOut = (r, i) => ({
    rank: i + 1,
    user_id: r.user_id,
    username: r.username,
    avatar_at: r.avatar_at || 0,
    score: r.score,
    accuracy: round2(r.accuracy),
    max_combo: r.max_combo,
    pp: round2(r.pp),
    achieved_at: r.achieved_at,
  });

  route('GET', /^\/api\/leaderboard\/map\/([A-Za-z0-9:_.\-]{1,64})$/, async (ctx, m) => {
    const me = await authUser(ctx.req, false);
    const mapId = m[1];
    const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 50));
    const sort = ctx.url.searchParams.get('sort') === 'pp' ? 'pp' : 'score';
    const [rows, title, total] = await Promise.all([q.mapBoard(mapId, limit, sort === 'pp'), q.mapTitle(mapId), q.mapCount(mapId)]);
    const out = { map_id: mapId, sort, title: (title || {}).map_title || '', total: total.n, entries: rows.map(rowOut) };
    if (me) {
      const mine = await q.mapMine(me.user.id, mapId);
      if (mine) {
        out.me = {
          rank: (await q.mapRankOf(mapId, mine.score, mine.achieved_at)).r,
          user_id: me.user.id,
          username: me.user.username,
          score: mine.score,
          accuracy: round2(mine.accuracy),
          max_combo: mine.max_combo,
          pp: round2(mine.pp),
          achieved_at: mine.achieved_at,
        };
      }
    }
    return out;
  });

  // Papan global menjumlah seluruh tabel map_completions: di-cache singkat supaya hemat "rows read" Turso.
  const boardCache = new Map();
  async function cachedGlobalBoard(limit, offset) {
    const k = limit + ':' + offset;
    const now = Date.now();
    const c = boardCache.get(k);
    if (c && now - c.at < 15000) return c.rows;
    const rows = await q.globalBoard(limit, offset);
    if (boardCache.size > 40) boardCache.clear();
    boardCache.set(k, { at: now, rows });
    return rows;
  }

  route('GET', /^\/api\/leaderboard\/global$/, async (ctx) => {
    const me = await authUser(ctx.req, false);
    const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(ctx.url.searchParams.get('offset')) || 0);
    const rows = await cachedGlobalBoard(limit, offset);
    const out = {
      offset,
      entries: rows.map((r, i) => ({
        rank: offset + i + 1,
        user_id: r.user_id,
        username: r.username,
        avatar_at: r.avatar_at || 0,
        pp: round2(r.total_pp),
        maps: r.maps,
        accuracy: round2(r.accuracy),
        achieved_at: r.last_at,
      })),
    };
    if (me) {
      const g = await q.globalMe(me.user.id);
      if (g.maps > 0) {
        out.me = {
          rank: (await q.globalRankOf(round2(g.total_pp))).r,
          user_id: me.user.id,
          username: me.user.username,
          pp: round2(g.total_pp),
          maps: g.maps,
          accuracy: round2(g.accuracy),
          achieved_at: g.last_at,
        };
      }
    }
    return out;
  });

  // ---- server HTTP ----
  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(new HttpError(413, 'terlalu_besar', 'Data terlalu besar'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (n === 0) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch (e) {
          reject(new HttpError(400, 'json_rusak', 'Format data salah'));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj, extra) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
      res.end(body);
    };
    try {
      const u = new URL(req.url, 'http://x');
      const ip = clientIp(req);
      rateLimit('ip:' + ip, 600, 60000); // batas kasar semua permintaan per IP
      let handler = null;
      let m = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        m = r.re.exec(u.pathname);
        if (m) {
          handler = r;
          break;
        }
      }
      if (!handler) throw new HttpError(404, 'tidak_ada', 'Alamat tidak ditemukan');
      const body = await readBody(req);
      const out = await handler.fn({ req, url: u, body, ip }, m);
      if (out && out.raw) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Length': out.raw.length, 'Cache-Control': out.cache || 'no-store' });
        res.end(out.raw);
      } else send(200, out);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { ...e.extra, error: e.code, message: e.message }, e.headers);
      else {
        console.error('galat:', e);
        send(500, { error: 'server', message: 'Galat di server' });
      }
    }
  });
  server.requestTimeout = 30000;
  // Proxy hosting menjaga koneksi tetap hidup lebih lama dari bawaan Node (5 dtk): tanpa ini kadang muncul galat 502 acak.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---- room multiplayer (WebSocket) ----
  const rooms = attachRooms({
    server,
    route,
    HttpError,
    rateLimit,
    clientIp,
    authToken: async (token) => {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
      const u = await q.sessionUser(sha256(token), Date.now() - SESSION_DAYS * 86400000);
      return u ? { id: u.id, username: u.username } : null;
    },
    limits: opts.roomLimits,
  });

  return { server, client, rooms };
}

module.exports = { createApp };

if (require.main === module) {
  createApp()
    .then(({ server, rooms }) => {
      const port = Number(process.env.PORT) || 8080;
      server.listen(port, '0.0.0.0', () => console.log('Nova Beat server aktif di port ' + port + (process.env.TURSO_DATABASE_URL ? ' (database: Turso)' : ' (database: file lokal)')));
      // Hosting mengirim SIGTERM saat deploy ulang / mematikan instans: beri tahu pemain di room lalu berhenti dengan rapi.
      process.on('SIGTERM', () => {
        console.log('SIGTERM: menutup room dan berhenti');
        try {
          rooms.shutdown();
        } catch (e) {
          /* abaikan */
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      });
    })
    .catch((e) => {
      console.error('Gagal memulai server:', e);
      process.exit(1);
    });
}
