# Antigravity Bridge — Handoff

A live-rendering Penpot integration: type/talk to an AI agent on one
side, watch the canvas update on the other. Five UI surfaces, one
shared agent runtime, one shared LLM gateway.

This doc gives the next maintainer (or future-you) everything needed to
bring the loop up from a cold start and keep it running.

---

## TL;DR — one-command up

```bash
cd ~/coding-agents/repos/penpot/tools/agent-bridge
bash start-stack.sh                   # idempotent, safe to re-run
bash health-check.sh                  # one-shot probe of all 6 components
open http://localhost:9001/auto-login.html
# In Penpot: Cmd+Alt+P → Add custom plugin →
#   http://localhost:9001/plugins/agent-bridge/manifest.json
```

If any step fails, `start-stack.sh` exits non-zero with a `FAIL` line
naming the broken component and where its log is. Fix and re-run.

---

## Architecture (45-second tour)

```
                           ┌────────────────────────────────────┐
                           │  Penpot @ :9001 (Docker)           │
                           │   ┌─────────────────────────────┐  │
   ┌────────────┐          │   │ Plugin iframe (markup+chat) │  │
   │  Browser   │ ◀──────▶ │   │   ⌘J = AI inline rewrite    │  │
   └────────────┘          │   └──────┬──────────────────────┘  │
                           │          │ shape mutations         │
                           │   ┌──────▼──────────────────────┐  │
                           │   │  Penpot canvas              │  │
                           │   └─────────────────────────────┘  │
                           └────────────────────────────────────┘
                                      │ postMessage / WS
                                      ▼
   ┌──────────────────────────────────────────────────────────┐
   │  agent-bridge dev-server :9010                            │
   │  • static (plugin.js, compiler.mjs, index.html)           │
   │  • POST /tool → WS → plugin sandbox → penpot.* API        │
   │  • RFC6455 WS at /ws (stdlib hand-roll, no `ws` dep)      │
   └──────────────────────────────────────────────────────────┘
        ▲                              ▲
        │ tool calls                   │ chat / agent / cancel
        │                              │
   ┌────────────────────────────┐  ┌───────────────────────────┐
   │  newcore (opengravity)     │  │  Tauri popup :OS-wide      │
   │  :3777                     │  │  Cmd+Ctrl+I global         │
   │  • /chat /agents /cancel   │  │  Tauri wrapper :standalone │
   │  • 19 tools (7 penpot.*)   │  │  Tauri IDE :3-pane shell   │
   │  • ArtifactStore (memory)  │  │  All call newcore /chat    │
   └────────────┬───────────────┘  └───────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────┐
   │  LiteLLM gateway :4000            │
   │  Bearer sk-litemagic-123          │
   │  118+ models (groq-*, or-*, ...)  │
   └──────────────────────────────────┘
```

**Default model:** `groq-llama-8b` (fast SLM, ~300ms via Groq).
**For real Claude:** pick `claude-cli/haiku` or `claude-cli/sonnet` —
routes through the `claude` CLI using your OAuth, no API key needed.

---

## Port allocation

| Port | Service                       | Started by             |
|------|-------------------------------|-------------------------|
| 4000 | LiteLLM gateway               | start-stack step 1      |
| 3777 | newcore                       | start-stack step 2      |
| 4401-4403 | Penpot MCP                | Penpot docker compose   |
| 9001 | Penpot frontend (Docker)      | start-stack step 3      |
| 9005-9007, 9090 | portfolio-sync (peer) | not touched by us      |
| 9010 | agent-bridge dev-server + /ws | start-stack step 6      |
| 9011 | (reserved for v3 tool proxy)  | unused                  |

Peer instance owns 9005-9007 + 9090 (portfolio-sync). Never touch
`tools/portfolio-sync/`, `auto-login.html`, or root `launch-all.sh`.

---

## Prerequisites

| Tool        | Use                                          |
|-------------|----------------------------------------------|
| **Docker Desktop** | Penpot + its sub-containers          |
| **Node 20+**       | newcore (tsx), agent-bridge dev-server, Tauri frontends |
| **Rust + cargo**   | Tauri apps (popup, wrapper, IDE)     |
| **`uv`**           | LiteLLM gateway (Python via Accelerators) |
| **`gh` (auth'd to both accounts)** | mirror push: SaiMahitVaddadi + MahitVaddadi-115023 |
| **`claude` CLI**   | for `claude-cli/*` models (OAuth, no API key) |
| **Playwright**     | tests T14/T15 (reuses tldraw's install) |

Environment variables (`~/.bashrc` or `~/.zshrc`):

```bash
export GROQ_API_KEY=...           # used BY THE GATEWAY, not by newcore
export OLLAMA_BASE_URL=...        # if you want local models
# newcore + Tauri apps need NOTHING — they talk to :4000 with the
# master key sk-litemagic-123 (documented, not secret).
```

---

## Where the AI lives (and how to invoke it)

| Surface | Launch | AI trigger | Models |
|---|---|---|---|
| **In-Penpot plugin** | Plugin Manager → manifest URL | **Cmd+J** in markup pane / chat input | Dropdown picks any of 122 |
| **Penpot chat** | Same plugin, right pane | Type → Send (Chat mode = `/chat`, Agent mode = `/agents`) | Dropdown |
| **Tauri popup** | `cd tauri-popup && npm run tauri dev` | **Cmd+Ctrl+I** anywhere on macOS | Dropdown in popup |
| **Tauri plugin wrapper** | `cd tauri-plugin-wrapper && npm run tauri dev` | Same as in-Penpot plugin | Dropdown |
| **Tauri IDE** | `cd tauri-ide && npm run tauri dev` | Cmd+Shift+A = start agent; Cmd+S save; Cmd+J in editor | Dropdown |

**Cmd+J workflow** (in any markup pane or chat input):
1. Select text (or just place cursor on a line).
2. Press **Cmd+J** → popover appears, anchored below the selection.
3. Type instruction ("make the rectangle larger", "add a CTA below").
4. Cmd+Enter → response replaces selected text, compiler re-runs,
   canvas updates within ~300ms.

**Cmd+Ctrl+I workflow** (Tauri popup, anywhere):
1. Select text in any macOS app → **Cmd+C**.
2. Press **Cmd+Ctrl+I** → popup over the active window.
3. Type instruction → Cmd+Enter → result auto-pastes back.
4. First run needs Accessibility permission (popup will prompt).

---

## Plugin auto-registration (no Plugin Manager paste)

The Penpot Plugin Manager requires you to paste a manifest URL the first
time you install any plugin. **You don't have to do that anymore** —
`start-stack.sh` runs `register-plugins.mjs` as step **5b**, which:

1. Opens auto-login.html in headless Playwright → inherits session cookies.
2. Reads existing `profile.props.plugins` via the `get-profile` RPC.
3. Merges any plugins from `PLUGINS_TO_REGISTER` (declared in the script)
   that aren't already present.
4. Persists via `update-profile-props`.

It's **idempotent** — re-runs are no-ops if a plugin is already registered
(by stable `plugin-id` UUID). Run on demand:

```bash
node ~/coding-agents/repos/penpot/tools/agent-bridge/register-plugins.mjs
```

### Adding a new plugin to auto-register

Open `register-plugins.mjs` and append to `PLUGINS_TO_REGISTER`:

```js
{
  'plugin-id':   '<v4 UUID>',                 // must be a real UUID
  'name':        'My Plugin',
  'description': 'one-line desc',
  'host':        'http://localhost:NNNN',     // where the iframe is served
  'code':        'plugin.js',
  'url':         'http://.../manifest.json',
  'version':     2,
  'permissions': ['content:read', 'content:write'],
}
```

The `host` field is what the runtime uses to resolve `code` and the
iframe `src`. Use `localhost:9010` if you want the bridge dev-server's WS
proxy; use `localhost:9001/plugins/<name>` if the plugin is served same-
origin (and you've installed it via `docker cp`).

After paste-and-save, run `node register-plugins.mjs` once. From then on
the plugin appears in Penpot's **Plugins** menu — click the name to open
it. No Plugin Manager interaction needed.

---

## Frontend packages (motion + clover)

The portfolio site (`~/Documents/GitHub/websites/portfolio`) carries
`motion@^12.40.0` as a dependency — used for portfolio animations, not
something the bridge plugin needs to import. If you want motion inside
the agent-plugin iframe, the cleanest path is to add it via Astro's
existing bundler in portfolio and either:

- **Re-export via portfolio-sync's canvas-to-portfolio bridge** (parallel
  instance owns that path), or
- **Drop a UMD/ESM bundle of motion into `agent-plugin/`** and import as
  `<script type="module" src="motion.bundle.mjs"></script>` — keeps the
  plugin's "single-file HTML, no bundler" property.

`clover` doesn't appear in any package.json in either repo. If you
intended to add it but didn't (or meant a different package name —
`@clover/...`, `cloverleaf`, `clover-design`?), add it to the same
spot as motion and the plugin's `<script>` can pick it up.

---

## Five known-fragile spots and how each is healed

| Fragility | Self-heal | Manual recover |
|---|---|---|
| Penpot 2.15 ships index.html referencing `/css/ui.css` but the image only has `main.css` → white-on-white home | `auto-reinstall-watch.sh` re-copies every 30s | `bash install-into-penpot.sh` |
| Penpot container restart wipes `docker cp`'d plugin files | Same watcher catches manifest 404 | Same script |
| Gateway env vars not in shell → models 401 | `start-stack.sh` uses `bash -ic` so it sources `.bashrc` | Verify with `bash -ic 'set | grep GROQ'` |
| newcore default model changed from `mock-default` → `groq-llama-8b`; T12 was failing | T12 pins `model: mock-default` explicitly | Pass `model` in any `/agents` POST |
| Penpot SPA boot lags 60-90s on busy machine | T14/T15 use BOOTING/STABLE/OLD heuristic with PENPOT_DEMAND_PASS=1 gate | Wait or set `PENPOT_DEMAND_PASS=1` for strict CI mode |

---

## File map

```
~/Documents/GitHub/Accelerators/02-gateway/
   configs/litellm_config.example.yaml      # 118 model aliases + master_key

~/coding-agents/repos/open-antigravity/newcore/
   src/server.ts                            # /chat /agents /agents/:id /agents/:id/cancel /info
   src/orchestrator/agent.ts                # cancel() + CancelledError + checkCancelled()
   src/artifacts/index.ts                   # in-memory store w/ createVerificationArtifact
   src/gateway/providers/litellm.ts         # gateway provider w/ FALLBACK_MODELS
   src/gateway/providers/claude-cli.ts      # claude CLI subprocess provider
   src/gateway/providers/mock.ts            # MOCK_DELAY_MS hook for testing
   src/tools/penpot.ts                      # 7 penpot.* tools (live + MCP)
   src/config/index.ts                      # all env knobs

~/coding-agents/repos/penpot/tools/agent-bridge/
   start-stack.sh                           # one-command up (idempotent)
   stop-stack.sh                            # graceful teardown
   health-check.sh                          # 3s probe of all 6 components
   launch.sh                                # dev-server + auto-install + watcher
   install-into-penpot.sh                   # docker cp plugin → frontend container + ui.css patch
   auto-reinstall-watch.sh                  # 30s loop: manifest + ui.css healthcheck
   SPEC.md                                  # JSON-IR + textual DSL spec
   HANDOFF.md                               # this file
   agent-plugin/
      manifest.json                         # Penpot v2 manifest
      plugin.js                             # sandbox entry (tool dispatch + events)
      index.html                            # iframe UI (markup + chat + status + Cmd+J)
      compiler.mjs                          # DSL parse/format/validate/compile/decompile
      compiler.test.mjs                     # 21 cases (node --test)
   tauri-popup/                             # global Cmd+Ctrl+I popup
   tauri-plugin-wrapper/                    # standalone plugin window
   tauri-ide/                               # 3-pane IDE shell
   test/
      run-all.sh                            # 18 tests; PASS-only exit 0
      GRADE.md                              # latest grade report
      t01..t18-*.sh                         # individual tests
      mock-plugin.mjs / ws-client.mjs       # WS mock for T08-T10
      lib.sh                                # shared shell helpers + penpot_uptime_seconds
```

---

## Test suite

```bash
cd ~/coding-agents/repos/penpot/tools/agent-bridge
MOCK_DELAY_MS=500 bash test/run-all.sh     # 18 tests, ~3 min
```

Latest baseline: **16 PASS · 0 PARTIAL · 0 FAIL · 3 SKIP**.

| Tier | Tests | Notes |
|---|---|---|
| 1 — plumbing | T01-T10 | HTTP, WS, MIME, mock plugin round-trip |
| 2 — agent runtime | T11-T13, T17 | /chat, /agents lifecycle, real LLM tool-use, /cancel |
| 3 — substance | T15b, T18 | Same-origin manifest, penpot uptime helper |
| 4 — Playwright (env-sensitive) | T14, T15 | SKIP unless `PENPOT_DEMAND_PASS=1` and container is in STABLE band (60s..30min) |

T16 stays SKIP-by-design — visual canvas-rendering assertions are out of
scope for the headless suite.

---

## Recovery cookbook

**Symptom: Penpot home is white-on-white, fonts not rendering.**
- Cause: `/css/ui.css` 404 (image packaging bug).
- Fix: `bash install-into-penpot.sh` (or wait 30s for watcher).

**Symptom: plugin opens but iframe is blank.**
- Cause: dev-server :9010 not running OR plugin manifest's `host`
  still points at :9010 inside the Penpot-served manifest.
- Fix: `bash start-stack.sh`. Confirm `bash health-check.sh` is green.
- Re-paste the manifest URL in Plugin Manager (it auto-strips host).

**Symptom: agent never picks the right tool.**
- Cause: defaultModel rolled back to `mock-default` (fixed plan).
- Fix: check `curl http://localhost:3777/info | jq .defaultModel`.
  Should be `groq-llama-8b`. If not, restart newcore.

**Symptom: chat returns 401 from gateway.**
- Cause: gateway started in a shell that didn't inherit `GROQ_API_KEY`.
- Fix: `pkill -f 'litellm' ; bash start-stack.sh`.
  start-stack uses `bash -ic` to source `.bashrc`.

**Symptom: agent stuck in `planning`, can't cancel.**
- Cause: in-flight LLM HTTP call (Claude CLI) can't be aborted.
- v3 known limit. Workaround: cancel sets the flag; the agent will
  exit when the current call returns. v4 will plumb AbortController.

**Symptom: T15 keeps SKIPping.**
- Penpot container is in the OLD (>30min) band → degraded.
- `docker restart images-penpot-frontend-1`, wait 90s, re-run.
- For CI: set `PENPOT_DEMAND_PASS=1` to force FAIL on env-timeout.

**Symptom: Tauri Cmd+Ctrl+I doesn't fire.**
- Tauri popup not running. `cd tauri-popup && npm run tauri dev`.
- macOS Accessibility not granted. Banner inside the popup explains.
  System Settings → Privacy & Security → Accessibility → toggle.

---

## Git layout

| Repo | Branch | Remote(s) |
|---|---|---|
| `penpot` | `portfolio-sync-toolkit` (also `agent-bridge-toolkit`) | SaiMahitVaddadi/penpot + MahitVaddadi-115023/penpot (fan-out push) |
| `open-antigravity` | `main` | SaiMahitVaddadi/open-antigravity + MahitVaddadi-115023 (mirror-adopted from ishandutta2007's repo; `upstream` kept) |
| `websites` | `fix/consulting-reveal-blog-empty-state` | MahitVaddadi-115023/websites |

Push helper: `mirror` from `~/Documents/GitHub/github-mirror/bin/mirror`
fan-outs to both accounts on every push.

---

## Make-it-bulletproof checklist (for a new machine)

1. Install Docker Desktop, Node 20+, Rust+cargo, `uv`, `gh`, `claude` CLI.
2. Clone all four repos in the expected paths (see file map above).
3. `cd ~/Documents/GitHub/Accelerators/02-gateway && uv sync && uv pip install 'litellm[proxy]'`
4. `cd ~/coding-agents/repos/open-antigravity/newcore && npm install`
5. `cd ~/coding-agents/repos/penpot/tools/agent-bridge && bash start-stack.sh`
6. `bash health-check.sh` — should be all green.
7. `bash test/run-all.sh` — should be 14+ PASS, 0 FAIL.
8. Open Penpot, install the plugin, press **Cmd+J** in the markup
   pane, type "add a hero board", press Cmd+Enter, watch the canvas.

If any step fails, the script names the component + log path. Each
script is idempotent — re-run is always safe.

---

## What's still v4 backlog

1. `agent.cancel()` only flips a flag — plumb `AbortController.signal`
   through `gateway.complete()` to actually abort in-flight LLM HTTP.
2. Tauri IDE tabs: drag-reorder, middle-click close, flush outgoing tab
   on activate (avoids 200ms-debounce-window edit loss).
3. IDE: SSE/WebSocket subscription on agent events instead of 500ms
   polling.
4. T14 timeout (currently 20s) — bump to 60s once we adopt a SPA-ready
   probe before starting the test timer.
5. `MOCK_DELAY_MS` env hook should be promoted to a `--delay` flag or a
   dedicated `SlowMockProvider` to keep `MockProvider` clean.
6. Promote `start-stack.sh` to launchd for boot-time auto-up.

---

## One-liner reminders

```bash
# Up:        bash ~/coding-agents/repos/penpot/tools/agent-bridge/start-stack.sh
# Health:    bash ~/coding-agents/repos/penpot/tools/agent-bridge/health-check.sh
# Down:      bash ~/coding-agents/repos/penpot/tools/agent-bridge/stop-stack.sh
# Tests:     cd .../agent-bridge && MOCK_DELAY_MS=500 bash test/run-all.sh
# Plugin URL: http://localhost:9001/plugins/agent-bridge/manifest.json
# Default model: groq-llama-8b (change via PENPOT or newcore /info)
```
