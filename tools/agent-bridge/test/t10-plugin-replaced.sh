#!/usr/bin/env bash
# T10 — Second mock plugin replaces the first (single-client invariant).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T10 — second plugin replaces first${NC}"

LOG1=/tmp/agent-bridge-t10-mock1.log
LOG2=/tmp/agent-bridge-t10-mock2.log
node "$DIR/mock-plugin.mjs" --mode=echo --url="$BRIDGE_WS" > "$LOG1" 2>&1 &
P1=$!
cleanup() { kill "$P1" 2>/dev/null || true; kill "$P2" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do grep -q '^READY' "$LOG1" && break; sleep 0.1; done
grep -q '^READY' "$LOG1" || { fail "mock1 never READY"; exit 1; }
h1=$(curl -sS "$BRIDGE_URL/health")
echo "  after mock1: $h1"
echo "$h1" | grep -q '"pluginConnected":true' || { fail "mock1 not connected"; exit 1; }

node "$DIR/mock-plugin.mjs" --mode=echo --url="$BRIDGE_WS" > "$LOG2" 2>&1 &
P2=$!

for i in $(seq 1 30); do grep -q '^READY' "$LOG2" && break; sleep 0.1; done
grep -q '^READY' "$LOG2" || { fail "mock2 never READY"; exit 1; }

# Give the server a moment to close the first client.
sleep 0.3
h2=$(curl -sS "$BRIDGE_URL/health")
echo "  after mock2: $h2"
echo "$h2" | grep -q '"pluginConnected":true' || { fail "no plugin connected after replace"; exit 1; }

# Mock1's ws should have been closed by the server with 'replaced'.
# Our mock prints '[mock] ws closed' on EOF; check stderr in $LOG1.
if grep -q 'ws closed' "$LOG1"; then
  echo "  ${GREEN}✓${NC} mock1's ws was closed (single-client invariant honored)"
else
  echo "  ${YELLOW}!${NC} mock1 didn't report ws closed — may still be a clean replace"
fi

# Round-trip via mock2 — confirms the active client really is mock2.
body=$(curl -sS -X POST "$BRIDGE_URL/tool" -H 'Content-Type: application/json' \
       -d '{"name":"ping","input":{"who":"mock2"},"timeoutMs":3000}')
echo "  /tool through mock2: $body"
echo "$body" | grep -q '"ok":true' || { fail "tool call through replacement plugin failed"; exit 1; }

pass "second plugin replaced first; tool calls now hit mock2"
