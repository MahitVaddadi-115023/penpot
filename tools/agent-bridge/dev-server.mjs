#!/usr/bin/env node
// dev-server.mjs — Static server + tool-call proxy for the "Antigravity
// Bridge" Penpot plugin. Serves tools/agent-bridge/agent-plugin/ on
// http://localhost:9010/ so Penpot can register the plugin and the iframe
// can fetch its assets, AND brokers tool calls between newcore (HTTP, :3777)
// and the plugin iframe (WebSocket, /ws).
//
// Phase 1 (static) mirrors portfolio-sync/live-preview-server.mjs (zero npm
// deps, node stdlib only). Phase 3 (tool proxy) adds a tiny hand-rolled
// RFC6455 frame parser — no `ws` dep — because the surface is one client,
// text frames only, no extensions, no fragmentation. Total WS code is ~150
// LoC; pulling in `ws` would have been simpler but `npm ls -g ws` came back
// empty and we don't want to introduce a node_modules tree here.
//
// Port allocation:
//   portfolio-sync   -> 9005, 9006, 9007, 9090
//   agent-bridge     -> 9010 (this server: HTTP + WS /ws)
//
//   PID  → /tmp/agent-bridge-dev.pid (written by launch.sh, not this file)
//   log  → /tmp/agent-bridge-dev.log (redirected by launch.sh)
//
// Endpoints (see README.md "Tool Proxy" for full table):
//   GET  /                          — index.html
//   GET  /agent-plugin/*            — static plugin assets
//   GET  /<asset>                   — static plugin assets (root-relative)
//   GET  /health                    — { ok, pluginConnected, pendingTools }
//   POST /tool                      — { name, input, timeoutMs? } → { ok, result?|error? }
//   WS   /ws                        — bidirectional tool channel (single client)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_DIR = path.join(__dirname, 'agent-plugin');
const INDEX_FILE = path.join(PLUGIN_DIR, 'index.html');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 9010);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  // `text/javascript` is the spec-preferred type (HTML Living Standard) for
  // both classic and module scripts; some strict ESM loaders refuse anything
  // else. `application/javascript` also works in every browser today but we
  // pick the spec-preferred form so cross-origin module imports never trip.
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function safeResolve(reqPath) {
  // Strip query string, decode, then map "/" → index.html.
  let p = reqPath.split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  if (p === '/' || p === '') return INDEX_FILE;
  // Allow both "/agent-plugin/foo" (Penpot loads the manifest URL, then
  // resolves siblings relative to it) and "/foo" (when index.html is fetched
  // at the root because plugin.js calls penpot.ui.open with just '?theme=…').
  if (p.startsWith('/agent-plugin/')) p = p.slice('/agent-plugin'.length);
  // Prevent path traversal — resolve and confirm we stay under PLUGIN_DIR.
  const resolved = path.normalize(path.join(PLUGIN_DIR, p));
  if (!resolved.startsWith(PLUGIN_DIR)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// Tool proxy state
// ---------------------------------------------------------------------------
//
// Single-client by design — one Penpot plugin iframe is the only legit
// connector. A second connection replaces the first (and we log it). All
// in-flight tool calls indexed by request id; timeouts reject and clean up.

/** @type {WSClient | null} */
let activeClient = null;
/** @type {Map<string, { resolve: (v:any)=>void, reject:(e:Error)=>void, timer: any, name: string }>} */
const pendingTools = new Map();

function failAllPending(reason) {
  for (const [id, p] of pendingTools) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pendingTools.clear();
}

function dispatchToolFromClient(client, msg) {
  // Expected: { type: "tool.result", id, ok, result?, error? }
  if (!msg || msg.type !== 'tool.result' || typeof msg.id !== 'string') {
    console.warn('[agent-bridge] ws: ignoring malformed message:', msg && msg.type);
    return;
  }
  const pending = pendingTools.get(msg.id);
  if (!pending) {
    console.warn('[agent-bridge] ws: tool.result for unknown id', msg.id);
    return;
  }
  pendingTools.delete(msg.id);
  clearTimeout(pending.timer);
  pending.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error });
}

function callTool(name, input, timeoutMs) {
  if (!activeClient) {
    return Promise.resolve({ status: 503, body: { ok: false, error: 'no_plugin_connected' } });
  }
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingTools.has(id)) {
        pendingTools.delete(id);
        resolve({ status: 504, body: { ok: false, error: 'timeout' } });
      }
    }, Math.max(1, timeoutMs | 0));
    pendingTools.set(id, {
      name,
      timer,
      resolve: (payload) => resolve({ status: 200, body: payload }),
      reject: (err) => resolve({ status: 502, body: { ok: false, error: err.message || String(err) } }),
    });
    try {
      activeClient.send(JSON.stringify({ type: 'tool', id, name, input }));
    } catch (e) {
      pendingTools.delete(id);
      clearTimeout(timer);
      resolve({ status: 502, body: { ok: false, error: 'ws_send_failed: ' + (e && e.message) } });
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP server (static + /health + /tool)
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || '/';
  const pathOnly = url.split('?')[0];

  // ---- /health -----------------------------------------------------------
  if (pathOnly === '/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    const body = JSON.stringify({
      ok: true,
      pluginConnected: !!activeClient,
      pendingTools: pendingTools.size,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(body);
    return;
  }

  // ---- POST /tool --------------------------------------------------------
  if (pathOnly === '/tool') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    let aborted = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'body_too_large' }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (aborted) return;
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
        return;
      }
      const name = body && typeof body.name === 'string' ? body.name : null;
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing_name' }));
        return;
      }
      const input = body && Object.prototype.hasOwnProperty.call(body, 'input') ? body.input : {};
      const timeoutMs = (body && Number(body.timeoutMs)) || 10000;
      const { status, body: outBody } = await callTool(name, input, timeoutMs);
      const json = JSON.stringify(outBody);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        'Cache-Control': 'no-store',
      });
      res.end(json);
    });
    return;
  }

  // ---- Static files ------------------------------------------------------
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const filePath = safeResolve(url);
  if (!filePath) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found: ' + url);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.end(); } catch {} });
    stream.pipe(res);
  });
});

// ---------------------------------------------------------------------------
// WebSocket: hand-rolled RFC6455 (text frames only, server-side)
// ---------------------------------------------------------------------------
//
// Spec corners we implement:
//   - Handshake: Sec-WebSocket-Accept = base64(sha1(key + GUID))
//   - Server→client frames: unmasked, single fragment, opcode 0x1 (text) or 0x8 (close) / 0x9 (ping) / 0xA (pong)
//   - Client→server frames: MUST be masked; we unmask. Single fragment only.
//   - Payload length: 7-bit, 7+16 (0x7E + uint16), 7+64 (0x7F + uint64). We support all three.
//   - Close: respond to 0x8 with a 0x8 echo, then close the socket.
//   - Ping: respond with 0xA pong carrying the same payload.
// We don't implement: fragmentation (continuation frames), per-message-deflate,
// subprotocol negotiation, binary frames. The iframe-side client only sends
// short JSON messages, so this is fine in practice.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose('socket_closed'));
    socket.on('error', (err) => {
      console.warn('[agent-bridge] ws: socket error:', err && err.message);
      this._onClose('socket_error');
    });
  }

  send(text) {
    if (!this.alive) throw new Error('ws_closed');
    const payload = Buffer.from(text, 'utf8');
    const frame = encodeFrame(0x1, payload);
    this.socket.write(frame);
  }

  close(code = 1000, reason = '') {
    if (!this.alive) return;
    this.alive = false;
    try {
      const r = Buffer.from(reason, 'utf8');
      const body = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), r]);
      this.socket.write(encodeFrame(0x8, body));
    } catch {}
    try { this.socket.end(); } catch {}
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Loop because multiple frames may arrive in one TCP read.
    while (this.alive) {
      const parsed = decodeFrame(this.buffer);
      if (!parsed) return; // need more bytes
      this.buffer = this.buffer.slice(parsed.totalLen);
      this._handleFrame(parsed);
    }
  }

  _handleFrame(frame) {
    if (frame.opcode === 0x1) {
      // Text. We expect JSON.
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); }
      catch {
        console.warn('[agent-bridge] ws: non-JSON text frame, dropping');
        return;
      }
      dispatchToolFromClient(this, msg);
    } else if (frame.opcode === 0x8) {
      // Close.
      this.alive = false;
      try { this.socket.write(encodeFrame(0x8, frame.payload)); } catch {}
      try { this.socket.end(); } catch {}
    } else if (frame.opcode === 0x9) {
      // Ping → pong with same payload.
      try { this.socket.write(encodeFrame(0xA, frame.payload)); } catch {}
    } else if (frame.opcode === 0xA) {
      // Pong — ignore.
    } else {
      // Unsupported (binary, continuation, etc). Best-effort close.
      console.warn('[agent-bridge] ws: unsupported opcode 0x' + frame.opcode.toString(16));
      this.close(1003, 'unsupported_opcode');
    }
  }

  _onClose(reason) {
    if (!this.alive && activeClient !== this) return;
    this.alive = false;
    if (activeClient === this) {
      activeClient = null;
      failAllPending('plugin_disconnected:' + reason);
      console.log('[agent-bridge] ws: client disconnected (' + reason + ')');
    }
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    // Node Buffer has no UInt64BE writer pre-v12; use BigInt or split.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    if (hi !== 0) {
      // > 4 GiB. We refuse — sanity cap.
      throw new Error('frame too large');
    }
    payloadLen = lo;
    offset += 8;
  }
  if (!masked) {
    // Per spec the client MUST mask. Refuse.
    throw new Error('client frame not masked');
  }
  if (buf.length < offset + 4 + payloadLen) return null;
  const mask = buf.slice(offset, offset + 4);
  offset += 4;
  const masked_payload = buf.slice(offset, offset + payloadLen);
  const payload = Buffer.allocUnsafe(payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] = masked_payload[i] ^ mask[i & 3];
  return { fin, opcode, payload, totalLen: offset + payloadLen };
}

server.on('upgrade', (req, socket, head) => {
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const ver = req.headers['sec-websocket-version'];
  if (!key || String(ver) !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
  socket.setNoDelay(true);

  // Single-client invariant — replace any prior client.
  if (activeClient) {
    console.warn('[agent-bridge] ws: replacing existing client (only one iframe expected)');
    failAllPending('plugin_replaced');
    try { activeClient.close(1000, 'replaced'); } catch {}
    activeClient = null;
  }
  const client = new WSClient(socket);
  activeClient = client;
  console.log('[agent-bridge] ws: client connected');

  // Drain head (unlikely to have any payload at upgrade time, but be safe).
  if (head && head.length) client._onData(head);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

server.on('error', (err) => {
  console.error('[agent-bridge] server error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`[agent-bridge] port ${PORT} already in use — refusing to start.`);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[agent-bridge] serving:   ${PLUGIN_DIR}`);
  console.log(`[agent-bridge] manifest:  http://${HOST}:${PORT}/agent-plugin/manifest.json`);
  console.log(`[agent-bridge] tool:      POST http://${HOST}:${PORT}/tool`);
  console.log(`[agent-bridge] health:    GET  http://${HOST}:${PORT}/health`);
  console.log(`[agent-bridge] ws:        ws://${HOST}:${PORT}/ws`);
});

// Keep process alive on stray errors so it survives weird requests.
process.on('uncaughtException', (err) => {
  console.error('[agent-bridge] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[agent-bridge] unhandledRejection:', err);
});
