#!/usr/bin/env bash
# start-stack.sh — bring the entire Antigravity Bridge stack up.
#
# Idempotent and self-healing. Run after a fresh boot, after `docker
# restart`, or any time you want to confirm everything is alive. Components
# checked / started:
#
#   1. LiteLLM gateway          :4000   (Accelerators/02-gateway)
#   2. newcore (opengravity)    :3777   (open-antigravity/newcore)
#   3. Penpot docker stack      :9001   (penpot/docker/images)
#   4. Penpot ui.css patch       —      (main.css → ui.css in container)
#   5. Same-origin plugin install —     (install-into-penpot.sh)
#   6. agent-bridge dev-server  :9010   + RFC6455 WS at /ws
#   7. Auto-reinstall watcher    —      (auto-reinstall-watch.sh, 30s loop)
#
# Each step prints OK / STARTED / SKIPPED / FAILED and exits non-zero on any
# FAILED. Re-run after fixing whatever blocked it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$HOME/Documents/GitHub/Accelerators/02-gateway"
NEWCORE_DIR="$HOME/coding-agents/repos/open-antigravity/newcore"
PENPOT_DIR="$HOME/coding-agents/repos/penpot/docker/images"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'; BOLD=$'\033[1m'

ok()      { echo "  ${GREEN}OK${NC}     $*"; }
started() { echo "  ${BLUE}STARTED${NC} $*"; }
skip()    { echo "  ${YELLOW}SKIP${NC}   $*"; }
fail()    { echo "  ${RED}FAIL${NC}   $*" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

FAIL_COUNT=0

probe() {
  local url="$1" auth="${2:-}"
  if [ -n "$auth" ]; then
    curl -sf -o /dev/null -m 3 -H "Authorization: Bearer $auth" "$url"
  else
    curl -sf -o /dev/null -m 3 "$url"
  fi
}

wait_for() {
  local url="$1" label="$2" budget="${3:-30}" auth="${4:-}"
  for i in $(seq 1 "$budget"); do
    if probe "$url" "$auth"; then return 0; fi
    sleep 1
  done
  return 1
}

echo "${BOLD}── Antigravity Bridge stack ──${NC}"

# 1. LiteLLM gateway ────────────────────────────────────────────────────────
echo
echo "[1/7] LiteLLM gateway :4000"
if probe http://localhost:4000/v1/models sk-litemagic-123; then
  ok "already up"
else
  if [ ! -d "$GATEWAY_DIR" ]; then
    fail "gateway repo not found at $GATEWAY_DIR (skipping; newcore will fall back to mock)"
  else
    ( cd "$GATEWAY_DIR" && nohup bash -ic 'uv run gateway start' >/tmp/llm-gateway.log 2>&1 & disown )
    if wait_for http://localhost:4000/v1/models "gateway" 60 sk-litemagic-123; then
      started "gateway up; log → /tmp/llm-gateway.log"
    else
      fail "gateway didn't come up in 60s (tail /tmp/llm-gateway.log)"
    fi
  fi
fi

# 2. newcore ────────────────────────────────────────────────────────────────
echo
echo "[2/7] newcore :3777"
if probe http://localhost:3777/health; then
  ok "already up"
else
  if [ ! -d "$NEWCORE_DIR" ]; then
    fail "newcore not found at $NEWCORE_DIR"
  else
    ( cd "$NEWCORE_DIR" && nohup npm run server >/tmp/newcore.log 2>&1 & disown )
    if wait_for http://localhost:3777/health "newcore" 30; then
      started "newcore up; log → /tmp/newcore.log"
    else
      fail "newcore didn't come up in 30s"
    fi
  fi
fi

# 3. Penpot docker stack ────────────────────────────────────────────────────
echo
echo "[3/7] Penpot docker stack :9001"
if probe http://localhost:9001/; then
  ok "already up"
else
  if [ ! -d "$PENPOT_DIR" ]; then
    fail "Penpot docker dir not found at $PENPOT_DIR"
  else
    ( cd "$PENPOT_DIR" && docker compose up -d ) >/tmp/penpot-up.log 2>&1
    if wait_for http://localhost:9001/ "Penpot" 60; then
      started "Penpot containers up"
    else
      fail "Penpot didn't come up in 60s (tail /tmp/penpot-up.log)"
    fi
  fi
fi

# 4. Penpot ui.css patch ────────────────────────────────────────────────────
echo
echo "[4/7] Penpot ui.css patch"
if probe http://localhost:9001/css/ui.css; then
  ok "ui.css already served"
else
  if docker exec images-penpot-frontend-1 sh -c "[ -f /var/www/app/css/main.css ]" 2>/dev/null; then
    docker exec images-penpot-frontend-1 sh -c "cp /var/www/app/css/main.css /var/www/app/css/ui.css" 2>/dev/null
    if probe http://localhost:9001/css/ui.css; then
      started "patched main.css → ui.css"
    else
      fail "patch applied but /css/ui.css still 404"
    fi
  else
    fail "Penpot frontend container not reachable for patch"
  fi
fi

# 5. Same-origin plugin install ─────────────────────────────────────────────
echo
echo "[5/7] Plugin install (Penpot frontend container)"
if probe http://localhost:9001/plugins/agent-bridge/manifest.json; then
  ok "plugin already installed same-origin"
else
  if bash "$SCRIPT_DIR/install-into-penpot.sh" >/tmp/agent-bridge-install.log 2>&1; then
    started "plugin installed; log → /tmp/agent-bridge-install.log"
  else
    fail "install-into-penpot.sh failed (tail /tmp/agent-bridge-install.log)"
  fi
fi

# 6. agent-bridge dev-server ────────────────────────────────────────────────
echo
echo "[6/7] agent-bridge dev-server :9010"
if probe http://localhost:9010/health; then
  ok "already up"
else
  bash "$SCRIPT_DIR/launch.sh" --no-watch >/tmp/agent-bridge-launch.log 2>&1
  if wait_for http://localhost:9010/health "bridge" 10; then
    started "bridge up; log → /tmp/agent-bridge-launch.log"
  else
    fail "bridge didn't come up in 10s (tail /tmp/agent-bridge-launch.log)"
  fi
fi

# 7. Auto-reinstall watcher ─────────────────────────────────────────────────
echo
echo "[7/7] Auto-reinstall watcher (30s loop)"
if pgrep -f "auto-reinstall-watch.sh" >/dev/null 2>&1; then
  ok "watcher already running"
else
  nohup bash "$SCRIPT_DIR/auto-reinstall-watch.sh" >>/tmp/agent-bridge-watch.log 2>&1 & disown
  sleep 1
  if pgrep -f "auto-reinstall-watch.sh" >/dev/null 2>&1; then
    started "watcher running; log → /tmp/agent-bridge-watch.log"
  else
    fail "watcher failed to start"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo
echo "${BOLD}── Stack URLs ──${NC}"
echo "  Penpot UI            : http://localhost:9001/auto-login.html"
echo "  Plugin manifest      : http://localhost:9001/plugins/agent-bridge/manifest.json"
echo "  newcore /info        : http://localhost:3777/info"
echo "  Bridge /health       : http://localhost:9010/health"
echo "  Gateway /v1/models   : http://localhost:4000/v1/models  (Bearer sk-litemagic-123)"
echo
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "${GREEN}${BOLD}Stack ready.${NC} Open Penpot, Plugin Manager (Cmd+Alt+P), paste the manifest URL."
  exit 0
else
  echo "${RED}${BOLD}${FAIL_COUNT} component(s) failed.${NC} Fix and re-run." >&2
  exit 1
fi
