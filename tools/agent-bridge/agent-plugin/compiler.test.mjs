// compiler.test.mjs — node --test compiler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse, format, validate, compile, decompile, applyMutations,
  SUPPORTED_SHAPES, SUPPORTED_BINDINGS,
} from './compiler.mjs';

// ---------- fixtures ----------

const SAMPLE_TEXT = `\\page home
\\tokens {
  --bg: #FAFAFA;
  --ink: #111111;
  --serif: "GT Sectra";
}

\\board hero (0, 0, 1440, 800) fill=var(--bg) {
  \\text title (64, 120) font=var(--serif) size=96 weight="400" fill=var(--ink) { Consulting }
  \\rect cta (64, 300, 200, 56) fill=#111111 radius=8
}

\\bind anchor hero:bottom -> cta:top offset=24 align=start
\\anchor "shape:title.props.text" "shape:cta.props.fill"
`;

const SAMPLE_IR = {
  v: 1,
  page: 'home',
  tokens: { '--bg': '#FAFAFA', '--ink': '#111111', '--serif': 'GT Sectra' },
  shapes: [
    { id: 'hero', type: 'board', x: 0, y: 0, w: 1440, h: 800, props: { fill: 'var(--bg)' } },
    { id: 'title', type: 'text', parent: 'hero', x: 64, y: 120,
      props: { font: 'var(--serif)', size: 96, weight: '400', fill: 'var(--ink)', text: 'Consulting' } },
    { id: 'cta', type: 'rectangle', parent: 'hero', x: 64, y: 300, w: 200, h: 56,
      props: { fill: '#111111', radius: 8 } },
  ],
  bindings: [
    { id: 'bind-1', type: 'anchor', fromId: 'hero', toId: 'cta',
      props: { offset: 24, align: 'start', fromSide: 'bottom', toSide: 'top' } },
  ],
  anchored: ['shape:title.props.text', 'shape:cta.props.fill'],
};

// ---------- module shape ----------

test('exports the locked contract', () => {
  assert.equal(typeof parse, 'function');
  assert.equal(typeof format, 'function');
  assert.equal(typeof validate, 'function');
  assert.equal(typeof compile, 'function');
  assert.equal(typeof decompile, 'function');
  assert.equal(typeof applyMutations, 'function');
  assert.deepEqual([...SUPPORTED_SHAPES], ['board', 'group', 'rectangle', 'ellipse', 'text']);
  assert.deepEqual([...SUPPORTED_BINDINGS], ['anchor']);
});

// ---------- parse / round-trip ----------

test('parse(text) returns an IR matching the canonical sample', () => {
  const { ir, errors } = parse(SAMPLE_TEXT);
  assert.deepEqual(errors, []);
  assert.equal(ir.v, 1);
  assert.equal(ir.page, 'home');
  assert.equal(ir.shapes.length, 3);
  const title = ir.shapes.find(s => s.id === 'title');
  assert.equal(title.props.text, 'Consulting');
  assert.equal(title.props.font, 'var(--serif)');
  assert.equal(title.props.size, 96);
  assert.equal(ir.bindings[0].props.fromSide, 'bottom');
  assert.deepEqual(ir.anchored, ['shape:title.props.text', 'shape:cta.props.fill']);
});

test('round-trip: text → IR → text → IR (deep equal)', () => {
  const a = parse(SAMPLE_TEXT).ir;
  const text2 = format(a);
  const b = parse(text2).ir;
  assert.deepEqual(b, a);
});

test('round-trip: JSON-IR → text → JSON-IR (deep equal)', () => {
  const text = format(SAMPLE_IR);
  const { ir, errors } = parse(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(ir, SAMPLE_IR);
});

test('parse auto-detects JSON input', () => {
  const json = JSON.stringify(SAMPLE_IR);
  const { ir, errors } = parse(json);
  assert.deepEqual(errors, []);
  assert.deepEqual(ir, SAMPLE_IR);
});

test('parse reports JSON error with line/col', () => {
  const { ir, errors } = parse('{ "bad": ');
  assert.equal(ir, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'json_parse_error');
});

// ---------- validate ----------

test('validate: valid IR passes', () => {
  const errs = validate(SAMPLE_IR);
  // SAMPLE_IR has all tokens defined; should be zero errors and zero warnings.
  assert.deepEqual(errs, []);
});

test('validate: unsupported shape type → unsupported_in_v1', () => {
  const ir = { ...SAMPLE_IR, shapes: [{ id: 'a', type: 'boolean', x: 0, y: 0, props: {} }] };
  const errs = validate(ir);
  assert.ok(errs.some(e => e.code === 'unsupported_in_v1'));
});

test('validate: unsupported binding type → unsupported_in_v1', () => {
  const ir = {
    v: 1, page: 'p', shapes: [{ id: 'a', type: 'rectangle', x: 0, y: 0, props: {} }, { id: 'b', type: 'rectangle', x: 0, y: 0, props: {} }],
    bindings: [{ id: 'x', type: 'arrow', fromId: 'a', toId: 'b', props: {} }],
  };
  const errs = validate(ir);
  assert.ok(errs.some(e => e.code === 'unsupported_in_v1' && e.path.startsWith('bindings')));
});

test('validate: unresolved token ref → warning', () => {
  const ir = {
    v: 1, page: 'p', tokens: {},
    shapes: [{ id: 'a', type: 'rectangle', x: 0, y: 0, props: { fill: 'var(--missing)' } }],
  };
  const errs = validate(ir);
  const warn = errs.find(e => e.code === 'unresolved_token');
  assert.ok(warn);
  assert.equal(warn.severity, 'warning');
});

test('validate: duplicate shape id', () => {
  const ir = {
    v: 1, page: 'p',
    shapes: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, props: {} },
      { id: 'a', type: 'rectangle', x: 0, y: 0, props: {} },
    ],
  };
  const errs = validate(ir);
  assert.ok(errs.some(e => e.code === 'duplicate_id'));
});

// ---------- compile ----------

test('compile: empty canvas → creates in parent-before-child order', () => {
  const { mutations, skipped } = compile(SAMPLE_IR, null);
  assert.deepEqual(skipped.filter(s => s.reason === 'anchored'), []);
  const creates = mutations.filter(m => m.op === 'create');
  // hero must come before its children
  const idx = (id) => creates.findIndex(m => m.shapeId === id);
  assert.ok(idx('hero') < idx('title'));
  assert.ok(idx('hero') < idx('cta'));
  // no deletes/updates/reparents on empty canvas
  assert.equal(mutations.filter(m => m.op === 'delete').length, 0);
  assert.equal(mutations.filter(m => m.op === 'update').length, 0);
  assert.equal(mutations.filter(m => m.op === 'reparent').length, 0);
});

test('compile idempotency: re-compile after apply yields zero mutations', () => {
  const { mutations: m1 } = compile(SAMPLE_IR, null);
  const next = applyMutations(null, m1);
  const { mutations: m2 } = compile(SAMPLE_IR, next);
  assert.deepEqual(m2, []);
});

test('compile: anchored field change is skipped, mutation dropped', () => {
  const seedIR = { ...SAMPLE_IR, anchored: ['shape:cta.props.fill'] };
  const seed = applyMutations(null, compile(seedIR, null).mutations);
  // Now change ONLY the anchored field (cta.props.fill) in the IR.
  const irChanged = JSON.parse(JSON.stringify(seedIR));
  const cta = irChanged.shapes.find(s => s.id === 'cta');
  cta.props.fill = '#222222';
  const { mutations, skipped } = compile(irChanged, seed);
  // No mutation should touch cta because the only diff is the anchored field.
  assert.equal(mutations.filter(m => m.shapeId === 'cta').length, 0);
  assert.ok(skipped.some(s => s.path === 'shape:cta.props.fill'));
});

test('compile: delete preservation — `preserve-*` shapes survive', () => {
  const seed = applyMutations(null, compile(SAMPLE_IR, null).mutations);
  // Inject an out-of-band preserve-* shape that the IR does not know about.
  seed.shapes.push({ id: 'preserve-debug', type: 'rectangle', parent: null, x: 0, y: 0, props: {} });
  const { mutations } = compile(SAMPLE_IR, seed);
  assert.equal(mutations.filter(m => m.op === 'delete').length, 0);
});

test('compile: shapes in state but not IR → deletes (when not preserve-*)', () => {
  const seed = applyMutations(null, compile(SAMPLE_IR, null).mutations);
  seed.shapes.push({ id: 'ghost', type: 'rectangle', parent: null, x: 0, y: 0, props: {} });
  const { mutations } = compile(SAMPLE_IR, seed);
  const deletes = mutations.filter(m => m.op === 'delete');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].shapeId, 'ghost');
});

test('compile: reparent emitted when parent changes', () => {
  const seed = applyMutations(null, compile(SAMPLE_IR, null).mutations);
  const irChanged = JSON.parse(JSON.stringify(SAMPLE_IR));
  // Move cta out from under hero to page root.
  const cta = irChanged.shapes.find(s => s.id === 'cta');
  cta.parent = null;
  const { mutations } = compile(irChanged, seed);
  const reparents = mutations.filter(m => m.op === 'reparent');
  assert.equal(reparents.length, 1);
  assert.equal(reparents[0].shapeId, 'cta');
  assert.equal(reparents[0].parent, null);
});

test('compile: token-ref preserved literal in mutation fields', () => {
  const { mutations } = compile(SAMPLE_IR, null);
  const heroCreate = mutations.find(m => m.op === 'create' && m.shapeId === 'hero');
  assert.equal(heroCreate.fields['props.fill'], 'var(--bg)');
});

test('compile + validate: undefined token still produces mutations', () => {
  const ir = {
    v: 1, page: 'p', tokens: {},
    shapes: [{ id: 'r', type: 'rectangle', x: 0, y: 0, w: 10, h: 10, props: { fill: 'var(--missing)' } }],
  };
  const warnings = validate(ir);
  assert.ok(warnings.some(w => w.code === 'unresolved_token'));
  const { mutations } = compile(ir, null);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].fields['props.fill'], 'var(--missing)');
});

// ---------- decompile / round-trip ----------

test('decompile then compile against same state produces zero mutations', () => {
  const seed = applyMutations(null, compile(SAMPLE_IR, null).mutations);
  const ir2 = decompile(seed);
  const { mutations } = compile(ir2, seed);
  assert.deepEqual(mutations, []);
});

// ---------- ordering ----------

test('compile: mutation order is deletes → creates → updates → reparents', () => {
  const seed = applyMutations(null, compile(SAMPLE_IR, null).mutations);
  // Add a ghost (to be deleted), change a non-anchored field on title, and reparent cta.
  seed.shapes.push({ id: 'ghost', type: 'rectangle', parent: null, x: 0, y: 0, props: {} });
  const irChanged = JSON.parse(JSON.stringify(SAMPLE_IR));
  irChanged.shapes.find(s => s.id === 'title').props.size = 120;
  irChanged.shapes.find(s => s.id === 'cta').parent = null;
  // Also force a create by adding a new shape:
  irChanged.shapes.push({ id: 'newcomer', type: 'rectangle', parent: null, x: 5, y: 5, w: 10, h: 10, props: {} });
  // Drop the anchored entries so the title size change isn't skipped.
  irChanged.anchored = [];
  const { mutations } = compile(irChanged, seed);
  const ops = mutations.map(m => m.op);
  const firstUpdate = ops.indexOf('update');
  const firstReparent = ops.indexOf('reparent');
  const lastCreate = ops.lastIndexOf('create');
  const lastDelete = ops.lastIndexOf('delete');
  assert.ok(lastDelete < lastCreate || lastCreate === -1, 'all deletes before any create');
  assert.ok(lastCreate < firstUpdate || firstUpdate === -1, 'all creates before any update');
  assert.ok(firstUpdate < firstReparent || firstReparent === -1, 'updates before reparents');
});
