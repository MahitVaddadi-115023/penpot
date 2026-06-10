// compiler.mjs — Antigravity Bridge markup compiler (v1)
//
// Pure ES module. No dependencies. Importable both in the Penpot plugin
// iframe (<script type="module">) and in `node --test`.
//
// v1 supports: board, group, rectangle, ellipse, text (shapes); anchor (bindings).
// Everything else is reported as `unsupported_in_v1`.
//
// Public API (locked contract — sub-agent E depends on this):
//   parse(text)               -> { ir, errors }
//   format(ir)                -> string                (textual surface form)
//   validate(ir)              -> ValidationError[]
//   compile(ir, currentState) -> { mutations, skipped } // NOTE: object, not array
//   decompile(state)          -> IR
//   applyMutations(state, m)  -> CanvasState           (helper, also useful for sandbox)
//   SUPPORTED_SHAPES, SUPPORTED_BINDINGS
//
// See SPEC.md §§3, 4, 6, 7, 8 for the source-of-truth grammar/semantics.

export const SUPPORTED_SHAPES = Object.freeze(['board', 'group', 'rectangle', 'ellipse', 'text']);
export const SUPPORTED_BINDINGS = Object.freeze(['anchor']);

// SPEC-AMBIG: SPEC §3 lists 9 shape types; v1 brief locks us to 5. Boolean/path/image/svg-raw
// validate as `unsupported_in_v1`. Likewise `arrow` and `constraint` bindings.

const BASE_FIELDS = new Set(['id', 'type', 'parent', 'x', 'y', 'w', 'h', 'rotation', 'opacity', 'locked', 'name', 'meta']);
const SHAPE_COMMANDS = {
  board: 'board', group: 'group', rect: 'rectangle', ellipse: 'ellipse', text: 'text',
  bool: 'boolean', path: 'path', image: 'image', svg: 'svg-raw',
};
const COMMAND_FOR_TYPE = {
  board: 'board', group: 'group', rectangle: 'rect', ellipse: 'ellipse', text: 'text',
  boolean: 'bool', path: 'path', image: 'image', 'svg-raw': 'svg',
};

// ---------- small helpers ----------

const err = (path, code, message, extra = {}) => ({ path, code, message, ...extra });

function deepClone(x) {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(deepClone);
  const out = {};
  for (const k of Object.keys(x)) out[k] = deepClone(x[k]);
  return out;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// ---------- parse() ----------

export function parse(text) {
  if (typeof text !== 'string') return { ir: null, errors: [err('', 'bad_input', 'parse() expects a string')] };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJSON(text);
  return parseText(text);
}

function parseJSON(text) {
  let ir;
  try { ir = JSON.parse(text); }
  catch (e) {
    const m = /position\s+(\d+)/.exec(e.message);
    let line, col;
    if (m) ({ line, col } = offsetToLineCol(text, Number(m[1])));
    return { ir: null, errors: [err('', 'json_parse_error', e.message, { line, col })] };
  }
  return { ir, errors: [] };
}

function offsetToLineCol(text, offset) {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

// ----- textual surface parser (SPEC §7) -----
//
// SPEC-AMBIG: SPEC §7.2 lists `\anchor` paths as bare PATH tokens (containing `.`, `:`,
// `[`, `]`), but the published lexer table tokenizes `.` as a separator only inside
// numbers, and doesn't list `:`/`[`/`]` as path-significant. To keep the lexer small
// and unambiguous, we require anchor paths to be written as quoted strings in textual
// surface form. The JSON IR is unaffected (its `anchored[]` entries are always strings).

function parseText(src) {
  const errors = [];
  const tokens = lex(src, errors);
  if (errors.length) return { ir: null, errors };
  const ir = { v: 1, page: '', shapes: [], bindings: [], anchored: [], tokens: {} };
  const p = { tokens, i: 0, errors };
  try {
    while (!atEnd(p)) {
      const t = peek(p);
      if (t.kind !== 'COMMAND') {
        errors.push(err('', 'parse_error', `unexpected token "${t.value}"`, { line: t.line, col: t.col }));
        advance(p);
        continue;
      }
      switch (t.value) {
        case 'page':    parsePage(p, ir); break;
        case 'tokens':  parseTokensBlock(p, ir); break;
        case 'anchor':  parseAnchorDecl(p, ir); break;
        case 'bind':    parseBindDecl(p, ir); break;
        case 'note':    parseNote(p, ir, null); break;
        default:        parseShape(p, ir, null);
      }
    }
  } catch (e) {
    if (e && e.__parse) errors.push(e.__parse);
    else throw e;
  }
  if (errors.length) return { ir: null, errors };
  if (!ir.page) return { ir: null, errors: [err('', 'missing_page', '\\page declaration required')] };
  return { ir, errors: [] };
}

// --- lexer ---

function lex(src, errors) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const advChar = () => { if (src[i] === '\n') { line++; col = 1; } else col++; i++; };
  while (i < src.length) {
    const c = src[i];
    if (c === '%') { while (i < src.length && src[i] !== '\n') advChar(); continue; }
    if (/\s/.test(c)) { advChar(); continue; }
    const sl = line, sc = col;
    if (c === '\\') {
      advChar();
      let name = '';
      while (i < src.length && /[a-z0-9-]/i.test(src[i])) { name += src[i]; advChar(); }
      if (!name) { errors.push(err('', 'lex_error', 'bare backslash', { line: sl, col: sc })); continue; }
      tokens.push({ kind: 'COMMAND', value: name, line: sl, col: sc });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c; advChar();
      let s = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { s += src[i + 1]; advChar(); advChar(); }
        else { s += src[i]; advChar(); }
      }
      if (i >= src.length) errors.push(err('', 'lex_error', 'unterminated string', { line: sl, col: sc }));
      else advChar();
      tokens.push({ kind: 'STRING', value: s, line: sl, col: sc });
      continue;
    }
    if (c === '#') {
      let s = '#'; advChar();
      while (i < src.length && /[0-9A-Fa-f]/.test(src[i])) { s += src[i]; advChar(); }
      tokens.push({ kind: 'COLOR', value: s, line: sl, col: sc });
      continue;
    }
    // arrow `->`
    if (c === '-' && src[i + 1] === '>') {
      advChar(); advChar();
      tokens.push({ kind: 'ARROW', value: '->', line: sl, col: sc });
      continue;
    }
    // token-def `--name` (used only inside `\tokens` block)
    if (c === '-' && src[i + 1] === '-') {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) { s += src[i]; advChar(); }
      tokens.push({ kind: 'TOKEN_DEF', value: s, line: sl, col: sc });
      continue;
    }
    // signed number
    if (c === '-' && /\d/.test(src[i + 1] || '')) {
      let s = '-'; advChar();
      while (i < src.length && /[0-9.]/.test(src[i])) { s += src[i]; advChar(); }
      tokens.push({ kind: 'NUMBER', value: parseFloat(s), line: sl, col: sc });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i])) { s += src[i]; advChar(); }
      tokens.push({ kind: 'NUMBER', value: parseFloat(s), line: sl, col: sc });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) { s += src[i]; advChar(); }
      // var(--x)
      if (s === 'var' && src[i] === '(') {
        let body = ''; advChar();
        while (i < src.length && src[i] !== ')') { body += src[i]; advChar(); }
        if (src[i] === ')') advChar();
        tokens.push({ kind: 'TOKEN_REF', value: `var(${body.trim()})`, line: sl, col: sc });
        continue;
      }
      tokens.push({ kind: 'IDENT', value: s, line: sl, col: sc });
      continue;
    }
    if ('(){},=:;'.includes(c)) {
      const map = { '(': 'LPAREN', ')': 'RPAREN', '{': 'LBRACE', '}': 'RBRACE', ',': 'COMMA', '=': 'EQ', ':': 'COLON', ';': 'SEMI' };
      tokens.push({ kind: map[c], value: c, line: sl, col: sc });
      advChar();
      continue;
    }
    errors.push(err('', 'lex_error', `unexpected character "${c}"`, { line: sl, col: sc }));
    advChar();
  }
  return tokens;
}

// --- token-stream helpers ---

const atEnd = (p) => p.i >= p.tokens.length;
const peek = (p, n = 0) => p.tokens[p.i + n];
const advance = (p) => p.tokens[p.i++];
function expect(p, kind, value) {
  const t = peek(p);
  if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
    const what = value !== undefined ? `${kind}("${value}")` : kind;
    const got = t ? `${t.kind}("${t.value}")` : 'EOF';
    throw { __parse: err('', 'parse_error', `expected ${what}, got ${got}`, t ? { line: t.line, col: t.col } : {}) };
  }
  return advance(p);
}

// --- production rules ---

function parsePage(p, ir) {
  expect(p, 'COMMAND', 'page');
  ir.page = expect(p, 'IDENT').value;
}

function parseTokensBlock(p, ir) {
  expect(p, 'COMMAND', 'tokens');
  expect(p, 'LBRACE');
  while (!atEnd(p) && peek(p).kind !== 'RBRACE') {
    const def = expect(p, 'TOKEN_DEF');
    expect(p, 'COLON');
    const v = parseValue(p);
    ir.tokens[def.value] = String(v);
    if (peek(p) && peek(p).kind === 'SEMI') advance(p);
  }
  expect(p, 'RBRACE');
}

function parseAnchorDecl(p, ir) {
  // Anchor paths are quoted strings in the textual surface (see SPEC-AMBIG above).
  expect(p, 'COMMAND', 'anchor');
  while (!atEnd(p) && peek(p).kind === 'STRING') {
    ir.anchored.push(advance(p).value);
  }
}

function parseBindDecl(p, ir) {
  expect(p, 'COMMAND', 'bind');
  const kind = expect(p, 'IDENT').value;
  if (kind !== 'anchor' && kind !== 'arrow' && kind !== 'constraint') {
    throw { __parse: err('', 'parse_error', `unknown bind kind "${kind}"`) };
  }
  const from = parseBindRef(p);
  expect(p, 'ARROW');
  const to = parseBindRef(p);
  const props = parsePropList(p);
  if (kind === 'anchor' && from.side) props.fromSide = from.side;
  if (kind === 'anchor' && to.side) props.toSide = to.side;
  const id = props.id || `bind-${ir.bindings.length + 1}`;
  delete props.id;
  ir.bindings.push({ id, type: kind, fromId: from.id, toId: to.id, props });
}

function parseBindRef(p) {
  const id = expect(p, 'IDENT').value;
  if (peek(p) && peek(p).kind === 'COLON') {
    advance(p);
    const side = expect(p, 'IDENT').value;
    return { id, side };
  }
  return { id, side: null };
}

function parseShape(p, ir, parentId) {
  const cmd = expect(p, 'COMMAND');
  const irType = SHAPE_COMMANDS[cmd.value];
  if (!irType) throw { __parse: err('', 'parse_error', `unknown command \\${cmd.value}`, { line: cmd.line, col: cmd.col }) };
  const idTok = expect(p, 'IDENT');
  const id = idTok.value;
  const shape = { id, type: irType, x: 0, y: 0, props: {} };
  if (parentId) shape.parent = parentId;
  // geometry?
  if (peek(p) && peek(p).kind === 'LPAREN') {
    advance(p);
    const nums = [];
    while (peek(p) && peek(p).kind !== 'RPAREN') {
      nums.push(expect(p, 'NUMBER').value);
      if (peek(p) && peek(p).kind === 'COMMA') advance(p);
    }
    expect(p, 'RPAREN');
    if (nums.length >= 1) shape.x = nums[0];
    if (nums.length >= 2) shape.y = nums[1];
    if (nums.length >= 3) shape.w = nums[2];
    if (nums.length >= 4) shape.h = nums[3];
  }
  // prop list
  const props = parsePropList(p);
  for (const k of Object.keys(props)) {
    if (BASE_FIELDS.has(k)) shape[k] = props[k];
    else shape.props[k] = props[k];
  }
  ir.shapes.push(shape);
  // children
  if (peek(p) && peek(p).kind === 'LBRACE') {
    advance(p);
    if (irType === 'text') {
      // text body — join token surface values; loses original whitespace but preserves content.
      // SPEC-AMBIG: SPEC §7.2 defines `text_body` but doesn't specify whitespace preservation;
      // we join with single spaces and trim. Authors who care about exact spacing should use
      // `text="..."` as a prop instead.
      const parts = [];
      while (!atEnd(p) && peek(p).kind !== 'RBRACE') parts.push(String(advance(p).value));
      if (!('text' in shape.props)) shape.props.text = parts.join(' ').trim();
      expect(p, 'RBRACE');
    } else {
      while (!atEnd(p) && peek(p).kind !== 'RBRACE') {
        const t = peek(p);
        if (t.kind === 'COMMAND') {
          if (t.value === 'note') parseNote(p, ir, id);
          else parseShape(p, ir, id);
        } else {
          throw { __parse: err('', 'parse_error', `unexpected token in children: ${t.kind}`, { line: t.line, col: t.col }) };
        }
      }
      expect(p, 'RBRACE');
    }
  }
}

function parseNote(p, ir, parentId) {
  expect(p, 'COMMAND', 'note');
  expect(p, 'LBRACE');
  const parts = [];
  while (!atEnd(p) && peek(p).kind !== 'RBRACE') parts.push(String(advance(p).value));
  expect(p, 'RBRACE');
  const note = parts.join(' ').trim();
  if (parentId) {
    const sh = ir.shapes.find(s => s.id === parentId);
    if (sh) { sh.meta = sh.meta || {}; sh.meta.note = note; }
  } else {
    ir.meta = ir.meta || {}; ir.meta.note = note;
  }
}

function parsePropList(p) {
  const out = {};
  while (!atEnd(p)) {
    const t = peek(p);
    if (t.kind !== 'IDENT') break;
    const eq = peek(p, 1);
    if (!eq || eq.kind !== 'EQ') break;
    const key = advance(p).value;
    advance(p); // EQ
    out[key] = parseValue(p);
  }
  return out;
}

function parseValue(p) {
  const t = peek(p);
  if (!t) throw { __parse: err('', 'parse_error', 'expected value, got EOF') };
  if (t.kind === 'NUMBER' || t.kind === 'STRING' || t.kind === 'COLOR' || t.kind === 'TOKEN_REF') return advance(p).value;
  if (t.kind === 'IDENT') return advance(p).value;
  if (t.kind === 'LBRACE') return parseInlineObj(p);
  throw { __parse: err('', 'parse_error', `unexpected value token ${t.kind}`, { line: t.line, col: t.col }) };
}

function parseInlineObj(p) {
  expect(p, 'LBRACE');
  const out = {};
  while (!atEnd(p) && peek(p).kind !== 'RBRACE') {
    const key = expect(p, 'IDENT').value;
    expect(p, 'COLON');
    out[key] = parseValue(p);
    if (peek(p) && peek(p).kind === 'COMMA') advance(p);
  }
  expect(p, 'RBRACE');
  return out;
}

// ---------- format() ----------

export function format(ir) {
  const lines = [];
  lines.push(`\\page ${ir.page}`);
  if (ir.tokens && Object.keys(ir.tokens).length) {
    lines.push('\\tokens {');
    for (const k of Object.keys(ir.tokens)) lines.push(`  ${k}: ${formatValue(ir.tokens[k])};`);
    lines.push('}');
  }
  // group children by parent
  const childrenOf = new Map();
  for (const s of ir.shapes) {
    const par = s.parent || null;
    if (!childrenOf.has(par)) childrenOf.set(par, []);
    childrenOf.get(par).push(s);
  }
  const renderShape = (shape, indent) => {
    const pad = '  '.repeat(indent);
    const cmd = COMMAND_FOR_TYPE[shape.type] || shape.type;
    let line = `${pad}\\${cmd} ${shape.id}`;
    const geom = [];
    if (typeof shape.x === 'number') geom.push(shape.x);
    if (typeof shape.y === 'number') geom.push(shape.y);
    if (typeof shape.w === 'number') geom.push(shape.w);
    if (typeof shape.h === 'number') geom.push(shape.h);
    if (geom.length) line += ` (${geom.join(', ')})`;
    for (const k of ['rotation', 'opacity', 'locked', 'name']) {
      if (shape[k] !== undefined) line += ` ${k}=${formatValue(shape[k])}`;
    }
    for (const k of Object.keys(shape.props || {})) {
      if (shape.type === 'text' && k === 'text') continue;
      line += ` ${k}=${formatValue(shape.props[k])}`;
    }
    const kids = childrenOf.get(shape.id) || [];
    if (shape.type === 'text' && shape.props && typeof shape.props.text === 'string') {
      line += ` { ${shape.props.text} }`;
      lines.push(line);
    } else if (kids.length) {
      lines.push(line + ' {');
      for (const c of kids) renderShape(c, indent + 1);
      lines.push(pad + '}');
    } else {
      lines.push(line);
    }
  };
  for (const s of childrenOf.get(null) || []) renderShape(s, 0);
  for (const b of ir.bindings || []) {
    let from = b.fromId, to = b.toId;
    if (b.type === 'anchor') {
      if (b.props && b.props.fromSide) from = `${from}:${b.props.fromSide}`;
      if (b.props && b.props.toSide) to = `${to}:${b.props.toSide}`;
    }
    const propsCopy = { ...(b.props || {}) };
    delete propsCopy.fromSide; delete propsCopy.toSide;
    let line = `\\bind ${b.type} ${from} -> ${to}`;
    if (b.id && !/^bind-\d+$/.test(b.id)) line += ` id=${formatValue(b.id)}`;
    for (const k of Object.keys(propsCopy)) line += ` ${k}=${formatValue(propsCopy[k])}`;
    lines.push(line);
  }
  if (ir.anchored && ir.anchored.length) {
    lines.push('\\anchor ' + ir.anchored.map(a => JSON.stringify(a)).join(' '));
  }
  return lines.join('\n') + '\n';
}

function formatValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if (/^var\(--[A-Za-z][A-Za-z0-9-]*\)$/.test(v)) return v;
    if (/^#[0-9A-Fa-f]{3,8}$/.test(v)) return v;
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(v)) return v;
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(formatValue).join(',') + ']';
  if (typeof v === 'object') {
    const parts = Object.keys(v).map(k => `${k}:${formatValue(v[k])}`);
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---------- validate() ----------

export function validate(ir) {
  const errors = [];
  if (!ir || typeof ir !== 'object') { errors.push(err('', 'bad_ir', 'IR must be an object')); return errors; }
  if (ir.v !== 1) errors.push(err('v', 'bad_version', `unsupported IR version ${ir.v}`));
  if (typeof ir.page !== 'string' || !ir.page) errors.push(err('page', 'missing_page', 'page name required'));
  if (!Array.isArray(ir.shapes)) { errors.push(err('shapes', 'bad_shapes', 'shapes must be array')); return errors; }
  const seenIds = new Set();
  for (let i = 0; i < ir.shapes.length; i++) {
    const s = ir.shapes[i];
    const path = `shapes[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(err(path, 'bad_shape', 'shape must be object')); continue; }
    if (typeof s.id !== 'string' || !s.id) errors.push(err(`${path}.id`, 'bad_id', 'shape id required'));
    if (seenIds.has(s.id)) errors.push(err(`${path}.id`, 'duplicate_id', `duplicate shape id "${s.id}"`));
    seenIds.add(s.id);
    if (!SUPPORTED_SHAPES.includes(s.type)) {
      errors.push(err(`${path}.type`, 'unsupported_in_v1', `shape type "${s.type}" not supported in v1`));
      continue;
    }
    if (typeof s.x !== 'number' || typeof s.y !== 'number') {
      errors.push(err(path, 'bad_geometry', 'x/y must be numbers'));
    }
    if (s.opacity !== undefined && (typeof s.opacity !== 'number' || s.opacity < 0 || s.opacity > 1)) {
      errors.push(err(`${path}.opacity`, 'bad_opacity', 'opacity must be in [0,1]'));
    }
    if (s.type === 'text' && s.props && Array.isArray(s.props.runs)) {
      errors.push(err(`${path}.props.runs`, 'unsupported_in_v1', 'rich text runs not supported in v1'));
    }
  }
  // parent refs exist
  for (let i = 0; i < ir.shapes.length; i++) {
    const s = ir.shapes[i];
    if (s && s.parent && !seenIds.has(s.parent)) {
      errors.push(err(`shapes[${i}].parent`, 'unknown_parent', `unknown parent "${s.parent}"`));
    }
  }
  // bindings
  if (ir.bindings) {
    if (!Array.isArray(ir.bindings)) errors.push(err('bindings', 'bad_bindings', 'bindings must be array'));
    else for (let i = 0; i < ir.bindings.length; i++) {
      const b = ir.bindings[i];
      const bpath = `bindings[${i}]`;
      if (!SUPPORTED_BINDINGS.includes(b.type)) {
        errors.push(err(`${bpath}.type`, 'unsupported_in_v1', `binding type "${b.type}" not supported in v1`));
        continue;
      }
      if (!seenIds.has(b.fromId)) errors.push(err(`${bpath}.fromId`, 'unknown_shape', `unknown shape "${b.fromId}"`));
      if (!seenIds.has(b.toId)) errors.push(err(`${bpath}.toId`, 'unknown_shape', `unknown shape "${b.toId}"`));
    }
  }
  if (ir.anchored) {
    for (let i = 0; i < ir.anchored.length; i++) {
      const ap = ir.anchored[i];
      if (typeof ap !== 'string' || !/^(shape:|binding:|page\.|tokens\.)/.test(ap)) {
        errors.push(err(`anchored[${i}]`, 'bad_anchor_path', `invalid anchor path "${ap}"`));
      }
    }
  }
  // token-ref resolution (warnings; literal preserved at compile time)
  const tokens = ir.tokens || {};
  const walk = (v, pathPrefix) => {
    if (typeof v === 'string') {
      const m = /^var\((--[A-Za-z][A-Za-z0-9-]*)\)$/.exec(v);
      if (m && !(m[1] in tokens)) {
        errors.push(err(pathPrefix, 'unresolved_token', `unresolved token "${m[1]}" (kept literal)`, { severity: 'warning' }));
      }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k], `${pathPrefix}.${k}`);
    }
  };
  for (let i = 0; i < ir.shapes.length; i++) {
    const s = ir.shapes[i];
    if (s && s.props) walk(s.props, `shapes[${i}].props`);
  }
  return errors;
}

// ---------- compile() ----------

export function compile(ir, currentState) {
  const mutations = [];
  const skipped = [];
  const state = currentState || { page: ir.page, shapes: [], bindings: [] };
  const anchored = new Set(ir.anchored || []);

  const stateById = new Map();
  for (const s of state.shapes || []) stateById.set(s.id, s);
  const irById = new Map();
  for (const s of ir.shapes) irById.set(s.id, s);

  // 1. deletes (preserving `preserve-*` shapes)
  for (const s of state.shapes || []) {
    if (irById.has(s.id)) continue;
    if (s.id.startsWith('preserve-')) continue;
    mutations.push({ op: 'delete', shapeId: s.id });
  }

  // 2. creates (parents first)
  const ordered = orderParentsFirst(ir.shapes);
  for (const s of ordered) {
    if (stateById.has(s.id)) continue;
    const fields = buildFieldsFromShape(s);
    // Record any anchored fields on a brand-new shape for visibility, but still
    // emit the create — the shape would otherwise not exist.
    for (const k of Object.keys(fields)) {
      const apath = anchorPathFor(s.id, k);
      if (anchored.has(apath)) skipped.push({ path: apath, reason: 'create-anchored', value: fields[k] });
    }
    mutations.push({
      op: 'create',
      shapeId: s.id,
      shapeType: s.type,
      parent: s.parent || null,
      fields,
    });
  }

  // 3. updates + reparents
  for (const s of ir.shapes) {
    const live = stateById.get(s.id);
    if (!live) continue;
    if ((live.parent || null) !== (s.parent || null)) {
      mutations.push({ op: 'reparent', shapeId: s.id, parent: s.parent || null });
    }
    const desired = buildFieldsFromShape(s);
    const current = buildFieldsFromShape(live);
    const diff = {};
    let anySkip = false;
    for (const k of Object.keys(desired)) {
      if (deepEqual(desired[k], current[k])) continue;
      const apath = anchorPathFor(s.id, k);
      if (anchored.has(apath)) {
        skipped.push({ path: apath, reason: 'anchored', value: desired[k] });
        anySkip = true;
        continue;
      }
      diff[k] = desired[k];
    }
    if (Object.keys(diff).length) {
      mutations.push({ op: 'update', shapeId: s.id, fields: diff });
    }
    // If anySkip and no other diff, mutation is intentionally dropped (per spec).
    void anySkip;
  }

  return { mutations: orderMutations(mutations), skipped };
}

function anchorPathFor(id, fieldKey) {
  if (BASE_FIELDS.has(fieldKey)) return `shape:${id}.${fieldKey}`;
  if (fieldKey.startsWith('props.')) return `shape:${id}.${fieldKey}`;
  return `shape:${id}.props.${fieldKey}`;
}

function buildFieldsFromShape(s) {
  const out = {};
  for (const k of ['x', 'y', 'w', 'h', 'rotation', 'opacity', 'locked', 'name']) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  if (s.meta !== undefined) out.meta = s.meta;
  for (const k of Object.keys(s.props || {})) out['props.' + k] = s.props[k];
  return out;
}

function orderParentsFirst(shapes) {
  const byId = new Map(shapes.map(s => [s.id, s]));
  const placed = new Set();
  const out = [];
  const visit = (s) => {
    if (placed.has(s.id)) return;
    if (s.parent && byId.has(s.parent) && !placed.has(s.parent)) visit(byId.get(s.parent));
    placed.add(s.id);
    out.push(s);
  };
  for (const s of shapes) visit(s);
  return out;
}

function orderMutations(muts) {
  const deletes = muts.filter(m => m.op === 'delete');
  const creates = muts.filter(m => m.op === 'create');
  const updates = muts.filter(m => m.op === 'update');
  const reparents = muts.filter(m => m.op === 'reparent');
  return [...deletes, ...creates, ...updates, ...reparents];
}

// ---------- decompile() ----------

export function decompile(state) {
  const ir = { v: 1, page: state.page || 'page', shapes: [], bindings: [], anchored: [], tokens: {} };
  for (const s of state.shapes || []) ir.shapes.push(deepClone(s));
  for (const b of state.bindings || []) ir.bindings.push(deepClone(b));
  return ir;
}

// ---------- applyMutations() — helper for tests and sandbox prototyping ----------

export function applyMutations(state, mutations) {
  const next = {
    page: state && state.page ? state.page : 'page',
    shapes: state && state.shapes ? deepClone(state.shapes) : [],
    bindings: state && state.bindings ? deepClone(state.bindings) : [],
  };
  for (const m of mutations) {
    if (m.op === 'delete') {
      next.shapes = next.shapes.filter(s => s.id !== m.shapeId);
    } else if (m.op === 'create') {
      const shape = { id: m.shapeId, type: m.shapeType, parent: m.parent || null, x: 0, y: 0, props: {} };
      applyFields(shape, m.fields || {});
      next.shapes.push(shape);
    } else if (m.op === 'update') {
      const shape = next.shapes.find(s => s.id === m.shapeId);
      if (shape) applyFields(shape, m.fields || {});
    } else if (m.op === 'reparent') {
      const shape = next.shapes.find(s => s.id === m.shapeId);
      if (shape) shape.parent = m.parent || null;
    }
  }
  return next;
}

function applyFields(shape, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('props.')) {
      shape.props = shape.props || {};
      shape.props[k.slice(6)] = v;
    } else {
      shape[k] = v;
    }
  }
}
