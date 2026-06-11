#!/usr/bin/env bash
# stop-stack.sh — graceful teardown of the Antigravity Bridge stack.
#
# Stops in reverse-start order. Leaves Penpot containers running by
# default (slow to bring back). Pass --everything to also stop them.

set -uo pipefail

include_penpot=0
include_gateway=0
for arg in "$@"; do
  case "$arg" in
    --everything|-e) include_penpot=1; include_gateway=1 ;;
    --penpot)        include_penpot=1 ;;
    --gateway)       include_gateway=1 ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--everything|--penpot|--gateway]
  Default: stops watcher + bridge + newcore. Keeps Penpot + gateway up.
  --everything : also stops Penpot containers and the LiteLLM gateway.
  --penpot     : also stops Penpot containers.
  --gateway    : also stops the LiteLLM gateway.
EOF
      exit 0
      ;;
  esac
done

stop_pgrep() {
  local label="$1" pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  stopping $label (pids: $pids)"
    echo "$pids" | xargs kill 2>/dev/null || true
  else
    echo "  $label not running"
  fi
}

stop_port() {
  local label="$1" port="$2"
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  stopping $label (pids: $pids, port :$port)"
    echo "$pids" | xargs kill 2>/dev/null || true
  else
    echo "  $label not running"
  fi
}

echo "── Antigravity Bridge stop ──"
stop_pgrep "auto-reinstall watcher" "auto-reinstall-watch.sh"
stop_pgrep "agent-bridge dev-server" "node.*dev-server.mjs"
stop_port  "newcore"                3777
if [ "$include_gateway" = "1" ]; then
  stop_port "LiteLLM gateway"       4000
else
  echo "  LiteLLM gateway   left running (--gateway to stop)"
fi
if [ "$include_penpot" = "1" ]; then
  echo "  stopping Penpot docker stack"
  ( cd "$HOME/coding-agents/repos/penpot/docker/images" && docker compose stop ) 2>/dev/null || true
else
  echo "  Penpot docker     left running (--penpot to stop)"
fi
echo "done."
