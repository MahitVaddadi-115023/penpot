#!/usr/bin/env bash
# T9 — POST /tool times out with 504 when the plugin ignores tool calls.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T9 — /tool timeout path${NC}"

LOG=/tmp/agent-bridge-t09-mock.log
node "$DIR/mock-plugin.mjs" --mode=ignore --url="$BRIDGE_WS" > "$LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 30); do
  grep -q '^READY' "$LOG" && break
  sleep 0.1
done
grep -q '^READY' "$LOG" || { fail "mock plugin never reported READY"; exit 1; }

t0=$(python3 -c 'import time; print(time.time())')
resp=$(curl -sS -o /tmp/agent-bridge-t09.body -w '%{http_code}' \
       -X POST "$BRIDGE_URL/tool" \
       -H 'Content-Type: application/json' \
       --max-time 4 \
       -d '{"name":"penpot.list_shapes","input":{},"timeoutMs":1000}')
t1=$(python3 -c 'import time; print(time.time())')
elapsed=$(python3 -c "print(round($t1-$t0,3))")
body=$(cat /tmp/agent-bridge-t09.body)

echo "  status: $resp  body: $body  elapsed: ${elapsed}s"

ok=1
assert_eq "504" "$resp" "HTTP status" || ok=0
assert_contains '"error":"timeout"' "$body" "body.error" || ok=0
# Should be ≥ ~1s but < ~3s (allow generous slack on macOS).
case "$elapsed" in
  0.[0-8]*) echo "  ${RED}✗${NC} elapsed=$elapsed < 1.0s, suspicious"; ok=0 ;;
  *)        echo "  ${GREEN}✓${NC} elapsed=$elapsed s (≥1.0s as expected)" ;;
esac

[ $ok -eq 1 ] && pass "timeout returns 504 around the requested deadline" || { fail "see above"; exit 1; }
