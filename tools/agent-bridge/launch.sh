#!/usr/bin/env bash
# launch.sh — Start the agent-bridge dev server (background) and, if Penpot
# is running, install the plugin assets into the Penpot frontend container so
# Penpot can load them SAME-ORIGIN.
#
# Two URLs end up exposed:
#   * http://localhost:9010/agent-plugin/manifest.json
#       — dev-server (this script). Used by headless / WS-only tests, the
#         tool-proxy (/tool, /ws), and direct curl from the host.
#   * http://localhost:9001/plugins/agent-bridge/manifest.json
#       — Penpot frontend (nginx) inside the docker container. Used by the
#         Penpot Plugin Manager and the ?plugin= auto-open path, because
#         Penpot silently drops cross-origin manifests.
#
# Idempotent: re-running is safe. If :9010 is already bound we reuse it; the
# install step always rewrites the container directory.
#
# To force a dev-server restart, kill the listener first:
#   lsof -ti tcp:9010 | xargs kill

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9010}"
HOST="${HOST:-127.0.0.1}"
LOG="/tmp/agent-bridge-dev.log"
PID_FILE="/tmp/agent-bridge-dev.pid"

DEV_MANIFEST_URL="http://${HOST}:${PORT}/agent-plugin/manifest.json"
PENPOT_MANIFEST_URL="http://localhost:9001/plugins/agent-bridge/manifest.json"

print_instructions() {
  local penpot_status="$1"
  cat <<EOF

  Antigravity Bridge dev server
  -----------------------------
    Dev-server URL (host : tool-proxy, headless tests)
      ${DEV_MANIFEST_URL}

    Penpot-served URL    (Plugin Manager + Playwright auto-load)
      ${PENPOT_MANIFEST_URL}    [${penpot_status}]

    Plugin dir  : ${SCRIPT_DIR}/agent-plugin
    Log         : ${LOG}
    PID file    : ${PID_FILE}

  To load into Penpot UI:
    1. Open Penpot.
    2. Plugin Manager  (Ctrl+Alt+P  /  Cmd+Alt+P on macOS)
    3. Add custom plugin
    4. Paste:  ${PENPOT_MANIFEST_URL}
    5. Install, then launch "Antigravity Bridge" from the plugins menu.

  Peer plugin (different scope): portfolio-sync on :9005/:9006/:9007/:9090.

EOF
}

# ── 1. Dev server (port :9010) ──────────────────────────────────────────────
if command -v lsof >/dev/null 2>&1; then
  EXISTING_PID="$(lsof -ti "tcp:${PORT}" || true)"
else
  EXISTING_PID=""
fi

if [ -n "${EXISTING_PID}" ]; then
  echo "[agent-bridge] :${PORT} already bound (pid ${EXISTING_PID}) — reusing."
else
  cd "${SCRIPT_DIR}"
  PORT="${PORT}" HOST="${HOST}" nohup node dev-server.mjs >"${LOG}" 2>&1 &
  NEW_PID=$!
  disown "${NEW_PID}" 2>/dev/null || true
  echo "${NEW_PID}" > "${PID_FILE}"

  sleep 0.3
  if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    echo "[agent-bridge] dev server failed to start. Tail of ${LOG}:" >&2
    tail -n 40 "${LOG}" >&2 || true
    exit 1
  fi
  echo "[agent-bridge] dev-server started (pid ${NEW_PID}), log → ${LOG}"
fi

# ── 2. Install into Penpot frontend container (if it's running) ─────────────
PENPOT_STATUS="not installed (Penpot not detected)"
if command -v docker >/dev/null 2>&1 \
   && docker ps --filter 'name=penpot-frontend' --format '{{.Names}}' \
        | grep -q '.'; then
  if bash "${SCRIPT_DIR}/install-into-penpot.sh" >/tmp/agent-bridge-install.log 2>&1; then
    PENPOT_STATUS="installed (same-origin)"
  else
    PENPOT_STATUS="install failed — see /tmp/agent-bridge-install.log"
    echo "[agent-bridge] WARNING: install-into-penpot.sh failed:" >&2
    tail -n 20 /tmp/agent-bridge-install.log >&2 || true
  fi
else
  echo "[agent-bridge] Penpot frontend container not running — skipping same-origin install."
  echo "             Start Penpot first (e.g. tools/portfolio-sync/penpot-launch.sh),"
  echo "             then re-run this script."
fi

print_instructions "${PENPOT_STATUS}"
