# Antigravity Bridge — Standalone Wrapper

A native macOS app that hosts the **Antigravity Bridge** plugin UI
(`agent-plugin/index.html`) as a regular desktop window. Same content as
the in-Penpot iframe — Phase 2 markup pane, Phase 4 chat, Phase 5 attribution,
Phase 6 Cmd+I — but available without Penpot open.

This is app **#2** of the 3-app sequence (popup → plugin wrapper → full IDE).

## Why two apps?

| | Tauri #1: Popup | **Tauri #2: Plugin Wrapper** |
|---|---|---|
| Window | Frameless 480×240, always-on-top | Decorated 1200×800, normal |
| Trigger | Global `Cmd+Opt+I` from anywhere | Launched like any Mac app |
| UI | Tiny rewrite popup | Full plugin (markup pane + chat) |
| Newcore | Calls `/info` + `/chat` from Rust | Plugin JS calls direct from webview |

The two apps **can run simultaneously** — they don't share any windows,
shortcuts, or processes. The popup owns `Cmd+Opt+I` globally; this wrapper
owns nothing global.

## Frontend strategy: shared source, no duplication

`tauri.conf.json` points `frontendDist` at `../../agent-plugin`, so the wrapper
serves the **exact same `index.html` / `plugin.js` / `compiler.mjs`** that
Penpot loads when the plugin is installed. There's no symlink, no build step,
no rsync — edit the plugin and both consumers update.

The only Tauri-aware code is **one line** in `agent-plugin/index.html`:

```js
// agent-plugin/index.html (inside openWS)
var wsHost = (typeof window !== 'undefined' && window.__TAURI__) ? 'localhost:9010' : location.host;
ws = new WebSocket('ws://' + wsHost + '/ws');
```

Inside Penpot, `location.host` is `localhost:9010` (matches the plugin
manifest's `host`), so the WS connects normally. Inside Tauri,
`location.host` is `tauri.localhost` and the WS would 404 — so we hardcode
the dev-server origin when `window.__TAURI__` is present.

## Requirements

- macOS 10.15+
- Rust toolchain (`rustup`) for build
- Node 18+ / npm for the Tauri CLI
- **newcore** running on `localhost:3777`
- **agent-bridge dev-server** running on `localhost:9010` (for the tool proxy WS)

Both are started by `bash tools/agent-bridge/launch.sh`.

## Develop

```bash
cd ~/coding-agents/repos/penpot/tools/agent-bridge/tauri-plugin-wrapper
npm install
npm run tauri dev
```

The window opens at 1200×800, centered, with a normal title bar. The plugin
boots inside it just like in Penpot — Cmd+I works in the chat box, the markup
pane parses DSL, and `(window.__TAURI__)` is `true` so the WS picks the
correct host.

## Native menu bar

| Menu | Items |
|---|---|
| Antigravity Bridge | About, Services, Hide, Quit |
| File | **Reload** (Cmd+R), Close Window |
| Edit | Undo/Redo, Cut/Copy/Paste, Select All |
| View | Toggle Full Screen (Cmd+Ctrl+F) |
| Window | Minimize, Maximize |
| Help | About Antigravity Bridge |

`Cmd+R` reloads the plugin — useful while iterating on `agent-plugin/index.html`.

## CSP

`tauri.conf.json` relaxes `connect-src` to include:

- `http://localhost:3777` (newcore `/info`, `/chat`, `/tool`, `/agents/*`)
- `ws://localhost:3777` (newcore agent SSE/WS if ever needed)
- `http://localhost:9010` (dev-server static assets)
- `ws://localhost:9010` (dev-server `/ws` tool proxy)

Everything else stays default-restrictive.

## Build a release `.app` (skip during normal dev)

```bash
npm run tauri build
# output: src-tauri/target/release/bundle/macos/Antigravity Bridge.app
```

## Layout

```
tauri-plugin-wrapper/
  package.json
  README.md
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json         # frontendDist → ../../agent-plugin
    capabilities/default.json
    src/
      main.rs               # binary stub
      lib.rs                # menu bar + open_external command
```

## Known gaps

- No global shortcut — by design, to avoid colliding with Tauri #1.
- No streaming `/chat` improvements beyond what the plugin already does.
- `open_external` is wired up but the plugin UI doesn't call it yet — it's
  there for any future "Open in Penpot" / "Open docs" link.
