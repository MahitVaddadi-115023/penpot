#!/usr/bin/env node
// snapshot.mjs — portfolio/src snapshot + restore CLI.
//
// A durable safety net against accidental clobbering by the canvas-sync
// round-trip. Each snapshot is a directory under
//   ${XDG_STATE_HOME:-$HOME/.local/state}/portfolio-sync/snapshots/<unix-ts>-<short-sha>/
// containing a full recursive copy of portfolio/src/ plus a meta.json with
// { ts, label, trigger, fileCount, totalBytes, sha }.
//
// Zero npm deps. Node ≥ 18 (built-in `crypto`, `fs/promises`, `path`).
//
// Commands:
//   snapshot.mjs save [--label "<text>"] [--trigger pre-sync|manual|...]
//   snapshot.mjs list [--json]
//   snapshot.mjs restore <id>
//   snapshot.mjs diff <id> [path]
//   snapshot.mjs prune                       (keep newest 10; aggressive if >200MB)
//   snapshot.mjs purge --yes                 (delete ALL snapshots)
//
// Concurrent saves serialize via a lockfile in the state dir. Restores are
// atomic: stage to a tmp dir, verify md5 against the snapshot, then swap into
// place via rename. On any failure, the live source is left untouched.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'portfolio-sync.config.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const cfg = readConfig();

// Allow override via env (used by tests) so we don't touch real portfolio.
const PORTFOLIO_DIR =
  process.env.PORTFOLIO_DIR ||
  cfg.portfolio_dir ||
  '/Users/svaddadi/Documents/GitHub/websites/portfolio';
const SRC_DIR = process.env.PORTFOLIO_SRC_DIR || path.join(PORTFOLIO_DIR, 'src');

const STATE_HOME =
  process.env.SNAPSHOT_STATE_DIR ||
  process.env.XDG_STATE_HOME ||
  path.join(os.homedir(), '.local', 'state');
const STATE_DIR = process.env.SNAPSHOT_STATE_DIR
  ? process.env.SNAPSHOT_STATE_DIR
  : path.join(STATE_HOME, 'portfolio-sync', 'snapshots');

const LOCK_FILE = path.join(STATE_DIR, '.lock');

const KEEP_NEWEST = 10;
const HARD_SIZE_BUDGET = 200 * 1024 * 1024; // 200 MB

// ─── small utils ─────────────────────────────────────────────────────────────

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function shortSha(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTs(unixSec) {
  return new Date(unixSec * 1000).toISOString();
}

// ─── lockfile (cross-process mutex) ──────────────────────────────────────────
//
// We use exclusive O_CREAT|O_EXCL on a sentinel file. If acquisition fails we
// retry with backoff. The lock includes our PID so a stale lock from a crashed
// process can be cleaned up.
async function acquireLock({ timeoutMs = 30_000 } = {}) {
  await ensureDir(STATE_DIR);
  const start = Date.now();
  const me = `${process.pid}\n${new Date().toISOString()}\n`;
  while (true) {
    try {
      const fd = await fsp.open(LOCK_FILE, 'wx');
      await fd.write(me);
      await fd.close();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check stale: if PID inside doesn't exist, reclaim.
      try {
        const existing = await fsp.readFile(LOCK_FILE, 'utf8');
        const pid = parseInt(existing.split('\n')[0], 10);
        if (pid && !pidAlive(pid)) {
          await fsp.unlink(LOCK_FILE).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Could not acquire snapshot lock (${LOCK_FILE}) within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    }
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function releaseLock() {
  try { await fsp.unlink(LOCK_FILE); } catch {}
}

async function withLock(task) {
  await acquireLock();
  try { return await task(); } finally { await releaseLock(); }
}

// ─── recursive copy + manifest ───────────────────────────────────────────────
//
// We walk SRC_DIR, copy every regular file to <dest>/<relpath>, and as we go,
// build a manifest list of { rel, size, md5 }. The manifest is written into
// meta.json so `restore` can verify byte-for-byte after copy.

async function walkAndCopy(srcDir, destDir) {
  const manifest = [];
  let totalBytes = 0;

  async function walk(relRoot) {
    const absSrc = path.join(srcDir, relRoot);
    const entries = await fsp.readdir(absSrc, { withFileTypes: true });
    for (const e of entries) {
      const rel = path.join(relRoot, e.name);
      const absS = path.join(srcDir, rel);
      const absD = path.join(destDir, rel);
      if (e.isDirectory()) {
        await fsp.mkdir(absD, { recursive: true });
        await walk(rel);
      } else if (e.isFile()) {
        const data = await fsp.readFile(absS);
        await fsp.mkdir(path.dirname(absD), { recursive: true });
        await fsp.writeFile(absD, data);
        const md5 = crypto.createHash('md5').update(data).digest('hex');
        manifest.push({ rel, size: data.length, md5 });
        totalBytes += data.length;
      } else if (e.isSymbolicLink()) {
        const target = await fsp.readlink(absS);
        await fsp.symlink(target, absD);
        manifest.push({ rel, symlink: target });
      }
      // ignore sockets / fifos / device files (none expected in portfolio/src)
    }
  }

  await fsp.mkdir(destDir, { recursive: true });
  await walk('.');
  return { manifest, totalBytes };
}

// ─── snapshot operations ─────────────────────────────────────────────────────

async function listSnapshotDirs() {
  await ensureDir(STATE_DIR);
  const entries = await fsp.readdir(STATE_DIR, { withFileTypes: true });
  const snaps = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const meta = await readMeta(e.name);
    if (meta) snaps.push({ id: e.name, ...meta });
  }
  snaps.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return snaps;
}

async function readMeta(id) {
  const metaPath = path.join(STATE_DIR, id, 'meta.json');
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function dirSize(p) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) {
        try { total += (await fsp.stat(f)).size; } catch {}
      }
    }
  }
  await walk(p);
  return total;
}

async function rmSnapshot(id) {
  await fsp.rm(path.join(STATE_DIR, id), { recursive: true, force: true });
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdSave({ label, trigger }) {
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Source dir does not exist: ${SRC_DIR}`);
  }
  return withLock(async () => {
    // Stage to tmp under STATE_DIR so the move is on the same filesystem.
    await ensureDir(STATE_DIR);
    const stagingId = `.staging-${process.pid}-${Date.now()}`;
    const stagingDir = path.join(STATE_DIR, stagingId);
    let id;
    try {
      const { manifest, totalBytes } = await walkAndCopy(SRC_DIR, stagingDir);

      // Compute a deterministic short-sha over the manifest so identical
      // snapshots are visually identifiable. Different content → different sha.
      const manifestStr = JSON.stringify(
        manifest.map((m) => ({ rel: m.rel, md5: m.md5 || '', size: m.size || 0 })),
      );
      const sha = shortSha(manifestStr);
      const ts = Math.floor(Date.now() / 1000);
      id = `${ts}-${sha}`;

      const meta = {
        id,
        ts,
        tsIso: new Date(ts * 1000).toISOString(),
        label: label || '',
        trigger: trigger || 'manual',
        source: SRC_DIR,
        fileCount: manifest.filter((m) => !m.symlink).length,
        totalBytes,
        sha,
        manifest,
      };
      await fsp.writeFile(
        path.join(stagingDir, 'meta.json'),
        JSON.stringify(meta, null, 2),
      );

      const finalDir = path.join(STATE_DIR, id);
      // If an identical snapshot already exists, drop the staging copy and
      // surface the existing ID instead of clobbering it.
      if (fs.existsSync(finalDir)) {
        await fsp.rm(stagingDir, { recursive: true, force: true });
      } else {
        await fsp.rename(stagingDir, finalDir);
      }
    } catch (err) {
      await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    // Prune after every save to enforce the 10-snapshot ceiling.
    await pruneInternal();
    return id;
  });
}

async function cmdList({ json }) {
  const snaps = await listSnapshotDirs();
  if (json) {
    // Strip manifest from list view — it can be large.
    const slim = snaps.map(({ manifest, ...rest }) => rest);
    process.stdout.write(JSON.stringify(slim, null, 2) + '\n');
    return;
  }
  if (snaps.length === 0) {
    process.stdout.write('No snapshots.\n');
    return;
  }
  const rows = [['ID', 'TS', 'TRIGGER', 'FILES', 'SIZE', 'LABEL']];
  for (const s of snaps) {
    rows.push([
      s.id,
      s.tsIso || fmtTs(s.ts),
      s.trigger || '-',
      String(s.fileCount ?? '-'),
      fmtBytes(s.totalBytes || 0),
      s.label || '',
    ]);
  }
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => String(r[i]).length)),
  );
  const out = rows
    .map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  '))
    .join('\n');
  process.stdout.write(out + '\n');
}

async function cmdRestore(id) {
  if (!id) throw new Error('Usage: snapshot.mjs restore <id>');
  const snapDir = path.join(STATE_DIR, id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Snapshot not found: ${id}`);

  return withLock(async () => {
    // 1. Copy snapshot contents into a fresh tmp dir on the same fs as SRC.
    const portfolioParent = path.dirname(SRC_DIR);
    await fsp.mkdir(portfolioParent, { recursive: true });
    const stagingDir = await fsp.mkdtemp(
      path.join(portfolioParent, '.snapshot-restore-'),
    );
    try {
      await walkAndCopyFromSnapshot(snapDir, stagingDir);

      // 2. Verify md5 of every file in staging vs manifest.
      const mismatches = [];
      for (const m of meta.manifest || []) {
        if (m.symlink) continue;
        const abs = path.join(stagingDir, m.rel);
        let data;
        try { data = await fsp.readFile(abs); }
        catch (err) {
          mismatches.push({ rel: m.rel, error: err.message });
          continue;
        }
        const md5 = crypto.createHash('md5').update(data).digest('hex');
        if (md5 !== m.md5) {
          mismatches.push({ rel: m.rel, expected: m.md5, got: md5 });
        }
      }
      if (mismatches.length) {
        throw new Error(
          `Snapshot integrity check failed:\n${
            mismatches.slice(0, 5).map((m) => `  ${m.rel}: ${m.error || `${m.expected} vs ${m.got}`}`).join('\n')
          }${mismatches.length > 5 ? `\n  ...and ${mismatches.length - 5} more` : ''}`,
        );
      }

      // 3. Atomically swap: move SRC_DIR → backup, staging → SRC_DIR, delete backup.
      const backupDir = `${SRC_DIR}.pre-restore-${Date.now()}`;
      const hadOld = fs.existsSync(SRC_DIR);
      if (hadOld) await fsp.rename(SRC_DIR, backupDir);
      try {
        await fsp.rename(stagingDir, SRC_DIR);
      } catch (err) {
        // Rollback: put the original back.
        if (hadOld) {
          try { await fsp.rename(backupDir, SRC_DIR); } catch {}
        }
        throw err;
      }
      if (hadOld) {
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      }
      return { restored: id, fileCount: meta.fileCount, totalBytes: meta.totalBytes };
    } catch (err) {
      // Clean up staging on any failure before swap. (After swap, staging no
      // longer exists.)
      try { await fsp.rm(stagingDir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  });
}

async function walkAndCopyFromSnapshot(snapDir, destDir) {
  async function walk(rel) {
    const absS = path.join(snapDir, rel);
    const entries = await fsp.readdir(absS, { withFileTypes: true });
    for (const e of entries) {
      // Skip meta.json — it's metadata, not part of the source tree.
      if (rel === '.' && e.name === 'meta.json') continue;
      const relPath = path.join(rel, e.name);
      const absSrc = path.join(snapDir, relPath);
      const absDst = path.join(destDir, relPath);
      if (e.isDirectory()) {
        await fsp.mkdir(absDst, { recursive: true });
        await walk(relPath);
      } else if (e.isSymbolicLink()) {
        const target = await fsp.readlink(absSrc);
        await fsp.mkdir(path.dirname(absDst), { recursive: true });
        await fsp.symlink(target, absDst);
      } else if (e.isFile()) {
        const data = await fsp.readFile(absSrc);
        await fsp.mkdir(path.dirname(absDst), { recursive: true });
        await fsp.writeFile(absDst, data);
      }
    }
  }
  await fsp.mkdir(destDir, { recursive: true });
  await walk('.');
}

async function cmdDiff(id, filterPath) {
  if (!id) throw new Error('Usage: snapshot.mjs diff <id> [path]');
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Snapshot not found: ${id}`);
  const snapDir = path.join(STATE_DIR, id);
  const lines = [];
  lines.push(`# diff snapshot ${id} (${meta.tsIso}) → current ${SRC_DIR}`);
  lines.push(`# trigger=${meta.trigger || '-'}  label=${meta.label || ''}`);
  lines.push('');

  const inSnap = new Map();
  for (const m of meta.manifest || []) {
    if (!m.symlink) inSnap.set(m.rel, m);
  }

  // Walk current SRC_DIR.
  const currentFiles = new Set();
  if (fs.existsSync(SRC_DIR)) {
    async function walk(rel) {
      const abs = path.join(SRC_DIR, rel);
      let entries;
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const relPath = path.join(rel, e.name);
        if (e.isDirectory()) await walk(relPath);
        else if (e.isFile()) currentFiles.add(relPath);
      }
    }
    await walk('.');
  }

  function match(rel) {
    if (!filterPath) return true;
    return rel === filterPath || rel.startsWith(filterPath + path.sep);
  }

  // Files in snapshot.
  for (const [rel, m] of inSnap) {
    if (!match(rel)) continue;
    if (!currentFiles.has(rel)) {
      lines.push(`+ would-create  ${rel}  (${fmtBytes(m.size)})`);
      continue;
    }
    const cur = await fsp.readFile(path.join(SRC_DIR, rel));
    const curMd5 = crypto.createHash('md5').update(cur).digest('hex');
    if (curMd5 !== m.md5) {
      lines.push(`~ would-modify ${rel}  (current ${fmtBytes(cur.length)} → snapshot ${fmtBytes(m.size)})`);
    }
  }
  // Files only in current.
  for (const rel of currentFiles) {
    if (!match(rel)) continue;
    if (!inSnap.has(rel)) {
      lines.push(`- would-delete ${rel}`);
    }
  }

  if (lines.length <= 3) lines.push('(no differences)');
  process.stdout.write(lines.join('\n') + '\n');
}

async function pruneInternal() {
  const snaps = await listSnapshotDirs();
  // Keep newest KEEP_NEWEST.
  const survivors = snaps.slice(0, KEEP_NEWEST);
  const drop = snaps.slice(KEEP_NEWEST);
  for (const s of drop) await rmSnapshot(s.id);

  // Hard size cap: trim more if we're over budget.
  let total = await dirSize(STATE_DIR);
  if (total > HARD_SIZE_BUDGET) {
    // Drop oldest survivors until we're under budget (but always keep ≥3).
    let i = survivors.length - 1;
    while (i >= 3 && total > HARD_SIZE_BUDGET) {
      const victim = survivors[i];
      const vSize = await dirSize(path.join(STATE_DIR, victim.id));
      await rmSnapshot(victim.id);
      total -= vSize;
      i--;
    }
  }
}

async function cmdPrune() {
  await withLock(async () => {
    await pruneInternal();
  });
  const snaps = await listSnapshotDirs();
  process.stdout.write(`Pruned. ${snaps.length} snapshot(s) retained.\n`);
}

async function cmdPurge({ confirmed }) {
  if (!confirmed) {
    throw new Error('Refusing to purge without --yes flag.');
  }
  await withLock(async () => {
    const snaps = await listSnapshotDirs();
    for (const s of snaps) await rmSnapshot(s.id);
  });
  process.stdout.write('All snapshots deleted.\n');
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--yes') flags.yes = true;
    else if (a === '--label') flags.label = args[++i] || '';
    else if (a === '--trigger') flags.trigger = args[++i] || '';
    else if (a.startsWith('--label=')) flags.label = a.slice('--label='.length);
    else if (a.startsWith('--trigger=')) flags.trigger = a.slice('--trigger='.length);
    else positional.push(a);
  }
  return { flags, positional };
}

function usage() {
  return [
    'snapshot.mjs — portfolio/src snapshot/restore',
    '',
    'Commands:',
    '  save [--label <text>] [--trigger pre-sync|manual|...]',
    '  list [--json]',
    '  restore <id>',
    '  diff <id> [path]',
    '  prune',
    '  purge --yes',
    '',
    `State dir: ${STATE_DIR}`,
    `Source:    ${SRC_DIR}`,
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const cmd = argv[0];
  const { flags, positional } = parseFlags(argv.slice(1));

  switch (cmd) {
    case 'save': {
      const id = await cmdSave({ label: flags.label, trigger: flags.trigger });
      process.stdout.write(id + '\n');
      return 0;
    }
    case 'list': {
      await cmdList({ json: !!flags.json });
      return 0;
    }
    case 'restore': {
      const id = positional[0];
      const result = await cmdRestore(id);
      process.stdout.write(
        `Restored ${result.restored} (${result.fileCount} files, ${fmtBytes(result.totalBytes)})\n`,
      );
      return 0;
    }
    case 'diff': {
      const id = positional[0];
      const p = positional[1];
      await cmdDiff(id, p);
      return 0;
    }
    case 'prune': {
      await cmdPrune();
      return 0;
    }
    case 'purge': {
      await cmdPurge({ confirmed: !!flags.yes });
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${usage()}\n`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code || 0),
  (err) => {
    process.stderr.write(`snapshot.mjs: ${err.message}\n`);
    process.exit(1);
  },
);
