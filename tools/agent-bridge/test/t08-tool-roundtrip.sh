#!/usr/bin/env bash
# T8 — End-to-end tool round-trip with the mock plugin in echo mode.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T8 — POST /tool round-trip via mock plugin${NC}"

LOG=/tmp/agent-bridge-t08-mock.log
node "$DIR/mock-plugin.mjs" --mode=echo --url="$BRIDGE_WS" > "$LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Wait until the mock prints READY (i.e. ws upgraded). Cap 3s.
for i in $(seq 1 30); do
  grep -q '^READY' "$LOG" && break
  sleep 0.1
done
grep -q '^READY' "$LOG" || { fail "mock plugin never reported READY"; cat "$LOG"; exit 1; }

# Confirm pluginConnected flips to true.
h=$(curl -sS "$BRIDGE_URL/health")
echo "  health: $h"
echo "$h" | grep -q '"pluginConnected":true' || { fail "health.pluginConnected=true expected"; exit 1; }

# Round-trip a tool call.
body=$(curl -sS -X POST "$BRIDGE_URL/tool" \
  -H 'Content-Type: application/json' \
  -d '{"name":"penpot.list_shapes","input":{"page":"home"},"timeoutMs":3000}')
echo "  /tool reply: $body"

ok=1
assert_contains '"ok":true' "$body" "ok=true" || ok=0
assert_contains '"echoed"' "$body" "result contains echoed payload" || ok=0
assert_contains '"page":"home"' "$body" "echoed input preserved" || ok=0

[ $ok -eq 1 ] && pass "tool round-trip works end-to-end" || { fail "see above"; exit 1; }
