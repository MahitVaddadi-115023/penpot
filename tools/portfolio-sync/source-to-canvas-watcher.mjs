#!/usr/bin/env node
/**
 * source-to-canvas-watcher.mjs
 *
 * V2 reverse-direction watcher. Watches the portfolio source tree and pushes
 * any changes into Penpot (via build-live-dom-canvas.mjs) so the canvas stays
 * in sync with the code-of-truth.
 *
 * Differs from portfolio-watcher.mjs in three ways:
 *   1. Tighter file-type filter — only .astro, .css, and .ts under src/.
 *      portfolio-watcher.mjs reacts to every src/ change (markdown, images,
 *      tooling) which floods the canvas with rebuilds when committing.
 *   2. Aggressive debounce (500ms vs 2000ms) — picks up edits while still
 *      typing without rebuilding mid-character.
 *   3. Always uses live-dom pipeline. No screenshot fallback.
 *
 * Conventions match the rest of portfolio-sync:
 *   - PID file:  /tmp/source-to-canvas-watcher.pid
 *   - Log file:  /tmp/source-to-canvas-watcher.log (when launched detached)
 *   - REPL ping at :4403 to skip rebuild when plugin is gone
 *   - Aborts if portfolio dev server is unreachable
 *
 * Usage:
 *   node ./source-to-canvas-watcher.mjs           # foreground
 *   ./launch-all.sh source-watcher                 # detached, via launcher
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'portfolio-sync.config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (err) {
    console.error(`[source-to-canvas-watcher] could not read ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
}

const cfg = readConfig();
const PORTFOLIO_DIR = cfg.portfolio_dir;
const WATCH_DIR     = path.join(PORTFOLIO_DIR, 'src');
const PORTFOLIO_URL = cfg.portfolio_local || 'http://localhost:4321';
const PIPELINE_SCRIPT = path.join(__dirname, 'build-live-dom-canvas.mjs');
const REPL_URL      = 'http://localhost:4403/execute';
const DEBOUNCE_MS   = 500;

// Only react to source-of-truth files. Astro pages, scoped/global CSS, the
// design tokens, and TS data files all affect what the canvas should show.
// Everything else (assets, configs, .lock files) is ignored.
const WATCH_EXT = /\.(astro|css|ts|js|mjs|md)$/i;

const PID_PATH = '/tmp/source-to-canvas-watcher.pid';

function ts() { return new Date().toTimeString().slice(0, 8); }
function log(msg) { console.log(`[source-to-canvas-watcher] ${ts()} ${msg}`); }

// ─── State ──────────────────────────────────────────────────────────────────

let debounceTimer    = null;
let pipelineRunning  = false;
let retryQueued      = false;
let lastFile         = null;

// ─── Health checks ──────────────────────────────────────────────────────────

async function checkRepl() {
  try {
    const res = await fetch(REPL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'return 1+1;' }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json.success === true;
  } catch { return false; }
}

async function checkPortfolio() {
  try {
    const res = await fetch(PORTFOLIO_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok || res.status < 500;
  } catch { return false; }
}

// ─── Pipeline runner ─────────────────────────────────────────────────────────

async function runPipeline() {
  if (pipelineRunning) {
    if (!retryQueued) {
      log('busy — will retry after current run completes');
      retryQueued = true;
    }
    return;
  }

  const replReady = await checkRepl();
  if (!replReady) {
    log('REPL at :4403 not responding — skipping this rebuild (Penpot plugin not connected).');
    return;
  }

  const portfolioUp = await checkPortfolio();
  if (!portfolioUp) {
    log(`portfolio dev server at ${PORTFOLIO_URL} not reachable — aborting rebuild.`);
    return;
  }

  log(`Spawning build-live-dom-canvas (trigger: ${lastFile || 'unknown'})...`);
  pipelineRunning = true;
  const child = spawn(process.execPath, [PIPELINE_SCRIPT], { stdio: 'inherit' });
  child.on('error', err => log(`pipeline spawn error: ${err.message}`));
  child.on('close', code => {
    pipelineRunning = false;
    log(`pipeline exited with code ${code}.`);
    if (retryQueued) {
      retryQueued = false;
      log('running queued trigger...');
      setTimeout(() => runPipeline(), 250);
    }
  });
}

// ─── Debounced trigger ───────────────────────────────────────────────────────

function schedulePipeline(filename) {
  lastFile = filename;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { runPipeline(); }, DEBOUNCE_MS);
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

function startWatcher() {
  if (!fs.existsSync(WATCH_DIR)) {
    log(`watch dir does not exist: ${WATCH_DIR}`);
    process.exit(1);
  }
  log(`watching ${WATCH_DIR}`);
  log(`extensions: ${WATCH_EXT.source}`);
  log(`debounce: ${DEBOUNCE_MS}ms`);

  fs.watch(WATCH_DIR, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const base = path.basename(filename);
    if (base.startsWith('.') || base.endsWith('~') || base.endsWith('.bak')) return;
    if (!WATCH_EXT.test(filename)) return;
    schedulePipeline(filename);
  });
}

// ─── PID file management ─────────────────────────────────────────────────────

function writePid() {
  try { fs.writeFileSync(PID_PATH, String(process.pid)); }
  catch (err) { log(`could not write PID file: ${err.message}`); }
}
function clearPid() {
  try { if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH); } catch {}
}
process.on('SIGTERM', () => { log('SIGTERM — exiting.'); clearPid(); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT — exiting.');  clearPid(); process.exit(0); });

// ─── Entry ────────────────────────────────────────────────────────────────────

writePid();
log(`PID: ${process.pid}`);
startWatcher();
