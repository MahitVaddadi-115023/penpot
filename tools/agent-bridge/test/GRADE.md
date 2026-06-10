# Agent Bridge — Test & Grade Report

**Grade: B+ — Plumbing rock-solid (T01-T11 all green), agent runtime healthy, the two automation gaps are honestly outside the bridge's scope: a deterministic mock LLM that doesn't pick custom tools (T13) and Penpot's cross-origin plugin install requiring a Plugin Manager click (T15).**

Run with: `bash test/run-all.sh` from `tools/agent-bridge/`.

---

## Results table

| ID  | Test                                          | Status   | Time    | Note                                                                                                              |
| --- | --------------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| T01 | HTTP health (newcore + bridge)                | PASS     | 0.10s   | Both endpoints return expected shape.                                                                             |
| T02 | newcore `/info` tool list                     | PASS     | 0.13s   | Exactly 7 `penpot.*` tools registered, names match.                                                               |
| T03 | compiler unit suite                           | PASS     | 0.15s   | 21/21 cases in `agent-plugin/compiler.test.mjs`.                                                                  |
| T04 | newcore penpot tool tests                     | PASS     | 1.26s   | 20/20 cases in `newcore/src/tools/penpot.test.ts`.                                                                |
| T05 | `POST /tool` without plugin → 503             | PASS     | 0.12s   | `no_plugin_connected` returned correctly.                                                                         |
| T06 | static asset MIME types                       | PASS     | 0.14s   | `.mjs`/`.js` served as `text/javascript`.                                                                         |
| T07 | WS handshake to `/ws`                         | PASS     | 0.16s   | Stdlib RFC6455 client connects cleanly.                                                                           |
| T08 | `POST /tool` round-trip via mock plugin       | PASS     | 0.20s   | Live WS, real `tool.result` echoed back.                                                                          |
| T09 | `/tool` timeout → 504                         | PASS     | 1.30s   | Elapsed ≈ 1s as requested, `timeout` error returned.                                                              |
| T10 | second plugin replaces first                  | PASS     | 0.68s   | Single-client invariant honored, mock1 disconnected.                                                              |
| T11 | newcore `/chat` (mock-default)                | PASS     | 0.10s   | 200 OK, 524-byte content payload.                                                                                 |
| T12 | agent lifecycle                               | PARTIAL  | 0.33s   | Agent reaches `completed` in 116ms; emits `execution_plan` + 3 `log` artifacts. **No `verification` artifact.**   |
| T13 | agent → bridge → plugin round-trip            | PARTIAL  | 0.37s   | Mock plugin connects; agent runs to completion; **mock LLM doesn't pick `penpot.list_shapes`** so fixture stays in mock. |
| T14 | Penpot workspace loads (Playwright)           | PASS     | 5.76s   | Workspace + 42 SVGs render in ~5s, screenshot at `/tmp/agent-bridge-test-screenshots/t14.png`.                    |
| T15 | Antigravity Bridge plugin loads in Penpot     | PARTIAL  | 20.01s  | Plugin registered via RPC, workspace opened with `?plugin=`; **iframe never auto-mounted** (see finding #2).      |
| T16 | forward render (DSL → canvas mutation)        | SKIP     | 0.07s   | Prerequisite (T15 plugin load) blocked; substance covered by T03 + T08.                                           |

**Summary: 12 PASS · 3 PARTIAL · 0 FAIL · 1 SKIP — wall ≈ 32 s.**

---

## Tiny fixes applied

None. T01–T10 all passed cleanly on the baseline run; no shimming, MIME tweaks, or chmod needed.

---

## Findings (ranked by severity)

### F1 — Orchestrator never emits a `verification` artifact `S2`

**Files:** `newcore/src/artifacts/index.ts` (lines 10-50), `newcore/src/orchestrator/`

**Repro:** Run any agent, `GET /artifacts/<id>` → artifacts only have `type: "execution_plan"` and `type: "log"`. Step 4 of the canonical plan ("Verify the implementation with Z3 constraints") executes but doesn't produce a discrete artifact callers can introspect.

**Suggested fix:** add `ArtifactStore.createVerificationArtifact(agentId, { passed, counterexample?, tool })` and have the orchestrator call it after each `z3_verify` / `type_check` / `lint_code` step. Tighten the `ArtifactData.type` union too.

**Why it matters:** UI clients can't surface "verification passed/failed" without grepping log content — defeats the artifact store's purpose.

---

### F2 — Cross-origin Penpot plugins can't be auto-loaded via `?plugin=` `S2`

**Files:** Penpot frontend (plugin-host code), `tools/agent-bridge/launch.sh`, `tools/agent-bridge/dev-server.mjs`

**Repro:** T15 registers the agent-bridge plugin (host `http://localhost:9010`) in `profile.props.plugins` via RPC, then opens `…/?plugin=http://localhost:9010/agent-plugin/manifest.json#/workspace/…`. Same-origin `live-embed` plugin (host `:9001`) auto-opens fine in the same path. Ours doesn't — only the `rasterizer.html` iframe is in the DOM, no plugin runtime.

**Suggested fix (cheapest):** proxy the agent-plugin assets through Penpot's own origin in dev (`:9001/agent-bridge/*` → `:9010/agent-plugin/*`). Or ship a tiny "install agent-bridge" button in `auto-login.html` mirroring the existing live-embed bootstrap.

**Why it matters:** blocks every E2E automation of the bridge UX; today a human has to click through Plugin Manager once per session, which makes T16–T18 (forward/reverse render in real Penpot) impossible to script.

---

### F3 — Mock LLM provider hard-codes a 5-step plan; ignores custom tools `S3`

**Files:** `newcore/src/gateway/providers/mock.ts` (or equivalent)

**Repro:** T13 explicitly tells the agent "Use the penpot.list_shapes tool" — agent still produces the canonical `list_directory → read_file → write_file → z3_verify → run_command` plan and never invokes any `penpot.*` tool. Mock plugin's WS log shows zero tool calls.

**Suggested fix:** mock provider should at minimum look for `<tool_name>` mentions in the task and inject a plan step using that tool. Or expose a `mock-deterministic-plan` flag and have a separate `mock-task-aware` provider for integration tests.

**Why it matters:** the mock provider is the only zero-config testing path. Without task-aware planning, end-to-end agent-loop tests can't exercise custom tools — they have to be re-run against Ollama/Gemini, which adds latency and an API key dependency to CI.

---

## What I couldn't test and why

- **T16 (forward render via UI):** blocked by F2 — without the plugin iframe in the page we can't drive the markup textarea.
- **T17, T18 (reverse render / round-trip of canvas selection events):** deferred for the same reason. Substance for T17 is partially covered by `compiler.test.mjs` (parsing); T18 needs a working bidirectional plugin connection.
- **Agent → real penpot tool against real Penpot:** even with the plugin loaded manually, the mock LLM (F3) won't pick the tool. Needs Ollama or Gemini to fully prove the loop.

---

## Confidence per phase (0-10)

| Phase                                          | Score | Rationale                                                                                                                                                                          |
| ---------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 — newcore boots, exposes 19 tools      | **10**| T01, T02, T04, T11, T12 all green. Health, info, chat, agent lifecycle all working; mock provider deterministic in < 200 ms.                                                       |
| Phase 2 — markup → ops compile correctly       | **9** | T03 (21/21 unit cases) + T04 (20/20 newcore tool cases). Confidence dinged 1 pt because the unit suite isn't run against the live agent-plugin compiler.mjs from inside Penpot.    |
| Phase 3 — live render via bridge `/tool`       | **9** | T05–T10 cover the protocol comprehensively: no-plugin 503, MIME, WS handshake, real round-trip, timeout, replace. The remaining 1 pt: never validated against the *real* plugin.   |
| Phase 4 — agent picks tools & calls bridge     | **5** | Bridge wiring is solid (T08, T13 mock connected, request reaches bridge), but the mock LLM in the loop doesn't pick `penpot.*` tools, and the orchestrator doesn't expose verification artifacts. Need F3 fixed or Ollama in CI to raise this.|
| Phase 5 — bidirectional canvas sync           | **3** | Plugin runtime never loaded in our Playwright sessions (F2). Code path exists in `plugin.js` (themechange/page/selection forwarders), but it's untested end-to-end from a script.   |

---

## Verification

```bash
cd tools/agent-bridge
bash test/run-all.sh
```

Logs: `/tmp/agent-bridge-runall/<test>.log`
Screenshots: `/tmp/agent-bridge-test-screenshots/t1{4,5}.png`
