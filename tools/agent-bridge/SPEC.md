# Penpot Agent-Bridge DSL — SPEC

Status: draft v0.1 — Phase 1 (spec only, no compiler).
Owner: agent-bridge. Companion runtime: `tools/agent-bridge/agent-plugin/` (Penpot plugin shell).

This document defines a Penpot-native design markup DSL with two surfaces:

1. **JSON IR** — canonical, machine-emitted/consumed, the source of truth.
2. **Textual surface syntax** — LaTeX-flavored, human-friendly, parses to and formats from the JSON IR. Round-trippable.

The compiler emits **mutations** against the live Penpot plugin API (`penpot.currentPage`, shape setters defined in `plugins/libs/plugin-types/index.d.ts`).

---

## Table of contents

1. [Goals & non-goals](#1-goals--non-goals)
2. [JSON IR top-level shape](#2-json-ir-top-level-shape)
3. [Shape discriminated union](#3-shape-discriminated-union)
4. [Bindings](#4-bindings)
5. [Tokens & style refs](#5-tokens--style-refs)
6. [Anchored property paths](#6-anchored-property-paths)
7. [Textual surface syntax](#7-textual-surface-syntax)
8. [Compiler contracts](#8-compiler-contracts)
9. [Validation (zod)](#9-validation-zod)
10. [Versioning & migrations](#10-versioning--migrations)
11. [Full round-trip example](#11-full-round-trip-example)
12. [Open questions](#12-open-questions)

---

## 1. Goals & non-goals

**Goals**

- Give an LLM agent a single, deterministic representation it can read **and** write that maps 1:1 onto Penpot's shape model (`plugins/libs/plugin-types/index.d.ts:3540-3549`).
- Preserve human-edited decisions across re-renders via explicit **anchored property paths** (FigMirror L1/L2/L3 pattern adapted to design state — see `~/coding-agents/repos/FigMirror/.claude/skills/figmirror/references/aesthetic-library.md:253-279`).
- Make agent edits idempotent and reviewable: same IR + same canvas state → same mutation list.

**Non-goals**

- Replacing `.penpot` file format. The IR is an interchange/edit layer above the Penpot plugin API, not a storage format.
- Modeling every Penpot capability (variants, components, prototyping flows, plugin data, library assets are out of scope for v1).
- Building the compiler, parser, or plugin runtime. Those are Phase 2+.

---

## 2. JSON IR top-level shape

```jsonc
{
  "v": 1,                            // schema version (see §10)
  "page": "home",                    // logical page name; matches Penpot Page.name (plugin-types:3056)
  "shapes": [ /* Shape[] — see §3 */ ],
  "bindings": [ /* Binding[] — see §4 */ ],
  "anchored": [
    "shape:hero.props.fill",         // dotted paths preserved across re-renders (§6)
    "shape:title.props.text"
  ],
  "tokens": {                        // optional local L2 layer (§5)
    "--bg": "#FAFAFA",
    "--serif": "GT Sectra",
    "--ink": "#111111"
  }
}
```

**Notes**

- `v` is mandatory. Compiler refuses unknown majors; migrates minors (§10).
- `page` is the logical name only. ID-resolution (name → Penpot `Page.id`) is the compiler's job.
- `shapes` is a **flat** list, not a tree. Parent/child is expressed via `parent` on each shape. The compiler reconstructs the tree using `appendChild` / `insertChild` (Board: `plugin-types/index.d.ts:289-301`; Group: `2139-2150`).
- `bindings` and `anchored` may be omitted (treated as `[]`).
- `tokens` shadows global CSS-var tokens during resolution (§5).

---

## 3. Shape discriminated union

Every shape extends a common `BaseFields` block, then carries a type-specific `props` object. This mirrors tldraw's `TLBaseShape<Type, Props>` pattern (`~/coding-agents/repos/tldraw/packages/tlschema/src/shapes/TLBaseShape.ts:61-77`) and discriminates on `type`.

### 3.1 Common base fields

| Field      | Type                    | Required | Notes                                                                                                |
| ---------- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`       | `string`                | yes      | Stable local ID (e.g. `"hero"`, `"cta-btn"`). Mapped to Penpot's opaque `Shape.id` via name index.   |
| `type`     | `ShapeType`             | yes      | Discriminator. Values mirror Penpot: `board \| group \| boolean \| rectangle \| path \| text \| ellipse \| svg-raw \| image`. See `plugin-types/index.d.ts:3540-3549`. |
| `parent`   | `string \| null`        | no       | ID of parent shape, or `null`/omitted → page root (`Page.root`, `plugin-types/index.d.ts:3067`).      |
| `x`        | `number`                | yes      | Absolute canvas X; mirrors `ShapeBase.x` (`plugin-types/index.d.ts:3580`).                            |
| `y`        | `number`                | yes      | Absolute canvas Y; mirrors `ShapeBase.y` (`:3585`).                                                   |
| `w`        | `number`                | per-type | Width. Applied via `resize(w, h)` (`:3871`). `width` is read-only on `ShapeBase`.                     |
| `h`        | `number`                | per-type | Height, same notes as `w`.                                                                            |
| `rotation` | `number`                | no       | Degrees, applied via `rotate(angle)` (`:3883`). Default 0.                                            |
| `opacity`  | `number` (0..1)         | no       | Mirrors `ShapeBase.opacity` (`:3665`). Default 1.                                                     |
| `locked`   | `boolean`               | no       | Maps to `ShapeBase.blocked` (`:3610`). Default false.                                                 |
| `name`     | `string`                | no       | Display name; if omitted compiler uses `id`. Maps to `ShapeBase.name` (`:3564`).                      |
| `meta`     | `Record<string,unknown>`| no       | Arbitrary JSON; mirrors tldraw `meta` (`TLBaseShape.ts:76`). Stored via Penpot `setPluginData` under the `agent-bridge` namespace (`PluginData`, `plugin-types/index.d.ts:3317-3400`). |
| `props`    | `<type-specific>`       | yes      | See per-type tables below.                                                                            |

### 3.2 Per-type `props`

All `Fill[]` mappings produce Penpot `Fill` objects (`plugin-types/index.d.ts:1680-1706`); strokes produce `Stroke` (`:4009-4051`). For the IR, color/stroke values are either literals (`"#111"`) or token refs (`"var(--ink)"`); see §5.

#### `board` — maps to `Board` (`plugin-types/index.d.ts:209-353`)

| IR prop          | Penpot field                                  | Notes                                           |
| ---------------- | --------------------------------------------- | ----------------------------------------------- |
| `fill`           | `fills[0]` (`Board.fills`, `:264`)            | Single literal-or-token. Compiler wraps in `[{fillColor,fillOpacity}]`. |
| `fills`          | `Board.fills` (`:264`)                        | Use when multi-fill needed. Mutually exclusive with `fill`. |
| `stroke`         | `strokes[0]`                                  | Convenience like `fill`.                        |
| `clip`           | `Board.clipContent` (`:218`)                  | Default `true`.                                 |
| `layout`         | `"flex" \| "grid" \| null`                    | If `"flex"`, compiler calls `addFlexLayout()` (`:320`); if `"grid"`, `addGridLayout()` (`:337`). |
| `flex`           | `FlexLayout` subset (`:1733-1757`, `CommonLayout` `:652-766`) | Keys: `dir, wrap, alignItems, justifyContent, rowGap, columnGap, padding{Top,Right,Bottom,Left}`. |
| `grid`           | `GridLayout` subset (`:1989+`)                | Phase 2; punted for now (see §12).              |
| `sizing`         | `{ h: 'auto'\|'fix', v: 'auto'\|'fix' }`      | Maps to `horizontalSizing` / `verticalSizing` (`:251`, `:259`). |
| `guides`         | `Guide[]` (`:2172`)                           | Optional; passes through.                       |

#### `group` — maps to `Group` (`plugin-types/index.d.ts:2119-2166`)

| IR prop  | Penpot field         | Notes                                  |
| -------- | -------------------- | -------------------------------------- |
| `mask`   | `isMask()`/`makeMask()` (`:2156-2161`) | When `true`, compiler calls `makeMask()` after children are placed. |

Groups have **no own fill/stroke** in Penpot — children carry visuals.

#### `boolean` — maps to `Boolean` (`plugin-types/index.d.ts:370-430`)

| IR prop    | Penpot field                              | Notes                                  |
| ---------- | ----------------------------------------- | -------------------------------------- |
| `op`       | `BooleanType` (`:436`)                    | `'union' \| 'difference' \| 'exclude' \| 'intersection'`. **Note:** Penpot's `Boolean` interface does not expose `op` as a writable field on the shape itself — boolean ops are created via builder calls. Punted (§12). |
| `fill`     | `Boolean.fills[0]` (`:402`)               | Same convenience as `board`.           |
| `d`        | `Boolean.d` (`:392`)                      | SVG path string. Mostly read-only output; supplied by Penpot. |
| `commands` | `Boolean.commands` (`:397`)               | `PathCommand[]` (`:3211-3312`).        |

Children come from `shapes[]` with `parent = <boolean-id>` (`appendChild`, `:418`).

#### `rectangle` — maps to `Rectangle` (`plugin-types/index.d.ts:3447-3457`)

| IR prop        | Penpot field                          | Notes                                  |
| -------------- | ------------------------------------- | -------------------------------------- |
| `fill`         | `Rectangle.fills[0]` (`:3456`)        | Convenience.                           |
| `fills`        | `Rectangle.fills`                     | Multi-fill (gradient stacks, etc.).    |
| `stroke`       | `ShapeBase.strokes[0]` (`:3746`)      | Convenience.                           |
| `strokeWidth`  | `Stroke.strokeWidth` (`:4034`)        | Folded into `stroke` literal.          |
| `strokeAlign`  | `Stroke.strokeAlignment` (`:4038`)    | `'center' \| 'inner' \| 'outer'`.      |
| `radius`       | `ShapeBase.borderRadius` (`:3640`)    | Uniform corner radius.                 |
| `radii`        | `{tl, tr, br, bl}`                    | Per-corner; maps to `borderRadiusTopLeft` etc. (`:3645-3660`). |
| `shadows`      | `ShapeBase.shadows: Shadow[]` (`:3691`, defined `:3490-3537`) | Pass-through array. |
| `blur`         | `ShapeBase.blur?: Blur` (`:3696`)     | Pass-through.                          |

#### `ellipse` — maps to `Ellipse` (`plugin-types/index.d.ts:1491-1498`)

Same `props` shape as `rectangle` **minus** `radius`/`radii` (geometry implied by `w`/`h`).

#### `path` — maps to `Path` (`plugin-types/index.d.ts:3173-3205`)

| IR prop    | Penpot field                       | Notes                                                          |
| ---------- | ---------------------------------- | -------------------------------------------------------------- |
| `d`        | `Path.d` (`:3194`)                 | SVG path string. Either `d` **or** `commands` required.        |
| `commands` | `Path.commands` (`:3199`)          | `PathCommand[]` (`:3211-3312`). Preferred for machine emission.|
| `fill`/`fills` | `Path.fills` (`:3204`)         |                                                                |
| `stroke`   | `ShapeBase.strokes[0]`             |                                                                |

#### `text` — maps to `Text` (`plugin-types/index.d.ts:4078-4193`)

| IR prop      | Penpot field                              | Notes                                                  |
| ------------ | ----------------------------------------- | ------------------------------------------------------ |
| `text`       | `Text.characters` (`:4086`)               | Plain string (rich runs out of scope v1).              |
| `font`       | `Text.fontFamily` (`:4104`)               | Token-ref allowed (`"var(--serif)"`).                  |
| `fontId`     | `Text.fontId` (`:4099`)                   | Optional; if omitted compiler resolves by family.      |
| `size`       | `Text.fontSize` (`:4114`)                 | Number serialized as string per Penpot's API.          |
| `weight`     | `Text.fontWeight` (`:4119`)               | E.g. `"400"`, `"700"`.                                 |
| `style`      | `Text.fontStyle` (`:4124`)                | `'normal' \| 'italic'`.                                |
| `lineHeight` | `Text.lineHeight` (`:4129`)               |                                                        |
| `letterSpacing` | `Text.letterSpacing` (`:4134`)         |                                                        |
| `align`      | `Text.align` (`:4154`)                    | `'left' \| 'center' \| 'right' \| 'justify'`.          |
| `vAlign`     | `Text.verticalAlign` (`:4159`)            | `'top' \| 'center' \| 'bottom'`.                       |
| `decoration` | `Text.textDecoration` (`:4144`)           |                                                        |
| `transform`  | `Text.textTransform` (`:4139`)            |                                                        |
| `grow`       | `Text.growType` (`:4094`)                 | `'fixed' \| 'auto-width' \| 'auto-height'`. Default `'fixed'`. |
| `fill`       | `ShapeBase.fills[0]`                      | Text color via fill (Penpot convention).               |

`'mixed'` is **not** a legal IR value — IR must commit to a single value per property. Round-trip from a `mixed` Penpot state pins each run's value or warns (see §12).

#### `image` — maps to `Image` (`plugin-types/index.d.ts:2309-2316`)

| IR prop  | Penpot field                                                          | Notes                                       |
| -------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `src`    | `Image.fills[0].fillImage` (`ImageData`, `:2322-2356`)                | URL or `imageId`; compiler uploads if URL.  |
| `fit`    | (synthetic) translates to `fillImage.keepAspectRatio`                 | `'cover' \| 'contain' \| 'fill'`.           |
| `alt`    | stored under `meta.alt` (no native Penpot field)                      | Reserved for export pipelines.              |

#### `svg-raw` — maps to `SvgRaw` (`plugin-types/index.d.ts:4070-4072`)

| IR prop | Penpot field | Notes                                                              |
| ------- | ------------ | ------------------------------------------------------------------ |
| `svg`   | (synthetic)  | Raw SVG markup. Compiler decomposes into native primitives where possible; otherwise inserts via `penpot.createShapeFromSvg` (out of `plugin-types/index.d.ts:Context` surface — see §12). |

### 3.3 Shared composite types

- **Fill** literal form: `string` (e.g. `"#FF5733"`, `"var(--bg)"`) — compiler expands to `{ fillColor, fillOpacity: 1 }`.
- **Fill** object form: full Penpot `Fill` (`:1680-1706`) passed through.
- **Stroke** literal form: `string | { color, width?, align?, style? }`.
- **Color refs** to a library color use `{ refFile, refId }` mapping to `fillColorRefFile`/`fillColorRefId` (`:1697-1701`).
- **Shadow**, **Blur**, **Gradient** are pass-through to the matching Penpot interfaces.

---

## 4. Bindings

Bindings are first-class records, separate from shapes (mirrors tldraw's split between shapes and bindings — see `~/coding-agents/repos/tldraw/packages/tlschema/src/bindings/TLBaseBinding.ts:54-70` and `TLArrowBinding.ts:135`).

```ts
type Binding =
  | AnchorBinding
  | ArrowBinding
  | ConstraintBinding;

interface BindingBase<Type extends string, Props> {
  id: string;
  type: Type;
  fromId: string;     // shape id (local)
  toId: string;       // shape id (local)
  props: Props;
  meta?: Record<string, unknown>;
}
```

### 4.1 `anchor` — edge-to-edge positional lock

```jsonc
{
  "id": "anc1",
  "type": "anchor",
  "fromId": "hero",
  "toId": "cta",
  "props": {
    "fromSide": "bottom",        // 'top'|'right'|'bottom'|'left'|'center'
    "toSide":   "top",
    "offset":   24,              // px along the perpendicular axis (gap)
    "align":    "center"         // 'start'|'center'|'end' on the parallel axis
  }
}
```

Compile-time effect: the compiler re-solves `to.x` / `to.y` so that `to[toSide]` sits `offset` from `from[fromSide]`, with `align` controlling the cross-axis. Anchored bindings re-run on every `compile()`; their result is allowed to update positions even when `anchored` lists the same path, because the binding itself **is** the anchor of truth.

### 4.2 `arrow` — visible connector

Mirrors tldraw's `TLArrowBindingProps` (`TLArrowBinding.ts:58-78`) but flattened — we don't yet split arrow shape from arrow binding.

```jsonc
{
  "id": "ar1",
  "type": "arrow",
  "fromId": "boxA",
  "toId":   "boxB",
  "props": {
    "fromAnchor": { "x": 0.5, "y": 1.0 },   // normalized 0..1 on source box
    "toAnchor":   { "x": 0.5, "y": 0.0 },
    "head":       "triangle-arrow",          // StrokeCap (plugin-types:4057-4064)
    "stroke":     "var(--ink)",
    "strokeWidth": 2,
    "elbow":      "edge"                     // 'center'|'edge-point'|'edge'|'none' (tldraw ElbowArrowSnap, TLArrowBinding.ts:28)
  }
}
```

Compiles to a Penpot `Path` shape + two endpoints with `strokeCapStart`/`strokeCapEnd` (`plugin-types/index.d.ts:4042-4046`). The path's `id` is `binding:<id>` so subsequent `compile()` runs find and update it instead of inserting a duplicate.

### 4.3 `constraint` — declarative formula

```jsonc
{
  "id": "c1",
  "type": "constraint",
  "fromId": "cta",
  "toId":   "hero",
  "props": {
    "expr": "from.w = to.w - 64",
    "axes": ["w"]
  }
}
```

- `expr` is a single equation in a tiny expression language: identifiers `from`, `to`, `parent`, `page`; fields `x y w h rotation`; ops `+ - * /`; literals; **no functions** in v1.
- `axes` lists which IR fields on `from` get rewritten. Anything else in the expression is read-only.
- On each `compile()`, constraints run **after** anchor bindings but **before** the diff is emitted.

Constraints whose targets are listed in `anchored` are **skipped** with a warning (anchoring wins — see §6).

---

## 5. Tokens & style refs

Inspired by FigMirror's L1/L2/L3 hierarchy (`~/coding-agents/repos/FigMirror/.claude/skills/figmirror/references/aesthetic-library.md:253-279`):

- **L1 — reference / locked value.** A literal in IR or an anchored path. Highest authority.
- **L2 — token library.** Named, swappable values (`--bg`, `--serif`, `--space-4`). Lives in `tokens` block or in the global portfolio CSS-var registry.
- **L3 — model opinion.** Disallowed in IR. Every value must resolve to L1 or L2.

### 5.1 Value forms

| Form                    | Example                  | Resolves via             |
| ----------------------- | ------------------------ | ------------------------ |
| Literal                 | `"#FAFAFA"`, `96`, `"GT Sectra"` | identity                 |
| Token ref               | `"var(--bg)"`            | tokens table (see 5.2)   |
| Library ref             | `{ refFile, refId }`     | Penpot `LibraryColor` (`plugin-types/index.d.ts:2611+`) |
| Computed (binding-only) | n/a in IR; only in `constraint.expr` |              |

### 5.2 Resolution order

1. Local IR `tokens` (block at top-level).
2. Portfolio CSS-var registry (Phase 2 — provided to compiler as `{[name: string]: string}`).
3. Compile-time fallback (`#000` for color, `0` for number, error for font family).

### 5.3 Penpot design-token bridge

When a token ref resolves to a value that matches a Penpot **design token** (`Token*` interfaces, `plugin-types/index.d.ts:4354-4750`), the compiler may call `applyToken(token, properties)` (`:3955`) instead of writing the literal — preserving the token link inside Penpot. Heuristic: token name in IR matches token name in Penpot. Otherwise compiler writes the literal value.

---

## 6. Anchored property paths

`anchored: string[]` is a list of dotted paths. Compiler diff must **not** overwrite these on re-render unless the IR itself changes the value (i.e., the human edited the IR).

### 6.1 Path grammar

```
<path>     ::= <subject> "." <dotted>
<subject>  ::= "shape:" <id> | "binding:" <id> | "page" | "tokens"
<dotted>   ::= <segment> ("." <segment>)*
<segment>  ::= <ident> | "[" <integer> "]"
```

Examples:

```
shape:hero.x
shape:hero.props.fill
shape:cta.props.shadows[0].blur
binding:anc1.props.offset
tokens.--bg
```

### 6.2 Compile semantics

For each anchored path `P`:

1. Read live value `V_live` from current Penpot state.
2. Read IR value `V_ir` from incoming IR.
3. If `V_ir === V_live` → no-op.
4. If `V_ir !== V_live` and `P` was **edited in IR since last compile** (IR delta has `P`) → mutation emitted; the user's IR edit wins.
5. If `V_ir !== V_live` and IR was **not** edited (path is still its last-compiled value) → **skip with diagnostic**; live state wins. Compiler records the live value into a side-channel so the next `decompile()` updates the IR.

This makes anchored paths "sticky" without being immutable — they're the FigMirror L1-cleaned crop equivalent.

### 6.3 Defaults

Geometry of unmodified board children (`shape:*.x`, `shape:*.y`, `shape:*.w`, `shape:*.h`) is implicitly anchored when the parent has `layout: "flex"|"grid"` — the layout engine owns geometry. Otherwise un-anchored geometry is freely mutable.

---

## 7. Textual surface syntax

LaTeX-flavored, indentation-insensitive, `{}` for children.

### 7.1 Tokens of the lexer

| Token       | Pattern                                      |
| ----------- | -------------------------------------------- |
| `COMMAND`   | `\` followed by `[a-z][a-z0-9-]*`            |
| `IDENT`     | `[A-Za-z_][A-Za-z0-9_-]*`                    |
| `TOKEN_REF` | `var(--[A-Za-z][A-Za-z0-9-]*)`               |
| `TOKEN_DEF` | `--[A-Za-z][A-Za-z0-9-]*` (only inside `\tokens` block) |
| `NUMBER`    | `-?\d+(\.\d+)?`                              |
| `STRING`    | `"..."` with `\"` escape, or single-quoted   |
| `COLOR`     | `#[0-9A-Fa-f]{3,8}`                          |
| `LPAREN/RPAREN/LBRACE/RBRACE/COMMA/EQ/ARROW` | literal `( ) { } , = ->`           |
| `LINECOMMENT` | `%` to EOL (LaTeX-flavor)                  |
| `WS/NL`     | ignored except as token separator            |

### 7.2 Grammar (high level — not full BNF)

```
program        := page_decl tokens_decl? top_node*

page_decl      := "\page" IDENT
tokens_decl    := "\tokens" "{" (TOKEN_DEF ":" value ";")* "}"

top_node       := shape_decl | bind_decl | anchor_decl

shape_decl     := COMMAND IDENT geometry? prop_list? children?
                  // COMMAND is one of: \board \group \bool \rect \ellipse \path \text \image \svg
geometry       := "(" NUMBER "," NUMBER ("," NUMBER ("," NUMBER)?)? ")"
                  // (x, y) | (x, y, w, h) — w/h required for primitives that need them
prop_list      := (IDENT "=" value)+
children       := "{" (top_node | text_body)* "}"
text_body      := "{" RAW_TEXT "}"     // inside \text only

bind_decl      := "\bind" bind_type ref_side "->" ref_side prop_list?
bind_type      := "anchor" | "arrow" | "constraint"
ref_side       := IDENT ("." side)?
side           := "top" | "right" | "bottom" | "left" | "center"

anchor_decl    := "\anchor" PATH (WS PATH)*
                  // PATH is the dotted form from §6.1

value          := NUMBER | STRING | COLOR | TOKEN_REF | IDENT | "{" inline_obj "}"
inline_obj     := (IDENT ":" value ("," IDENT ":" value)*)?
```

### 7.3 Worked example

```latex
\page home
\tokens {
  --bg:    #FAFAFA;
  --ink:   #111111;
  --serif: "GT Sectra";
}

\board hero (0, 0, 1440, 800) fill=var(--bg) layout=flex flex={dir:column,padding:64} {
  \text title (0, 0) font=var(--serif) size=96 weight=400 fill=var(--ink) { Consulting }
  \text sub   (0, 0) font=var(--serif) size=20 weight=400 fill=var(--ink) { Engineering as a service. }
  \rect cta   (0, 0, 200, 56) fill=#111 radius=8
}

\bind anchor hero.bottom -> cta.top offset=24 align=center
\bind arrow  title       -> cta     head=triangle-arrow stroke=var(--ink) strokeWidth=2

\anchor shape:title.props.text  shape:cta.props.fill  tokens.--ink
```

### 7.4 Compilation rules (text → IR)

- `\board`, `\group`, `\bool`, `\rect`, `\ellipse`, `\path`, `\text`, `\image`, `\svg` → `type` in the IR.
- First positional `IDENT` after the command is the shape `id`.
- `(x, y, w, h)` populates the base fields. `w`/`h` defaulted from text bounds for `\text`.
- All `key=value` after geometry become `props.<key>`, **except** the reserved base-field names (`rotation, opacity, locked, name, meta`) which populate the base.
- Children inside `{}` carry `parent = <enclosing id>` in the IR.
- `\bind` produces one entry in `bindings`. `\anchor` accumulates into `anchored`.
- Whitespace and newlines are insignificant. Indentation is for humans only.

### 7.5 Comments and pragmas

- `% line comment` is dropped.
- `\note { ... free text ... }` survives into `meta.note` on the *enclosing* shape (or top-level `meta.note` if outside any shape).

---

## 8. Compiler contracts

Three functions; each must be a pure function of its inputs.

### 8.1 Forward compiler

```ts
type MutationOp =
  | 'create' | 'update' | 'reparent' | 'reorder' | 'delete';

interface Mutation {
  op: MutationOp;
  shapeId: string;          // local IR id; compiler maintains id → Penpot.id mapping
  fields?: Record<string, unknown>;   // for create/update
  parent?: string;          // for reparent
  index?: number;           // for reorder/reparent
}

function compile(
  ir: IR,
  currentPenpotState: PenpotSnapshot,
  options?: { prune?: boolean }
): Mutation[];
```

**Rules.**

1. **Idempotent.** `compile(ir, S) === compile(ir, apply(S, compile(ir, S)))` modulo `[]`. After applying a mutation list, re-running compile against the new state yields `[]`.
2. **Anchored-safe.** A path in `anchored` is honored per §6.2. If skipped, the mutation is dropped and a diagnostic is collected.
3. **Non-destructive by default.** Shapes present in `currentPenpotState` but absent from `ir.shapes` are **left alone** unless `options.prune === true`, in which case they are deleted.
4. **Binding resolution order.** anchor → constraint → diff. Bindings mutate geometry **before** the diff sees the resulting positions, so what's emitted reflects the post-binding world.
5. **History.** All mutations from a single `compile()` are wrapped in one `historyContext.undoBlockBegin()` / `undoBlockFinish()` (`plugin-types/index.d.ts:2291-2302`) by the caller, so undo is a single step.

### 8.2 Reverse compiler

```ts
function decompile(state: PenpotSnapshot, prior?: IR): IR;
```

**Rules.**

1. **Round-trip.** `apply(state0, compile(decompile(state0), state0)) ≡ state0` (modulo ordering & ids).
2. **Anchored continuity.** If `prior` is provided, its `anchored` list and `tokens` are preserved verbatim; only `shapes` and `bindings` are recomputed.
3. **`mixed` handling.** When Penpot returns `'mixed'` (e.g. `Text.fontSize`, `plugin-types/index.d.ts:4114`), decompiler emits the value of the **first** run and records a `meta._warnings` entry on the shape.

### 8.3 Textual ↔ IR

```ts
function parse(text: string): { ir: IR; diagnostics: Diagnostic[] };
function format(ir: IR): string;
```

**Rules.**

1. `format(parse(text).ir)` is stable: re-formatting yields the same string up to whitespace canonicalization.
2. `parse(format(ir)).ir` deep-equals `ir` (modulo property order).
3. Diagnostics carry `{ line, column, message, severity }`.

---

## 9. Validation (zod)

One zod schema per shape type, one per binding type, one for the top-level IR. Schemas live in `tools/agent-bridge/agent-plugin/src/ir/schema.ts` (Phase 2).

Sketch:

```ts
import { z } from 'zod';

const ValueScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const TokenRef    = z.string().regex(/^var\(--[A-Za-z][A-Za-z0-9-]*\)$/);
const ColorLit    = z.string().regex(/^#[0-9A-Fa-f]{3,8}$/);
const ColorValue  = z.union([ColorLit, TokenRef]);

const BaseFields = z.object({
  id:       z.string().min(1),
  parent:   z.string().nullable().optional(),
  x:        z.number(),
  y:        z.number(),
  w:        z.number().optional(),
  h:        z.number().optional(),
  rotation: z.number().optional(),
  opacity:  z.number().min(0).max(1).optional(),
  locked:   z.boolean().optional(),
  name:     z.string().optional(),
  meta:     z.record(z.unknown()).optional(),
});

const RectangleShape = BaseFields.extend({
  type:  z.literal('rectangle'),
  props: z.object({
    fill:        ColorValue.optional(),
    fills:       z.array(z.unknown()).optional(),
    stroke:      ColorValue.optional(),
    strokeWidth: z.number().optional(),
    strokeAlign: z.enum(['center', 'inner', 'outer']).optional(),
    radius:      z.number().optional(),
    radii:       z.object({ tl: z.number(), tr: z.number(), br: z.number(), bl: z.number() }).partial().optional(),
    shadows:     z.array(z.unknown()).optional(),
    blur:        z.unknown().optional(),
  }),
});

// ... one per shape type ...

const Shape = z.discriminatedUnion('type', [
  BoardShape, GroupShape, BooleanShape, RectangleShape,
  EllipseShape, PathShape, TextShape, ImageShape, SvgRawShape,
]);

const Binding = z.discriminatedUnion('type', [AnchorBinding, ArrowBinding, ConstraintBinding]);

export const IR = z.object({
  v:        z.literal(1),
  page:     z.string().min(1),
  shapes:   z.array(Shape),
  bindings: z.array(Binding).optional().default([]),
  anchored: z.array(z.string()).optional().default([]),
  tokens:   z.record(z.string(), z.string()).optional().default({}),
});
```

When validation runs against the **textual surface**, each `ZodIssue` is enriched with source-line info captured during parsing — the parser produces a `SourceMap: Map<JsonPath, { line, col }>` and the validator joins on it.

---

## 10. Versioning & migrations

- `v: 1` is the current major. Compiler refuses any major it does not know.
- Minor schema evolution is handled per-shape, following tldraw's migration pattern (`createBindingPropsMigrationSequence` in `~/coding-agents/repos/tldraw/packages/tlschema/src/bindings/TLArrowBinding.ts:172-185`).

Naming convention for migrations (mirrors tldraw):

```
com.antigravity.agent-bridge.shape.<type>/<n>
com.antigravity.agent-bridge.binding.<type>/<n>
com.antigravity.agent-bridge.ir/<n>
```

Each migration has `{ up(props), down(props) }`. The compiler runs migrations in order on `decompile` (when reading older IR from disk or `meta`) and refuses to write older versions on `format`.

---

## 11. Full round-trip example

### 11.1 Textual

```latex
\page home
\tokens {
  --bg:    #FAFAFA;
  --ink:   #111111;
  --serif: "GT Sectra";
}

\board hero (0, 0, 1440, 800) fill=var(--bg) {
  \text title (64, 120) font=var(--serif) size=96 weight=400 fill=var(--ink) { Consulting }
  \rect cta   (64, 300, 200, 56) fill=#111111 radius=8
}

\bind anchor hero.bottom -> cta.top offset=24 align=start
\anchor shape:title.props.text  shape:cta.props.fill
```

### 11.2 JSON IR (output of `parse(...)`)

```json
{
  "v": 1,
  "page": "home",
  "tokens": {
    "--bg":    "#FAFAFA",
    "--ink":   "#111111",
    "--serif": "GT Sectra"
  },
  "shapes": [
    {
      "id":   "hero",
      "type": "board",
      "x": 0, "y": 0, "w": 1440, "h": 800,
      "props": { "fill": "var(--bg)" }
    },
    {
      "id":   "title",
      "type": "text",
      "parent": "hero",
      "x": 64, "y": 120,
      "props": {
        "text":   "Consulting",
        "font":   "var(--serif)",
        "size":   96,
        "weight": "400",
        "fill":   "var(--ink)"
      }
    },
    {
      "id":   "cta",
      "type": "rectangle",
      "parent": "hero",
      "x": 64, "y": 300, "w": 200, "h": 56,
      "props": { "fill": "#111111", "radius": 8 }
    }
  ],
  "bindings": [
    {
      "id":     "anc-hero-cta",
      "type":   "anchor",
      "fromId": "hero",
      "toId":   "cta",
      "props":  { "fromSide": "bottom", "toSide": "top", "offset": 24, "align": "start" }
    }
  ],
  "anchored": [
    "shape:title.props.text",
    "shape:cta.props.fill"
  ]
}
```

### 11.3 Expected Penpot mutations (output of `compile(ir, emptyState)`)

```jsonc
[
  { "op": "create", "shapeId": "hero",
    "fields": {
      "type": "board",
      "name": "hero",
      "x": 0, "y": 0,
      "resize": [1440, 800],
      "fills": [{ "fillColor": "#FAFAFA", "fillOpacity": 1 }],
      "clipContent": true
    }
  },
  { "op": "create", "shapeId": "title",
    "parent": "hero",
    "fields": {
      "type": "text",
      "name": "title",
      "x": 64, "y": 120,
      "characters": "Consulting",
      "fontFamily": "GT Sectra",
      "fontSize": "96",
      "fontWeight": "400",
      "fills": [{ "fillColor": "#111111", "fillOpacity": 1 }],
      "growType": "auto-height"
    }
  },
  { "op": "create", "shapeId": "cta",
    "parent": "hero",
    "fields": {
      "type": "rectangle",
      "name": "cta",
      "x": 64, "y": 300,
      "resize": [200, 56],
      "fills": [{ "fillColor": "#111111", "fillOpacity": 1 }],
      "borderRadius": 8
    }
  },
  // anchor binding resolves cta.y so cta.top sits 24 below hero.bottom:
  // hero.bottom = 0 + 800 = 800, so cta.y becomes 800 + 24 = 824 with align=start keeping cta.x = 64.
  { "op": "update", "shapeId": "cta",
    "fields": { "x": 64, "y": 824 }
  }
]
```

Subsequent `compile(ir, post-state)` returns `[]`.

If the user manually changes `cta` fill in Penpot to `#222222`, the next `decompile` updates the IR (the anchored path's live value wins per §6.2, step 5), and the IR's recorded value is now `"#222222"`. The user's intent — "this color is locked" — is preserved across re-renders even though the value moved.

---

## 12. Open questions

Decisions deferred to Phase 2 (compiler implementation):

1. **Shape ID mapping & persistence.** Local IR ids are stable strings (`"hero"`); Penpot ids are opaque uuids. Where does the mapping live? Options: (a) `setSharedPluginData('agent-bridge', '<localId>', '<penpotId>')` on each shape (`plugin-types/index.d.ts:3385`); (b) a top-level manifest stored as plugin data on the `File`. (a) is simpler, (b) survives shape deletion better.
2. **Boolean op creation.** `Boolean.op` is not exposed as a writable field on the `Boolean` interface (`:370-430`). Need to confirm whether `penpot.createBoolean(type, shapes)` exists on `Context` and is callable post-creation, or if boolean shapes are created-once-immutable.
3. **`svg-raw` insertion API.** `SvgRaw` (`:4070`) has no documented constructor on `ShapeBase`. We may need `penpot.createShapeFromSvg(svgString)` — verify on the `Context` interface (`:771+`). If absent, `\svg` lowers to a `\path` decomposition.
4. **Image upload.** IR allows `props.src` as URL. Need the upload primitive: `penpot.uploadMediaUrl` or similar — locate on `Context`.
5. **`mixed` text values.** `Text.fontSize` etc. return `'mixed'`. Three options: (a) IR forbids mixed and decompile pins first-run; (b) IR allows per-range styling (rich text); (c) IR carries a synthetic `runs[]` block. (a) is v1; (b/c) is v2.
6. **Constraint expression language.** Where to draw the line — just linear arithmetic? Min/max? `clamp()`? Currently spec'd at the minimum. A parser for the full expression sub-language is one of the bigger Phase-2 line items.
7. **Tokens ↔ Penpot design tokens.** `applyToken()` (`plugin-types/index.d.ts:3955`) takes a `Token` object, not a string. Need the lookup path from token name → `Token` instance (`Library.tokens`? `LibraryContext`?). Punted until Penpot's token API surface is fully mapped.
8. **Arrow as shape vs. binding.** tldraw separates them (arrows are shapes; bindings glue them to endpoints). v1 collapses an arrow into a single binding that synthesizes a `Path` shape. Revisit if arrow-shape styling needs (curvature, labels) outgrow `props`.
9. **Layout-owned geometry.** When a parent is `layout: flex|grid`, child `x`/`y` are computed by Penpot. Should the IR carry them at all? Current spec says they're auto-anchored and ignored on write. Confirm decompile drops them or stores `null`.
10. **Multi-page IR.** Current top-level is single-page. A `Workspace` wrapper (array of IRs keyed by page name) is probably needed before the editor ships.
11. **Conflict diagnostics surface.** When compile skips anchored mutations, where do diagnostics go? Returned alongside `Mutation[]`? Pushed to the plugin chat panel? Decide before wiring the UI.

### Areas where the Penpot API was unclear (punted)

- **Boolean creation** (`Boolean.op` not writable on `:370-430`).
- **`SvgRaw` insertion** — no obvious constructor in `plugin-types/index.d.ts` beyond the type definition at `:4070`.
- **Grid layout track configuration** — `GridLayout` (`:1989+`) is large and undocumented in this spec; `\board layout=grid` is currently a stub.
- **Image uploads from URL** — no `uploadMediaUrl` documented in the slice of `Context` I read; image fills currently assume a pre-uploaded `imageId`.
- **Design-token application** — `applyToken(token, properties)` takes a token *object*, not a name; mapping from `var(--x)` to a `Token` requires Penpot's `Library` traversal which isn't covered here.
