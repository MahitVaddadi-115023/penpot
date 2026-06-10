#!/usr/bin/env node
/**
 * canvas-to-portfolio.mjs
 *
 * Reverse half of the portfolio<->Penpot pipeline. Reads the current Penpot
 * canvas state via the MCP REPL plugin and writes any text-content edits back
 * into the corresponding `.astro` source files.
 *
 * V1 scope: text content only. No color, font, link href, or new-shape ingestion
 * (see V2 notes at bottom of this file).
 *
 * Match strategy: parse Penpot text shapes into a flat list of leaves with
 * normalized text. For each candidate `.astro` source file, walk the raw text,
 * skip frontmatter (`--- ... ---`), `<script>` and `<style>` blocks, and treat
 * every text run between tags (`>...<`) as a leaf. Match Penpot shapes against
 * source leaves using progressively looser criteria: exact normalized equality,
 * substring containment, then Levenshtein distance <= 5. Unmatched shapes are
 * logged but not errors — they may be shapes the user added by hand in Penpot.
 *
 * The forward pipeline (build-live-dom-canvas.mjs) ran the live Astro server
 * at http://localhost:4321 and harvested the rendered DOM, so what's on the
 * canvas reflects post-CSS-transform text (e.g. `text-transform: uppercase` is
 * applied, HTML entities are decoded, list-item bullets are prepended). The
 * matcher therefore normalizes both sides: decodes entities, strips leading
 * bullets and the "NN " numbering glyphs ul/ol shapes carry, lowercases for
 * comparison.
 *
 * Important: home board text lives in components imported by index.astro, not
 * in index.astro itself. We therefore scan every `.astro` file under
 * portfolio/src/ when looking for home-board matches. consulting.astro and
 * blog.astro are mostly self-contained so we look at them first for those
 * boards, and only fall back to the wider scan if needed.
 *
 * Flags:
 *   --dry-run                print diff to stdout, no writes
 *   --page <home|consulting|blog>  only sync that board
 *   --out-diff <path>        write unified diff to that path instead of editing
 *   (no flag)                write edits in place, with .bak backup per file
 *
 * Exit code is 0 even with unmatched shapes — they're not errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, 'portfolio-sync.config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

const cfg = readConfig();
const MCP_URL       = 'http://localhost:4401/mcp';
// Fallback: lightweight REPL bridge (used by penpot-bridge in newer versions).
// If MCP returns "no plugin connected" we retry against this endpoint.
const REPL_URL      = 'http://localhost:4403/execute';
const PORTFOLIO_DIR = cfg.portfolio_dir || '/Users/svaddadi/Documents/GitHub/websites/portfolio';
const SRC_DIR       = path.join(PORTFOLIO_DIR, 'src');

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const PAGE_IDX    = args.indexOf('--page');
const PAGE_PICK   = PAGE_IDX !== -1 ? args[PAGE_IDX + 1] : null;
const OUT_DIFF_IDX = args.indexOf('--out-diff');
const OUT_DIFF    = OUT_DIFF_IDX !== -1 ? args[OUT_DIFF_IDX + 1] : null;
// V2: offline path — load canvas state from a previously captured snapshot
// instead of hitting the live MCP / REPL. Lets us unit-test matchers when
// the Penpot plugin is disconnected. `--save-snapshot <path>` writes a
// captured canvas to disk for later replay.
const FROM_SNAP_IDX  = args.indexOf('--from-snapshot');
const FROM_SNAPSHOT  = FROM_SNAP_IDX !== -1 ? args[FROM_SNAP_IDX + 1] : null;
const SAVE_SNAP_IDX  = args.indexOf('--save-snapshot');
const SAVE_SNAPSHOT  = SAVE_SNAP_IDX !== -1 ? args[SAVE_SNAP_IDX + 1] : null;
// Loop 7: persistent last-sync state.
const STATE_DIR      = path.join(__dirname, 'state');
const LAST_SYNC_PATH = path.join(STATE_DIR, 'last-sync-snapshot.json');
const APPLY_DELETIONS = args.includes('--apply-deletions');

// ─── MCP plumbing (lifted from canvas-to-html.mjs / build-live-dom-canvas) ───

async function mcpInit() {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
                clientInfo: { name: 'canvas-to-portfolio', version: '1.0' } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`MCP init failed: ${res.status}`);
  const sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
  await res.text();
  if (!sid) throw new Error('no MCP session id');
  return sid;
}

async function mcpExec(sid, code) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sid },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'execute_code', arguments: { code } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  if (!line) throw new Error('MCP empty data frame');
  const parsed = JSON.parse(line.slice(6));
  const payload = parsed?.result?.content?.[0]?.text;
  if (!payload) {
    if (parsed?.result?.isError) throw new Error('MCP tool error: ' + JSON.stringify(parsed.result));
    throw new Error('MCP empty content: ' + JSON.stringify(parsed));
  }
  if (/^Tool execution failed/.test(payload)) throw new Error(payload);
  try { return JSON.parse(payload); } catch { return { raw: payload }; }
}

// REPL fallback: simpler HTTP wrapper around the plugin's eval bridge. Returns
// the same shape as mcpExec: a parsed object (`{ result: ... }` wrapper from
// MCP wraps the user-returned value at `result`). The REPL returns
// `{ success: bool, result: <user return value>, log: ... }` so we
// re-shape to `{ result: <user value> }` for compatibility with callers.
async function replExec(code) {
  const res = await fetch(REPL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error('REPL error: ' + (body.error || JSON.stringify(body)));
  }
  // Shape matches what mcpExec returns: the plugin code uses `return X;` and
  // we surface X under `result`.
  return { result: body.result };
}

// Try MCP first; if it reports "no plugin connected", retry via REPL.
async function bridgeExec(sid, code) {
  try {
    return await mcpExec(sid, code);
  } catch (e) {
    if (/No Penpot plugin instances are currently connected/i.test(e.message)) {
      return await replExec(code);
    }
    throw e;
  }
}

// ─── Canvas read: every board's text shapes, board-local coords ─────────────

async function readCanvas(sid) {
  const code = `
const cur = penpot.currentFile.pages.find(p => p.name === 'Page 1') || penpot.currentFile.pages[0];
if (!cur) return { error: 'no pages' };
if (penpot.currentPage.id !== cur.id) penpot.openPage(cur);

const ROOT_ID = '00000000-0000-0000-0000-000000000000';
const all = cur.findShapes();
const boards = all.filter(s => s.type === 'board' && s.id !== ROOT_ID
                                && s.parent && s.parent.id === ROOT_ID);

const out = [];
for (const b of boards) {
  const children = all.filter(s => s.parent && s.parent.id === b.id);
  const shapes = children
    .filter(s => s.type === 'text')
    .map(s => {
      let chars = null;
      try { chars = (typeof s.characters === 'string') ? s.characters : null; } catch (_) {}
      // Read fillColor (text fill). Penpot reports an array; first entry
      // is the primary fill. Tolerant to missing values.
      let fillColor = null;
      try {
        const fills = Array.isArray(s.fills) ? s.fills : null;
        if (fills && fills[0] && typeof fills[0].fillColor === 'string') {
          fillColor = fills[0].fillColor.toLowerCase();
        }
      } catch (_) {}
      // Try to parse link href from shape.name (format: "link: <href> ..." or
      // "link: <href>"; might also have suffix metadata like ¶anim:{...}).
      let link = null;
      try {
        const nm = s.name || '';
        const linkMatch = /^link:\\s*([^\\s¶]*)/.exec(nm);
        if (linkMatch) link = linkMatch[1] || '';
      } catch (_) {}
      return {
        id: s.id,
        name: s.name || '',
        // Board-local coords for stable logging — Penpot reports absolute.
        x: (s.x | 0) - (b.x | 0),
        y: (s.y | 0) - (b.y | 0),
        w: s.width | 0,
        h: s.height | 0,
        text: chars,
        fontSize: typeof s.fontSize === 'string' ? s.fontSize : null,
        fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily : null,
        fontWeight: typeof s.fontWeight === 'string' ? s.fontWeight : null,
        fillColor,
        link,
      };
    })
    .filter(s => s.text && s.text.trim().length > 0);
  out.push({
    id: b.id, name: b.name || 'board',
    x: b.x | 0, y: b.y | 0, w: b.width | 0, h: b.height | 0,
    shapes,
  });
}
return { boards: out };
`;
  return bridgeExec(sid, code);
}

// ─── Text normalization for matching ─────────────────────────────────────────

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', thinsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©',
  reg: '®', trade: '™', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  times: '×', divide: '÷', deg: '°', sect: '§',
  para: '¶', plusmn: '±',
};

// Decode the entities the portfolio actually uses. We don't need a full HTML
// entity table — just the ones present in src/.
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => HTML_ENTITIES[name.toLowerCase()] || m);
}

// Normalize a chunk of text for cross-side matching. Strips leading bullet
// glyphs (build-live-dom-canvas prefixes "• " to li shapes), normalizes
// whitespace, decodes entities, lowercases.
function normalizeForMatch(s) {
  if (!s) return '';
  let t = decodeEntities(s);
  // Strip leading bullet/ordinal glyphs the harvester injects.
  t = t.replace(/^[•·●▪◦\-\*]\s+/, '');
  // Collapse all whitespace runs (including non-breaking) to a single space.
  t = t.replace(/[\s    ]+/g, ' ').trim();
  return t.toLowerCase();
}

// Looser normalization — also strips leading "NN " numbering (li items in the
// "01 Graph neural networks" style) so we can match against source that omits
// the number.
function normalizeLoose(s) {
  let t = normalizeForMatch(s);
  t = t.replace(/^\d{1,3}\s+/, '');
  return t;
}

// ─── Levenshtein distance (cap-aware, early exit) ───────────────────────────

function levenshtein(a, b, cap) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ─── Astro source parsing: extract text leaves ──────────────────────────────

/**
 * Scan an .astro source string and return a list of text leaves. Each leaf is
 * `{ start, end, text }` where `start`/`end` are character offsets into the
 * original source and `text` is the raw substring between `>` and the next
 * `<` (exactly what the file holds — entities intact, whitespace preserved).
 *
 * Skips:
 *   - frontmatter (the first `---\n...\n---` block at the top of the file)
 *   - `<script>...</script>` blocks (anywhere)
 *   - `<style>...</style>` blocks (anywhere)
 *   - comment blocks `<!-- ... -->`
 *   - text that's pure whitespace
 *   - text that's an Astro/JSX expression like `{post.title}`
 *
 * The parser is intentionally simple — we're not building a real AST, just
 * locating the substrings we'd safely replace. If parsing gets confused
 * (mismatched skip blocks), we err on the side of recording fewer leaves;
 * unmatched Penpot shapes will then be reported as "unmatched" rather than
 * mis-applied.
 */
function extractTextLeaves(src) {
  const leaves = [];

  // 1. Locate frontmatter (only at very top of file).
  let scanStart = 0;
  if (src.startsWith('---')) {
    const closeIdx = src.indexOf('\n---', 3);
    if (closeIdx !== -1) {
      scanStart = closeIdx + 4; // after '\n---'
      // Skip optional trailing newline.
      if (src[scanStart] === '\n') scanStart++;
    }
  }

  // 2. Pre-compute skip regions: <script>...</script>, <style>...</style>,
  //    and <!-- ... --> comments. We'll consult these when emitting leaves.
  //    After sorting we MERGE overlapping ranges so the binary-search `inSkip`
  //    helper can rely on disjoint regions (a `<!--` inside a `<script>` body
  //    would otherwise produce an inner range whose start falls inside the
  //    outer range, breaking the search).
  let skipRegions = []; // sorted, non-overlapping array of [start, end)
  const blockRe = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = blockRe.exec(src)) !== null) {
    skipRegions.push([m.index, m.index + m[0].length]);
  }
  const commentRe = /<!--[\s\S]*?-->/g;
  while ((m = commentRe.exec(src)) !== null) {
    skipRegions.push([m.index, m.index + m[0].length]);
  }
  skipRegions.sort((a, b) => a[0] - b[0]);
  // Merge overlapping/adjacent regions.
  if (skipRegions.length > 1) {
    const merged = [skipRegions[0].slice()];
    for (let k = 1; k < skipRegions.length; k++) {
      const last = merged[merged.length - 1];
      const cur = skipRegions[k];
      if (cur[0] <= last[1]) {
        if (cur[1] > last[1]) last[1] = cur[1];
      } else {
        merged.push(cur.slice());
      }
    }
    skipRegions = merged;
  }

  function inSkip(pos) {
    // Binary search.
    let lo = 0, hi = skipRegions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = skipRegions[mid];
      if (pos < s) hi = mid - 1;
      else if (pos >= e) lo = mid + 1;
      else return true;
    }
    return false;
  }

  // 3. Walk every "between-tag" run after a `>` that ends with a `<`.
  let i = scanStart;
  while (i < src.length) {
    const gt = src.indexOf('>', i);
    if (gt === -1) break;
    const lt = src.indexOf('<', gt + 1);
    if (lt === -1) break;
    const start = gt + 1;
    const end = lt;
    if (end <= start) { i = lt + 1; continue; }
    // Skip if the `>` is inside a skipped region (e.g. inside <script>'s body
    // we might encounter `>` characters from JS but it's all in the script).
    if (inSkip(start)) { i = lt + 1; continue; }
    const raw = src.slice(start, end);
    // Drop pure-whitespace runs and runs that are a single JSX expression
    // (those are values resolved at build time, not literal text we can edit).
    const trimmed = raw.trim();
    if (trimmed.length === 0) { i = lt + 1; continue; }
    if (/^\{[\s\S]*\}$/.test(trimmed) && !/[<>]/.test(trimmed.slice(1, -1))) {
      i = lt + 1; continue;
    }
    leaves.push({ start, end, text: raw });
    i = lt + 1;
  }

  return leaves;
}

/**
 * Scan an .astro source for component invocations like
 *   <SectionLabel number="00" title="Front Matter" />
 * and emit synthetic leaves for each STRING-LITERAL prop value. Returns
 * `[{ start, end, text, kind: 'prop', propName }]` where `start`/`end`
 * delimit the VALUE between the quotes (not including the quotes themselves).
 *
 * Component invocations are recognised heuristically: open tag whose tag
 * name starts with an uppercase letter (PascalCase) — Astro convention.
 * Only `prop="value"` and `prop='value'` (literal string) attributes are
 * captured; expression props like `prop={foo}` are skipped.
 */
function extractPropLeaves(src) {
  const out = [];
  let scanStart = 0;
  if (src.startsWith('---')) {
    const close = src.indexOf('\n---', 3);
    if (close !== -1) scanStart = close + 4;
  }
  // Walk tags; component names start with [A-Z].
  const tagRe = /<([A-Z][\w]*)\b([^>]*)\/?>/g;
  tagRe.lastIndex = scanStart;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const attrBlock = m[2];
    const tagAbsStart = m.index;
    const attrAbsStart = tagAbsStart + 1 + m[1].length;
    // Parse attrs.
    const attrRe = /(\w[\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(attrBlock)) !== null) {
      const propName = am[1];
      const isDouble = am[2].startsWith('"');
      const value = isDouble ? am[3] : am[4];
      // Offset of the value (after the opening quote).
      const localValueStart = am.index + am[0].indexOf('=') + 2; // past `="` or `='`
      const absValueStart = attrAbsStart + localValueStart;
      const absValueEnd = absValueStart + value.length;
      if (value.length === 0) continue;
      // Skip obviously non-displayed props.
      if (/^(class|className|id|style|href|src|alt|aria-[\w-]+|data-[\w-]+|role|type|rel|target|name|for|key|slot)$/i.test(propName)) continue;
      out.push({
        start: absValueStart,
        end: absValueEnd,
        text: value,
        kind: 'prop',
        propName,
      });
    }
  }
  return out;
}

/**
 * Scan a `.ts` / `.js` source for string literals and emit synthetic leaves.
 * Each leaf carries `kind:'data'` and the value range (between quotes) so
 * the writer can rewrite the value in place.
 *
 * Only matches plain double- and single-quoted strings, NOT template literals
 * (\`...\`) — those frequently contain expressions and edits are risky. Also
 * skips strings that look like enum/keyword discriminators (all-lowercase,
 * short, in arrays like ['active', 'archived']) by requiring length ≥ 12.
 * The threshold matches our substring matcher's minimum so we can rely on
 * the existing matcher for non-trivial content only.
 */
function extractDataLeaves(src) {
  const out = [];
  // Skip block comments / line comments to reduce false positives.
  // Walk char-by-char tracking position; track whether we're in a comment,
  // a template literal, or a regex.
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src[i];
    // Line comment.
    if (ch === '/' && src[i+1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl === -1 ? len : nl + 1;
      continue;
    }
    // Block comment.
    if (ch === '/' && src[i+1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    // Template literal — skip; expressions inside are dangerous to write.
    if (ch === '`') {
      let j = i + 1;
      while (j < len && src[j] !== '`') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$' && src[j+1] === '{') {
          // Skip nested expression.
          let depth = 1; j += 2;
          while (j < len && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
        } else j++;
      }
      i = j + 1;
      continue;
    }
    // String literal.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let raw = '';
      while (j < len && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < len) {
          // Decode common escape sequences.
          const esc = src[j+1];
          if (esc === 'n') raw += '\n';
          else if (esc === 't') raw += '\t';
          else if (esc === 'r') raw += '\r';
          else raw += esc;
          j += 2;
        } else if (src[j] === '\n') {
          // Unterminated string on this line — give up at newline.
          break;
        } else {
          raw += src[j];
          j++;
        }
      }
      if (j < len && src[j] === quote) {
        if (raw.length >= 12) {
          out.push({
            start: i + 1,
            end: j,
            text: raw,
            kind: 'data',
          });
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Scan a markdown file's frontmatter for string-valued keys and emit synthetic
 * leaves for each. Body content is NOT scanned — we don't want to round-trip
 * partial paragraphs through Penpot (markdown formatting would be lost on
 * any partial edit). Returns leaves with `kind:'collection'`.
 */
function extractMarkdownLeaves(src) {
  const out = [];
  if (!src.startsWith('---')) return out;
  const close = src.indexOf('\n---', 3);
  if (close === -1) return out;
  const fm = src.slice(3, close);
  // Parse simple YAML key-value lines.
  const lines = fm.split('\n');
  let lineStart = 3; // after the opening ---\n? — actually +1 for newline after ---
  // Recompute: opening "---" is at 0, then a newline at index 3.
  let cursor = 4; // after first newline
  for (const line of lines) {
    const m = /^(\w[\w-]*)\s*:\s*"([^"]*)"\s*$/.exec(line) || /^(\w[\w-]*)\s*:\s*'([^']*)'\s*$/.exec(line) || /^(\w[\w-]*)\s*:\s*([^"'#\n][^\n]*?)\s*$/.exec(line);
    if (m) {
      const key = m[1];
      const value = m[2];
      // Find value position within the line.
      const colonIdx = line.indexOf(':');
      const valStartInLine = line.indexOf(value, colonIdx + 1);
      if (valStartInLine !== -1 && value.length >= 3) {
        out.push({
          start: cursor + valStartInLine,
          end:   cursor + valStartInLine + value.length,
          text:  value,
          kind:  'collection',
          frontmatterKey: key,
        });
      }
    }
    cursor += line.length + 1;
  }
  return out;
}

// ─── Astro file discovery: which file(s) own a given board ──────────────────

function listAstroFiles(dir) {
  const out = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        walk(p);
      } else if (ent.isFile() && ent.name.endsWith('.astro')) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out;
}

// Resolve the local-component imports declared in an .astro file's
// frontmatter. Returns a list of absolute paths that exist on disk.
// Only `.astro` imports are followed (no JS/TS components). Used to
// build the component graph for board → file mapping.
function resolveAstroImports(filePath) {
  let src;
  try { src = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  if (!src.startsWith('---')) return [];
  const close = src.indexOf('\n---', 3);
  if (close === -1) return [];
  const frontmatter = src.slice(3, close);
  const out = [];
  // Match: `import Foo from '../components/Foo.astro';` (single or double).
  const importRe = /import\s+\w+\s+from\s+['"]([^'"]+\.astro)['"]/g;
  let m;
  const dir = path.dirname(filePath);
  while ((m = importRe.exec(frontmatter)) !== null) {
    const spec = m[1];
    let abs;
    if (spec.startsWith('.')) abs = path.resolve(dir, spec);
    else continue; // skip aliased / package imports for V1
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

// Recursively walk the .astro import graph starting from `entryFile`,
// returning the entry and every transitively imported component.
function collectComponentGraph(entryFile) {
  const seen = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of resolveAstroImports(f)) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }
  return [...seen];
}

// Heuristic mapping: which files we look at for each board. For home, we
// follow the index.astro component graph so leaves in HeroFrontMatter,
// AboutPractice, NowBlock, etc. are reachable. For consulting/blog, we look
// at the page itself plus any local component it imports.
function filesForBoard(boardName, allAstroFiles) {
  const pages = path.join(SRC_DIR, 'pages');
  const consultingPath = path.join(pages, 'consulting.astro');
  const blogPath       = path.join(pages, 'blog.astro');
  const indexPath      = path.join(pages, 'index.astro');

  if (boardName === 'consulting') {
    // Page + transitively imported components.
    return collectComponentGraph(consultingPath);
  }
  if (boardName === 'blog') {
    return collectComponentGraph(blogPath);
  }
  if (boardName === 'home') {
    // index.astro is just imports — the actual text lives in components.
    // Follow the import graph from index.astro. Fall back to "all astro
    // files except the other two pages" if graph resolution finds nothing
    // (defensive: keeps prior behavior for unusual project layouts).
    const graph = collectComponentGraph(indexPath);
    if (graph.length > 1) return graph;
    return allAstroFiles.filter(f =>
      f !== consultingPath && f !== blogPath
    );
  }
  // Unknown board: scan everything.
  return allAstroFiles;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Try to match a Penpot text shape to one or more source leaves across a set
 * of files. Returns `{ file, leafIdx, score, mode }` (single-leaf) or
 * `{ file, leafIdxs: [i, i+1, ...], score, mode }` (multi-leaf concat) or
 * `null`.
 *
 * `mode`:
 *   'exact'        normalized strings identical
 *   'substr'       one normalized string contains the other (>= 12 chars)
 *   'prefix'       leaf is a prefix of shape (trailing append in Penpot)
 *   'suffix'       shape is a prefix of leaf (trailing deletion in Penpot)
 *   'multi-exact'  concatenation of contiguous leaves == shape
 *   'multi-prefix' concatenation of contiguous leaves is a prefix of shape
 *   'fuzzy'        Levenshtein distance <= cap on normalized strings
 */
function matchShape(shape, fileLeaves, used) {
  const targetTight = normalizeForMatch(shape.text);
  const targetLoose = normalizeLoose(shape.text);
  if (!targetTight) return null;

  // Pass 1: exact match against tight or loose normalization.
  for (const { file, leaves } of fileLeaves) {
    for (let i = 0; i < leaves.length; i++) {
      const key = `${file}:${i}`;
      if (used.has(key)) continue;
      const leaf = leaves[i];
      const norm = normalizeForMatch(leaf.text);
      if (!norm) continue;
      if (norm === targetTight || norm === targetLoose) {
        return { file, leafIdx: i, score: 0, mode: 'exact' };
      }
    }
  }

  // Pass 2: substring containment (the source leaf often has interpolated
  // children mixed in — e.g. `Mahit Vaddadi\n  <!-- TODO: ... -->` — but the
  // visible text the harvester picked up is a substring). Require both sides
  // to be at least 12 chars after normalization, AND the length ratio of the
  // shorter to the longer to be >= 0.6 so we don't snap a long paragraph to
  // a tiny "internal" word that happens to appear inside it.
  let bestSub = null;
  for (const { file, leaves } of fileLeaves) {
    for (let i = 0; i < leaves.length; i++) {
      const key = `${file}:${i}`;
      if (used.has(key)) continue;
      const leaf = leaves[i];
      const norm = normalizeForMatch(leaf.text);
      if (norm.length < 12 || targetTight.length < 12) continue;
      const ratio = Math.min(norm.length, targetTight.length) / Math.max(norm.length, targetTight.length);
      if (ratio < 0.6) continue;
      if (norm.includes(targetTight) || targetTight.includes(norm)
          || norm.includes(targetLoose) || targetLoose.includes(norm)) {
        const delta = Math.abs(norm.length - targetTight.length);
        // Skip the "leaf is a strict subset of a much-longer shape" case —
        // that pattern almost always means the source split across multiple
        // leaves (e.g. around an HTML comment or <br/>) and the multi-leaf
        // concat pass below is the right matcher. If we returned substr
        // here, the consumer would either clobber the rest of the run or
        // flag "split across leaves" and miss a workable concat match.
        const leafStrictSubset = targetTight.includes(norm) && targetTight.length > norm.length + 16;
        if (leafStrictSubset) continue;
        if (!bestSub || delta < bestSub.score) {
          bestSub = { file, leafIdx: i, score: delta, mode: 'substr' };
        }
      }
    }
  }
  if (bestSub) return bestSub;

  // Pass 2c (run BEFORE single-leaf prefix because the multi-leaf concat is
  // the more conservative interpretation when a shape spans multiple source
  // leaves — without this, a leaf that is a strict prefix of the shape
  // would falsely "win" the prefix mode and clobber the rest of the run).
  const MULTI_MAX_RUN = 6;
  let bestMultiPre = null;
  for (const { file, leaves } of fileLeaves) {
    for (let i = 0; i < leaves.length; i++) {
      const startKey = `${file}:${i}`;
      if (used.has(startKey)) continue;
      const firstNorm = normalizeForMatch(leaves[i].text);
      if (!firstNorm) continue;
      let concat = firstNorm;
      for (let k = 1; k < MULTI_MAX_RUN && (i + k) < leaves.length; k++) {
        const stepKey = `${file}:${i + k}`;
        if (used.has(stepKey)) break;
        const stepNorm = normalizeForMatch(leaves[i + k].text);
        if (!stepNorm) continue;
        concat = (concat + ' ' + stepNorm).trim();
        if (concat.length > Math.max(targetTight.length, targetLoose.length) * 2.5) break;
        const leafIdxs = [];
        for (let j = 0; j <= k; j++) leafIdxs.push(i + j);
        if (concat === targetTight || concat === targetLoose) {
          bestMultiPre = { file, leafIdxs, score: 0, mode: 'multi-exact' };
          break;
        }
        if ((targetTight.startsWith(concat) || targetLoose.startsWith(concat))
            && targetTight.length >= 8
            && targetTight.length <= 3 * concat.length) {
          const delta = targetTight.length - concat.length;
          if (!bestMultiPre || delta < bestMultiPre.score) {
            bestMultiPre = { file, leafIdxs, score: delta, mode: 'multi-prefix' };
          }
        }
      }
      if (bestMultiPre && bestMultiPre.score === 0) break;
    }
    if (bestMultiPre && bestMultiPre.score === 0) break;
  }
  if (bestMultiPre) return bestMultiPre;

  // Pass 2b: prefix/suffix containment for shorter-vs-longer single leaves.
  // Handles the "trailing edit" case where a user appended (or deleted from)
  // the end of a text shape in Penpot. We require both sides ≥ 8 chars, the
  // shorter to be a prefix of the longer, and the longer to be ≤ 2× the
  // shorter so we don't snap a 4-word label to an unrelated paragraph that
  // happens to start with those words.
  let bestPrefix = null;
  for (const { file, leaves } of fileLeaves) {
    for (let i = 0; i < leaves.length; i++) {
      const key = `${file}:${i}`;
      if (used.has(key)) continue;
      const leaf = leaves[i];
      const norm = normalizeForMatch(leaf.text);
      if (norm.length < 8 || targetTight.length < 8) continue;
      const shorter = norm.length < targetTight.length ? norm : targetTight;
      const longer  = norm.length < targetTight.length ? targetTight : norm;
      // Cap how much longer the longer side can be. The prompt's spec says
      // ≤2× — we relax slightly to 3× so realistic sentinel/append cases
      // ([E2E-SENTINEL-<10digits>] is 26 chars) match short leaves like
      // "Posts forthcoming." (18 chars). Beyond 3× the leaf is too short to
      // be the natural anchor for the append.
      if (longer.length > 3 * shorter.length) continue;
      if (!longer.startsWith(shorter)) continue;
      const delta = longer.length - shorter.length;
      const mode = norm.length < targetTight.length ? 'prefix' : 'suffix';
      if (!bestPrefix || delta < bestPrefix.score) {
        bestPrefix = { file, leafIdx: i, score: delta, mode };
      }
    }
  }
  if (bestPrefix) return bestPrefix;

  // (multi-leaf concat already ran above as Pass 2c before the single-leaf
  // prefix pass — see comment there for rationale.)

  // Pass 3: Levenshtein. Cap scales with leaf length: 5 edits for short
  // strings (the prompt's explicit threshold), or up to 15% of the longer
  // length for paragraphs — so a 200-char paragraph with a small insertion
  // still matches. Also require both sides be at least 8 chars so tiny
  // labels (e.g. "active", "GitHub") don't snap to each other.
  //
  // Performance guard: Levenshtein is O(n*m). Even with the row-min early-exit,
  // a pair of long, nearly-identical strings (think: a blog post paragraph
  // edited at the very end) can degenerate to a full DP because every early row
  // has rowMin = 0. We cap fuzzy matching at FUZZY_MAX_LEN chars per side. For
  // anything longer, Pass 2's substring matcher is the right tool — fuzzy edits
  // to a 5000-char paragraph are not something we should be auto-applying
  // anyway.
  const FUZZY_MAX_LEN = 1024;
  let bestFuz = null;
  for (const { file, leaves } of fileLeaves) {
    for (let i = 0; i < leaves.length; i++) {
      const key = `${file}:${i}`;
      if (used.has(key)) continue;
      const leaf = leaves[i];
      const norm = normalizeForMatch(leaf.text);
      if (!norm) continue;
      if (norm.length < 8 || targetTight.length < 8) continue;
      if (norm.length > FUZZY_MAX_LEN || targetTight.length > FUZZY_MAX_LEN) continue;
      const longer = Math.max(norm.length, targetTight.length);
      const cap = Math.max(5, Math.floor(longer * 0.15));
      if (Math.abs(norm.length - targetTight.length) > cap) continue;
      const dist = Math.min(
        levenshtein(norm, targetTight, cap),
        levenshtein(norm, targetLoose, cap),
      );
      if (dist <= cap && (!bestFuz || dist < bestFuz.score)) {
        bestFuz = { file, leafIdx: i, score: dist, mode: 'fuzzy' };
      }
    }
  }
  return bestFuz;
}

// ─── Rewriting source leaves ────────────────────────────────────────────────

/**
 * Compose the new leaf text given the original leaf text (with its surrounding
 * whitespace and possibly embedded entities/comments) and the new Penpot text.
 *
 * Goals:
 *   - Preserve leading/trailing whitespace exactly.
 *   - Re-encode common HTML entities the source originally used (e.g. nbsp,
 *     middot, mdash) so the source stays human-readable rather than getting
 *     littered with raw   chars after a roundtrip.
 *   - Do NOT touch leaves that contain a `<` or `>` other than the trailing
 *     `<` boundary (we already stop the leaf at the next `<`, but a leaf could
 *     legitimately contain JSX expressions — refuse to edit those).
 */
function composeNewLeafText(originalLeaf, newText) {
  // Preserve leading/trailing whitespace.
  const leadMatch = originalLeaf.match(/^(\s*)/);
  const tailMatch = originalLeaf.match(/(\s*)$/);
  const lead = leadMatch ? leadMatch[1] : '';
  const tail = tailMatch ? tailMatch[1] : '';

  // For very short edits we accept the raw new text. For longer ones, try to
  // re-encode characters that appeared as entities in the original.
  let encoded = newText;
  // Build a reverse map from chars that the original used as entities. We
  // explicitly encode `&` FIRST so we don't double-encode the entities we then
  // emit (e.g. encoding `·` → `&middot;` and then re-encoding the `&` would
  // produce `&amp;middot;`). After the `&` pass, any remaining `&` chars in
  // `encoded` came from `newText` itself, not from our entity emission.
  const reverseMap = {};
  for (const [name, ch] of Object.entries(HTML_ENTITIES)) {
    if (originalLeaf.includes(`&${name};`)) reverseMap[ch] = `&${name};`;
  }
  if (reverseMap['&']) {
    encoded = encoded.split('&').join(reverseMap['&']);
  }
  for (const ch of Object.keys(reverseMap)) {
    if (ch === '&') continue;
    encoded = encoded.split(ch).join(reverseMap[ch]);
  }

  return lead + encoded + tail;
}

// ─── V2: leaf ancestor / CSS-aware helpers ──────────────────────────────────

/**
 * Find the OPEN tag immediately containing the leaf (i.e. the `<tagname ...>`
 * that ends right before `leaf.start`). Returns
 *   `{ tagName, classes:[], attrsRaw, tagStart, tagEnd, idAttr, styleAttr,
 *      hrefAttr, hrefStart, hrefEnd, styleStart, styleEnd }`
 * or null if we can't find a sensible open tag (text not inside a tag).
 */
function findEnclosingTag(src, leafStart) {
  // Walk backwards from leaf.start looking for the most recent `>` that closes
  // an opening tag (not a self-close `/>`, not a closing tag `</...>`).
  let i = leafStart - 1;
  while (i >= 0) {
    const ch = src[i];
    if (ch === '>') {
      // Find matching '<'.
      const open = src.lastIndexOf('<', i);
      if (open === -1) return null;
      const tagText = src.slice(open, i + 1);
      // Closing tag → skip.
      if (tagText.startsWith('</')) { i = open - 1; continue; }
      // Comment → skip.
      if (tagText.startsWith('<!--')) { i = open - 1; continue; }
      // Self-close → still the tag enclosing this leaf? No — self-close means
      // empty element, no children. Skip past.
      if (tagText.endsWith('/>')) { i = open - 1; continue; }
      // Strip "<" and ">".
      const inner = tagText.slice(1, -1);
      const tnMatch = /^([A-Za-z][\w-]*)/.exec(inner);
      if (!tnMatch) { i = open - 1; continue; }
      const tagName = tnMatch[1];
      // Parse a couple key attributes by lightweight regex.
      const classMatch = /\sclass=("[^"]*"|'[^']*')/.exec(inner);
      const idMatch = /\sid=("[^"]*"|'[^']*')/.exec(inner);
      const styleMatchRaw = /\sstyle=("[^"]*"|'[^']*')/.exec(inner);
      const hrefMatch = /\shref=("[^"]*"|'[^']*')/.exec(inner);
      let classes = [];
      if (classMatch) {
        const v = classMatch[1].slice(1, -1);
        classes = v.split(/\s+/).filter(Boolean);
      }
      let styleAttr = null, styleStart = -1, styleEnd = -1;
      if (styleMatchRaw) {
        styleAttr = styleMatchRaw[1].slice(1, -1);
        // Compute absolute offsets of the value (between the quotes).
        const localIdx = styleMatchRaw.index + styleMatchRaw[0].indexOf('=') + 2;
        styleStart = open + 1 + localIdx;
        styleEnd = styleStart + styleAttr.length;
      }
      let hrefAttr = null, hrefStart = -1, hrefEnd = -1;
      if (hrefMatch) {
        hrefAttr = hrefMatch[1].slice(1, -1);
        const localIdx = hrefMatch.index + hrefMatch[0].indexOf('=') + 2;
        hrefStart = open + 1 + localIdx;
        hrefEnd = hrefStart + hrefAttr.length;
      }
      return {
        tagName,
        classes,
        idAttr: idMatch ? idMatch[1].slice(1, -1) : null,
        styleAttr, styleStart, styleEnd,
        hrefAttr, hrefStart, hrefEnd,
        tagStart: open, tagEnd: i + 1,
      };
    }
    i--;
  }
  return null;
}

/**
 * Walk OUTWARD from an enclosing tag, returning the nearest ancestor with the
 * given attribute (e.g. find the `<a href=...>` ancestor of a `<span>`).
 * Returns the enclosing-tag descriptor or null. `predicate` is a function
 * `(tag) => bool`.
 */
function findAncestorTag(src, leafStart, predicate) {
  let probe = leafStart;
  // First find the immediate tag.
  let cur = findEnclosingTag(src, probe);
  let depth = 0;
  while (cur) {
    if (predicate(cur)) return cur;
    // Climb: re-search from cur.tagStart (the character just before this open tag).
    if (cur.tagStart <= 0) break;
    probe = cur.tagStart;
    cur = findEnclosingTag(src, probe);
    depth++;
    if (depth > 100) break; // pathological safety
  }
  return null;
}

/**
 * Locate the scoped `<style>...</style>` block in an .astro source.
 * Returns `{ start, end, body }` (start/end exclusive of tags' angle brackets'
 * outside? — they enclose the FULL `<style>...</style>` substring) or null.
 * If there are multiple style blocks we return the first; the matcher will
 * fall through to `tokens.css` if no relevant rule is found locally.
 */
function findScopedStyleBlocks(src) {
  const blocks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index;
    const innerStart = open + m[0].indexOf('>', 0) + 1;
    const innerEnd = innerStart + m[1].length;
    blocks.push({ start: open, end: open + m[0].length, innerStart, innerEnd, body: m[1] });
  }
  return blocks;
}

/**
 * Lightly parse a CSS body looking for a selector that matches one of the
 * candidate class chains. Returns the FIRST matching declaration of
 * `propertyName` with its absolute offsets.
 *
 * `candidateSelectors` is an array of selector strings (e.g. `.c-hero-title`,
 * `h1`, `.c-page h1`). We only check exact selector-text match (no
 * combinators/cascade resolution beyond that). The match is the LAST rule in
 * the body whose selector text exactly equals one of the candidates — last to
 * approximate CSS cascade order.
 *
 * Returns `{ value, valueStart, valueEnd, selector, blockStart, blockEnd }`
 * or null.
 */
function findRuleDeclaration(body, bodyAbsStart, candidateSelectors, propertyName) {
  let best = null;
  // Tokenize block: find each `{...}` block with a preceding selector run.
  // Be lenient about nested at-rules (@media) by scanning recursively.
  function scan(startIdx, endIdx) {
    let i = startIdx;
    while (i < endIdx) {
      const braceOpen = body.indexOf('{', i);
      if (braceOpen === -1 || braceOpen >= endIdx) return;
      // Selector run is everything since the previous `}` or `;` or start.
      let selStart = i;
      // Trim leading whitespace + ';' or '}'.
      while (selStart < braceOpen && /[\s;}]/.test(body[selStart])) selStart++;
      const selectorRaw = body.slice(selStart, braceOpen).trim();
      // Find matching close brace.
      let depth = 1;
      let j = braceOpen + 1;
      while (j < endIdx && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        if (depth === 0) break;
        j++;
      }
      if (j >= endIdx) return;
      const blockInnerStart = braceOpen + 1;
      const blockInnerEnd = j;
      // If the selector starts with '@' (at-rule), recurse into its body.
      if (selectorRaw.startsWith('@')) {
        scan(blockInnerStart, blockInnerEnd);
        i = j + 1;
        continue;
      }
      // Match selector against any of the candidate strings.
      const selectorList = selectorRaw.split(',').map(s => s.trim());
      const selectorMatches = selectorList.find(s => candidateSelectors.includes(s));
      if (selectorMatches) {
        // Scan the block for `propertyName:`. Take the LAST declaration.
        const propRe = new RegExp(`(^|[;{\\s])(${propertyName})\\s*:\\s*([^;}]+?)\\s*(;|(?=\\}))`, 'g');
        let pm, lastDecl = null;
        const inner = body.slice(blockInnerStart, blockInnerEnd);
        while ((pm = propRe.exec(inner)) !== null) {
          const valLocalStart = blockInnerStart + pm.index + pm[1].length + pm[2].length + pm[0].slice(pm[1].length + pm[2].length).indexOf(':') + 1;
          // Re-find value start more precisely.
          const colonIdx = inner.indexOf(':', pm.index);
          const valStartLocal = colonIdx + 1;
          // skip leading whitespace
          let vs = valStartLocal;
          while (vs < blockInnerEnd - blockInnerStart && /\s/.test(inner[vs])) vs++;
          let ve = vs;
          while (ve < inner.length && inner[ve] !== ';' && inner[ve] !== '}') ve++;
          // Trim trailing whitespace
          while (ve > vs && /\s/.test(inner[ve - 1])) ve--;
          lastDecl = {
            value: inner.slice(vs, ve),
            valueStart: bodyAbsStart + blockInnerStart + vs,
            valueEnd:   bodyAbsStart + blockInnerStart + ve,
            selector: selectorMatches,
          };
        }
        if (lastDecl) best = lastDecl;
      }
      i = j + 1;
    }
  }
  scan(0, body.length);
  return best;
}

/**
 * Find a CSS variable declaration (e.g. `--ink: #fff;`) in a body and report
 * its value range. `selectorScope` is an optional selector that the variable
 * declaration must be inside (e.g. `:root` or `.c-page`); pass null to match
 * any scope. Returns `{ value, valueStart, valueEnd, scope }` or null.
 */
function findVarDeclaration(body, bodyAbsStart, varName, selectorScope) {
  let best = null;
  function scan(startIdx, endIdx, currentScope) {
    let i = startIdx;
    while (i < endIdx) {
      const braceOpen = body.indexOf('{', i);
      if (braceOpen === -1 || braceOpen >= endIdx) return;
      let selStart = i;
      while (selStart < braceOpen && /[\s;}]/.test(body[selStart])) selStart++;
      const selectorRaw = body.slice(selStart, braceOpen).trim();
      let depth = 1, j = braceOpen + 1;
      while (j < endIdx && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        if (depth === 0) break;
        j++;
      }
      if (j >= endIdx) return;
      const innerStart = braceOpen + 1, innerEnd = j;
      if (selectorRaw.startsWith('@')) {
        scan(innerStart, innerEnd, currentScope);
        i = j + 1;
        continue;
      }
      const scopeMatches = selectorScope == null
        ? true
        : selectorRaw.split(',').map(s => s.trim()).includes(selectorScope);
      if (scopeMatches) {
        const inner = body.slice(innerStart, innerEnd);
        const decRe = new RegExp(`(^|[;{\\s])(${varName.replace(/-/g, '\\-')})\\s*:\\s*([^;}]+?)\\s*(;|(?=\\}))`, 'g');
        let pm;
        while ((pm = decRe.exec(inner)) !== null) {
          const colonIdx = inner.indexOf(':', pm.index);
          let vs = colonIdx + 1;
          while (vs < inner.length && /\s/.test(inner[vs])) vs++;
          let ve = vs;
          while (ve < inner.length && inner[ve] !== ';' && inner[ve] !== '}') ve++;
          while (ve > vs && /\s/.test(inner[ve - 1])) ve--;
          best = {
            value: inner.slice(vs, ve),
            valueStart: bodyAbsStart + innerStart + vs,
            valueEnd:   bodyAbsStart + innerStart + ve,
            scope: selectorRaw,
          };
        }
      }
      i = j + 1;
    }
  }
  scan(0, body.length, null);
  return best;
}

/**
 * Normalize a hex color to the lowercase 6-digit form `#rrggbb` (or 8-digit
 * with alpha if provided). Returns null if input doesn't look like a hex.
 */
function normalizeHex(c) {
  if (!c || typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  if (!s.startsWith('#')) return null;
  s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) {
    return '#' + s.split('').map(ch => ch + ch).join('');
  }
  if (/^[0-9a-f]{6}$/.test(s) || /^[0-9a-f]{8}$/.test(s)) return '#' + s;
  return null;
}

/**
 * Build a list of CSS selectors a given enclosing tag would match. For now:
 *   - `tagName`
 *   - each class as `.cls`
 *   - the id as `#id`
 *   - simple combinations like `tagName.cls` and the multi-class run `.a.b.c`
 * (No cascade — see findRuleDeclaration.) Returns ordered most-specific first.
 */
function selectorsForTag(tag) {
  if (!tag) return [];
  const out = [];
  if (tag.classes.length > 1) out.push(tag.classes.map(c => '.' + c).join(''));
  for (const c of tag.classes) {
    out.push(`${tag.tagName}.${c}`);
    out.push('.' + c);
  }
  if (tag.idAttr) out.push('#' + tag.idAttr);
  out.push(tag.tagName);
  return out;
}

/**
 * Parse an inline style="..." attribute body, returning a Map of prop → {
 *   value, valueStart, valueEnd } where the offsets are RELATIVE to the
 * attribute body. Last-declaration-wins (handles `color:red; color:blue;`).
 */
function parseInlineStyle(body) {
  const out = new Map();
  // Naive split on `;`. Inline styles in our source don't contain
  // semicolons inside `url(...)` so this is safe.
  const decls = body.split(';');
  let offset = 0;
  for (const decl of decls) {
    const colon = decl.indexOf(':');
    if (colon !== -1) {
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const valStartInDecl = colon + 1;
      // Trim leading whitespace from value.
      let vs = valStartInDecl;
      while (vs < decl.length && /\s/.test(decl[vs])) vs++;
      let ve = decl.length;
      while (ve > vs && /\s/.test(decl[ve - 1])) ve--;
      out.set(prop, {
        value: decl.slice(vs, ve),
        valueStart: offset + vs,
        valueEnd: offset + ve,
      });
    }
    offset += decl.length + 1; // +1 for `;`
  }
  return out;
}

/**
 * Resolve the source-side color for a given enclosing tag by searching:
 *   1. the tag's inline `style="color:..."` (literal)
 *   2. each scoped `<style>` block for a rule whose selector matches the tag,
 *      taking the last `color:` declaration
 *   3. tokens.css for the var name if the resolved value was `var(--xxx)`
 *
 * Returns `{ kind: 'literal'|'var', value: '#hex' (resolved), declSite: {
 *   file, valueStart, valueEnd, raw } }` or null. `varName` is set if kind=='var'.
 */
function resolveSourceColor(tag, fileSrc, filePath, tokensInfo) {
  if (!tag) return null;
  // 1) Inline style.
  if (tag.styleAttr) {
    const decls = parseInlineStyle(tag.styleAttr);
    const c = decls.get('color');
    if (c) {
      const lit = normalizeHex(c.value);
      if (lit) {
        return {
          kind: 'literal',
          value: lit,
          declSite: {
            file: filePath,
            valueStart: tag.styleStart + c.valueStart,
            valueEnd: tag.styleStart + c.valueEnd,
            raw: c.value,
          },
        };
      }
      // var(...) inline — rare; resolve via tokens.
      const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(c.value.trim());
      if (m && tokensInfo) {
        const v = tokensInfo.vars.get(m[1]);
        if (v) return {
          kind: 'var',
          varName: m[1],
          value: normalizeHex(v.value) || v.value,
          declSite: { file: tokensInfo.path, valueStart: v.valueStart, valueEnd: v.valueEnd, raw: v.value },
        };
      }
    }
  }
  // 2) Scoped style blocks.
  const blocks = findScopedStyleBlocks(fileSrc);
  const sels = selectorsForTag(tag);
  // Also consider ancestor tags. For now just current tag — Loop 1 keeps it
  // simple. Future loops can widen.
  for (const blk of blocks) {
    const decl = findRuleDeclaration(blk.body, blk.innerStart, sels, 'color');
    if (decl) {
      const trimmed = decl.value.trim();
      const lit = normalizeHex(trimmed);
      if (lit) {
        return {
          kind: 'literal',
          value: lit,
          declSite: { file: filePath, valueStart: decl.valueStart, valueEnd: decl.valueEnd, raw: trimmed },
        };
      }
      const vm = /^var\(\s*(--[\w-]+)(?:\s*,\s*[^)]*)?\)$/.exec(trimmed);
      if (vm) {
        const varName = vm[1];
        // Look for declaration in same scoped block (e.g. .c-page { --ink: ... }).
        const local = findVarDeclaration(blk.body, blk.innerStart, varName, null);
        if (local) {
          const lit2 = normalizeHex(local.value);
          if (lit2) {
            return {
              kind: 'var',
              varName,
              value: lit2,
              declSite: { file: filePath, valueStart: local.valueStart, valueEnd: local.valueEnd, raw: local.value },
            };
          }
        }
        // Fall back to tokens.css.
        if (tokensInfo) {
          const v = tokensInfo.vars.get(varName);
          if (v) {
            const lit2 = normalizeHex(v.value);
            if (lit2) {
              return {
                kind: 'var',
                varName,
                value: lit2,
                declSite: { file: tokensInfo.path, valueStart: v.valueStart, valueEnd: v.valueEnd, raw: v.value },
              };
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Walk a CSS body collecting all `--name: value;` declarations under :root.
 * Returns Map<name, {value, valueStart, valueEnd}>.
 */
function collectRootVars(body, bodyAbsStart) {
  const out = new Map();
  // Find the `:root { ... }` block.
  const m = /:root\s*\{/.exec(body);
  if (!m) return out;
  const blockStart = m.index + m[0].length;
  let depth = 1, j = blockStart;
  while (j < body.length && depth > 0) {
    if (body[j] === '{') depth++;
    else if (body[j] === '}') depth--;
    if (depth === 0) break;
    j++;
  }
  const blockEnd = j;
  const inner = body.slice(blockStart, blockEnd);
  const declRe = /(--[\w-]+)\s*:\s*([^;}]+?)\s*(?=;|$)/g;
  let dm;
  while ((dm = declRe.exec(inner)) !== null) {
    const colonIdx = inner.indexOf(':', dm.index);
    let vs = colonIdx + 1;
    while (vs < inner.length && /\s/.test(inner[vs])) vs++;
    let ve = vs;
    while (ve < inner.length && inner[ve] !== ';' && inner[ve] !== '}') ve++;
    while (ve > vs && /\s/.test(inner[ve - 1])) ve--;
    out.set(dm[1], {
      value: inner.slice(vs, ve),
      valueStart: bodyAbsStart + blockStart + vs,
      valueEnd:   bodyAbsStart + blockStart + ve,
    });
  }
  return out;
}

/**
 * Load tokens.css and return `{ path, vars: Map<name, {value, valueStart, valueEnd}> }`.
 */
function loadTokensInfo(srcDir) {
  const p = path.join(srcDir, 'styles', 'tokens.css');
  if (!fs.existsSync(p)) return null;
  const body = fs.readFileSync(p, 'utf8');
  const vars = collectRootVars(body, 0);
  return { path: p, body, vars };
}

/**
 * Resolve the source-side font properties (fontFamily / fontWeight / fontSize)
 * for a given tag. Same lookup strategy as color: inline style first, then
 * scoped `<style>` blocks. Returns `{ family, weight, size }` where each value
 * is `{ value, declSite: {file, valueStart, valueEnd}, kind: 'literal'|'var',
 * varName? }` or null per slot. Does NOT resolve vars to literal values
 * for font props — fonts use --font-display etc. and the resolved literal is
 * a font stack like `'Fraunces Variable', Georgia, serif`. We compare on the
 * primary family token.
 */
function resolveSourceFont(tag, fileSrc, filePath, tokensInfo) {
  if (!tag) return null;
  const result = { family: null, weight: null, size: null };
  const propMap = { family: 'font-family', weight: 'font-weight', size: 'font-size' };

  function resolveProp(key) {
    const cssProp = propMap[key];
    // Inline.
    if (tag.styleAttr) {
      const d = parseInlineStyle(tag.styleAttr).get(cssProp);
      if (d) {
        return { kind: 'literal', value: d.value, declSite: {
          file: filePath, valueStart: tag.styleStart + d.valueStart, valueEnd: tag.styleStart + d.valueEnd, raw: d.value,
        }};
      }
    }
    // Scoped <style> blocks.
    const blocks = findScopedStyleBlocks(fileSrc);
    const sels = selectorsForTag(tag);
    for (const blk of blocks) {
      const decl = findRuleDeclaration(blk.body, blk.innerStart, sels, cssProp);
      if (decl) {
        const trimmed = decl.value.trim();
        const vm = /^var\(\s*(--[\w-]+)(?:\s*,\s*[^)]*)?\)$/.exec(trimmed);
        if (vm && tokensInfo) {
          const v = tokensInfo.vars.get(vm[1]);
          if (v) return { kind: 'var', varName: vm[1], value: v.value, declSite: {
            file: tokensInfo.path, valueStart: v.valueStart, valueEnd: v.valueEnd, raw: v.value,
          }};
        }
        return { kind: 'literal', value: trimmed, declSite: {
          file: filePath, valueStart: decl.valueStart, valueEnd: decl.valueEnd, raw: trimmed,
        }};
      }
    }
    return null;
  }
  result.family = resolveProp('family');
  result.weight = resolveProp('weight');
  result.size   = resolveProp('size');
  return result;
}

/**
 * Convert a Penpot fontSize string (e.g. "96") to a px CSS value "96px" for
 * comparison. Returns null if not a number.
 */
function penpotFontSizeToPx(v) {
  if (!v) return null;
  const n = parseFloat(v);
  if (Number.isFinite(n)) return n + 'px';
  return null;
}

/**
 * Compare a Penpot font-family value (e.g. "Fraunces") against a CSS
 * font-family declaration (which may include fallback stack and quotes).
 * Returns true if the FIRST family in the CSS stack matches the Penpot value
 * (case-insensitive, stripping quotes).
 */
function fontFamilyMatches(canvasValue, cssValue) {
  if (!canvasValue || !cssValue) return true; // assume match if missing
  const a = canvasValue.replace(/['"]/g, '').trim().toLowerCase();
  const first = cssValue.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  // Strip "Variable" suffix from CSS first (canvas often drops it).
  const cssNormal = first.replace(/\s+variable\b/, '').trim();
  return cssNormal === a || cssNormal.startsWith(a + ' ') || a.startsWith(cssNormal + ' ');
}

/**
 * Check whether a CSS declaration at `declSite` is "uniquely owned" by the
 * matched leaf — i.e. whether changing it would affect ONLY this leaf and no
 * other leaf in source. We approximate: count how many leaves across the
 * current file's component graph would map to the same declSite. If exactly
 * 1, it's safe.
 *
 * This is conservative. The implementation walks `fileLeaves` (all known
 * leaves in scope), finds each leaf's enclosing tag and resolves its color
 * declaration site, and counts identical-{file, valueStart} matches.
 */
function isDeclSiteUnique(declSite, fileLeaves, fileSourceCache, tokensInfo, propResolver) {
  let count = 0;
  for (const { file, leaves } of fileLeaves) {
    const src = fileSourceCache.get(file);
    if (!src) continue;
    for (const leaf of leaves) {
      const tag = findEnclosingTag(src, leaf.start);
      if (!tag) continue;
      const resolved = propResolver(tag, src, file, tokensInfo);
      if (!resolved) continue;
      if (resolved.declSite
          && resolved.declSite.file === declSite.file
          && resolved.declSite.valueStart === declSite.valueStart) {
        count++;
        if (count > 1) return false;
      }
    }
  }
  return count === 1;
}

// Detect if a leaf is "safe" to edit (doesn't contain JSX expressions, HTML
// tags fragments, etc.). We already excluded pure-JSX leaves at extraction
// time, but mixed-content leaves can still slip through.
function isSafeLeaf(text) {
  // No JSX expressions — if the leaf has unbalanced `{` / `}` it's likely
  // sitting next to an expression, leave it alone.
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < 0) return false; }
  }
  if (depth !== 0) return false;
  // No `<` allowed inside a leaf (extractor stops at next `<` already).
  if (text.includes('<')) return false;
  return true;
}

// ─── Sanity check + .bak before write ───────────────────────────────────────

function frontmatterOf(src) {
  if (!src.startsWith('---')) return '';
  const close = src.indexOf('\n---', 3);
  if (close === -1) return '';
  return src.slice(0, close + 4);
}

function countAngleBrackets(src) {
  // Crude bracket balance check — count `<` and `>` excluding the frontmatter.
  let scanStart = 0;
  if (src.startsWith('---')) {
    const close = src.indexOf('\n---', 3);
    if (close !== -1) scanStart = close + 4;
  }
  const tail = src.slice(scanStart);
  let lt = 0, gt = 0;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === '<') lt++;
    else if (tail[i] === '>') gt++;
  }
  return { lt, gt };
}

function sanityOK(original, edited, filePath) {
  // For non-Astro files (data/*.ts, content/*.md, tokens.css) we skip the
  // angle-bracket and frontmatter check entirely — those files use different
  // syntax and the writer only modifies controlled value ranges. The
  // dangerous-content check above is the safety net for those.
  if (filePath && !filePath.endsWith('.astro')) {
    // Length-delta sanity: refuse if the file shrunk by more than 50% or
    // grew by more than 200% — catches catastrophic overwrites.
    const ratio = edited.length / Math.max(1, original.length);
    if (ratio < 0.5 || ratio > 2.0) return `size ratio out of bounds (${ratio.toFixed(2)})`;
    return null;
  }
  // Frontmatter must be byte-identical.
  if (frontmatterOf(original) !== frontmatterOf(edited)) return 'frontmatter changed';
  const a = countAngleBrackets(original);
  const b = countAngleBrackets(edited);
  if (a.lt !== b.lt) return `< count changed (${a.lt} → ${b.lt})`;
  if (a.gt !== b.gt) return `> count changed (${a.gt} → ${b.gt})`;
  return null;
}

// Apply a list of edits to a source string. Edits are
// `{ start, end, replacement }` and must not overlap. We sort descending so
// later replacements don't invalidate earlier offsets.
function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

// ─── Unified diff (minimal, fits a single hunk per file) ────────────────────

function unifiedDiff(filepath, original, edited) {
  if (original === edited) return '';
  const a = original.split('\n');
  const b = edited.split('\n');
  // Tiny LCS-free diff: emit changed regions by walking from both ends.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA > head && tailB > head && a[tailA] === b[tailB]) { tailA--; tailB--; }
  const ctx = 3;
  const startA = Math.max(0, head - ctx);
  const endA   = Math.min(a.length - 1, tailA + ctx);
  const startB = Math.max(0, head - ctx);
  const endB   = Math.min(b.length - 1, tailB + ctx);
  const lines = [];
  lines.push(`--- a/${filepath}`);
  lines.push(`+++ b/${filepath}`);
  lines.push(`@@ -${startA + 1},${endA - startA + 1} +${startB + 1},${endB - startB + 1} @@`);
  for (let i = startA; i < head; i++) lines.push(' ' + a[i]);
  for (let i = head; i <= tailA; i++) lines.push('-' + a[i]);
  for (let i = head; i <= tailB; i++) lines.push('+' + b[i]);
  for (let i = tailA + 1; i <= endA; i++) lines.push(' ' + a[i]);
  return lines.join('\n') + '\n';
}

// ─── Main reverse-sync routine ───────────────────────────────────────────────

async function run() {
  let boards;
  if (FROM_SNAPSHOT) {
    const raw = fs.readFileSync(FROM_SNAPSHOT, 'utf8');
    const snap = JSON.parse(raw);
    boards = snap.boards || snap.result?.boards || [];
    process.stderr.write(`[snapshot] loaded ${boards.length} board(s) from ${FROM_SNAPSHOT}\n`);
  } else {
    const sid = await mcpInit();
    const res = await readCanvas(sid);
    if (res?.result?.error) throw new Error(res.result.error);
    boards = res?.result?.boards || [];
    if (SAVE_SNAPSHOT) {
      fs.writeFileSync(SAVE_SNAPSHOT, JSON.stringify({ boards }, null, 2));
      process.stderr.write(`[snapshot] wrote ${boards.length} board(s) to ${SAVE_SNAPSHOT}\n`);
    }
  }

  const allAstroFiles = listAstroFiles(SRC_DIR);
  const fileSourceCache = new Map(); // path -> string
  const fileLeafCache   = new Map(); // path -> [{start,end,text}]
  function loadFile(p) {
    if (!fileSourceCache.has(p)) {
      const s = fs.readFileSync(p, 'utf8');
      fileSourceCache.set(p, s);
      // Combine text leaves and prop-value leaves. Prop leaves carry
      // `kind:'prop'` so the writer can rewrite them in place; text leaves
      // are unchanged.
      const text = extractTextLeaves(s);
      const props = extractPropLeaves(s);
      // Sort by position so matchShape iteration is deterministic.
      const all = [...text, ...props].sort((a, b) => a.start - b.start);
      fileLeafCache.set(p, all);
    }
    return { src: fileSourceCache.get(p), leaves: fileLeafCache.get(p) };
  }

  // Aggregate edits per file.
  const editsByFile = new Map(); // path -> [{start, end, replacement, oldText, newText}]
  const used = new Set();        // `${file}:${leafIdx}` keys already claimed
  // Track which (file, declSiteStart) ranges already have an edit so we don't
  // double-write the same CSS variable from two shapes.
  const declSiteEdited = new Set(); // `${file}:${valueStart}-${valueEnd}`
  // Loop 7: every TEXT leaf the matcher claimed gets recorded here. After
  // the matching pass we diff vs. last-sync snapshot to detect deletions.
  const matchedTextLeaves = []; // [{file, normText}]
  function recordMatchedLeaf(file, leaf) {
    if (!leaf || leaf.kind) return; // skip prop/data/collection leaves
    matchedTextLeaves.push({ file, normText: normalizeForMatch(leaf.text) });
  }
  let totalChanges = 0;
  let totalUnmatched = 0;
  const perBoardLog = []; // [{board, changes:[{file,line,old,new,mode}], unmatched:[{text}]}]

  // Load shared resources for style analysis.
  const tokensInfo = loadTokensInfo(SRC_DIR);
  // Tokens.css writes go through editsByFile too — but they need the source
  // loaded into the cache, so prime it.
  if (tokensInfo) {
    if (!fileSourceCache.has(tokensInfo.path)) {
      fileSourceCache.set(tokensInfo.path, tokensInfo.body);
      // No leaf list for .css files — leave empty.
      fileLeafCache.set(tokensInfo.path, []);
    }
  }


  // Loop 5: enumerate data + content files once. They're reused across
  // every board's matching pass.
  const dataFiles = [];
  const contentFiles = [];
  function walkExt(dir, ext, into) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkExt(p, ext, into);
      else if (ent.isFile() && ext.test(ent.name)) into.push(p);
    }
  }
  walkExt(path.join(SRC_DIR, 'data'),    /\.(ts|js|mjs)$/i, dataFiles);
  walkExt(path.join(SRC_DIR, 'content'), /\.md$/i,           contentFiles);
  function loadDataFile(p) {
    if (!fileSourceCache.has(p)) {
      const s = fs.readFileSync(p, 'utf8');
      fileSourceCache.set(p, s);
      fileLeafCache.set(p, extractDataLeaves(s));
    }
    return { src: fileSourceCache.get(p), leaves: fileLeafCache.get(p) };
  }
  function loadContentFile(p) {
    if (!fileSourceCache.has(p)) {
      const s = fs.readFileSync(p, 'utf8');
      fileSourceCache.set(p, s);
      fileLeafCache.set(p, extractMarkdownLeaves(s));
    }
    return { src: fileSourceCache.get(p), leaves: fileLeafCache.get(p) };
  }

  for (const b of boards) {
    if (PAGE_PICK && b.name !== PAGE_PICK) continue;
    const files = filesForBoard(b.name, allAstroFiles);
    const fileLeaves = files.map(f => {
      const { leaves } = loadFile(f);
      return { file: f, leaves };
    });
    // Append data + content leaves (shared across boards). The matcher
    // already de-duplicates by file:leafIdx so this is safe.
    for (const f of dataFiles) {
      const { leaves } = loadDataFile(f);
      fileLeaves.push({ file: f, leaves });
    }
    for (const f of contentFiles) {
      const { leaves } = loadContentFile(f);
      fileLeaves.push({ file: f, leaves });
    }

    const changes = [];
    const unmatched = [];
    // Loop 8: track per-shape matches for move detection.
    const perShapeMatches = []; // [{shape, file, leaf, kind: 'text'|'prop'|'data'|'collection'|'multi'}]

    // Stable shape iteration order (top-down on the canvas) makes matching
    // deterministic for siblings with identical text.
    const sortedShapes = [...b.shapes].sort((s1, s2) => (s1.y - s2.y) || (s1.x - s2.x));

    const collapseWs = (s) => s.replace(/\s+/g, ' ').trim();

    // Per-board emit helper: pushes a style/link/font/prop edit and updates
    // `changes` + counters. Dedup on (file, valueStart, valueEnd).
    function emitStyleEdit({ kind, file, valueStart, valueEnd, oldValue, newValue, shapeText }) {
      if (oldValue === newValue) return;
      const key = `${file}:${valueStart}-${valueEnd}`;
      if (declSiteEdited.has(key)) return;
      declSiteEdited.add(key);
      const src = fileSourceCache.get(file);
      if (!src) return;
      const line = src.slice(0, valueStart).split('\n').length;
      if (!editsByFile.has(file)) editsByFile.set(file, []);
      editsByFile.get(file).push({
        start: valueStart, end: valueEnd,
        replacement: newValue,
        oldText: oldValue, newText: newValue,
      });
      const snippetSrc = shapeText ? shapeText.slice(0, 30).replace(/\s+/g, ' ') : '';
      changes.push({
        file, line,
        old: `${oldValue} (${snippetSrc})`,
        new: newValue,
        mode: kind,
      });
      totalChanges++;
    }

    // After a successful single-leaf match, run style analyzers (color, font,
    // link). Each returns 0 or 1 edits and is independent of the text edit.
    function runStyleAnalyzers(shape, leaf, matchFile) {
      const src = fileSourceCache.get(matchFile);
      if (!src) return;
      const tag = findEnclosingTag(src, leaf.start);
      if (!tag) return;

      // Loop 1: color.
      if (shape.fillColor) {
        const canvasHex = normalizeHex(shape.fillColor);
        const resolved = resolveSourceColor(tag, src, matchFile, tokensInfo);
        if (canvasHex && resolved && resolved.value !== canvasHex) {
          // For 'var' kind, check that the variable is uniquely owned by THIS leaf —
          // if more than one leaf would change, refuse and emit info.
          let colorOK = true;
          if (resolved.kind === 'var') {
            const unique = isDeclSiteUnique(
              resolved.declSite, fileLeaves, fileSourceCache, tokensInfo, resolveSourceColor,
            );
            if (!unique) {
              changes.push({
                file: matchFile,
                line: src.slice(0, leaf.start).split('\n').length,
                old: `color ${resolved.value} (var ${resolved.varName})`,
                new: `${canvasHex} (refused: shared)`,
                mode: 'color-skip',
              });
              colorOK = false;
            }
          }
          if (colorOK) {
            emitStyleEdit({
              kind: 'color',
              file: resolved.declSite.file,
              valueStart: resolved.declSite.valueStart,
              valueEnd: resolved.declSite.valueEnd,
              oldValue: resolved.declSite.raw,
              newValue: canvasHex,
              shapeText: shape.text,
            });
          }
        }
      }

      // Loop 3: link href.
      // Shape's `link` field holds the href parsed from shape.name. If the
      // matched leaf sits inside an <a>, compare its href to the canvas link
      // and rewrite if different. Empty canvas link (no anchor on canvas
      // side) is treated as "no opinion" — don't propose to delete.
      if (typeof shape.link === 'string' && shape.link.length > 0) {
        const anchor = findAncestorTag(src, leaf.start, t => t.tagName.toLowerCase() === 'a' && t.hrefAttr != null);
        if (anchor && anchor.hrefAttr !== shape.link) {
          // Refuse if href contains a JSX expression (`{...}`) or is empty.
          if (!/\{[^}]*\}/.test(anchor.hrefAttr)) {
            emitStyleEdit({
              kind: 'link',
              file: matchFile,
              valueStart: anchor.hrefStart,
              valueEnd: anchor.hrefEnd,
              oldValue: anchor.hrefAttr,
              newValue: shape.link,
              shapeText: shape.text,
            });
          }
        }
      }

      // Loop 2: font-family / font-weight / font-size.
      if (shape.fontFamily || shape.fontWeight || shape.fontSize) {
        const fonts = resolveSourceFont(tag, src, matchFile, tokensInfo);
        if (fonts) {
          // font-family: compare PRIMARY name only.
          if (fonts.family && shape.fontFamily && !fontFamilyMatches(shape.fontFamily, fonts.family.value)) {
            // For 'var' kind (font-family: var(--font-display)), refuse if shared.
            const safeToEdit = fonts.family.kind === 'literal' ? true
              : isDeclSiteUnique(
                  fonts.family.declSite, fileLeaves, fileSourceCache, tokensInfo,
                  (t, s, f, ti) => { const r = resolveSourceFont(t, s, f, ti); return r ? r.family : null; },
                );
            if (!safeToEdit) {
              changes.push({
                file: matchFile,
                line: src.slice(0, leaf.start).split('\n').length,
                old: `font-family ${fonts.family.value}`,
                new: `${shape.fontFamily} (refused: shared)`,
                mode: 'font-skip',
              });
            } else if (fonts.family.kind === 'literal') {
              // Replace the FIRST family in the stack only — keep fallbacks.
              const stack = fonts.family.value.split(',');
              stack[0] = `'${shape.fontFamily}'`;
              emitStyleEdit({
                kind: 'font',
                file: fonts.family.declSite.file,
                valueStart: fonts.family.declSite.valueStart,
                valueEnd: fonts.family.declSite.valueEnd,
                oldValue: fonts.family.declSite.raw,
                newValue: stack.join(',').trim(),
                shapeText: shape.text,
              });
            }
          }
          // font-weight: source might be a number (300) or keyword (bold).
          if (fonts.weight && shape.fontWeight) {
            const cssW = fonts.weight.value.trim();
            const canvasW = shape.fontWeight.trim();
            if (cssW !== canvasW && cssW.toLowerCase() !== canvasW.toLowerCase()) {
              const safeToEdit = fonts.weight.kind === 'literal' ? true
                : isDeclSiteUnique(
                    fonts.weight.declSite, fileLeaves, fileSourceCache, tokensInfo,
                    (t, s, f, ti) => { const r = resolveSourceFont(t, s, f, ti); return r ? r.weight : null; },
                  );
              if (!safeToEdit) {
                changes.push({
                  file: matchFile,
                  line: src.slice(0, leaf.start).split('\n').length,
                  old: `font-weight ${cssW}`,
                  new: `${canvasW} (refused: shared)`,
                  mode: 'font-skip',
                });
              } else {
                emitStyleEdit({
                  kind: 'font',
                  file: fonts.weight.declSite.file,
                  valueStart: fonts.weight.declSite.valueStart,
                  valueEnd: fonts.weight.declSite.valueEnd,
                  oldValue: fonts.weight.declSite.raw,
                  newValue: canvasW,
                  shapeText: shape.text,
                });
              }
            }
          }
          // font-size: Penpot reports px. Compare to CSS literal (px/rem/etc.)
          // ONLY if the CSS value is in px — otherwise we'd lose modular-scale
          // information. The exception: if CSS resolves via var(--step-...) we
          // refuse (would require rewriting the scale variable).
          if (fonts.size && shape.fontSize) {
            const cssV = fonts.size.value.trim();
            const canvasPx = penpotFontSizeToPx(shape.fontSize);
            const isPx = /^\d+(\.\d+)?px$/i.test(cssV);
            const samePx = isPx && canvasPx
              && parseFloat(cssV) === parseFloat(canvasPx);
            if (isPx && canvasPx && !samePx) {
              if (fonts.size.kind !== 'literal') {
                changes.push({
                  file: matchFile,
                  line: src.slice(0, leaf.start).split('\n').length,
                  old: `font-size ${cssV}`,
                  new: `${canvasPx} (refused: via var)`,
                  mode: 'font-skip',
                });
              } else {
                emitStyleEdit({
                  kind: 'font',
                  file: fonts.size.declSite.file,
                  valueStart: fonts.size.declSite.valueStart,
                  valueEnd: fonts.size.declSite.valueEnd,
                  oldValue: fonts.size.declSite.raw,
                  newValue: canvasPx,
                  shapeText: shape.text,
                });
              }
            } else if (!isPx && fonts.size.kind === 'var' && canvasPx) {
              // CSS uses var(--step-X). Refuse to edit — would change the scale.
              changes.push({
                file: matchFile,
                line: src.slice(0, leaf.start).split('\n').length,
                old: `font-size ${cssV}`,
                new: `${canvasPx} (refused: scale var)`,
                mode: 'font-skip',
              });
            }
          }
        }
      }
    }

    // Loop 6: cache sentinel locations per file. A sentinel is
    //   <!-- penpot:insert-after-here -->
    // followed by (optional) whitespace then a newline. Multiple sentinels
    // per file are allowed; we pick the FIRST that's still unused per shape.
    const sentinelsByFile = new Map(); // file -> [{ start, end, line, used }]
    function getSentinels(file) {
      if (sentinelsByFile.has(file)) return sentinelsByFile.get(file);
      const src = fileSourceCache.get(file);
      const out = [];
      if (src) {
        const re = /<!--\s*penpot:insert-after-here\s*-->/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          const line = src.slice(0, m.index).split('\n').length;
          out.push({ start: m.index, end: m.index + m[0].length, line, claimed: false });
        }
      }
      sentinelsByFile.set(file, out);
      return out;
    }

    function classifyNewShape(shape) {
      // fontSize heuristic: >= 32px → h2, else p.
      const px = parseFloat(shape.fontSize || '0');
      return px >= 32 ? 'h2' : 'p';
    }

    for (const shape of sortedShapes) {
      const match = matchShape(shape, fileLeaves, used);
      if (!match) {
        // Loop 6: new-shape ingestion via sentinel.
        let inserted = false;
        const candidateFiles = files; // .astro files in board's component graph
        for (const f of candidateFiles) {
          const sentinels = getSentinels(f);
          const free = sentinels.find(s => !s.claimed);
          if (!free) continue;
          // Build new HTML snippet.
          const tag = classifyNewShape(shape);
          const safeText = shape.text.replace(/[<>]/g, '');
          if (safeText !== shape.text) {
            unmatched.push({ text: shape.text.slice(0,60).replace(/\s+/g, ' ') + ' (new — contains angle bracket, skipped)' });
            totalUnmatched++;
            break;
          }
          const snippet = `\n        <${tag} class="penpot-new">${safeText}</${tag}>`;
          const insertAt = free.end;
          if (!editsByFile.has(f)) editsByFile.set(f, []);
          editsByFile.get(f).push({
            start: insertAt, end: insertAt,
            replacement: snippet,
            oldText: '', newText: snippet,
          });
          changes.push({
            file: f, line: free.line,
            old: `(no source)`,
            new: snippet.trim(),
            mode: 'new',
          });
          totalChanges++;
          free.claimed = true;
          inserted = true;
          break;
        }
        if (!inserted) {
          const snippet = shape.text.slice(0, 60).replace(/\s+/g, ' ');
          unmatched.push({ text: snippet + ' (no sentinel — add <!-- penpot:insert-after-here --> to enable ingestion)' });
          totalUnmatched++;
        }
        continue;
      }

      // Multi-leaf match (concatenation spans `<br/>`, sibling tags, etc.).
      // The matcher already verified the concat is exact or is a prefix of
      // the shape text. For 'multi-exact' there is nothing to write — it's
      // idempotent, just mark the leaves used. For 'multi-prefix', the user
      // appended text in Penpot; we write the appended suffix into the LAST
      // leaf of the run, preserving the intervening source markup.
      if (Array.isArray(match.leafIdxs)) {
        const leafObjs = match.leafIdxs.map(i => fileLeafCache.get(match.file)[i]);
        // Safety: every leaf in the run must be safe to edit.
        if (!leafObjs.every(l => isSafeLeaf(l.text))) {
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe leaf in run)' });
          totalUnmatched++;
          continue;
        }
        for (const i of match.leafIdxs) {
          used.add(`${match.file}:${i}`);
          recordMatchedLeaf(match.file, fileLeafCache.get(match.file)[i]);
        }
        // Track for Loop 8 (move detection). Use the FIRST leaf as the anchor.
        perShapeMatches.push({ shape, file: match.file, leaf: leafObjs[0], kind: 'text' });
        // Run style analyzers using the FIRST leaf as anchor — its enclosing
        // tag (e.g. <h1>) is the containing block element whose CSS rules
        // apply to all sibling text leaves.
        runStyleAnalyzers(shape, leafObjs[0], match.file);
        if (match.mode === 'multi-exact') continue; // idempotent — nothing to do.
        // multi-prefix: write the new (longer) text by appending the diff
        // suffix to the LAST leaf. composeNewLeafText preserves the leaf's
        // own surrounding whitespace.
        const lastLeaf = leafObjs[leafObjs.length - 1];
        // Build the appended fragment: the part of shape.text beyond the
        // concatenated prefix. We can't safely slice raw shape.text by
        // normalized-prefix length, so we slice on the original shape.text
        // by character count of the existing leaves' visible text +
        // separators. Simpler & robust: take the suffix after the LAST
        // leaf's visible text in shape.text (the matcher already proved
        // shape starts with the concat).
        const lastNorm = normalizeForMatch(lastLeaf.text);
        const shapeNorm = normalizeForMatch(shape.text);
        const idx = shapeNorm.lastIndexOf(lastNorm);
        if (idx === -1 || idx + lastNorm.length > shapeNorm.length) {
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (multi-prefix slice failed)' });
          totalUnmatched++;
          continue;
        }
        // Map normalized indices back to shape.text by tracking the run
        // through shape.text directly. We just need the suffix starting
        // after lastLeaf's visible content within shape.text. Use a loose
        // approach: find the last occurrence of the last leaf's trimmed
        // text inside shape.text (collapsing whitespace), and take the
        // remainder.
        const shapeCollapsed = collapseWs(shape.text);
        const lastCollapsed = collapseWs(decodeEntities(lastLeaf.text));
        const sliceIdx = shapeCollapsed.lastIndexOf(lastCollapsed);
        const suffix = sliceIdx === -1
          ? null
          : shapeCollapsed.slice(sliceIdx + lastCollapsed.length);
        if (!suffix) {
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (multi-prefix suffix empty)' });
          totalUnmatched++;
          continue;
        }
        const newLastText = lastCollapsed + suffix;
        const replacement = composeNewLeafText(lastLeaf.text, newLastText);
        if (replacement === lastLeaf.text) continue;
        const { src } = loadFile(match.file);
        const line = src.slice(0, lastLeaf.start).split('\n').length;
        changes.push({
          file: match.file, line,
          old: collapseWs(decodeEntities(lastLeaf.text)),
          new: newLastText,
          mode: match.mode,
        });
        if (!editsByFile.has(match.file)) editsByFile.set(match.file, []);
        editsByFile.get(match.file).push({
          start: lastLeaf.start, end: lastLeaf.end,
          replacement,
          oldText: lastLeaf.text, newText: replacement,
        });
        totalChanges++;
        continue;
      }

      // Single-leaf match.
      used.add(`${match.file}:${match.leafIdx}`);
      recordMatchedLeaf(match.file, fileLeafCache.get(match.file)[match.leafIdx]);
      const { src } = loadFile(match.file);
      const leaf = fileLeafCache.get(match.file)[match.leafIdx];
      // Track for Loop 8 (move detection).
      perShapeMatches.push({ shape, file: match.file, leaf, kind: leaf.kind || 'text' });

      // Loop 4/5: PROP / DATA / COLLECTION leaf paths.
      // Synthetic leaves sit inside an attribute value (prop), a JS/TS string
      // literal (data), or a markdown frontmatter value (collection). Just
      // rewrite the value range — no surrounding whitespace, no entity decode.
      //
      // SAFETY: only fire on EXACT / fuzzy match (Levenshtein-ish). Substring
      // / prefix / multi-leaf matches mean the canvas text contains template
      // chrome (e.g. SectionLabel concatenates "§ NN / {title}") that we'd
      // otherwise blindly write back into the value. Reject those.
      if (leaf.kind === 'prop' || leaf.kind === 'data' || leaf.kind === 'collection') {
        if (match.mode !== 'exact' && match.mode !== 'fuzzy') {
          used.delete(`${match.file}:${match.leafIdx}`);
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ` (${leaf.kind} substr — skipped)` });
          totalUnmatched++;
          continue;
        }
        const shapeText = collapseWs(shape.text);
        const leafText  = collapseWs(decodeEntities(leaf.text));
        if (leafText === shapeText) continue;
        if (normalizeForMatch(leaf.text) === normalizeForMatch(shape.text)
            || normalizeLoose(leaf.text) === normalizeLoose(shape.text)) continue;
        // Refuse if shape text contains characters that would break the
        // surrounding syntax:
        //   - prop / data: need to stay in the chosen quote style
        //   - collection: need to stay simple YAML scalar (no `:`, `"`, ...)
        if (leaf.kind === 'prop' && /["<>]/.test(shape.text)) {
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe prop value)' });
          totalUnmatched++;
          continue;
        }
        if (leaf.kind === 'data') {
          // We assume double-quoted strings in TS/JS source; refuse if shape
          // text contains a `"` or a backslash (escape gymnastics out of scope).
          // Also refuse multi-line content (would need template-literal rewrite).
          if (/["\\]/.test(shape.text) || /\n/.test(shape.text)) {
            unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe data value)' });
            totalUnmatched++;
            continue;
          }
          // Detect original quote style to preserve.
          const origQuote = fileSourceCache.get(match.file)[leaf.start - 1];
          if (origQuote === "'" && /'/.test(shape.text)) {
            unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (apostrophe in single-quoted data)' });
            totalUnmatched++;
            continue;
          }
        }
        if (leaf.kind === 'collection') {
          // Frontmatter values are simple YAML scalars. Refuse anything
          // structural.
          if (/[:\n"'#]/.test(shape.text)) {
            unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe frontmatter value)' });
            totalUnmatched++;
            continue;
          }
        }
        const line = src.slice(0, leaf.start).split('\n').length;
        const modeTag = leaf.kind === 'prop' ? `prop:${leaf.propName}`
                      : leaf.kind === 'data' ? 'data'
                      : 'collection';
        changes.push({
          file: match.file, line,
          old: leafText, new: shapeText,
          mode: modeTag,
        });
        if (!editsByFile.has(match.file)) editsByFile.set(match.file, []);
        editsByFile.get(match.file).push({
          start: leaf.start, end: leaf.end,
          replacement: shape.text,
          oldText: leaf.text, newText: shape.text,
        });
        totalChanges++;
        continue;
      }

      if (!isSafeLeaf(leaf.text)) {
        // Refuse to edit unsafe leaves — log as unmatched-by-policy.
        unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe leaf)' });
        totalUnmatched++;
        continue;
      }

      // V2: style / link / font / prop analyzers run independently of text
      // changes. They may emit edits even if leafText == shapeText.
      runStyleAnalyzers(shape, leaf, match.file);

      // Compare current source content (after entity decode + whitespace
      // collapse) against the Penpot shape text. If they match modulo the
      // normalizer, no edit is required. We collapse internal whitespace too
      // because source leaves often wrap across multiple indented lines while
      // Penpot returns a single-spaced version. The normalizeForMatch
      // comparison handles the case-insensitive case (CSS uppercase, bullet
      // glyphs) — if the matcher classified this as "exact", the source and
      // canvas content are equivalent and no edit is needed.
      const leafTrim  = collapseWs(decodeEntities(leaf.text));
      const shapeTrim = collapseWs(shape.text);
      if (leafTrim === shapeTrim) continue;
      // If both sides normalize to the same string (e.g. only differ in
      // case because CSS applies `text-transform: uppercase`), the source is
      // already the canonical form — skip.
      if (normalizeForMatch(leaf.text) === normalizeForMatch(shape.text)
          || normalizeLoose(leaf.text) === normalizeLoose(shape.text)) {
        continue;
      }

      // Guard against substr/fuzzy matches where the leaf is a STRICT SUBSET
      // of the Penpot shape — that means the source split the text across
      // multiple leaves (e.g. around an HTML comment / <br/>) and the Penpot
      // harvester merged them. Editing only the matched leaf would lose the
      // trailing text in the other leaf. Skip and flag. Only fires for substr
      // mode (fuzzy mode requires similar lengths anyway). The multi-leaf
      // pass already handles the legitimate concat cases; if we got here in
      // substr mode it's a genuine ambiguity.
      if (match.mode === 'substr') {
        const leafNorm  = normalizeForMatch(leaf.text);
        const shapeNorm = normalizeForMatch(shape.text);
        if (shapeNorm.length > leafNorm.length
            && shapeNorm.includes(leafNorm)
            && (shapeNorm.length - leafNorm.length) > 16) {
          unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (split across leaves)' });
          totalUnmatched++;
          continue;
        }
      }

      // For prefix/suffix modes the leaf text is shorter/longer than shape
      // text but is anchored at the start. composeNewLeafText replaces the
      // visible content wholesale (preserving surrounding whitespace), so
      // the same path handles prefix/suffix as well as exact/substr/fuzzy.
      const replacement = composeNewLeafText(leaf.text, shape.text);
      if (replacement === leaf.text) continue;

      // Final safety: the proposed replacement must itself be safe (no
      // angle brackets injected via the shape text, balanced braces). This
      // guards the new fuzzy passes against pathological shape.text values.
      if (!isSafeLeaf(replacement)) {
        unmatched.push({ text: shape.text.slice(0, 60).replace(/\s+/g, ' ') + ' (unsafe replacement)' });
        totalUnmatched++;
        continue;
      }

      // Compute line number for logging.
      const line = src.slice(0, leaf.start).split('\n').length;

      changes.push({
        file: match.file, line,
        old: leafTrim, new: shapeTrim,
        mode: match.mode,
      });
      if (!editsByFile.has(match.file)) editsByFile.set(match.file, []);
      editsByFile.get(match.file).push({
        start: leaf.start, end: leaf.end,
        replacement,
        oldText: leaf.text, newText: replacement,
      });
      totalChanges++;
    }

    // Loop 8: move-detection (preview only — no writes in V2).
    // Use perShapeMatches to detect when canvas y-order disagrees with source
    // leaf order. We use a CONSERVATIVE bucketing: shapes whose matched leaves
    // share the same IMMEDIATE enclosing tagName + adjacency in source
    // (consecutive leaves of the same tag, no other leaves between them).
    // This avoids needing real HTML balance tracking (findEnclosingTag walks
    // back through closed siblings without tracking depth — see V3 note).
    //
    // For now we only report ADJACENT-IN-CANVAS pairs whose leafStart order
    // is reversed AND both leaves are siblings under the same enclosing
    // tagName (heuristic: tag.tagName equal AND parent.tagStart equal). The
    // parent detection is unreliable for tightly-nested layouts but works
    // for siblings inside the same containing block.
    const moveBuckets = new Map();
    for (const rec of perShapeMatches) {
      if (rec.kind !== 'text') continue;
      const src = fileSourceCache.get(rec.file);
      if (!src) continue;
      const tag = findEnclosingTag(src, rec.leaf.start);
      if (!tag) continue;
      // Bucket only by the leaf's immediate tagName + file. This is the
      // conservative fallback — siblings of the same type clustering together.
      const key = `${rec.file}:${tag.tagName}`;
      if (!moveBuckets.has(key)) moveBuckets.set(key, []);
      moveBuckets.get(key).push({
        shapeY: rec.shape.y, leafStart: rec.leaf.start, leaf: rec.leaf, file: rec.file, shapeText: rec.shape.text,
      });
    }
    for (const items of moveBuckets.values()) {
      if (items.length < 2) continue;
      const byCanvas = [...items].sort((a, b) => a.shapeY - b.shapeY);
      const bySource = [...items].sort((a, b) => a.leafStart - b.leafStart);
      if (byCanvas.every((it, i) => it.leafStart === bySource[i].leafStart)) continue;
      for (let i = 0; i < byCanvas.length - 1; i++) {
        if (byCanvas[i].leafStart > byCanvas[i+1].leafStart) {
          const src = fileSourceCache.get(byCanvas[i].file);
          const line = src.slice(0, byCanvas[i].leafStart).split('\n').length;
          changes.push({
            file: byCanvas[i].file, line,
            old: `"${collapseWs(decodeEntities(byCanvas[i].leaf.text)).slice(0, 30)}" before "${collapseWs(decodeEntities(byCanvas[i+1].leaf.text)).slice(0, 30)}"`,
            new: `(swap not yet auto-written — V3)`,
            mode: 'move-preview',
          });
        }
      }
    }

    perBoardLog.push({ board: b.name, changes, unmatched });
  }

  // ─── Loop 7: deletion detection ──────────────────────────────────────────
  //
  // Load the previous-sync snapshot of matched leaves; any entry that has no
  // match in the current run is a candidate for deletion. We re-locate the
  // leaf by searching the current file's text leaves for the same normalized
  // text. If found AND the enclosing tag is a "safe-to-delete" element
  // (<p> or <li>) AND nothing else in the run claimed it, we propose a
  // deletion edit.
  const deletionChanges = [];
  let lastSync = null;
  try { lastSync = JSON.parse(fs.readFileSync(LAST_SYNC_PATH, 'utf8')); } catch {}
  if (lastSync && Array.isArray(lastSync.matchedTextLeaves)) {
    // Index current matches for O(1) lookup.
    const currentSet = new Set(matchedTextLeaves.map(e => `${e.file}::${e.normText}`));
    for (const prev of lastSync.matchedTextLeaves) {
      const key = `${prev.file}::${prev.normText}`;
      if (currentSet.has(key)) continue;
      // Re-find the leaf in source.
      const src = fileSourceCache.get(prev.file);
      const leaves = fileLeafCache.get(prev.file);
      if (!src || !leaves) continue;
      const matchIdx = leaves.findIndex(l => l.kind == null && normalizeForMatch(l.text) === prev.normText);
      if (matchIdx === -1) continue; // already gone
      const leaf = leaves[matchIdx];
      const tag = findEnclosingTag(src, leaf.start);
      if (!tag) continue;
      const tn = tag.tagName.toLowerCase();
      if (tn !== 'p' && tn !== 'li') continue;
      // Confirm the leaf is the ENTIRE visible content of the enclosing tag.
      // Find the matching closing tag.
      const closeRe = new RegExp(`</${tn}\\s*>`, 'gi');
      closeRe.lastIndex = leaf.end;
      const cm = closeRe.exec(src);
      if (!cm) continue;
      const tagInner = src.slice(tag.tagEnd, cm.index);
      // Allow surrounding whitespace; refuse if there's a `<` inside (other tags).
      if (tagInner.includes('<')) continue;
      // Build deletion edit: remove from start-of-line containing the open tag
      // to end-of-line of the close tag (inclusive).
      let delStart = tag.tagStart;
      while (delStart > 0 && src[delStart - 1] !== '\n') delStart--;
      let delEnd = cm.index + cm[0].length;
      while (delEnd < src.length && src[delEnd] !== '\n') delEnd++;
      if (src[delEnd] === '\n') delEnd++;
      if (!APPLY_DELETIONS) {
        deletionChanges.push({
          file: prev.file,
          line: src.slice(0, tag.tagStart).split('\n').length,
          old: src.slice(tag.tagStart, cm.index + cm[0].length).replace(/\s+/g, ' '),
          new: '(would delete — pass --apply-deletions to commit)',
          mode: 'delete-preview',
        });
      } else {
        if (!editsByFile.has(prev.file)) editsByFile.set(prev.file, []);
        editsByFile.get(prev.file).push({
          start: delStart, end: delEnd,
          replacement: '',
          oldText: src.slice(delStart, delEnd), newText: '',
        });
        deletionChanges.push({
          file: prev.file,
          line: src.slice(0, tag.tagStart).split('\n').length,
          old: src.slice(tag.tagStart, cm.index + cm[0].length).replace(/\s+/g, ' '),
          new: '(deleted)',
          mode: 'delete',
        });
        totalChanges++;
      }
    }
  }
  if (deletionChanges.length > 0) {
    perBoardLog.push({ board: 'deletions', changes: deletionChanges, unmatched: [] });
  }

  // Persist new snapshot (best-effort — only if we have a state dir).
  // Idempotency requires this not to race; the snapshot reflects EXACTLY this
  // run's matched leaves and we write it AFTER all matching is done.
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    // For dry-runs we still update the snapshot — it's metadata, not source.
    fs.writeFileSync(LAST_SYNC_PATH, JSON.stringify({
      timestamp: new Date().toISOString(),
      matchedTextLeaves,
    }, null, 0));
  } catch (e) {
    process.stderr.write(`[state] failed to write ${LAST_SYNC_PATH}: ${e.message}\n`);
  }

  // ─── Output: per-board log to stdout ──────────────────────────────────────

  let diffOut = '';
  for (const { board, changes, unmatched } of perBoardLog) {
    process.stdout.write(`── ${board} ──\n`);
    if (changes.length === 0 && unmatched.length === 0) {
      process.stdout.write('  (no changes, no unmatched shapes)\n');
      continue;
    }
    for (const c of changes) {
      const rel = path.relative(PORTFOLIO_DIR, c.file);
      const oldShort = c.old.length > 60 ? c.old.slice(0, 57) + '…' : c.old;
      const newShort = c.new.length > 60 ? c.new.slice(0, 57) + '…' : c.new;
      process.stdout.write(`  ${rel}:${c.line}: "${oldShort}" → "${newShort}" [${c.mode}]\n`);
    }
    for (const u of unmatched) {
      process.stdout.write(`  unmatched: "${u.text}"\n`);
    }
  }

  // ─── Write phase ──────────────────────────────────────────────────────────

  const editedFiles = [];
  if (totalChanges > 0) {
    for (const [file, edits] of editsByFile.entries()) {
      const { src } = loadFile(file);
      const newSrc = applyEdits(src, edits);
      const reason = sanityOK(src, newSrc, file);
      if (reason) {
        process.stderr.write(`REFUSED ${path.relative(PORTFOLIO_DIR, file)}: sanity check failed (${reason})\n`);
        continue;
      }
      // Refuse if any edit text contains `<script>` or `<style>` markers.
      const dangerous = edits.some(e =>
        /<\s*(script|style)\b/i.test(e.replacement) ||
        /<\s*(script|style)\b/i.test(e.oldText)
      );
      if (dangerous) {
        process.stderr.write(`REFUSED ${path.relative(PORTFOLIO_DIR, file)}: edit touches script/style content\n`);
        continue;
      }

      const diff = unifiedDiff(path.relative(PORTFOLIO_DIR, file), src, newSrc);
      diffOut += diff;

      if (DRY_RUN || OUT_DIFF) continue;
      // Real write — back up first.
      fs.writeFileSync(file + '.bak', src);
      fs.writeFileSync(file, newSrc);
      editedFiles.push(file);
    }
  }

  if (OUT_DIFF) {
    fs.writeFileSync(OUT_DIFF, diffOut);
    process.stderr.write(`Wrote diff to ${OUT_DIFF} (${diffOut.length} bytes)\n`);
  } else if (DRY_RUN && diffOut) {
    process.stdout.write('\n' + diffOut);
  }

  const fileCount = editedFiles.length || editsByFile.size;
  process.stderr.write(
    `Summary: ${totalChanges} change${totalChanges === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'}; ${totalUnmatched} unmatched shape${totalUnmatched === 1 ? '' : 's'}\n`
  );
  return 0;
}

// ─── Self-test (small, runs at file invocation time) ─────────────────────────

async function selfTest() {
  process.stderr.write('[self-test] connecting to MCP @ ' + MCP_URL + '\n');
  const sid = await mcpInit();
  const res = await readCanvas(sid);
  const boards = res?.result?.boards || [];
  if (boards.length === 0) throw new Error('self-test: no boards on canvas');
  const totalShapes = boards.reduce((n, b) => n + b.shapes.length, 0);
  process.stderr.write(`[self-test] read ${boards.length} board(s), ${totalShapes} text shape(s)\n`);

  // Parse the three known pages, ensure each yields >= 1 leaf.
  for (const name of ['index.astro', 'consulting.astro', 'blog.astro']) {
    const p = path.join(SRC_DIR, 'pages', name);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const leaves = extractTextLeaves(src);
    process.stderr.write(`[self-test] ${name}: ${leaves.length} text leaves\n`);
  }
  process.stderr.write('[self-test] OK\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      // Always self-test first — bails fast if the canvas is empty or MCP
      // is down, which would otherwise produce a confusing "0 changes" diff.
      // In snapshot mode, skip the live MCP probe (used for offline tests).
      if (!FROM_SNAPSHOT) await selfTest();
      const rc = await run();
      process.exit(rc);
    } catch (err) {
      process.stderr.write(`canvas-to-portfolio: ${err.message}\n`);
      process.exit(1);
    }
  })();
}

export { extractTextLeaves, normalizeForMatch, normalizeLoose, levenshtein, matchShape, composeNewLeafText, isSafeLeaf };

/*
 * V2 roadmap (not implemented in V1):
 *
 *  - Color / font edits: read shape.fillColor and shape.fontFamily/fontSize,
 *    detect when they diverge from the source's inline-style or the CSS rule
 *    that targets the leaf, and write the corresponding CSS variable update.
 *    Tricky bit: the source uses CSS variables (var(--ink), var(--accent)) so
 *    the rewrite has to find the variable declaration and edit that, not the
 *    leaf-side `color:` line.
 *
 *  - Link href edits: link shapes carry `name = "link: <href>"`. Compare to
 *    the `href="..."` attribute on the `<a>` ancestor of the matched leaf.
 *    Re-find that attribute via a simple regex anchored at the leaf and
 *    rewrite it.
 *
 *  - New-shape ingestion: a shape that wins zero match passes and has a
 *    reasonable position (inside a known board, sane font size, prose-like
 *    text) should be appended as a new `<p>` (or `<a>` for a link shape) to
 *    a sentinel insertion point in the page (e.g. before a comment marker
 *    like `<!-- canvas-to-portfolio: insert here -->`). Penpot is then the
 *    add-content source of truth.
 *
 *  - Deletion: a leaf that exists in the source but has no corresponding
 *    Penpot shape should be flagged (not auto-deleted in V2 either — too
 *    easy to clobber content the user only hid in Penpot).
 *
 *  - Component-aware mapping: today home-board text is matched against every
 *    component file by greedy first-match. A smarter mapper would use shape
 *    `y` coordinates to bucket shapes by section, then match each bucket
 *    against the component whose name matches the section.
 */
