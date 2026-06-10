#!/usr/bin/env node
// canvas-to-portfolio-server.mjs — HTTP shim around canvas-to-portfolio.mjs
//
// Listens on http://127.0.0.1:9007/ and exposes a small JSON surface that the
// Penpot live-preview plugin (live-preview-plugin/index.html) calls when the
// user clicks "Preview Sync" or "Sync to Source". Each endpoint spawns the
// sibling canvas-to-portfolio.mjs script and streams its stdout/stderr back in
// the response.
//
// Conventions match the other portfolio-sync background services
// (penpot-bridge, portfolio-watcher, webhook-server, live-preview-server):
//   PID  → /tmp/canvas-to-portfolio-server.pid
//   log  → /tmp/canvas-to-portfolio-server.log
//
// Zero npm deps — built-in `http`, `child_process`, `fs`, `path`, `url` only.
//
// Usage:
//   node canvas-to-portfolio-server.mjs            # foreground (dev)
//   node canvas-to-portfolio-server.mjs --detached # nohup itself into bg

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '127.0.0.1';
const PORT = 9007;
const PID_FILE = '/tmp/canvas-to-portfolio-server.pid';
const LOG_FILE = '/tmp/canvas-to-portfolio-server.log';
const SCRIPT = path.join(__dirname, 'canvas-to-portfolio.mjs');
const SNAPSHOT_SCRIPT = path.join(__dirname, 'snapshot.mjs');

const VALID_PAGES = new Set(['home', 'consulting', 'blog']);

// ─── --detached self-relaunch ────────────────────────────────────────────────
//
// If invoked with --detached, re-spawn ourselves with nohup into the
// background, write PID, and exit. Mirrors the pattern launch-all.sh uses
// for the other services so people can run the server directly too.
//
// We give the child ~700ms to either bind the port or die, then verify it is
// still alive before persisting the PID file. If it died (e.g. EADDRINUSE),
// we exit non-zero so launch-all.sh / users notice instead of leaving behind
// a stale PID pointing at a dead pid.
if (process.argv.includes('--detached')) {
  const args = process.argv.slice(1).filter((a) => a !== '--detached');
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  // Give the child a beat to bind the socket (or fail with EADDRINUSE).
  await new Promise((r) => setTimeout(r, 700));

  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }

  if (!alive) {
    console.error(
      `[canvas-to-portfolio-server] child PID ${child.pid} died on startup ` +
      `(see ${LOG_FILE}). Most likely cause: port ${PORT} already in use.`,
    );
    // Only remove the PID file if it actually points at the dead child.
    // Otherwise we'd be wiping a healthy older server's PID and stranding
    // it from `launch-all.sh stop-sync`.
    try {
      const existing = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (existing === String(child.pid)) fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`[canvas-to-portfolio-server] detached PID ${child.pid}`);
  console.log(`[canvas-to-portfolio-server] log: ${LOG_FILE}`);
  process.exit(0);
}

// ─── logging ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function log(msg) {
  console.log(`[canvas-to-portfolio-server] ${ts()} ${msg}`);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function readBody(req, limit = 1 << 20 /* 1 MiB */) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload =
    typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type':
      typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── child-process management ────────────────────────────────────────────────
//
// We track every spawned canvas-to-portfolio.mjs child so SIGTERM / SIGINT on
// the server propagates cleanly (no zombie child after hot reload).
const liveChildren = new Set();
const CHILD_TIMEOUT_MS = 120_000; // hard ceiling per spawn; protects mutex

/**
 * Spawn `node canvas-to-portfolio.mjs [args]`, capture stdout/stderr, resolve
 * with { ok, exitCode, stdout, stderr, durationMs }. Never rejects — converts
 * spawn errors into a `{ ok:false, exitCode:null, stderr:err.message }` shape
 * so the HTTP layer always returns structured JSON.
 *
 * Enforces CHILD_TIMEOUT_MS to keep the write-mutex from being held forever
 * if the child hangs.
 */
function runCanvasToPortfolio(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    if (!fs.existsSync(SCRIPT)) {
      finish({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `canvas-to-portfolio.mjs not found at ${SCRIPT} — has the parallel agent landed it yet?`,
        durationMs: Date.now() - started,
      });
      return;
    }

    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    liveChildren.add(child);

    const timer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${CHILD_TIMEOUT_MS}ms`;
      try { child.kill('SIGTERM'); } catch {}
      // Give it a brief grace period before SIGKILL.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, CHILD_TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      finish({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Spawn `node snapshot.mjs [args]` and capture stdout/stderr. Same contract as
 * runCanvasToPortfolio: never rejects; returns structured JSON.
 */
function runSnapshot(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    if (!fs.existsSync(SNAPSHOT_SCRIPT)) {
      finish({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `snapshot.mjs not found at ${SNAPSHOT_SCRIPT}`,
        durationMs: Date.now() - started,
      });
      return;
    }

    const child = spawn(process.execPath, [SNAPSHOT_SCRIPT, ...args], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    liveChildren.add(child);

    const timer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      finish({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Take a pre-sync snapshot. Returns { ok, snapshotId, error? }. We do NOT take
 * snapshots for dry-run /preview calls (they don't write), and we skip them on
 * /sync when dryRun=true for the same reason — keeps the snapshot list focused
 * on actually-destructive operations. Snapshot is serialized via snapshot.mjs's
 * own lockfile, but the server-side write-mutex already protects /sync so the
 * snapshot is only invoked while we own that mutex.
 */
async function takeSnapshot({ trigger, label }) {
  const args = ['save', '--trigger', trigger, '--label', label];
  const r = await runSnapshot(args, { timeoutMs: 30_000 });
  if (!r.ok) {
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || 'snapshot failed' };
  }
  const id = r.stdout.trim().split('\n').pop();
  if (!id) {
    return { ok: false, error: 'snapshot.mjs save returned no ID' };
  }
  return { ok: true, snapshotId: id };
}

// ─── write mutex ─────────────────────────────────────────────────────────────
//
// Two /sync calls in flight at once would race writing the same .astro files
// in the portfolio source tree. We serialize writes through a tiny promise
// chain. /preview is read-only (--dry-run) so it doesn't need the mutex.
let writeChain = Promise.resolve();
function withWriteLock(task) {
  const next = writeChain.then(task, task);
  // Swallow rejections on the chain itself so one failure doesn't break the
  // chain for subsequent callers. The caller still sees their own result.
  writeChain = next.catch(() => {});
  return next;
}

function parseSyncBody(buf) {
  if (!buf || buf.length === 0) return { page: null, dryRun: false };
  let payload;
  try { payload = JSON.parse(buf.toString('utf8')); } catch {
    throw new Error('Body is not valid JSON');
  }
  const page = payload && typeof payload.page === 'string' ? payload.page : null;
  if (page !== null && !VALID_PAGES.has(page)) {
    throw new Error(`Unknown page "${page}". Valid: ${[...VALID_PAGES].join(', ')}`);
  }
  const dryRun = !!(payload && payload.dryRun);
  return { page, dryRun };
}

function argsFor({ page, dryRun }) {
  const args = [];
  if (page) args.push('--page', page);
  if (dryRun) args.push('--dry-run');
  return args;
}

// ─── server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || '/').split('?')[0];

  try {
    if (req.method === 'GET' && url === '/healthz') {
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (url === '/' || url === '')) {
      return send(
        res,
        200,
        [
          'canvas-to-portfolio-server — Penpot canvas → portfolio HTML sync',
          '',
          'Endpoints:',
          '  GET  /healthz                   — liveness probe',
          '  POST /sync                      — run canvas-to-portfolio.mjs (writes files; auto pre-sync snapshot)',
          '  POST /preview                   — same, but always --dry-run (diff only, no snapshot)',
          '  GET  /snapshots                 — list snapshots (newest first)',
          '  POST /snapshots/restore         — body {id} — restore portfolio/src from snapshot',
          '  GET  /snapshots/diff/:id        — show what restoring would change',
          '',
          'Body (POST /sync, /preview): { "page"?: "home"|"consulting"|"blog", "dryRun"?: bool }',
          '',
          `Spawns: ${SCRIPT}`,
          `        ${SNAPSHOT_SCRIPT}`,
        ].join('\n'),
      );
    }

    if (req.method === 'POST' && (url === '/sync' || url === '/preview')) {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return send(res, 413, { ok: false, error: err.message });
      }

      let parsed;
      try {
        parsed = parseSyncBody(body);
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }

      // /preview is always dry-run, regardless of body.
      if (url === '/preview') parsed.dryRun = true;

      const args = argsFor(parsed);
      log(`${url} page=${parsed.page || '(all)'} dryRun=${parsed.dryRun}  → node canvas-to-portfolio.mjs ${args.join(' ')}`);

      // /preview is read-only (--dry-run); /sync writes files and must be
      // serialized to avoid two children stomping on the same .astro output.
      // We also take a pre-sync snapshot — but ONLY when this call will
      // actually write (i.e. /sync with dryRun=false). Dry-runs don't touch
      // the filesystem, so snapshotting them would just clutter the list and
      // burn the 10-snapshot budget on no-ops.
      const willWrite = url === '/sync' && !parsed.dryRun;
      if (willWrite) {
        const snap = await withWriteLock(async () => {
          const label = `before sync via plugin (page=${parsed.page || 'all'})`;
          return takeSnapshot({ trigger: 'pre-sync', label });
        });
        if (!snap.ok) {
          log(`${url} snapshot failed: ${snap.error}`);
          return send(res, 500, {
            ok: false,
            error: 'Refusing to sync — pre-sync snapshot failed',
            snapshotError: snap.error,
          });
        }
        const result = await withWriteLock(() => runCanvasToPortfolio(args));
        log(`${url} done exit=${result.exitCode} ms=${result.durationMs} snapshot=${snap.snapshotId}`);
        return send(res, 200, { ...result, snapshotId: snap.snapshotId });
      }

      const result =
        url === '/sync'
          ? await withWriteLock(() => runCanvasToPortfolio(args))
          : await runCanvasToPortfolio(args);
      log(`${url} done exit=${result.exitCode} ms=${result.durationMs}`);
      return send(res, 200, { ...result, snapshotId: null });
    }

    // ─── snapshot endpoints ────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/snapshots') {
      const r = await runSnapshot(['list', '--json'], { timeoutMs: 10_000 });
      if (!r.ok) {
        return send(res, 500, {
          ok: false, error: r.stderr.trim() || 'snapshot list failed',
        });
      }
      let list;
      try { list = JSON.parse(r.stdout || '[]'); }
      catch (err) {
        return send(res, 500, {
          ok: false, error: `snapshot.mjs list returned non-JSON: ${err.message}`, stdout: r.stdout,
        });
      }
      return send(res, 200, { ok: true, snapshots: list });
    }

    if (req.method === 'POST' && url === '/snapshots/restore') {
      let body;
      try { body = await readBody(req); }
      catch (err) { return send(res, 413, { ok: false, error: err.message }); }

      let payload = {};
      if (body && body.length) {
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { return send(res, 400, { ok: false, error: 'Body is not valid JSON' }); }
      }
      const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'Missing "id" in body' });
      // Basic shape check so we don't pass weird stuff to the CLI.
      if (!/^[0-9]+-[a-f0-9]+$/.test(id)) {
        return send(res, 400, { ok: false, error: `Invalid snapshot id format: ${id}` });
      }

      log(`/snapshots/restore id=${id}`);
      const r = await withWriteLock(() => runSnapshot(['restore', id], { timeoutMs: 60_000 }));
      log(`/snapshots/restore done exit=${r.exitCode} ms=${r.durationMs}`);
      return send(res, r.ok ? 200 : 500, {
        ok: r.ok,
        restored: r.ok,
        snapshotId: id,
        message: r.stdout.trim() || r.stderr.trim() || (r.ok ? 'restored' : 'restore failed'),
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
      });
    }

    if (req.method === 'GET' && url.startsWith('/snapshots/diff/')) {
      const id = decodeURIComponent(url.slice('/snapshots/diff/'.length));
      if (!/^[0-9]+-[a-f0-9]+$/.test(id)) {
        return send(res, 400, { ok: false, error: `Invalid snapshot id format: ${id}` });
      }
      const r = await runSnapshot(['diff', id], { timeoutMs: 20_000 });
      return send(res, r.ok ? 200 : 500, {
        ok: r.ok,
        snapshotId: id,
        diff: r.stdout,
        stderr: r.stderr,
      });
    }

    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    log(`UNHANDLED ${err.message}`);
    return send(res, 500, { ok: false, error: 'Internal server error', detail: err.message });
  }
});

server.on('error', (err) => {
  console.error(`[canvas-to-portfolio-server] server error: ${err.message}`);
});

server.listen(PORT, HOST, () => {
  // Write a PID file when running in foreground too, so `stop-sync` can find
  // us regardless of how we were started. (When --detached, the parent
  // already wrote the child's PID before exiting — but a second write here is
  // harmless because the foreground PID and the new-self PID are the same.)
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  log(`Listening on http://${HOST}:${PORT}`);
  log(`Spawn target: ${SCRIPT}`);
  log('');
  log('Endpoints:');
  log('  GET  /healthz                — liveness');
  log('  POST /sync                   — canvas → portfolio sync (auto pre-sync snapshot)');
  log('  POST /preview                — dry-run only (returns diff in stdout)');
  log('  GET  /snapshots              — list snapshots');
  log('  POST /snapshots/restore      — body {id} — restore portfolio/src');
  log('  GET  /snapshots/diff/:id     — preview restore');
});

// Keep process alive on stray errors so it survives weird requests.
process.on('uncaughtException', (err) => {
  console.error('[canvas-to-portfolio-server] uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[canvas-to-portfolio-server] unhandledRejection:', err);
});

// ─── graceful shutdown ───────────────────────────────────────────────────────
// Propagate SIGTERM/SIGINT to any in-flight canvas-to-portfolio.mjs children
// so a `kill $(cat /tmp/canvas-to-portfolio-server.pid)` (e.g. from
// `launch-all.sh stop-sync`) doesn't leak a half-written .astro file.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal} — stopping (${liveChildren.size} child(ren) in flight)`);
  for (const child of liveChildren) {
    try { child.kill('SIGTERM'); } catch {}
  }
  server.close(() => process.exit(0));
  // Backstop: don't hang forever if a child won't die.
  setTimeout(() => {
    for (const child of liveChildren) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── TEST PLAN ───────────────────────────────────────────────────────────────
//
// 1. Health check
//    $ curl -s http://127.0.0.1:9007/healthz
//    → {"ok": true}
//
// 2. Preview (dry-run) — exercises the spawn path end-to-end
//    $ curl -s -X POST http://127.0.0.1:9007/preview \
//          -H 'Content-Type: application/json' \
//          -d '{"page":"home"}'
//    Expected: 200 with JSON body:
//      {
//        "ok": true|false,
//        "exitCode": <number>,
//        "stdout": "<diff that canvas-to-portfolio.mjs would write>",
//        "stderr": "...",
//        "durationMs": <number>
//      }
//    `exitCode` reflects the spawned canvas-to-portfolio.mjs process; the
//    HTTP layer itself always returns 200 unless the body was malformed.
//
// 3. Sync (real write) — same shape, but actually writes the portfolio files
//    $ curl -s -X POST http://127.0.0.1:9007/sync \
//          -H 'Content-Type: application/json' \
//          -d '{}'
//
// 4. Bad page value → 400
//    $ curl -s -X POST http://127.0.0.1:9007/sync \
//          -H 'Content-Type: application/json' \
//          -d '{"page":"nope"}'
//    → {"ok": false, "error": "Unknown page \"nope\". ..."}
//
// 5. Plugin button (manual)
//    a. ./launch-all.sh canvas-export   # start this server detached
//    b. ./launch-all.sh live-preview    # serve the plugin UI on :9005
//    c. In Penpot: Plugin Manager → Add custom plugin → http://localhost:9005
//    d. Open the plugin panel, click "↑ Preview Sync"
//    e. Modal pops with the dry-run diff from canvas-to-portfolio.mjs stdout.
//    f. Click "✓ Sync to Source" — modal shows the real write result, button
//       briefly flashes a checkmark then reverts.
//
// 6. Cleanup
//    $ ./launch-all.sh stop-sync
//    → /tmp/canvas-to-portfolio-server.pid is removed and the process exits.
