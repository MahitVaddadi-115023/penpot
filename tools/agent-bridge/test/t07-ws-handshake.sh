#!/usr/bin/env bash
# T7 — WS handshake to /ws on :9010.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T7 — WebSocket handshake${NC}"

node "$DIR/handshake-once.mjs" "$BRIDGE_WS" > /tmp/agent-bridge-t07.log 2>&1
rc=$?
cat /tmp/agent-bridge-t07.log | sed 's/^/  /'

if [ $rc -eq 0 ]; then
  pass "ws handshake succeeded"
else
  fail "ws handshake failed (exit $rc)"
  exit 1
fi
