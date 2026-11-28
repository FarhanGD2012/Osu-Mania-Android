'use strict';
// Uji cepat: node test.js   (butuh paket argon2 terpasang: npm install)
const assert = require('node:assert/strict');
const { createApp } = require('./server');

(async () => {
  const { server, client } = await createApp({ dbUrl: ':memory:' });
  const dbGet = async (sql, args) => {
    const r = await client.execute({ sql, args: args || [] });
    const o = {};
    r.columns.forEach((c, i) => (o[c] = r.rows[0][i]));
    return o;
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, json: ct.includes('json') ? await res.json() : null, buf: ct.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  };

  // --- daftar & masuk ---
  let r = await call('POST', '/api/register', { username: 'Alice', password: 'rahasia123' });
  assert.equal(r.status, 200);
  const tA = r.json.token;
  const idA = r.json.user.id;
  const stored = (await dbGet('SELECT password_hash FROM users WHERE id = ?', [idA])).password_hash;
  assert.ok(!stored.includes('rahasia123'), 'sandi tidak boleh tersimpan polos');
  assert.ok(stored.startsWith('$argon2id$'), 'harus hash Argon2id: ' + stored);
  r = await call('POST', '/api/register', { username: 'alice', password: 'lainnya123' });
  assert.equal(r.status, 409, 'nama tidak boleh kembar (tanpa beda huruf besar/kecil)');
  r = await call('POST', '/api/register', { username: 'x', password: 'rahasia123' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/register', { username: 'Bobby', password: '123' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/login', { username: 'Alice', password: 'salah-salah' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'ALICE', password: 'rahasia123' });
  assert.equal(r.status, 200);
  r = await call('POST', '/api/login', { username: 'tidak-ada', password: 'rahasia123' });
  assert.equal(r.status, 401);
  r = await call('GET', '/api/me');
  assert.equal(r.status, 401);
  r = await call('GET', '/api/me', null, tA);
  assert.equal(r.json.user.username, 'Alice');

  r = await call('POST', '/api/register', { username: 'Bobby', password: 'sandibobby' });
  const tB = r.json.token;
  const idB = r.json.user.id;

  // --- PP hanya sekali per map per akun ---
  r = await call('POST', '/api/scores', { map_id: 'osu:111', map_title: 'Lagu A', score: 800000, accuracy: 95.5, max_combo: 300, pp: 120.5, stars: 3.2 }, tA);
  assert.equal(r.status, 200);
  assert.equal(r.json.first_clear, true);
  assert.equal(r.json.pp_awarded, 120.5);
  assert.equal(r.json.total_pp, 120.5);
  r = await call('POST', '/api/scores', { map_id: 'osu:111', map_title: 'Lagu A', score: 950000, accuracy: 99, max_combo: 400, pp: 300 }, tA);
  assert.equal(r.json.first_clear, false);
  assert.equal(r.json.already_claimed, true);
  assert.equal(r.json.pp_awarded, 0);
  assert.equal(r.json.total_pp, 120.5, 'tamat ulang tidak boleh menambah PP');
  assert.equal(r.json.new_best, true);
  assert.equal(r.json.best_score, 950000);
  r = await call('POST', '/api/scores', { map_id: 'osu:111', map_title: 'Lagu A', score: 100000, accuracy: 50, max_combo: 10, pp: 999 }, tA);
  assert.equal(r.json.new_best, false);
  assert.equal(r.json.best_score, 950000, 'skor lebih rendah tidak menimpa rekor');
  assert.equal((await dbGet('SELECT COUNT(*) n FROM map_completions WHERE user_id = ?', [idA])).n, 1);
  assert.equal((await dbGet('SELECT COUNT(*) n FROM scores WHERE user_id = ? AND map_id = ?', [idA, 'osu:111'])).n, 1);

  await call('POST', '/api/scores', { map_id: 'osu:222', map_title: 'Lagu B', score: 700000, accuracy: 90, max_combo: 200, pp: 80, stars: 5.5 }, tA);
  await call('POST', '/api/scores', { map_id: 'osu:111', map_title: 'Lagu A', score: 990000, accuracy: 99.5, max_combo: 420, pp: 150 }, tB);
  r = await call('POST', '/api/scores', { map_id: 'osu:111', score: 2000000, accuracy: 99, pp: 1 }, tB);
  assert.equal(r.status, 400);
  r = await call('POST', '/api/scores', { map_id: 'osu:333', map_title: 'Cheat', score: 1000, accuracy: 50, max_combo: 1, pp: 99999999 }, tB);
  assert.equal(r.json.pp_awarded, 2000, 'PP dibatasi server');

  // --- leaderboard ---
  r = await call('GET', '/api/leaderboard/map/osu:111', null, tA);
  assert.equal(r.json.entries.length, 2, 'satu baris per pemain per map');
  assert.equal(r.json.entries[0].username, 'Bobby');
  assert.equal(r.json.entries[1].username, 'Alice');
  assert.equal(r.json.entries[1].pp, 120.5);
  assert.equal(r.json.me.rank, 2);
  r = await call('GET', '/api/leaderboard/map/osu:111?sort=pp');
  assert.equal(r.json.entries[0].username, 'Bobby');
  r = await call('GET', '/api/leaderboard/global', null, tA);
  assert.equal(r.json.entries[0].username, 'Bobby');
  assert.equal(r.json.entries[0].pp, 2150);
  assert.equal(r.json.entries[1].username, 'Alice');
  assert.equal(r.json.entries[1].pp, 200.5);
  assert.equal(r.json.me.rank, 2);
  assert.ok(r.json.entries[1].achieved_at > 0);

  // --- cari pemain, teman, profil ---
  r = await call('GET', '/api/users/search?q=bob', null, tA);
  assert.equal(r.json.users.length, 1);
  assert.equal(r.json.users[0].relation, 'none');
  r = await call('GET', '/api/users/search?q=%25', null, tA);
  assert.equal(r.json.users.length, 0, 'karakter % tidak boleh jadi wildcard');
  r = await call('POST', '/api/friends/request', { user_id: idB }, tA);
  assert.equal(r.json.relation, 'outgoing');
  r = await call('GET', '/api/friends', null, tB);
  assert.equal(r.json.incoming.length, 1);
  assert.equal(r.json.incoming[0].username, 'Alice');
  r = await call('GET', '/api/users/' + idA, null, tB);
  assert.equal(r.json.user.relation, 'incoming');
  r = await call('POST', '/api/friends/accept', { user_id: idA }, tB);
  assert.equal(r.json.relation, 'friend');
  r = await call('GET', '/api/friends', null, tA);
  assert.equal(r.json.friends.length, 1);
  r = await call('GET', '/api/users/' + idB, null, tA);
  assert.equal(r.json.user.relation, 'friend');
  assert.equal(r.json.user.global_rank, 1);
  assert.equal(r.json.user.maps_cleared, 2);
  assert.ok(r.json.user.recent.length >= 1);
  r = await call('POST', '/api/friends/request', { user_id: idA }, tA);
  assert.equal(r.status, 400);
  r = await call('POST', '/api/friends/remove', { user_id: idB }, tA);
  assert.equal(r.json.relation, 'none');

  r = await call('GET', '/api/users/' + idA, null, tA);
  assert.equal(r.json.user.hardest.title, 'Lagu B', 'map tersulit = bintang tertinggi');
  assert.equal(r.json.user.hardest.stars, 5.5);
  assert.equal(r.json.user.best_accuracy, 99);
  assert.equal(r.json.user.max_combo, 400);
  assert.ok(r.json.user.total_score > 0);

  // --- profil, avatar, sandi ---
  r = await call('POST', '/api/me/profile', { bio: 'halo dunia' }, tA);
  assert.equal(r.json.user.bio, 'halo dunia');
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/users/' + idA + '/avatar');
  assert.equal(r.status, 200);
  assert.equal(r.buf.length, fakeJpeg.length);
  r = await call('POST', '/api/me/avatar', { jpeg_base64: Buffer.alloc(500, 1).toString('base64') }, tB);
  assert.equal(r.status, 400, 'bukan JPEG ditolak');

  // --- batas ganti foto: maksimal 1x per 7 hari (dicatat di database) ---
  const DAY = 86400000;
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA);
  assert.equal(r.status, 429, 'ganti foto kedua dalam 7 hari harus ditolak');
  assert.equal(r.json.error, 'avatar_dibatasi');
  assert.match(r.json.message, /7 hari/);
  assert.match(r.json.message, /WIB/);
  assert.ok(r.json.retry_at > Date.now() + 6 * DAY && r.json.retry_at <= Date.now() + 7 * DAY, 'retry_at ~7 hari lagi');
  assert.ok(r.json.retry_after_seconds > 6 * 86400);
  assert.ok(r.json.message.includes('6 hari 23 jam') || r.json.message.includes('7 hari'), 'sisa waktu tampil: ' + r.json.message);
  r = await call('GET', '/api/me', null, tA);
  assert.ok(r.json.user.avatar_next_change_at > Date.now(), '/api/me memberi tahu kapan boleh ganti lagi');
  // hapus foto selalu boleh, dan TIDAK membuka kunci
  r = await call('POST', '/api/me/avatar', { remove: true }, tA);
  assert.equal(r.status, 200);
  assert.equal(r.json.avatar_at, 0);
  r = await call('GET', '/api/users/' + idA + '/avatar');
  assert.equal(r.status, 404, 'foto sudah terhapus');
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA);
  assert.equal(r.status, 429, 'hapus lalu unggah tidak boleh menembus batas 7 hari');
  // dua unggahan bersamaan setelah genap 7 hari: hanya satu yang lolos (atomik di database)
  await client.execute({ sql: 'UPDATE users SET avatar_changed_at = ? WHERE id = ?', args: [Date.now() - 7 * DAY - 1000, idA] });
  const both = await Promise.all([
    call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA),
    call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA),
  ]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 429], 'balapan: tepat satu yang berhasil');
  // belum genap 7 hari (kurang 1 menit) tetap ditolak, dan pesan menyebut sisa waktu
  await client.execute({ sql: 'UPDATE users SET avatar_changed_at = ? WHERE id = ?', args: [Date.now() - 7 * DAY + 60000, idA] });
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tA);
  assert.equal(r.status, 429);
  assert.match(r.json.message, /(kurang dari semenit|1 menit)/);
  // foto lama (sebelum fitur ini) dihitung dari avatar_at saat migrasi: pemain baru yang belum pernah unggah boleh langsung
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tB);
  assert.equal(r.status, 200, 'unggahan pertama selalu boleh');
  r = await call('POST', '/api/me/avatar', { jpeg_base64: fakeJpeg.toString('base64') }, tB);
  assert.equal(r.status, 429);
  // Retry-After ikut dikirim
  const raw = await fetch(base + '/api/me/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tB }, body: JSON.stringify({ jpeg_base64: fakeJpeg.toString('base64') }) });
  assert.equal(raw.status, 429);
  assert.ok(Number(raw.headers.get('retry-after')) > 6 * 86400, 'header Retry-After');

  // --- penguncian login (tersimpan di database) ---
  for (let i = 0; i < 8; i++) {
    r = await call('POST', '/api/login', { username: 'Alice', password: 'salah-' + i });
    assert.equal(r.status, 401);
  }
  r = await call('POST', '/api/login', { username: 'Alice', password: 'baruuuuu1' });
  assert.equal(r.status, 429, 'setelah 8 gagal, bahkan sandi benar ditolak sementara');
  assert.equal(r.json.error, 'login_terkunci');
  assert.match(r.json.message, /menit/);
  const lockRows = await dbGet('SELECT COUNT(*) n FROM auth_fails');
  assert.ok(lockRows.n >= 3, 'hitungan gagal ada di tabel database (tahan restart)');
  await client.execute('DELETE FROM auth_fails');
  r = await call('GET', '/api/whoami');
  assert.equal(r.status, 200);
  assert.ok(r.json.ip);
  r = await call('POST', '/api/me/password', { old_password: 'salah', new_password: 'baruuuuu1' }, tA);
  assert.equal(r.status, 403);
  r = await call('POST', '/api/me/password', { old_password: 'rahasia123', new_password: 'baruuuuu1' }, tA);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/me', null, tA);
  assert.equal(r.status, 401, 'sesi lama dicabut setelah ganti sandi');
  r = await call('POST', '/api/login', { username: 'Alice', password: 'baruuuuu1' });
  assert.equal(r.status, 200);

  // --- hapus akun ---
  r = await call('POST', '/api/me/delete', { password: 'salah' }, tB);
  assert.equal(r.status, 403);
  r = await call('POST', '/api/me/delete', { password: 'sandibobby' }, tB);
  assert.equal(r.status, 200);
  r = await call('GET', '/api/leaderboard/map/osu:111');
  assert.equal(r.json.entries.length, 1, 'skor akun terhapus ikut hilang');
  assert.equal((await dbGet('SELECT COUNT(*) n FROM map_completions WHERE user_id = ?', [idB])).n, 0);
  assert.equal((await dbGet('SELECT COUNT(*) n FROM users WHERE id = ?', [idB])).n, 0);
  assert.equal((await dbGet('SELECT COUNT(*) n FROM friendships')).n, 0);

  console.log('SEMUA UJI LULUS');
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('UJI GAGAL:', e);
  process.exit(1);
});
