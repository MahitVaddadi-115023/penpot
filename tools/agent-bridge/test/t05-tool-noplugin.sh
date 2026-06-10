#!/usr/bin/env bash
# T5 — POST /tool with no plugin connected → 503 no_plugin_connected.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T5 — POST /tool without plugin${NC}"

# Sanity: confirm plugin is not connected. If a real plugin happens to be
# attached (live Penpot session), report PARTIAL — we won't fight reality.
health=$(curl -sS "$BRIDGE_URL/health" || echo "")
connected=$(echo "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("pluginConnected"))')
if [ "$connected" = "True" ] || [ "$connected" = "true" ]; then
  partial "a plugin is currently connected; cannot validate 503 path in this session"
  exit 0
fi

resp=$(curl -sS -o /tmp/agent-bridge-test-t05.body -w '%{http_code}' \
       -X POST "$BRIDGE_URL/tool" \
       -H 'Content-Type: application/json' \
       -d '{"name":"penpot.list_shapes","input":{}}' )
body=$(cat /tmp/agent-bridge-test-t05.body)

echo "  status: $resp"
echo "  body:   $body"

ok=1
assert_eq "503" "$resp" "HTTP status" || ok=0
assert_contains '"ok":false' "$body" "body.ok" || ok=0
assert_contains 'no_plugin_connected' "$body" "body.error" || ok=0

[ $ok -eq 1 ] && pass "no_plugin_connected returned correctly" || { fail "see above"; exit 1; }
