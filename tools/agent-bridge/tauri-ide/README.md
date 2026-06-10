# Antigravity IDE (Tauri #3)

A native macOS app that composes the **full Antigravity IDE** in one window:
file tree of markup files | markup editor + Penpot canvas preview | agent chat.

This is app **#3** of the 3-app sequence (popup → plugin wrapper → **IDE**).

## v1 scope

| | Tauri #1: Popup | Tauri #2: Plugin Wrapper | **Tauri #3: IDE** |
|---|---|---|---|
| Window | 480×240 frameless, top | 1200×800 decorated | **1600×1000 decorated, 3-col grid** |
| Trigger | Global `Cmd+Opt+I` | Launch like any Mac app | Launch like any Mac app |
| UI | Tiny rewrite popup | Full plugin (editor + chat) | **Tree + editor (iframe) + canvas (iframe) + chat pane** |
| File CRUD | none | none | **`~/.antigravity/markups/`** via Tauri commands |

The IDE reuses the existing plugin UI by iframe-embedding
`http://localhost:9010/agent-plugin/index.html`. Zero duplication; the same
`__TAURI__`-aware WebSocket line that Tauri #2 added keeps working.

## Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ MenuBar: App / File / Edit / View / Agent / Window / Help        │
├──────────┬───────────────────────────┬──────────────────────────┤
│ File     │ Markup Editor              │ Agent Chat              │
│ Tree     │ (iframe → plugin UI)       │ (placeholder for v1 —    │
│ (220px)  │                            │  see "Chat pane" below) │
│          │                            │                          │
│ markups/ │                            │ (toggle Cmd+/)          │
│  ...     ├───────────────────────────┴──────────────────────────┤
│          │ Penpot Canvas                                        │
│          │ (iframe → http://localhost:9001/auto-login.html)     │
│          │ (toggle Cmd+P)                                       │
├──────────┴──────────────────────────────────────────────────────┤
│ Status bar: connection state · active file · version            │
└──────────────────────────────────────────────────────────────────┘
```

CSS grid: `grid-template-columns: 220px 1fr 360px` × `1fr 320px 24px`.
Each toggle (`Cmd+B` / `Cmd+/` / `Cmd+P`) collapses its column/row to `0`.

## Strategy: iframes inside one host page (no multi-webview)

We **explicitly avoided** multi-webview-children for v1. The host page is
plain HTML/CSS/JS shipped from `src/index.html`, and the editor + canvas
panes are `<iframe>`s. Benefits:

- Reuses the entire Phase 2-6 plugin UI verbatim — no porting, no duplication.
- Cross-pane communication can be deferred to v2 (the file tree talks only to
  Rust, not to the iframes).
- Single render process → simpler debugging.

Trade-off: file-tree → editor coordination uses an inline `<pre>` viewer
rather than driving the plugin's markup pane directly. Wiring the plugin's
editor textarea to the tree is a v2 task (needs postMessage glue).

## Tauri commands (6 + 1)

| Command | Signature | Notes |
|---|---|---|
| `list_markups` | `() -> Vec<String>` | Lists files in `~/.antigravity/markups/`. Creates dir on demand. |
| `read_markup` | `(name: String) -> Result<String, String>` | Sandboxed: rejects `/`, `\`, leading `.`. |
| `write_markup` | `(name: String, content: String) -> Result<(), String>` | Same sandbox. |
| `delete_markup` | `(name: String) -> Result<(), String>` | Same sandbox. |
| `open_penpot` | `(project_id: String, file_id: String) -> Result<(), String>` | Emits `open-penpot` event; host JS rewrites `canvas-frame.src` to `http://localhost:9001/#/workspace/<proj>/<file>`. |
| `agent_log` | `(level: String, message: String) -> Result<(), String>` | Echoes to stdout + emits `agent-log` event; status bar listens. |
| `open_external` | `(url: String) -> Result<(), String>` | Bonus — used by "Open ↗" canvas button & Help → Docs. |

## Menu structure

| Menu | Items |
|---|---|
| **Antigravity IDE** | About · Services · Hide / Hide Others / Show All · Quit |
| **File** | New Markup… (Cmd+N) · Open Workspace… · Save (Cmd+S) · Save All · Close Window |
| **Edit** | Undo / Redo · Cut / Copy / Paste · Select All |
| **View** | Toggle File Tree (Cmd+B) · Toggle Chat (Cmd+/) · Toggle Canvas Preview (Cmd+P) · Reload (Cmd+R) · Toggle Full Screen (Cmd+Ctrl+F) |
| **Agent** | Start Agent (Cmd+Shift+A) · Stop Agent |
| **Window** | Minimize · Maximize |
| **Help** | About Antigravity IDE · Documentation (opens GitHub README) |

Menu clicks for File / View / Agent / Help-About emit Tauri events the host
page listens to (`menu-new-markup`, `toggle-pane`, `agent-start`, …) —
the frontend owns the UX, Rust just routes.

## Requirements

- macOS 10.15+
- Rust toolchain (`rustup`) for build
- Node 18+ / npm for the Tauri CLI
- **newcore** on `localhost:3777`
- **agent-bridge dev-server** on `localhost:9010` (for editor iframe + tool proxy WS)
- **Penpot frontend** on `localhost:9001` (for canvas iframe)

All three are part of `bash tools/agent-bridge/launch.sh`.

## Develop

```bash
cd ~/coding-agents/repos/penpot/tools/agent-bridge/tauri-ide
npm install
npm run tauri dev
```

The window opens 1600×1000, centered. File tree polls
`~/.antigravity/markups/` on boot.

## CSP

`tauri.conf.json` allows:

- `connect-src`: `localhost:3777`, `:9010`, `:9001` (http + ws each)
- `frame-src`: `http://localhost:9010`, `http://localhost:9001`
- Defaults: `'unsafe-inline'` + `'unsafe-eval'` for the inline host-page script

## Known TODOs (v1 → v2)

- [ ] **Chat pane is a placeholder.** It explains the situation rather than
      rendering a real chat. Real fix needs postMessage from the editor
      iframe (or multi-webview-children) so both panes share state.
- [ ] **File-tree → editor wiring stops at an inline `<pre>` viewer.**
      Clicking a markup loads its content into a read-only viewer in the
      editor pane. Driving the plugin's actual markup textarea + compile
      pipeline from the tree requires postMessage glue with `index.html`.
- [ ] **`Save` only persists the inline-viewer text.** If you use the
      plugin's textarea via the "Plugin" button, the save button won't
      capture those edits yet.
- [ ] **`Start / Stop Agent` are stubs.** They update the status bar but
      don't drive newcore. Wire to `POST /agents` once we settle on the
      lifecycle.
- [ ] **`Open Workspace…`** currently just opens `localhost:9001/` in the
      external browser. A real workspace picker (project + file dialog) is
      a v2 task — `tauri-plugin-dialog` is already wired in `Cargo.toml`.
- [ ] **No multi-webview-children.** Per spec, v1 stays single-page. The
      capability/event scaffolding is already there if we want to migrate.
- [ ] **`open_penpot(project_id, file_id)`** has Rust + JS plumbing but no
      UI surface (no "Open in Canvas" button on tree items yet). Easy v2 win.

## Files

```
tauri-ide/
  package.json
  README.md
  src/
    index.html              # host page: tree + iframes + status bar (~310 LoC)
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json         # 1600×1000 window, frame-src CSP
    capabilities/default.json
    icons/                  # copied from tauri-plugin-wrapper
    src/
      main.rs               # binary stub
      lib.rs                # 6 commands + native menu bar (~270 LoC)
```
