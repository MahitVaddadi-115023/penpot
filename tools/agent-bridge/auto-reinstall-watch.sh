#!/usr/bin/env bash
# auto-reinstall-watch.sh — Background watcher that re-installs the
# Antigravity Bridge plugin into the Penpot frontend container whenever
# the same-origin manifest URL stops responding (which happens when the
# Penpot Docker stack restarts, since docker cp is ephemeral).
#
# Loops every 30s. Silent on the happy path. Logs reinstall attempts.
# Exits if Penpot is gone for more than 5 consecutive minutes.
#
# Start:
#   nohup bash auto-reinstall-watch.sh >/tmp/agent-bridge-watch.log 2>&1 &
# Or via launch.sh (the default).
#
# Stop:
#   lsof -ti tcp:9011-port-watch-check 2>/dev/null   # if needed
#   pkill -f auto-reinstall-watch.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${WATCH_INTERVAL:-30}"
PENPOT_URL="${PENPOT_URL:-http://localhost:9001/plugins/agent-bridge/manifest.json}"
CONTAINER_FILTER="${PENPOT_FRONTEND_FILTER:-name=penpot-frontend}"
INSTALL_SCRIPT="${SCRIPT_DIR}/install-into-penpot.sh"
MAX_PENPOT_DOWN_TICKS=10   # 10 * 30s = 5 min; exit after that

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] [watch] $*"; }

penpot_down_ticks=0
last_state="unknown"

trap 'log "watcher stopped (signal)"; exit 0' INT TERM

log "watcher started (interval=${INTERVAL}s, manifest=${PENPOT_URL})"

while true; do
  # 1. Is the Penpot frontend container running?
  if command -v docker >/dev/null 2>&1 \
     && docker ps --filter "${CONTAINER_FILTER}" --format '{{.Names}}' \
          | grep -q '.'; then
    penpot_down_ticks=0

    # 2. Is the same-origin manifest reachable? And is the Penpot UI CSS
    #    (ui.css patch) still in place? Either missing triggers reinstall.
    code="$(curl -s -o /dev/null -w '%{http_code}' "${PENPOT_URL}" || echo "000")"
    css_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:9001/css/ui.css" || echo "000")"
    if [ "${code}" = "200" ] && [ "${css_code}" = "200" ]; then
      if [ "${last_state}" != "ok" ]; then
        log "manifest OK (${PENPOT_URL})"
        last_state="ok"
      fi
    else
      log "manifest=${code} ui.css=${css_code}; attempting reinstall"
      if bash "${INSTALL_SCRIPT}" >/tmp/agent-bridge-reinstall.log 2>&1; then
        log "reinstall succeeded"
        last_state="ok"
      else
        log "reinstall FAILED — see /tmp/agent-bridge-reinstall.log"
        last_state="error"
      fi
    fi
  else
    penpot_down_ticks=$((penpot_down_ticks + 1))
    if [ "${last_state}" != "penpot-down" ]; then
      log "Penpot frontend container not running (tick ${penpot_down_ticks}/${MAX_PENPOT_DOWN_TICKS})"
      last_state="penpot-down"
    fi
    if [ "${penpot_down_ticks}" -ge "${MAX_PENPOT_DOWN_TICKS}" ]; then
      log "Penpot down for ${MAX_PENPOT_DOWN_TICKS} consecutive ticks — exiting watcher"
      exit 0
    fi
  fi

  sleep "${INTERVAL}"
done
