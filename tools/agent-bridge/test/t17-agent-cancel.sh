#!/usr/bin/env bash
# T17 — Agent cancel: POST /agents/:id/cancel transitions a running agent
# into the 'cancelled' terminal state and emits a log artifact mentioning
# cancellation.
#
# Strategy:
#   1. Spawn an agent against the mock provider.
#   2. Immediately POST /agents/:id/cancel.
#   3. Poll status; expect 'cancelled' within 5s.
#   4. Fetch artifacts and look for one whose content mentions cancellation.
#
# Race tolerance: the mock provider can finish in <100ms, faster than the
# cancel POST round-trip. If newcore was started with MOCK_DELAY_MS unset
# (default), the agent may finish before cancel arrives. In that case the
# cancel endpoint still returns 200 with {"ok":false,"state":"completed"} —
# we treat that path as PARTIAL (endpoint wired, but race lost).
#
# To deterministically test the cancel path, start newcore with
#   MOCK_DELAY_MS=500 npm run server
# which slows each gateway.complete() call by 500ms so the run loop has
# safe boundaries for the cancel flag to be observed.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T17 — newcore agent cancel${NC}"

# ── Health check ──
if ! curl -sS --max-time 3 "$NEWCORE_URL/health" >/dev/null 2>&1; then
  skip "newcore not reachable at $NEWCORE_URL"
  exit 0
fi

# ── Verify the cancel endpoint exists at all ──
# Hit a known-bad id; we expect 404 with { ok: false, error: "agent_not_found" }.
miss=$(curl -sS -o /tmp/t17-miss.json -w '%{http_code}' \
  -X POST "$NEWCORE_URL/agents/__nope__/cancel" --max-time 5)
if [ "$miss" != "404" ]; then
  fail "cancel endpoint missing or wrong shape (status=$miss, body=$(cat /tmp/t17-miss.json 2>/dev/null | head -c 200))"
  exit 1
fi
miss_body=$(cat /tmp/t17-miss.json 2>/dev/null)
assert_contains "agent_not_found" "$miss_body" "404 body" || { fail "wrong 404 body"; exit 1; }

# ── Spawn agent ──
create=$(curl -sS -X POST "$NEWCORE_URL/agents" \
  -H 'Content-Type: application/json' \
  --max-time 10 \
  -d '{"task":"plan and execute a complex multi-step refactor that takes a long time","model":"mock-default"}')
agent_id=$(echo "$create" | python3 -c '
import json, sys
try:
  print(json.load(sys.stdin).get("id",""))
except Exception:
  print("")
')
[ -z "$agent_id" ] && { fail "could not extract agent id from $create"; exit 1; }
echo "  agent id: $agent_id"

# ── Cancel ASAP ──
cancel_resp=$(curl -sS -X POST "$NEWCORE_URL/agents/$agent_id/cancel" --max-time 5)
echo "  cancel resp: $cancel_resp"

cancel_ok=$(echo "$cancel_resp" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  print(d.get("ok", False))
except Exception:
  print("False")
')

# ── Poll status (up to 5s) ──
state=""
for i in $(seq 1 20); do  # 20 × 250ms = 5s
  status=$(curl -sS --max-time 5 "$NEWCORE_URL/agents/$agent_id" || echo "{}")
  state=$(echo "$status" | python3 -c '
import json, sys
try:
  print(json.load(sys.stdin).get("state",""))
except Exception:
  print("")
')
  case "$state" in
    cancelled|completed|failed) break ;;
  esac
  sleep 0.25
done
echo "  final state: $state (cancel ok=$cancel_ok)"

# ── Fetch artifacts and look for a cancellation log ──
arts=$(curl -sS --max-time 5 "$NEWCORE_URL/artifacts/$agent_id" || echo "[]")
has_cancel_artifact=$(echo "$arts" | python3 -c '
import json, sys
try:
  a = json.load(sys.stdin)
  hits = [x for x in a if "cancel" in (x.get("content","") + x.get("title","")).lower()]
  print(1 if hits else 0)
except Exception:
  print(0)
')

# ── Evaluate ──
if [ "$state" = "cancelled" ]; then
  if [ "$has_cancel_artifact" = "1" ]; then
    pass "agent cancelled within 5s + cancellation log artifact emitted"
    exit 0
  fi
  partial "agent cancelled but no log artifact mentioning cancellation found"
  exit 0
fi

if [ "$state" = "completed" ] && [ "$cancel_ok" = "False" ]; then
  # Endpoint exists and returned correctly, but the mock model ran too fast
  # for the cancel to land mid-run. The endpoint itself is wired and proven
  # by the 404 check above. Hint at MOCK_DELAY_MS for deterministic runs.
  partial "agent finished before cancel landed (mock too fast) — set MOCK_DELAY_MS=500 to test the cancel path deterministically"
  exit 0
fi

fail "unexpected final state '$state' (cancel ok=$cancel_ok)"
exit 1
