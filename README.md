# Nova Beat server

Server akun + leaderboard + room multiplayer. Node.js 22.13+, database libSQL/Turso, tanpa framework.
Panduan lengkap langkah demi langkah: **../PANDUAN-NOVABEAT.md**.

## Berkas
- `server.js` – akun (Argon2id), sesi, profil, foto (maks 1x/7 hari), teman, leaderboard, pembatas laju
- `rooms.js` + `wsmini.js` – room multiplayer lewat WebSocket (`/ws/rooms`, daftar publik `GET /api/rooms`), tanpa paket tambahan
- `maintenance.js` – pembersihan + laporan ukuran database (`npm run maintain`)
- `test.js`, `test-rooms.js` – uji otomatis (`npm test`, `node test-rooms.js`)

## Variabel lingkungan
| Nama | Wajib | Keterangan |
|---|---|---|
| `TURSO_DATABASE_URL` | ya (produksi) | `libsql://nama-db-akun.turso.io` |
| `TURSO_AUTH_TOKEN` | ya (produksi) | token database dari Turso |
| `PORT` | otomatis | diisi hosting |
| `TRUST_PROXY` | ya di hosting | `1` bila di belakang proxy (Render) |
| `TRUST_PROXY_HOPS` | tidak | jumlah proxy tepercaya di depan server (bawaan 1). Cek dengan `GET /api/whoami` |
| `IP_HEADER` | tidak | mis. `cf-connecting-ip` bila hosting menyediakan header IP yang tak bisa dipalsukan |
| `NODE_VERSION` | Render | `22.13.0` |
| `ROOM_MAX_PLAYERS` | tidak | batas pemain per room (bawaan 16) |
| `ROOM_MAX_ROOMS` | tidak | batas room bersamaan (bawaan 60) |
| `ROOM_MAX_CONNECTIONS` | tidak | batas koneksi WebSocket (bawaan 300) |
| `DATA_DIR` | tidak | hanya untuk uji lokal tanpa Turso (file SQLite) |

## Endpoint tambahan di versi ini
- `POST /api/me/avatar` – `{jpeg_base64}` atau `{remove:true}`. Ganti foto maks 1x/7 hari → 429 `avatar_dibatasi` (`retry_at`, `retry_after_seconds`, header `Retry-After`). Hapus foto selalu boleh.
- `GET /api/me` kini memuat `avatar_next_change_at` (0 = boleh ganti sekarang).
- `GET /api/rooms` – daftar room publik. `GET /api/whoami` – IP yang dipakai pembatas laju.
- WebSocket `wss://<server>/ws/rooms` – pesan pertama `{t:"create"|"join", token, ...}`.
- Gagal login berulang → 429 `login_terkunci` (hitungan tersimpan di tabel `auth_fails`, tahan restart).

## Uji
```
npm install
npm test
node test-rooms.js
```
