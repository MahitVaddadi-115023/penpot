# Antigravity Popup

Tiny Tauri 2.x macOS app: press **Cmd+Ctrl+I** anywhere, type an instruction, get the result pasted back into whatever app was focused.

This is app **#1** of the 3-app sequence (popup -> plugin wrapper -> full IDE).

## What it does

1. Runs in the background with a hidden window + global shortcut.
2. On **Cmd+Ctrl+I**, a small frameless popup (480x240) appears, focused.
3. On open it reads your clipboard and shows the first ~200 chars as the "draft" (so the standard workflow is: select text -> Cmd+C -> Cmd+Ctrl+I -> type instruction).
4. You pick a model (loaded from `GET http://localhost:3777/info`), type an instruction (e.g. "make this more concise"), hit **Cmd+Enter** or click **Send**.
5. The popup `POST`s to `http://localhost:3777/chat` with a tightly constrained system prompt that asks for ONLY the rewritten text.
6. The result is written to the clipboard, the popup hides, and `osascript` synthesizes **Cmd+V** in the now-foreground app — pasting the rewrite where your cursor sits.
7. Press **Esc** or click away to dismiss without sending.

## Requirements

- macOS (10.15+)
- Rust toolchain (`rustup`) for build
- Node 18+ / npm for the Tauri CLI
- **newcore** running on `localhost:3777` with:
  - `GET /info` -> `{ models: [{ id: "..." }, ...] }`
  - `POST /chat` body `{ model, message }` -> `{ content: "..." }`
- **macOS Accessibility permission** for the binary (or `Terminal.app` in dev) — otherwise the auto-paste keystroke won't fire. See "First run" below.

## First-run setup (Accessibility permission)

The auto-paste step calls `osascript -e 'tell application "System Events" to keystroke "v" using command down'`. macOS gates synthetic keystrokes behind **Accessibility**. Without it, the `osascript` exits non-zero and nothing pastes — historically this looked to the user like "submit said done but nothing happened".

The popup now detects this on every open and surfaces a banner above the input:

```
⚠ Auto-paste needs Accessibility permission. [Grant…] [Skip]
```

- **Grant…** opens **System Settings -> Privacy & Security -> Accessibility** directly (via `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`).
- **Skip** dismisses the banner for this session only — it'll show again next launch if permission is still missing.

In the System Settings pane you'll see a list of apps with an on/off toggle. Find the one that's running the popup and turn it on:

- **Dev (`npm run tauri dev`)**: the permission applies to the **Terminal app** (or iTerm2 / your shell host) that's running `cargo`. macOS attributes synthesized keystrokes to the parent process, not the Tauri webview.
- **Production (bundled `.app`)**: the permission applies to **Antigravity Popup.app** itself. Drag it into the Accessibility list (or use the `+` button) and toggle on.

After granting, you don't need to restart — just reopen the popup with Cmd+Ctrl+I, and the banner should disappear on its own (the popup rechecks on every open).

If auto-paste is unavailable, the popup still writes the result to your clipboard and shows:

> Result copied to clipboard — press Cmd+V to paste manually.

…so you always get the output even on a fresh, ungranted machine.

## Develop

```bash
cd ~/coding-agents/repos/penpot/tools/agent-bridge/tauri-popup
npm install              # installs the Tauri CLI
npm run tauri dev        # live-reload dev build
```

## Build a release `.app`

```bash
npm run tauri build
# output: src-tauri/target/release/bundle/macos/Antigravity Popup.app
```

## Configure the shortcut

`Cmd+Ctrl+I` is registered in `src-tauri/src/lib.rs`:

```rust
let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyI);
```

Change `Code::KeyI` / the modifier mask to rebind, then rebuild.

(`Cmd+I` alone was avoided because most editors bind it to italic.)

## Layout

```
tauri-popup/
  package.json
  README.md
  src/
    index.html              # single-file UI (HTML + inline CSS + inline JS)
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json         # frameless / always-on-top / hidden-on-launch window
    capabilities/default.json
    src/
      main.rs               # binary stub
      lib.rs                # all Tauri commands + shortcut + paste logic
```

## Tauri commands (Rust -> JS)

- `get_models() -> Vec<String>`
- `submit_instruction(instruction, model, draft) -> String`
- `paste_result(text) -> { ok: bool, pasted: bool, error: string | null }`
  - Writes the result to the clipboard, then synthesizes Cmd+V **only if** Accessibility is granted. `pasted: false` means clipboard is set but the user needs to press Cmd+V themselves.
- `hide_popup() -> ()`
- `check_accessibility() -> bool` — runs a no-op `osascript` against System Events to probe AX. Always `true` on non-macOS.
- `open_accessibility_settings() -> ()` — opens System Settings to the Accessibility pane on macOS 13+.

## Known gaps

- **No OS-selection capture**: macOS doesn't expose the current text selection without Accessibility-API scraping. We use the clipboard as the "draft" instead. The intended UX is: select -> Cmd+C -> Cmd+Ctrl+I.
- **No tray icon yet**: the binary just runs invisibly. Add `tauri-plugin-tray` later for menu-bar controls.
- **No streaming**: `/chat` is awaited fully then pasted in one shot. Streaming into the popup is a follow-up.
