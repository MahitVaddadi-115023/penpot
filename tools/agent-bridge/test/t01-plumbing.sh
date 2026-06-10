#!/usr/bin/env bash
# T1 — HTTP health on both newcore (:3777) and dev-server (:9010).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T1 — HTTP health${NC}"
ok=1

bridge=$(curl -sS --max-time 5 "$BRIDGE_URL/health" || echo "")
[ -z "$bridge" ] && { fail "agent-bridge :9010 /health returned nothing"; exit 1; }
echo "  bridge: $bridge"
assert_contains '"ok":true' "$bridge" "bridge health.ok" || ok=0
assert_contains '"pluginConnected"' "$bridge" "bridge has pluginConnected key" || ok=0
assert_contains '"pendingTools"' "$bridge" "bridge has pendingTools key" || ok=0

newcore=$(curl -sS --max-time 5 "$NEWCORE_URL/health" || echo "")
[ -z "$newcore" ] && { fail "newcore :3777 /health returned nothing"; exit 1; }
echo "  newcore: $newcore"
assert_contains '"status":"ok"' "$newcore" "newcore health.status" || ok=0
assert_contains 'OpenGravity' "$newcore" "newcore engine name" || ok=0

[ $ok -eq 1 ] && pass "both health endpoints look good" || { fail "see assertion failures above"; exit 1; }
