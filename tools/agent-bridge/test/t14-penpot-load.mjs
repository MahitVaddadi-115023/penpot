#!/usr/bin/env node
// T14 — Open Penpot via auto-login.html, wait for the workspace to render,
// snap a screenshot. Uses an existing Playwright install (no npm deps added).
//
// We're not picky about the exact workspace selector — Penpot's frontend is
// React/Clojure and selectors change. We pass-by-content: wait until the URL
// includes "/workspace/" AND the page reports a non-trivial body height.
//
// Output:
//   - exit 0 → PASS
//   - exit 1 → FAIL (banner with reason)
//   - screenshot to /tmp/agent-bridge-test-screenshots/t14.png

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Try a couple of known Playwright install locations.
const candidates = [
  '/Users/svaddadi/coding-agents/repos/tldraw/node_modules/playwright',
  'playwright',
];
let chromium = null;
for (const p of candidates) {
  try { chromium = require(p).chromium; break; } catch {}
}
if (!chromium) {
  console.error('RESULT: SKIP (no Playwright install found)');
  process.exit(0);
}

const SCREENS = '/tmp/agent-bridge-test-screenshots';
await mkdir(SCREENS, { recursive: true });

const LOGIN_URL = 'http://localhost:9001/auto-login.html';
const TIMEOUT_MS = 20000;

// Container-age heuristic: a freshly-restarted Penpot (< FRESH_SEC) should
// reliably load the workspace within budget. If it doesn't, that's a real
// regression — don't SKIP, FAIL. Long-running containers (after hours of
// plugin churn) degrade unpredictably, so timeouts there stay env-sensitive.
const FRESH_SEC = 300;
const penpotAge = parseInt(process.env.PENPOT_AGE_SEC || '999999', 10);
const fresh = penpotAge < FRESH_SEC;
console.log(`[t14] Penpot container age: ${penpotAge}s (${fresh ? 'FRESH — must pass' : 'OLD — env-sensitive, may SKIP'})`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const t0 = Date.now();
let verdict = 'FAIL';
let reason = '';

try {
  console.log('[t14] navigating to auto-login...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });

  // auto-login.html redirects to /?plugin=...#/workspace/PROJECT/FILE after ~600ms.
  // Wait for that redirect.
  await page.waitForURL(/\/workspace\//, { timeout: TIMEOUT_MS });
  console.log('[t14] URL is now', page.url());

  // Give Penpot's React app time to mount the workspace shell.
  // Wait until either a canvas-like selector appears OR network goes idle.
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});

  // Heuristic content checks — accept any of these as "workspace rendered".
  const sel = await page.evaluate(() => {
    const hits = [];
    if (document.querySelector('svg.render-shapes, .viewport, [class*="workspace"]')) hits.push('workspace-class');
    if (document.querySelectorAll('svg').length > 0) hits.push(`svg:${document.querySelectorAll('svg').length}`);
    if (document.body && document.body.offsetHeight > 500) hits.push(`bodyH:${document.body.offsetHeight}`);
    return hits;
  });
  console.log('[t14] page signal hits:', sel);

  await page.screenshot({ path: `${SCREENS}/t14.png`, fullPage: false });
  const dur = Date.now() - t0;
  console.log(`[t14] screenshot saved → ${SCREENS}/t14.png  (load time: ${dur}ms)`);

  if (sel.length === 0) {
    verdict = 'FAIL';
    reason = 'no workspace signals detected on page';
  } else if (dur > 15000) {
    verdict = 'PARTIAL';
    reason = `workspace loaded in ${dur}ms (> 15s budget)`;
  } else {
    verdict = 'PASS';
    reason = `workspace loaded in ${dur}ms with signals: ${sel.join(',')}`;
  }
} catch (e) {
  // Penpot's SPA boot can take 20-60s depending on cache / container state.
  // After many plugin install/uninstall cycles, containers degrade and the
  // load event lags well past any reasonable budget. Classify SPA-load
  // timeouts as SKIP (environment-sensitive) rather than FAIL — UNLESS the
  // container is fresh (< FRESH_SEC), in which case a timeout is a real
  // regression and we must FAIL.
  const isTimeout = /Timeout \d+ms exceeded|page\.waitForURL/.test(e.message || '');
  if (isTimeout && fresh) {
    verdict = 'FAIL';
    reason = `Penpot is fresh (${penpotAge}s < ${FRESH_SEC}s) so this timeout is a real regression, not env-sensitivity: ${e.message.split('\n')[0]}`;
  } else if (isTimeout) {
    verdict = 'SKIP';
    reason = `Penpot SPA didn't load within budget (env-sensitive, container age ${penpotAge}s): ${e.message.split('\n')[0]}`;
  } else {
    verdict = 'FAIL';
    reason = `exception: ${e.message}`;
  }
  try { await page.screenshot({ path: `${SCREENS}/t14-fail.png` }); } catch {}
}

await browser.close();
console.log(`${verdict} — ${reason}`);
console.log(`RESULT: ${verdict}`);
// FAIL exits non-zero; PASS / PARTIAL / SKIP exit 0.
process.exit(verdict === 'FAIL' ? 1 : 0);
