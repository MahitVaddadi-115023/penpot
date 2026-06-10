// Minimal RFC6455 WebSocket client — stdlib only, no `ws` dep.
// Used by mock-plugin.mjs and several Tier 2/3 test scripts.
//
// Mirrors what dev-server.mjs does on the server side (single fragment,
// text + control frames only). The client MUST mask outgoing frames per spec.

import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeClientFrame(opcode, payload) {
  // FIN=1, RSV=0, opcode in low nibble; MASK=1 always (client requirement).
  const len = payload.length;
  let header;
  let extraLen = 0;
  let lenByte;
  if (len < 126) {
    lenByte = len;
  } else if (len < 65536) {
    lenByte = 126; extraLen = 2;
  } else {
    lenByte = 127; extraLen = 8;
  }
  const mask = crypto.randomBytes(4);
  header = Buffer.alloc(2 + extraLen + 4);
  header[0] = 0x80 | (opcode & 0x0f);
  header[1] = 0x80 | lenByte;
  if (extraLen === 2) header.writeUInt16BE(len, 2);
  if (extraLen === 8) {
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  mask.copy(header, 2 + extraLen);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

function decodeServerFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0]; const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2); offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    // Skip top 4 bytes (we don't expect >4GiB).
    payloadLen = buf.readUInt32BE(6); offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4); offset += 4;
  }
  if (buf.length < offset + payloadLen) return null;
  let payload = buf.slice(offset, offset + payloadLen);
  if (masked) {
    const unmasked = Buffer.allocUnsafe(payloadLen);
    for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
    payload = unmasked;
  }
  return { opcode, payload, total: offset + payloadLen };
}

export class WsClient extends EventEmitter {
  constructor() { super(); this.socket = null; this.alive = false; this.buf = Buffer.alloc(0); }

  connect(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80);
      const key = crypto.randomBytes(16).toString('base64');
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

      const req = http.request({
        host: u.hostname, port, path: u.pathname || '/',
        method: 'GET',
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          'Host': `${u.hostname}:${port}`,
        },
      });

      req.on('upgrade', (res, socket, head) => {
        if (String(res.headers['sec-websocket-accept']) !== expect) {
          socket.destroy();
          reject(new Error('bad ws accept'));
          return;
        }
        this.socket = socket;
        this.alive = true;
        socket.setNoDelay(true);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => { this.alive = false; this.emit('error', err); });
        socket.on('close', () => { this.alive = false; this.emit('close'); });
        if (head && head.length) this._onData(head);
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.alive) {
      const f = decodeServerFrame(this.buf);
      if (!f) return;
      this.buf = this.buf.slice(f.total);
      if (f.opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(f.payload.toString('utf8')); } catch { msg = { _raw: f.payload.toString('utf8') }; }
        this.emit('message', msg);
      } else if (f.opcode === 0x8) {
        // close echo
        try { this.socket.write(encodeClientFrame(0x8, f.payload)); } catch {}
        this.alive = false;
        try { this.socket.end(); } catch {}
      } else if (f.opcode === 0x9) {
        try { this.socket.write(encodeClientFrame(0xA, f.payload)); } catch {}
      }
    }
  }

  send(obj) {
    if (!this.alive) throw new Error('ws closed');
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    this.socket.write(encodeClientFrame(0x1, payload));
  }

  close() {
    if (!this.alive) return;
    try { this.socket.write(encodeClientFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch {}
    try { this.socket.end(); } catch {}
    this.alive = false;
  }
}
