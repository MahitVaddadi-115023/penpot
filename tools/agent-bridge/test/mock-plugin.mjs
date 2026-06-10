#!/usr/bin/env node
// mock-plugin.mjs — a fake Penpot plugin iframe that answers tool calls.
//
// Modes:
//   echo (default) — every tool returns { echoed: input, tool: name }
//   ignore         — never reply (use for T9 timeout test)
//   shapes         — return a stub shape list for penpot.list_shapes;
//                    everything else echoes.
//
// Usage:
//   node mock-plugin.mjs [--mode=echo|ignore|shapes] [--url=ws://localhost:9010/ws]
//
// Quiet, single-line logs to stderr so tests can read stdout for ack lines.

import { WsClient } from './ws-client.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const mode = String(args.mode || 'echo');
const url  = String(args.url  || 'ws://localhost:9010/ws');

const ws = new WsClient();

ws.on('message', (msg) => {
  if (!msg || msg.type !== 'tool') return;
  process.stderr.write(`[mock] got tool name=${msg.name} id=${msg.id} mode=${mode}\n`);

  if (mode === 'ignore') return;

  let result;
  if (mode === 'shapes' && msg.name === 'list_shapes') {
    result = {
      page: 'home',
      pageMatched: true,
      shapes: [
        { id: 'test-1', name: 'test-rect', type: 'rectangle', x: 0, y: 0, w: 100, h: 50 },
      ],
    };
  } else {
    result = { echoed: msg.input, tool: msg.name };
  }

  ws.send({ type: 'tool.result', id: msg.id, ok: true, result });
});

ws.on('error', (e) => process.stderr.write(`[mock] ws error: ${e.message}\n`));
ws.on('close', () => { process.stderr.write('[mock] ws closed\n'); process.exit(0); });

await ws.connect(url);
process.stderr.write(`[mock] connected to ${url} mode=${mode}\n`);
process.stdout.write('READY\n');

// Run until killed (sigterm/sigint).
process.on('SIGINT',  () => { ws.close(); process.exit(0); });
process.on('SIGTERM', () => { ws.close(); process.exit(0); });
// Keep alive — readline-style block.
setInterval(() => {}, 1 << 30);
