# Antigravity Bridge

A Penpot plugin that will host an Overleaf-style markup-DSL editor + AI agent
chat panel for live design rendering on the Penpot canvas. **This is Phase 1:
the empty shell. It proves the postMessage bridge between Penpot's plugin
sandbox and the iframe UI.**

## How it relates to `portfolio-sync`

`tools/portfolio-sync/` is the peer pipeline going the **opposite direction**:

| Direction              | Tool                | Purpose                                      |
|------------------------|---------------------|----------------------------------------------|
| Canvas → Portfolio HTML | `portfolio-sync`    | Export Penpot designs to the live site       |
| Markup/Agent → Canvas   | `agent-bridge` (this) | Write designs into the canvas from a DSL    |

They are independent. Do not edit each other's files.

## Port allocation

| Port | Owner            | Purpose                                  |
|------|------------------|------------------------------------------|
| 9005 | portfolio-sync   | live-preview-server (plugin static)      |
| 9006 | portfolio-sync   | (reserved)                               |
| 9007 | portfolio-sync   | canvas-to-portfolio-server (sync API)    |
| 9090 | portfolio-sync   | (reserved)                               |
| 9010 | **agent-bridge** | dev-server (plugin static + tool proxy)  |
| 9011 | **agent-bridge** | (reserved)                               |

## Launch

```bash
bash tools/agent-bridge/launch.sh
```

The script:

- checks whether :9010 is already bound (and reuses it if so)
- otherwise starts `dev-server.mjs` in the background via `nohup` + `disown`
- prints the manifest URL to paste into Penpot

Logs land in `/tmp/agent-bridge-dev.log`; PID in `/tmp/agent-bridge-dev.pid`.
To force-restart:

```bash
lsof -ti tcp:9010 | xargs kill ; bash tools/agent-bridge/launch.sh
```

## Load into Penpot

1. **Plugin Manager** (`Ctrl+Alt+P` / `Cmd+Alt+P`)
2. **Add custom plugin**
3. Paste: `http://localhost:9010/agent-plugin/manifest.json`
4. Install, then launch **Antigravity Bridge** from the plugins menu.

## What you should see (Phase 1)

A 1100×800 dark panel with three regions:

- **Left (50%)** — *Markup*: monospace `<textarea>` placeholder for the DSL.
- **Right top (60%)** — *Agent*: disabled chat input ("coming in Phase 4").
- **Right bottom (40%)** — *Status*: live event log.

The Status log should immediately show:

- `iframe-loaded` (system, on iframe boot)
- `hello` (outbound to sandbox)
- `ack` (inbound — sandbox echoing the hello back; this proves the bridge)
- `theme` / `page` / `selection` (inbound — initial snapshot from the sandbox)

…then more events as you change theme, switch pages, or select shapes in
Penpot. Click **Ping sandbox** to fire a manual round-trip.

## Files

```
tools/agent-bridge/
├── README.md           you are here
├── dev-server.mjs      stdlib-only static server on :9010
├── launch.sh           idempotent background launcher
└── agent-plugin/
    ├── manifest.json   Penpot v2 manifest (name + permissions)
    ├── plugin.js       sandbox entry — opens iframe, forwards events
    └── index.html      self-contained iframe UI (3-pane shell)
```

## Tool Proxy (Phase 3)

The dev-server doubles as a **tool-call proxy** between newcore (HTTP, on
`:3777`) and the plugin iframe (WebSocket, on `/ws`). Newcore POSTs a tool
call to `/tool`, the server forwards it over WS to the iframe, the iframe
dispatches to the sandbox (or applies markup tools itself), and the result
travels back the same path.

```
  newcore ──POST /tool──► dev-server ──WS frame──► iframe ──postMessage──► sandbox
                          (single client)            │                       │
  newcore ◄─JSON reply─── dev-server ◄──WS frame──── iframe ◄──postMessage───┘
```

Single iframe assumption: a second WS client replaces the first (and logs a
warning); in-flight tool calls fail with `plugin_replaced`.

### Endpoints

| Method | Path     | Request                                  | Response                                                 |
|--------|----------|------------------------------------------|----------------------------------------------------------|
| GET    | `/health`| —                                        | `{ ok, pluginConnected, pendingTools }`                  |
| POST   | `/tool`  | `{ name, input, timeoutMs? }` (default 10000) | `200 { ok, result?, error? }`, `503 { ok:false, error:"no_plugin_connected" }`, `504 { ok:false, error:"timeout" }`, `400` on bad body |
| WS     | `/ws`    | server→client `{type:"tool", id, name, input}` | client→server `{type:"tool.result", id, ok, result?, error?}` |

CORS is `*` on all three; preflight `OPTIONS` is handled.

### Tools the sandbox supports today

| Name                    | Input                                                 | Result                                                                 |
|-------------------------|-------------------------------------------------------|------------------------------------------------------------------------|
| `penpot.list_shapes`    | `{ page?: string, filter?: { type?: string, name?: string } }` | `{ page, pageMatched, shapes: [{ id, name, type, x, y, w, h }] }`     |
| `penpot.mutate_shape`   | `{ shapeId, fields: { x?, y?, w?, h?, rotation?, opacity?, locked?, "props.fill"?, "props.text"?, "props.radius"?, ... } }` | `{ shapeId, applied: string[], errors: [{ field, error }] }`           |
| `penpot.set_markup`     | `{ markup: string }`                                  | `{ applied: true, length }` (iframe replies after compile pipeline runs) |
| `penpot.patch_markup`   | `{ patch: string }` (unified diff)                    | `{ applied: true, length }` or `{ ok:false, error:"patch_apply_failed" }` |

`set_markup` and `patch_markup` are routed through the iframe because the
markup textarea is the canonical state for those; the sandbox forwards the
payload with the original tool `id` so the iframe's reply still matches the
pending HTTP request.

Markup tools rely on the iframe being open. If only the sandbox is running
(no UI), markup tools time out at `/tool`'s `timeoutMs`.

### Test from the CLI

With Penpot open and the plugin loaded:

```bash
# Liveness
curl http://localhost:9010/health
# → {"ok":true,"pluginConnected":true,"pendingTools":0}

# List shapes on the current page
curl -X POST http://localhost:9010/tool \
  -H 'Content-Type: application/json' \
  -d '{"name":"penpot.list_shapes","input":{}}'

# Move a shape (by IR name, which is shape.name)
curl -X POST http://localhost:9010/tool \
  -H 'Content-Type: application/json' \
  -d '{"name":"penpot.mutate_shape","input":{"shapeId":"cta","fields":{"x":200,"y":300}}}'

# Replace the entire markup buffer
curl -X POST http://localhost:9010/tool \
  -H 'Content-Type: application/json' \
  -d '{"name":"penpot.set_markup","input":{"markup":"\\page home\n\\board hero (0,0,1440,800) fill=#000\n"}}'
```

Before the plugin is connected the server returns `503 no_plugin_connected`.

### WS frame implementation

Hand-rolled RFC6455 (no `ws` dependency) — about ~150 lines of `dev-server.mjs`.
Supports text + control frames, single fragment, server-side. Client-side
masking is enforced; binary, continuation and extension frames are refused.

## Out of scope (Phase 2+)

- DSL compiler enhancements (markup → canvas ops)
- Monaco editor in the Markup pane
- Real chat UX in the Agent pane (newcore wires this up — sub-agent H)
- High-fidelity unified-diff patcher (current applier is apply-or-fail)
- Authentication on `/tool` (single-host localhost, defer)
- Persistence of pending tool calls across server restart

## Testing

Full test suite lives in [`test/`](./test/). Single entrypoint:

```bash
bash test/run-all.sh
```

Tier 1 (T01–T07) covers HTTP/WS plumbing. Tier 2 (T08–T10) drives the bridge
via a stdlib WS mock plugin. Tier 3 (T11–T13) exercises the newcore agent
runtime end-to-end. Tier 4 (T14–T16) drives Penpot with Playwright (uses an
existing install at `~/coding-agents/repos/tldraw/node_modules/playwright`,
no new npm deps).

See [`test/GRADE.md`](./test/GRADE.md) for the latest grade, per-test results,
findings, and per-phase confidence scores. Run logs land in
`/tmp/agent-bridge-runall/<test>.log`; Playwright screenshots in
`/tmp/agent-bridge-test-screenshots/`.
