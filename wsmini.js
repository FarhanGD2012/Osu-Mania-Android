'use strict';
/**
 * WebSocket server mini (RFC 6455) tanpa paket tambahan. Hanya yang dibutuhkan room multiplayer:
 * pesan teks (UTF-8), ping/pong, close, pecahan pesan (fragmen), batas ukuran, dan penolakan klien yang lambat.
 * Dipasang lewat acara 'upgrade' milik http.Server (lihat [accept]).
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BACKLOG = 1024 * 1024; // jika antrean kirim satu klien > 1 MB: putuskan (klien terlalu lambat)

class WsConn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frag = null; // { parts: Buffer[], size }
    this.closed = false;
    this.closeSent = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (c) => this._onData(c));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch (e) {
      /* sudah putus */
    }
    this.emit('close');
  }

  _write(op, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    if (this.socket.writableLength > MAX_BACKLOG) {
      this.terminate();
      return false;
    }
    this.socket.write(Buffer.concat([head, payload]));
    return true;
  }

  /** Kirim teks. Return false bila koneksi sudah tertutup. */
  send(text) {
    return this._write(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.alive = false;
    this._write(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._write(0x8, p);
    // beri waktu pesan penutup terkirim, lalu putus
    setTimeout(() => this._finish(), 500).unref();
  }

  terminate() {
    this._finish();
  }

  _fail(code) {
    this.close(code);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv !== 0 || !masked) return this._fail(1002); // klien wajib memakai mask
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this._fail(1009);
        len = b.readUInt32BE(6);
        off = 10;
      }
      if (len > this.maxPayload) return this._fail(1009);
      if (op >= 0x8 && (!fin || len > 125)) return this._fail(1002); // frame kontrol tidak boleh dipecah / besar
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op === 0x8) {
        this.close(1000);
        return;
      } else if (op === 0x9) {
        this._write(0xa, data);
      } else if (op === 0xa) {
        this.alive = true;
      } else if (op === 0x1 || op === 0x0) {
        if (op === 0x1) {
          if (this.frag) return this._fail(1002);
          this.frag = { parts: [], size: 0 };
        } else if (!this.frag) return this._fail(1002);
        this.frag.parts.push(data);
        this.frag.size += data.length;
        if (this.frag.size > this.maxPayload) return this._fail(1009);
        if (fin) {
          const full = Buffer.concat(this.frag.parts);
          this.frag = null;
          this.alive = true;
          this.emit('message', full.toString('utf8'));
        }
      } else {
        return this._fail(1003); // biner / opcode tak dikenal: tidak didukung
      }
      if (this.closed) return;
    }
  }
}

/** Selesaikan jabat tangan WebSocket pada [socket] dari acara 'upgrade'. Return WsConn, atau null (socket ditutup) bila permintaan tidak sah. */
function accept(req, socket, head, maxPayload) {
  const key = req.headers['sec-websocket-key'];
  const up = String(req.headers['upgrade'] || '').toLowerCase();
  if (up !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + accept, '', ''].join('\r\n'));
  const conn = new WsConn(socket, maxPayload);
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { accept, WsConn };
