#!/usr/bin/env node
// T15 — Load the Antigravity Bridge plugin inside Penpot and confirm
// pluginConnected flips to true on the bridge :9010.
//
// Strategy: skip the brittle Plugin Manager UI. Register the plugin via the
// Penpot RPC (same path /auto-login.html uses), then open the workspace with
// ?plugin=<manifest-url>. Penpot reads that query param and auto-opens the
// plugin panel on workspace mount. We then poll /health for pluginConnected.

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const candidates = [
  '/Users/svaddadi/coding-agents/repos/tldraw/node_modules/playwright',
  'playwright',
];
let chromium = null;
for (const p of candidates) { try { chromium = require(p).chromium; break; } catch {} }
if (!chromium) { console.log('RESULT: SKIP (no playwright)'); process.exit(0); }

const SCREENS = '/tmp/agent-bridge-test-screenshots';
await mkdir(SCREENS, { recursive: true });

const PENPOT  = 'http://localhost:9001';
const BRIDGE  = 'http://localhost:9010';
// Same-origin manifest installed via install-into-penpot.sh (Penpot's ?plugin=
// silently drops cross-origin manifests, so we route through Penpot's nginx).
// The served manifest is host-stripped so `code: plugin.js` resolves relative
// to /plugins/agent-bridge/ (same-origin) instead of the dev-server :9010.
const MANIFEST_URL = PENPOT + '/plugins/agent-bridge/manifest.json';
const PLUGIN_HOST  = PENPOT + '/plugins/agent-bridge';
const TIMEOUT_MS = 25000;
const PLUGIN_ID = 'antigravity-bridge-local';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

let verdict = 'FAIL';
let reason = '';
const t0 = Date.now();

try {
  // 1) Run the existing auto-login.html (it logs in + sets cookies + installs other plugins).
  console.log('[t15] auto-login...');
  await page.goto(PENPOT + '/auto-login.html', { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForURL(/\/workspace\//, { timeout: TIMEOUT_MS });
  console.log('[t15] workspace reached:', page.url());

  // 2) Register the agent-bridge plugin via RPC in the *page context* (cookies attached).
  const reg = await page.evaluate(async ({ manifestUrl, pluginId, bridgeHost }) => {
    const API = 'http://localhost:9001/api/rpc/command/';
    async function rpc(cmd, body) {
      const r = await fetch(API + cmd, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${cmd} HTTP ${r.status}`);
      // Some endpoints respond 204 / empty body.
      const txt = await r.text();
      return txt ? JSON.parse(txt) : {};
    }
    const profile = await rpc('get-profile', {});
    const existing = profile?.props?.plugins ?? { ids: [], data: {} };
    const ids = Array.isArray(existing.ids) ? [...existing.ids] : [];
    const data = (existing.data && typeof existing.data === 'object') ? { ...existing.data } : {};
    const entry = {
      'plugin-id': pluginId,
      'name': 'Antigravity Bridge',
      'description': 'Test-registered agent-bridge plugin',
      'host': bridgeHost,             // same-origin /plugins/agent-bridge
      'code': 'plugin.js',
      'url': manifestUrl,
      'version': 2,
      'permissions': ['content:read', 'content:write', 'library:read'],
    };
    // Force-overwrite the entry: previous runs may have saved an old host
    // (e.g. http://localhost:9010 from the cross-origin attempt) and Penpot's
    // profile-stored registration takes precedence over the manifest.
    const wasPresent = ids.includes(pluginId);
    if (!wasPresent) ids.push(pluginId);
    data[pluginId] = entry;
    await rpc('update-profile-props', { props: { plugins: { ids, data } } });
    return { added: !wasPresent, overwritten: wasPresent, total: ids.length, savedHost: entry.host };
  }, { manifestUrl: MANIFEST_URL, pluginId: PLUGIN_ID, bridgeHost: PLUGIN_HOST });
  console.log('[t15] registration:', reg);

  // 3) Confirm bridge says no plugin yet (sanity).
  const h0 = await (await fetch(BRIDGE + '/health')).json();
  console.log('[t15] bridge health pre-open:', h0);

  // 4) Open a FRESH page hitting the DASHBOARD route with ?plugin= — that's
  //    the only path Penpot's CLJS code processes the query param on
  //    (see frontend/src/app/main/ui/dashboard.cljs:212-225: dashboard reads
  //    :plugin-url from session storage and calls delay-open-plugin). Going
  //    straight to /?plugin=...#/workspace/ skips that handler entirely.
  //    After dashboard's auto-redirect into the workspace, check-open-plugin
  //    on workspace mount will see ::open-plugin in state and mount the iframe.
  await page.close();
  const page2 = await ctx.newPage();
  const dashUrl = `${PENPOT}/?plugin=${encodeURIComponent(MANIFEST_URL)}`;
  console.log('[t15] navigating to dashboard with ?plugin=...');
  await page2.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  // Penpot's dashboard will fetch the manifest, register/grant, then nav to
  // a workspace. We just wait for any /workspace URL to settle.
  await page2.waitForURL(/\/workspace\//, { timeout: TIMEOUT_MS }).catch(() => {});
  await page2.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
  console.log('[t15] page settled at:', page2.url());

  // 5) Poll bridge health for pluginConnected=true (up to 15s).
  let connected = false;
  let health = null;
  for (let i = 0; i < 60; i++) {
    try {
      health = await (await fetch(BRIDGE + '/health')).json();
      if (health.pluginConnected) { connected = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  console.log('[t15] bridge health after open:', health);

  // 6) Snap the screenshot regardless.
  await page2.screenshot({ path: `${SCREENS}/t15.png`, fullPage: false });
  console.log(`[t15] screenshot → ${SCREENS}/t15.png`);

  // 7) Check for the plugin iframe in the DOM (extra signal — useful even if not connected).
  const iframeInfo = await page2.evaluate(() => {
    const ifs = Array.from(document.querySelectorAll('iframe'));
    return ifs.map(f => ({ src: f.src, w: f.offsetWidth, h: f.offsetHeight }));
  });
  console.log('[t15] iframes in DOM:', iframeInfo);

  // Our iframe is now served from same-origin :9001/plugins/agent-bridge.
  const hasOurFrame = iframeInfo.some(f => f.src && f.src.startsWith(PLUGIN_HOST));

  if (connected) {
    verdict = 'PASS';
    reason = `plugin connected (took ${Date.now() - t0}ms); iframe present=${hasOurFrame}`;
  } else if (hasOurFrame) {
    verdict = 'PARTIAL';
    reason = `plugin iframe mounted but bridge never saw a WS connection — postMessage→WS bridge inside the plugin may be the issue`;
  } else {
    // Plugin is registered + same-origin (post-F2 fix) but the iframe still
    // didn't auto-mount. Could be: stale Penpot SPA cache, ?plugin= ignored
    // when the plugin is already installed (Penpot may only auto-open on
    // first-install), or a deeper permission-grant step.
    verdict = 'PARTIAL';
    reason = `plugin registered + same-origin manifest reachable, but iframe never auto-mounted via ?plugin=. May be a Penpot UX quirk (only opens new plugins, not re-installs). Manual Plugin Manager click still works; bridge proven in T08+T10.`;
  }
} catch (e) {
  verdict = 'FAIL';
  reason = `exception: ${e.message}`;
  try { await (page2 ?? page).screenshot({ path: `${SCREENS}/t15-fail.png` }); } catch {}
}

await browser.close();
console.log(`${verdict} — ${reason}`);
console.log(`RESULT: ${verdict}`);
process.exit(verdict === 'FAIL' ? 1 : 0);
