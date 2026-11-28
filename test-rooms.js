'use strict';
// Uji room multiplayer: node test-rooms.js  (memakai WebSocket bawaan Node 22 sebagai klien)
const assert = require('node:assert/strict');
const { createApp } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { server, rooms } = await createApp({ dbUrl: ':memory:', roomLimits: { maxPlayers: 4 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const tokens = {};
  for (const n of ['Host1', 'Guest1', 'Guest2', 'Guest3', 'Guest4']) {
    const r = await call('POST', '/api/register', { username: n, password: 'rahasia123' });
    assert.equal(r.status, 200, 'daftar ' + n + ' ' + JSON.stringify(r.json));
    tokens[n] = r.json.token;
  }

  // klien WebSocket sederhana yang menyimpan semua pesan
  function client(name, first) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws/rooms');
      const c = { name, ws, msgs: [], closed: false, id: '' };
      c.send = (o) => ws.send(JSON.stringify(o));
      c.last = (t) => [...c.msgs].reverse().find((m) => m.t === t);
      c.wait = async (t, pred = () => true, ms = 2500) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const m = [...c.msgs].reverse().find((x) => x.t === t && pred(x));
          if (m) return m;
          await sleep(15);
        }
        throw new Error(name + ': pesan ' + t + ' tidak datang. Diterima: ' + c.msgs.map((m) => m.t).join(','));
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'welcome') c.id = m.id;
        c.msgs.push(m);
      };
      ws.onclose = () => (c.closed = true);
      ws.onerror = (e) => reject(e);
      ws.onopen = () => {
        if (first) c.send(first);
        resolve(c);
      };
    });
  }

  // --- tanpa token / token salah ditolak ---
  let bad = await client('bad', { t: 'create', token: 'x'.repeat(30), settings: {} });
  await bad.wait('error');
  assert.equal(bad.last('error').fatal, true);
  await sleep(700);
  assert.equal(bad.closed, true, 'koneksi ditutup setelah token salah');

  // --- buat room ---
  const host = await client('host', { t: 'create', token: tokens.Host1, settings: { name: 'Room Uji', pw: '', mt: 0, qm: 1, wc: 0, as: 0, mx: 0, ls: true } });
  const w = await host.wait('welcome');
  assert.match(w.code, /^S[A-HJ-NP-Z2-9]{5}$/, 'kode room diawali S: ' + w.code);
  let room = await host.wait('room');
  assert.equal(room.name, 'Room Uji');
  assert.equal(room.host, host.id);
  assert.equal(room.mx, 4, 'batas pemain dibatasi server');
  assert.equal(room.vc, false);
  const code = w.code;

  // --- daftar publik ---
  let r = await call('GET', '/api/rooms');
  assert.equal(r.json.rooms.length, 1);
  assert.equal(r.json.rooms[0].code, code);
  assert.equal(r.json.rooms[0].pl, 1);

  // --- gabung, password, room tidak ada ---
  const ghost = await client('ghost', { t: 'join', token: tokens.Guest1, code: 'SZZZZZ' });
  await ghost.wait('error');
  assert.match(ghost.last('error').msg, /tidak ditemukan/);

  const g1 = await client('g1', { t: 'join', token: tokens.Guest1, code });
  await g1.wait('welcome');
  await g1.wait('room', (m) => m.players.length === 2);
  const g2 = await client('g2', { t: 'join', token: tokens.Guest2, code: code.toLowerCase() });
  await g2.wait('welcome');
  await host.wait('room', (m) => m.players.length === 3);
  assert.equal(g1.last('room').players.find((p) => p.id === g1.id).n, 'Guest1', 'nama pemain = nama akun');

  // --- pilih lagu: mode "semua pemain" ---
  g1.send({ t: 'chart', ck: 'abc123', sid: 555, ti: 'Judul', ar: 'Artis', cr: 'Mapper', v: '4K Hard', k: 4, n: 800 });
  room = await host.wait('room', (m) => m.queue.length === 1);
  assert.equal(room.queue[0].on, 'Guest1');
  assert.equal(room.queue[0].sid, 555);
  g1.send({ t: 'chart', ck: 'abc123', sid: 555, ti: 'Judul', ar: 'Artis', cr: 'Mapper', v: '4K Hard', k: 4, n: 800 });
  await sleep(150);
  assert.equal(host.last('room').queue.length, 1, 'chart sama tidak ganda');

  // --- siap ---
  g1.send({ t: 'ready', ready: true });
  await host.wait('room', (m) => m.players.find((p) => p.id === g1.id)?.rd === true);
  // g2 tidak siap -> tidak ikut ronde

  // --- bukan host tidak bisa mulai / mengeluarkan / mengubah pengaturan ---
  g1.send({ t: 'start' });
  g1.send({ t: 'kick', id: host.id });
  g1.send({ t: 'settings', name: 'Diretas' });
  await sleep(200);
  assert.equal(host.last('room').st, 'lobby');
  assert.equal(host.last('room').name, 'Room Uji');
  assert.equal(host.closed, false);

  // --- host mulai ---
  const t0 = Date.now();
  host.send({ t: 'start' });
  const st = await g1.wait('start');
  assert.ok(st.at - Date.now() > 3500 && st.at - Date.now() <= 5100, 'aba-aba mulai ~5 detik lagi');
  assert.deepEqual(st.parts.sort(), [g1.id, host.id].sort(), 'hanya yang siap + host ikut');
  assert.ok(Math.abs(st.now - t0) < 1500);
  await g2.wait('start');
  assert.equal(g2.last('start').parts.includes(g2.id), false);

  // ping/pong untuk sinkron jam
  g1.send({ t: 'ping', c: 12345 });
  const pong = await g1.wait('pong');
  assert.equal(pong.c, 12345);
  assert.ok(Math.abs(pong.s - Date.now()) < 1500);

  // --- skor selama main (di-clamp, disiarkan ringkas) ---
  host.send({ t: 'score', score: 5000, acc: 97.5, combo: 40, hp: 0.9, prog: 0.1 });
  g1.send({ t: 'score', score: 99999999, acc: 500, combo: -5, hp: 9, prog: 2 });
  const sc = await g2.wait('scores', (m) => m.p.length === 2 && m.p.some((a) => a[1] === 2000000));
  const row = sc.p.find((a) => a[0] === g1.id);
  assert.equal(row[1], 2000000, 'skor di-clamp');
  assert.equal(row[2], 100);
  assert.equal(row[3], 0);
  assert.equal(row[4], 1);
  assert.equal(row[5], 1);
  // pemain yang tidak ikut ronde tidak bisa mengirim skor
  g2.send({ t: 'score', score: 777, acc: 50, combo: 1, hp: 1, prog: 0.5 });
  await sleep(350);
  assert.equal(g1.last('scores').p.some((a) => a[0] === g2.id), false);

  // --- selesai -> peringkat ---
  host.send({ t: 'finish', score: 800000, acc: 98.2, maxCombo: 300, failed: false, counts: [1, 2, 3, 4, 5, 6] });
  await sleep(100);
  assert.equal(host.last('results'), undefined, 'belum semua selesai');
  g1.send({ t: 'finish', score: 900000, acc: 99, maxCombo: 350, failed: false });
  const res = await g2.wait('results');
  assert.deepEqual(res.ranking.map((x) => x.name), ['Guest1', 'Host1'], 'peringkat menurut skor');
  assert.equal(res.wc, 0);
  assert.deepEqual(res.ranking[1].counts, [1, 2, 3, 4, 5, 6]);
  room = await host.wait('room', (m) => m.st === 'lobby' && m.queue.length === 0);
  assert.equal(room.players.every((p) => p.rd === false), true, 'siap direset setelah ronde');

  // --- batas pemain (maks 4) ---
  const g3 = await client('g3', { t: 'join', token: tokens.Guest3, code });
  await g3.wait('welcome');
  assert.equal(rooms.rooms.get(code).players.size, 4, 'Host1, Guest1, Guest2, Guest3 = penuh');
  const g4 = await client('g4', { t: 'join', token: tokens.Guest4, code });
  await g4.wait('error', (m) => /penuh/.test(m.msg));
  // akun Host1 masuk lagi dari sambungan baru: sambungan lama dikeluarkan, jadi slot-nya terpakai kembali
  const extra = await client('extra', { t: 'join', token: tokens.Host1, code });
  await extra.wait('welcome');
  await host.wait('error', (m) => /tempat lain/.test(m.msg));
  await sleep(700);
  assert.equal(host.closed, true);
  room = await g1.wait('room', (m) => m.host !== host.id);
  assert.ok(room.players.some((p) => p.id === room.host), 'host pindah ke pemain lain');
  assert.equal(room.host, g1.id, 'host pindah ke pemain tertua');
  assert.equal(rooms.rooms.get(code).players.size, 4);

  // --- password room ---
  g1.send({ t: 'settings', pw: 'rahasia' });
  await g1.wait('room', (m) => m.pw === true);
  r = await call('GET', '/api/rooms');
  assert.equal(r.json.rooms[0].pw, true);
  assert.equal(JSON.stringify(r.json).includes('rahasia"'), false, 'password tidak bocor di daftar');

  // --- tutup: semua keluar -> room dihapus ---
  for (const c of [g1, g2, g3, extra]) c.send({ t: 'leave' });
  await sleep(900);
  assert.equal(rooms.rooms.size, 0, 'room kosong dihapus otomatis');
  r = await call('GET', '/api/rooms');
  assert.equal(r.json.rooms.length, 0);

  // --- banjir pesan tidak menjatuhkan server ---
  const fl = await client('fl', { t: 'create', token: tokens.Guest2, settings: {} });
  await fl.wait('welcome');
  for (let i = 0; i < 400; i++) fl.send({ t: 'score', score: i });
  await sleep(300);
  r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  fl.send({ t: 'leave' });

  // --- pesan sampah ---
  const junk = new WebSocket('ws://127.0.0.1:' + port + '/ws/rooms');
  await new Promise((res) => (junk.onopen = res));
  junk.send('bukan json');
  junk.send('{"t":"hack"}');
  await sleep(200);
  junk.close();
  const wrongPath = new WebSocket('ws://127.0.0.1:' + port + '/lain');
  const failed = await new Promise((res) => {
    wrongPath.onerror = () => res(true);
    wrongPath.onopen = () => res(false);
  });
  assert.equal(failed, true, 'path WebSocket lain ditolak');

  console.log('SEMUA UJI ROOM LULUS');
  rooms.shutdown();
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('UJI ROOM GAGAL:', e);
  process.exit(1);
});
