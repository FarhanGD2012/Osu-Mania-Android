'use strict';
/**
 * Pemeliharaan database Nova Beat (dijalankan manual, gratis):
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node maintenance.js            -> bersihkan + laporan ukuran
 *   ... node maintenance.js --vacuum                                          -> coba VACUUM (lihat catatan)
 *
 * Yang dilakukan:
 *  1. Hapus sesi kedaluwarsa dan hitungan gagal-masuk yang sudah lewat.
 *  2. Laporan: jumlah baris tiap tabel, jumlah & total ukuran foto profil, perkiraan ukuran file database.
 *  3. (--vacuum) Coba memadatkan file. Di Turso Cloud VACUUM bisa belum tersedia / eksperimental; bila ditolak, skrip hanya
 *     mencetak alasannya dan TIDAK mengubah apa pun. Menghapus baris tidak membuat database membengkak: SQLite memakai ulang
 *     halaman kosong, jadi VACUUM baru berguna setelah menghapus data BESAR (mis. ribuan foto sekaligus).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const SESSION_DAYS = 180;

(async () => {
  let url = process.env.TURSO_DATABASE_URL || '';
  if (!url) {
    const f = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'novabeat.db');
    if (!fs.existsSync(f)) {
      console.error('Tidak ada TURSO_DATABASE_URL dan tidak ada ./data/novabeat.db. Isi variabel Turso dulu.');
      process.exit(1);
    }
    url = 'file:' + f;
  }
  const c = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  const one = async (sql, args) => {
    const r = await c.execute({ sql, args: args || [] });
    return r.rows.length ? r.rows[0][0] : null;
  };
  const now = Date.now();

  const s = await c.execute({ sql: 'DELETE FROM sessions WHERE last_used < ?', args: [now - SESSION_DAYS * 86400000] });
  console.log('Sesi kedaluwarsa dihapus:', s.rowsAffected);
  try {
    const f = await c.execute({ sql: 'DELETE FROM auth_fails WHERE reset_at < ?', args: [now] });
    console.log('Hitungan gagal-masuk lama dihapus:', f.rowsAffected);
  } catch (e) {
    /* tabel belum ada: server belum pernah dijalankan dengan versi ini */
  }

  console.log('\nJumlah baris:');
  for (const t of ['users', 'sessions', 'scores', 'map_completions', 'friendships']) console.log('  ' + t.padEnd(16), await one('SELECT COUNT(*) FROM ' + t));
  const av = await c.execute('SELECT COUNT(*), COALESCE(SUM(LENGTH(avatar)), 0), COALESCE(MAX(LENGTH(avatar)), 0) FROM users WHERE avatar IS NOT NULL');
  const [n, bytes, max] = av.rows[0].map(Number);
  console.log(`\nFoto profil: ${n} foto, total ${(bytes / 1048576).toFixed(2)} MB, terbesar ${(max / 1024).toFixed(1)} KB (batas server 80 KB)`);
  try {
    const pages = Number(await one('PRAGMA page_count'));
    const size = Number(await one('PRAGMA page_size'));
    if (pages && size) console.log(`Perkiraan ukuran database: ${((pages * size) / 1048576).toFixed(2)} MB (jatah gratis Turso: 5 GB)`);
  } catch (e) {
    console.log('(PRAGMA page_count tidak tersedia di database ini; lihat ukuran di dashboard Turso)');
  }

  if (bytes > 1.5 * 1024 * 1024 * 1024) {
    console.log('\nPERINGATAN: foto profil sudah > 1,5 GB. Saatnya memisahkan foto ke tabel/database sendiri (lihat server/README.md).');
  }

  if (process.argv.includes('--vacuum')) {
    console.log('\nMencoba VACUUM…');
    try {
      await c.execute('VACUUM');
      console.log('VACUUM selesai.');
    } catch (e) {
      console.log('VACUUM ditolak oleh database ini (normal di Turso Cloud saat ini):', e.message);
      console.log('Tidak ada yang diubah. Alternatif: cadangkan lalu buat database baru dari dump (lihat server/README.md).');
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('Gagal:', e.message || e);
  process.exit(1);
});
