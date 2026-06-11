#!/usr/bin/env node
// register-plugins.mjs — Programmatically register every Antigravity Bridge
// plugin in the user's Penpot profile so they don't have to paste manifest
// URLs into Plugin Manager.
//
// Uses Playwright to:
//   1) Open auto-login.html (parallel instance's auth handshake)
//   2) Wait for the workspace cookies to settle
//   3) Call get-profile RPC to read existing :plugins prop
//   4) Merge our PLUGINS_TO_REGISTER (additive; doesn't replace existing)
//   5) Call update-profile-props RPC to persist
//
// Idempotent: re-running adds nothing new. start-stack.sh runs this as
// step 5b after install-into-penpot succeeds.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const PLAYWRIGHT_CANDIDATES = [
  '/Users/svaddadi/coding-agents/repos/tldraw/node_modules/playwright',
  'playwright',
];
let chromium = null;
for (const p of PLAYWRIGHT_CANDIDATES) {
  try { chromium = require(p).chromium; break; } catch {}
}
if (!chromium) {
  console.error('register-plugins: no Playwright install found (looked in tldraw + global).');
  console.error('Install: `cd ~/coding-agents/repos/tldraw && npm i playwright` (downloads chromium once).');
  process.exit(2);
}

const PENPOT = process.env.PENPOT_BASE || 'http://localhost:9001';

// PLUGINS_TO_REGISTER — additive merge into profile.props.plugins.
// `plugin-id` MUST be a stable UUID (Penpot's events.cljs parses it).
// `host` must match where the iframe is actually served.
const PLUGINS_TO_REGISTER = [
  {
    'plugin-id':   '9aebb000-aebb-4000-aebb-000000000001',  // stable UUID for agent-bridge
    'name':        'Antigravity Bridge',
    'description': 'Markup-DSL editor + AI agent chat panel for live Penpot canvas rendering.',
    'host':        'http://localhost:9010',                  // bridge dev-server (iframe + WS)
    'code':        'plugin.js',
    'url':         `${PENPOT}/plugins/agent-bridge/manifest.json`,
    'version':     2,
    'permissions': ['content:read', 'content:write', 'library:read'],
  },
  // Add more entries here. Each must include a stable UUID, host, code, url,
  // version, permissions. They'll be merged additively — duplicates by
  // plugin-id are kept (no overwrite). Example skeleton:
  //
  // {
  //   'plugin-id':   '<uuid-v4>',
  //   'name':        'My Plugin',
  //   'host':        'http://localhost:NNNN',
  //   'code':        'plugin.js',
  //   'url':         'http://.../manifest.json',
  //   'version':     2,
  //   'permissions': ['content:read'],
  // },
];

const TIMEOUT_MS = 60_000;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

try {
  console.log('[register] opening auto-login...');
  await page.goto(`${PENPOT}/auto-login.html`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

  // Poll page.url() rather than waitForURL('load') — Penpot's load lags 60-90s.
  let urlOk = false;
  for (let i = 0; i < 240; i++) {
    if (/\/workspace\//.test(page.url())) { urlOk = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!urlOk) throw new Error(`auto-login didn't reach /workspace/ in 60s (last: ${page.url()})`);
  console.log('[register] authenticated; merging plugins...');

  // Use Playwright's request API — inherits the auth cookies from the
  // browser context without racing with the page's own fetch lifecycle.
  const api = (cmd) => `${PENPOT}/api/rpc/command/${cmd}`;
  async function rpc(cmd, body) {
    const r = await ctx.request.post(api(cmd), {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      data: body,
    });
    if (!r.ok()) throw new Error(`${cmd} HTTP ${r.status()}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : {};
  }

  const profile = await rpc('get-profile', {});
  const existing = profile?.props?.plugins ?? { ids: [], data: {} };
  const ids = Array.isArray(existing.ids) ? [...existing.ids] : [];
  const data = (existing.data && typeof existing.data === 'object') ? { ...existing.data } : {};

  const added = [];
  const skipped = [];
  for (const p of PLUGINS_TO_REGISTER) {
    const id = p['plugin-id'];
    if (ids.includes(id)) { skipped.push(p.name); continue; }
    ids.push(id);
    data[id] = p;
    added.push(p.name);
  }

  if (added.length > 0) {
    await rpc('update-profile-props', { props: { plugins: { ids, data } } });
  }
  const result = { added, skipped, total: ids.length };

  console.log(`[register] added: ${result.added.join(', ') || '(none)'}`);
  console.log(`[register] already present: ${result.skipped.join(', ') || '(none)'}`);
  console.log(`[register] total plugins in profile now: ${result.total}`);

} finally {
  await browser.close();
}
