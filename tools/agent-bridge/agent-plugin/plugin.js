// plugin.js — Penpot plugin runtime entry for "Antigravity Bridge".
//
// Runs in Penpot's plugin sandbox (NOT the iframe). Three jobs:
//   1. Open the UI panel (index.html, served by dev-server.mjs on :9010).
//   2. Forward Penpot events into the iframe (theme/page/selection/shapechange).
//   3. Apply incoming `apply` mutations against penpot.* and emit `canvasState`
//      snapshots in the reverse direction.
//
// The second arg to penpot.ui.open is a *path relative to the manifest URL*.
// We pass `?theme=...` (matching every reference plugin in
// penpot/plugins/apps/) so the iframe can theme itself; index.html is served
// at the root of :9010 by dev-server.mjs.
//
// Mutation/snapshot wire format is locked by tools/agent-bridge/SPEC.md and
// the compiler.mjs contract in agent-plugin/compiler.mjs.

const theme = (() => { try { return penpot.theme; } catch { return 'dark'; } })();
penpot.ui.open('Antigravity Bridge', `?theme=${theme}`, { width: 1100, height: 800 });

// --- small helpers -----------------------------------------------------------

function send(type, content) {
  try { penpot.ui.sendMessage({ type, content }); } catch (e) {
    // sandbox can be torn down before async events fire; swallow.
  }
}

function log(...args) {
  // Visible in Penpot's devtools console (Plugin Manager > inspect).
  try { console.log('[agent-bridge]', ...args); } catch {}
}

// --- initial state snapshot --------------------------------------------------

try {
  if (penpot.currentPage) {
    send('page', { id: penpot.currentPage.id, name: penpot.currentPage.name });
  }
} catch {}

try {
  const sel = penpot.selection || [];
  send('selection', sel.map((s) => ({ id: s.id, name: s.name, type: s.type })));
} catch {}

// --- event forwarders --------------------------------------------------------

penpot.on('themechange', (newTheme) => {
  send('theme', newTheme);
});

penpot.on('pagechange', (page) => {
  send('page', page ? { id: page.id, name: page.name } : null);
  scheduleSnapshot('pagechange');
});

// `shapechange` requires a `shapeId` in props per the type defs — we
// (re)subscribe to the currently-selected shapes whenever selection changes,
// disposing the previous listeners so we don't leak.
let shapeListenerIds = [];
function clearShapeListeners() {
  for (const id of shapeListenerIds) {
    try { penpot.off(id); } catch {}
  }
  shapeListenerIds = [];
}

function subscribeToSelection(selection) {
  clearShapeListeners();
  for (const shape of selection) {
    try {
      const lid = penpot.on('shapechange', (s) => {
        send('shape', {
          id: s && s.id,
          name: s && s.name,
          type: s && s.type,
          x: s && s.x, y: s && s.y,
          width: s && s.width, height: s && s.height,
        });
        scheduleSnapshot('shapechange');
      }, { shapeId: shape.id });
      shapeListenerIds.push(lid);
    } catch (e) {
      log('shapechange subscribe failed for', shape && shape.id, e && e.message);
    }
  }
}

penpot.on('selectionchange', (ids) => {
  // Resolve ids -> shapes for nicer payloads in the Status pane.
  let shapes = [];
  try {
    shapes = (penpot.selection || []).map((s) => ({
      id: s.id, name: s.name, type: s.type,
    }));
  } catch {}
  send('selection', shapes.length ? shapes : (ids || []).map((id) => ({ id })));
  try { subscribeToSelection(penpot.selection || []); } catch {}
  scheduleSnapshot('selectionchange');
});

// Subscribe to whatever is already selected at load time.
try { subscribeToSelection(penpot.selection || []); } catch {}

// --- canvas snapshot emitter -------------------------------------------------
//
// The compiler's CanvasState shape: { page, shapes: Shape[], bindings: [] }
// where each Shape is { id, type, parent, x, y, w, h, ...base, props: {...} }.
// We only emit shape types the v1 compiler supports — anything else lives on
// the canvas but is invisible to the markup pane (round-trip preserves it
// because we don't synthesise deletes for it on the iframe side).
const SUPPORTED_TYPES = new Set(['board', 'group', 'rectangle', 'ellipse', 'text']);
const PENPOT_TO_IR = {
  board: 'board',
  group: 'group',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  text: 'text',
  // Unsupported in v1 — we don't include them in the snapshot.
  boolean: null,
  path: null,
  'svg-raw': null,
  image: null,
};

// Suppress repeat warnings about multi-fill / multi-stroke shapes (one log per shape id).
const warnedMultiFill = new Set();
const warnedMultiStroke = new Set();

// Parse a Penpot dimension-ish string (e.g. "12", "12px", "1.5") to a finite number.
// Returns undefined for anything we can't read or for 'mixed'.
function parsePenpotNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v === 'mixed' || !v.length) return undefined;
  // Strip a trailing unit ("px", "em") if any; lineHeight is usually unitless.
  const m = /^(-?\d+(?:\.\d+)?)/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return isFinite(n) ? n : undefined;
}

function shapeToIR(s) {
  if (!s) return null;
  try {
    const irType = PENPOT_TO_IR[s.type] || null;
    if (!irType || !SUPPORTED_TYPES.has(irType)) return null;
    // Use shape.name as the IR id (we set name = shapeId on create — see applier).
    const id = (s.name && typeof s.name === 'string' && s.name.length) ? s.name : s.id;
    const parentRaw = (() => {
      try { return s.parent || null; } catch { return null; }
    })();
    // Page root is the parent for top-level shapes; treat it as null.
    let parent = null;
    if (parentRaw) {
      try {
        const pt = parentRaw.type;
        // Skip page-root parent — manifest as null.
        if (pt && pt !== 'page' && pt !== 'frame-root') {
          parent = (parentRaw.name && typeof parentRaw.name === 'string' && parentRaw.name.length)
            ? parentRaw.name : parentRaw.id;
        }
      } catch {}
    }
    const out = {
      id,
      type: irType,
      parent,
      x: numOr0(s.x),
      y: numOr0(s.y),
      w: numOr0(s.width),
      h: numOr0(s.height),
      props: {},
    };
    // ---- Optional base fields — omit when at default (undefined ≠ destructive update).
    try { if (typeof s.rotation === 'number' && s.rotation !== 0) out.rotation = s.rotation; } catch {}
    try { if (typeof s.opacity === 'number' && s.opacity !== 1) out.opacity = s.opacity; } catch {}
    try { if (s.blocked === true) out.locked = true; } catch {}

    // ---- Fill (any type with own fills): pick fills[0].fillColor.
    try {
      if (Array.isArray(s.fills) && s.fills.length) {
        const f0 = s.fills[0];
        if (f0 && typeof f0.fillColor === 'string' && f0.fillColor.length) {
          out.props.fill = f0.fillColor;
        }
        if (s.fills.length > 1 && !warnedMultiFill.has(s.id)) {
          warnedMultiFill.add(s.id);
          log('shape', id, 'has multi-fill (' + s.fills.length + '); only first preserved in markup');
        }
      }
    } catch {}

    // ---- Stroke (rectangle/ellipse/text): pick strokes[0].strokeColor + strokeWidth.
    if (irType === 'rectangle' || irType === 'ellipse' || irType === 'text') {
      try {
        if (Array.isArray(s.strokes) && s.strokes.length) {
          const st0 = s.strokes[0];
          if (st0 && typeof st0.strokeColor === 'string' && st0.strokeColor.length) {
            out.props.stroke = st0.strokeColor;
          }
          if (st0 && typeof st0.strokeWidth === 'number' && isFinite(st0.strokeWidth)) {
            out.props.strokeWidth = st0.strokeWidth;
          }
          if (s.strokes.length > 1 && !warnedMultiStroke.has(s.id)) {
            warnedMultiStroke.add(s.id);
            log('shape', id, 'has multi-stroke (' + s.strokes.length + '); only first preserved in markup');
          }
        }
      } catch {}
    }

    // ---- Rectangle: corner radius.
    if (irType === 'rectangle') {
      try {
        if (typeof s.borderRadius === 'number' && s.borderRadius !== 0) {
          out.props.radius = s.borderRadius;
        }
      } catch {}
    }

    // ---- Text: characters + type-specific font/typography fields.
    if (irType === 'text') {
      try {
        if (typeof s.characters === 'string') out.props.text = s.characters;
      } catch {}
      // fontSize: Penpot stores as string-or-'mixed'; IR wants a number.
      try {
        const n = parsePenpotNumber(s.fontSize);
        if (n !== undefined) out.props.fontSize = n;
      } catch {}
      try {
        if (typeof s.fontFamily === 'string' && s.fontFamily.length && s.fontFamily !== 'mixed') {
          out.props.fontFamily = s.fontFamily;
        }
      } catch {}
      try {
        if (typeof s.fontWeight === 'string' && s.fontWeight.length && s.fontWeight !== 'mixed') {
          out.props.fontWeight = s.fontWeight;
        }
      } catch {}
      try {
        const lh = parsePenpotNumber(s.lineHeight);
        if (lh !== undefined) out.props.lineHeight = lh;
      } catch {}
      try {
        if (typeof s.align === 'string' && s.align.length && s.align !== 'mixed') {
          out.props.align = s.align;
        }
      } catch {}
    }

    return out;
  } catch (e) {
    // One bad shape must not abort the whole snapshot.
    try { log('shapeToIR failed for', s && s.id, e && e.message); } catch {}
    return null;
  }
}

function numOr0(n) { return (typeof n === 'number' && isFinite(n)) ? n : 0; }

function buildCanvasState() {
  const page = (() => { try { return penpot.currentPage; } catch { return null; } })();
  if (!page) return { page: 'page', shapes: [], bindings: [] };
  let raw = [];
  try { raw = page.findShapes() || []; } catch { raw = []; }
  const shapes = [];
  for (const s of raw) {
    const ir = shapeToIR(s);
    if (ir) shapes.push(ir);
  }
  return {
    page: page.name || page.id || 'page',
    shapes,
    bindings: [],
  };
}

// Debounce sandbox-side snapshots — page walks can be expensive.
let snapshotTimer = null;
let snapshotSuppressUntil = 0;
// Diff-fallback bookkeeping (Gap 2): JSON of the last canvasState we *sent* to
// the iframe, plus the timestamp of that send. The periodic diff loop early-
// exits when JSON matches the last-sent baseline, and throttles to avoid
// firing immediately after a real `shapechange`-triggered send.
let lastSentSnapshotJson = '';
let lastSnapshotSentAt = 0;
// Soft cost ceiling — if a snapshot build takes longer than this we skip the
// next periodic tick and log a warning. Cheap protection for huge canvases.
const SNAPSHOT_SLOW_MS = 50;
let skipNextPeriodic = false;

function emitSnapshot(reason) {
  let t0 = 0, state;
  try { t0 = Date.now(); state = buildCanvasState(); }
  catch (e) { log('snapshot failed', reason, e && e.message); return; }
  const dur = Date.now() - t0;
  if (dur > SNAPSHOT_SLOW_MS) {
    skipNextPeriodic = true;
    log('snapshot slow', reason, dur + 'ms', '(' + (state.shapes || []).length + ' shapes) — skipping next periodic tick');
  }
  let json;
  try { json = JSON.stringify(state); } catch { json = ''; }
  lastSentSnapshotJson = json;
  lastSnapshotSentAt = Date.now();
  send('canvasState', state);
}

function scheduleSnapshot(reason) {
  if (Date.now() < snapshotSuppressUntil) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    emitSnapshot(reason);
  }, 500);
}

// Periodic full-page diff fallback (Gap 2).
// `shapechange` only fires for shapes that are currently selected, so edits to
// unselected shapes go unnoticed. Walk the page on a 2s cadence and send a
// fresh snapshot when JSON differs from the last sent baseline. Cheap because
// we early-exit on byte-equal JSON and throttle on recent sends + the apply
// suppression window.
const PERIODIC_INTERVAL_MS = 2000;
const PERIODIC_THROTTLE_MS = 500;
setInterval(() => {
  try {
    const now = Date.now();
    if (now < snapshotSuppressUntil) return;
    if (now - lastSnapshotSentAt < PERIODIC_THROTTLE_MS) return;
    if (skipNextPeriodic) { skipNextPeriodic = false; return; }
    let t0 = now, state;
    try { state = buildCanvasState(); }
    catch (e) { log('periodic snapshot build failed', e && e.message); return; }
    const dur = Date.now() - t0;
    if (dur > SNAPSHOT_SLOW_MS) {
      skipNextPeriodic = true;
      log('periodic snapshot slow', dur + 'ms', '(' + (state.shapes || []).length + ' shapes) — skipping next tick');
    }
    let json;
    try { json = JSON.stringify(state); } catch { return; }
    if (json === lastSentSnapshotJson) return; // no canvas change since last send
    lastSentSnapshotJson = json;
    lastSnapshotSentAt = Date.now();
    send('canvasState', state);
  } catch (e) {
    // Belt-and-braces: never let the interval die.
    try { log('periodic snapshot tick threw', e && e.message); } catch {}
  }
}, PERIODIC_INTERVAL_MS);

// Initial snapshot once the page is reachable.
try {
  if (penpot.currentPage) scheduleSnapshot('initial');
} catch {}

// --- mutation applier --------------------------------------------------------
//
// Each mutation: { op, shapeId, shapeType?, parent?, fields? }
// We use shape.name == shapeId for round-trip lookup. fields keys come from
// the compiler's buildFieldsFromShape — base fields like 'x','y','w','h' plus
// props keys prefixed 'props.<key>'.

function findShapeById(name) {
  try {
    const page = penpot.currentPage;
    if (!page) return null;
    const found = page.findShapes({ name }) || [];
    // findShapes by name returns potentially many; we expect 1.
    return found.length ? found[0] : null;
  } catch (e) {
    return null;
  }
}

function applyFieldsToShape(shape, fields) {
  // Base fields → direct assignment when writable.
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    try {
      if (key === 'x') shape.x = value;
      else if (key === 'y') shape.y = value;
      else if (key === 'w' || key === 'h') {
        // Width/height are readonly on ShapeBase; use resize() once we have both.
        // Handled below in second pass.
      }
      else if (key === 'rotation') shape.rotation = value;
      else if (key === 'opacity') shape.opacity = value;
      else if (key === 'locked') shape.blocked = !!value;
      else if (key === 'name') {
        // Don't overwrite the canonical IR id we just set.
      }
      else if (key.startsWith('props.')) {
        applyPropToShape(shape, key.slice(6), value);
      }
    } catch (e) {
      log('field apply failed', key, e && e.message);
    }
  }
  // Resize pass — readonly width/height require resize(w, h).
  if (typeof shape.resize === 'function') {
    const w = fields.w != null ? fields.w : (typeof shape.width === 'number' ? shape.width : undefined);
    const h = fields.h != null ? fields.h : (typeof shape.height === 'number' ? shape.height : undefined);
    if ((fields.w != null || fields.h != null) && typeof w === 'number' && typeof h === 'number') {
      try { shape.resize(w, h); } catch (e) { log('resize failed', e && e.message); }
    }
  }
}

function applyPropToShape(shape, propKey, value) {
  switch (propKey) {
    case 'fill':
      try { shape.fills = [{ fillColor: String(value), fillOpacity: 1 }]; } catch (e) { log('fill set fail', e && e.message); }
      break;
    case 'text':
      try { if ('characters' in shape) shape.characters = String(value); } catch (e) { log('text set fail', e && e.message); }
      break;
    case 'radius':
      try { shape.borderRadius = Number(value); } catch (e) { log('radius set fail', e && e.message); }
      break;
    default:
      // Best-effort generic assignment; unknown props become no-ops.
      try { if (propKey in shape) shape[propKey] = value; } catch {}
      break;
  }
}

function createShape(m) {
  let shape = null;
  switch (m.shapeType) {
    case 'board':
      shape = penpot.createBoard();
      break;
    case 'rectangle':
      shape = penpot.createRectangle();
      break;
    case 'ellipse':
      shape = penpot.createEllipse();
      break;
    case 'text': {
      // createText needs initial content; we'll set characters again from fields below.
      const initial = (m.fields && m.fields['props.text']) ? String(m.fields['props.text']) : 'text';
      shape = penpot.createText(initial);
      break;
    }
    case 'group': {
      // Penpot's group(shapes) requires at least one shape. We can't pre-create
      // an empty group — defer until children land via reparent. For v1 we
      // create a board as a stand-in if no children are present; otherwise the
      // caller should ensure children are reparented under it. Track as TODO.
      shape = penpot.createBoard();
      break;
    }
    default:
      throw new Error('unsupported shapeType: ' + m.shapeType);
  }
  if (!shape) throw new Error('create returned null for ' + m.shapeType);
  // Round-trip lookup convention: shape.name == shapeId from the IR.
  try { shape.name = m.shapeId; } catch {}
  applyFieldsToShape(shape, m.fields || {});
  // Reparent if a parent is specified.
  if (m.parent) {
    const parent = findShapeById(m.parent);
    if (parent && typeof parent.appendChild === 'function') {
      try { parent.appendChild(shape); } catch (e) { log('appendChild on create failed', e && e.message); }
    }
  }
  return shape;
}

function applyMutations(mutations) {
  let ok = 0;
  const failed = [];
  for (const m of mutations || []) {
    try {
      if (m.op === 'create') {
        createShape(m);
        ok += 1;
      } else if (m.op === 'update') {
        const shape = findShapeById(m.shapeId);
        if (!shape) throw new Error('shape not found: ' + m.shapeId);
        applyFieldsToShape(shape, m.fields || {});
        ok += 1;
      } else if (m.op === 'delete') {
        const shape = findShapeById(m.shapeId);
        if (!shape) throw new Error('shape not found: ' + m.shapeId);
        if (typeof shape.remove === 'function') shape.remove();
        else throw new Error('shape has no remove()');
        ok += 1;
      } else if (m.op === 'reparent') {
        const shape = findShapeById(m.shapeId);
        if (!shape) throw new Error('shape not found: ' + m.shapeId);
        if (m.parent) {
          const parent = findShapeById(m.parent);
          if (!parent) throw new Error('parent not found: ' + m.parent);
          if (typeof parent.appendChild !== 'function') throw new Error('parent.appendChild missing');
          parent.appendChild(shape);
        } else {
          // Re-parent to root — currentPage may not expose appendChild; best-effort.
          try {
            const page = penpot.currentPage;
            if (page && typeof page.appendChild === 'function') page.appendChild(shape);
          } catch {}
        }
        ok += 1;
      } else {
        throw new Error('unknown op: ' + m.op);
      }
    } catch (e) {
      failed.push({ shapeId: m.shapeId, error: (e && e.message) || String(e) });
      log('mutation failed', m, e && e.message);
    }
  }
  return { ok, failed };
}

// --- tool dispatch -----------------------------------------------------------
//
// Wire protocol (iframe → sandbox): {type:"tool", id, name, input}
// We reply by emitting {type:"tool.result", id, ok, result?|error?}. The
// iframe forwards this reply over its WS to dev-server, which resolves the
// matching pending HTTP /tool request from newcore.
//
// For markup tools (penpot.set_markup, penpot.patch_markup) the canonical
// state lives in the iframe textarea, not in the sandbox. We forward the
// payload BACK to the iframe (carrying the original id), reply immediately
// with {ok:true, deferred:true} for the synchronous contract, and the iframe
// produces its own tool.result over WS once it has applied the textarea
// change. The dev-server only resolves the request on the *first* tool.result
// it receives for that id, so propagation order matters: send the deferred
// reply LAST (via setTimeout) so the iframe's real reply wins the race.

function sendToolResult(id, ok, payload) {
  try {
    if (ok) penpot.ui.sendMessage({ type: 'tool.result', id, ok: true, result: payload });
    else penpot.ui.sendMessage({ type: 'tool.result', id, ok: false, error: payload });
  } catch (e) {
    log('tool.result send failed', e && e.message);
  }
}

function toolListShapes(input) {
  const pageName = input && input.page;
  const filter = (input && input.filter) || {};
  const page = (() => {
    try { return penpot.currentPage; } catch { return null; }
  })();
  if (!page) return { shapes: [] };
  // findShapes accepts a filter object {type?, name?}; pass through what we got.
  const queryFilter = {};
  if (filter.type) queryFilter.type = filter.type;
  if (filter.name) queryFilter.name = filter.name;
  let raw = [];
  try { raw = page.findShapes(queryFilter) || []; }
  catch (e) {
    // Fallback: walk all + filter manually.
    try {
      const all = page.findShapes() || [];
      raw = all.filter((s) => {
        if (filter.type && s.type !== filter.type) return false;
        if (filter.name && s.name !== filter.name) return false;
        return true;
      });
    } catch { raw = []; }
  }
  // Note: pageName filtering isn't supported by penpot.currentPage; if the
  // caller passes one and it doesn't match, we still operate on the current
  // page but flag it in the result so newcore can decide to retry.
  const pageMatched = !pageName || pageName === page.name;
  return {
    page: page.name || page.id || 'page',
    pageMatched,
    shapes: raw.map((s) => ({
      id: s && s.id,
      name: s && s.name,
      type: s && s.type,
      x: numOr0(s && s.x),
      y: numOr0(s && s.y),
      w: numOr0(s && s.width),
      h: numOr0(s && s.height),
    })),
  };
}

function toolMutateShape(input) {
  const shapeId = input && input.shapeId;
  const fields = (input && input.fields) || {};
  if (!shapeId) throw new Error('missing shapeId');
  const shape = findShapeById(shapeId);
  if (!shape) throw new Error('shape not found: ' + shapeId);
  const applied = [];
  const errors = [];
  // Suppress canvasState bursts during our writes, matching the apply path.
  snapshotSuppressUntil = Date.now() + 750;
  // We piggyback on the existing applier so behaviour stays consistent with
  // the markup-driven path. The applier swallows per-field errors and logs
  // them; we get coarser fidelity here than ideal, but applied[] is at
  // least the set of fields we attempted that didn't throw at dispatch.
  for (const [k, v] of Object.entries(fields)) {
    try {
      applyFieldsToShape(shape, { [k]: v });
      applied.push(k);
    } catch (e) {
      errors.push({ field: k, error: (e && e.message) || String(e) });
    }
  }
  setTimeout(() => { scheduleSnapshot('post-tool-mutate'); }, 800);
  return { shapeId, applied, errors };
}

function dispatchTool(id, name, input) {
  try {
    switch (name) {
      case 'penpot.list_shapes': {
        const result = toolListShapes(input || {});
        sendToolResult(id, true, result);
        return;
      }
      case 'penpot.mutate_shape': {
        const result = toolMutateShape(input || {});
        sendToolResult(id, true, result);
        return;
      }
      case 'penpot.set_markup': {
        const markup = (input && typeof input.markup === 'string') ? input.markup : '';
        // Forward to iframe — the iframe textarea is canonical state, and it
        // will reply with its own tool.result(id) after running the compile
        // pipeline. Sending no fallback reply here: the iframe owns this id.
        try {
          penpot.ui.sendMessage({ type: 'set_markup', id, content: markup });
        } catch (e) {
          sendToolResult(id, false, 'iframe_send_failed: ' + (e && e.message));
        }
        return;
      }
      case 'penpot.patch_markup': {
        const patch = (input && typeof input.patch === 'string') ? input.patch : '';
        try {
          penpot.ui.sendMessage({ type: 'patch_markup', id, content: patch });
        } catch (e) {
          sendToolResult(id, false, 'iframe_send_failed: ' + (e && e.message));
        }
        return;
      }
      default:
        sendToolResult(id, false, 'unknown_tool: ' + name);
    }
  } catch (e) {
    sendToolResult(id, false, (e && e.message) || String(e));
  }
}

// --- iframe → sandbox bridge -------------------------------------------------

penpot.ui.onMessage((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'apply') {
    const content = msg.content || {};
    const mutations = Array.isArray(content.mutations) ? content.mutations : [];
    // Suppress canvasState emissions for a beat — Penpot fires shapechange
    // during our own writes. The iframe also has its own applyingFromMarkup
    // flag; the sandbox-side suppression is belt-and-suspenders.
    snapshotSuppressUntil = Date.now() + 750;
    const result = applyMutations(mutations);
    send('applied', result);
    // After the suppression window, emit a fresh snapshot so iframe state
    // catches up.
    setTimeout(() => { scheduleSnapshot('post-apply'); }, 800);
    return;
  }
  if (msg.type === 'tool' && typeof msg.id === 'string' && typeof msg.name === 'string') {
    dispatchTool(msg.id, msg.name, msg.input);
    return;
  }
  // Everything else: log + ack.
  log('iframe →', msg);
  send('ack', msg);
});
