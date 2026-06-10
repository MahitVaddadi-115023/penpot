#!/usr/bin/env bash
# T12 — Agent lifecycle: create → poll until completed → fetch artifacts.
# Mock provider should finish well under 5s.
# PARTIAL if completed but no 'verification' artifact (mock provider doesn't
# emit a discrete verification artifact type — only execution_plan + log).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T12 — newcore agent lifecycle${NC}"

# ── Create agent ──
t0=$(python3 -c 'import time; print(time.time())')
create=$(curl -sS -X POST "$NEWCORE_URL/agents" \
  -H 'Content-Type: application/json' \
  --max-time 10 \
  -d '{"task":"echo hello world"}')
echo "  create: $(echo "$create" | head -c 200)"

agent_id=$(echo "$create" | python3 -c '
import json, sys
try:
  print(json.load(sys.stdin).get("id",""))
except Exception:
  print("")
')
[ -z "$agent_id" ] && { fail "could not extract agent id from $create"; exit 1; }
echo "  agent id: $agent_id"

# ── Poll until terminal state ──
state=""
for i in $(seq 1 120); do  # 120 × 250ms = 30s cap
  status=$(curl -sS --max-time 5 "$NEWCORE_URL/agents/$agent_id" || echo "{}")
  state=$(echo "$status" | python3 -c '
import json, sys
try:
  print(json.load(sys.stdin).get("state",""))
except Exception:
  print("")
')
  case "$state" in
    completed|failed) break ;;
  esac
  sleep 0.25
done
t1=$(python3 -c 'import time; print(time.time())')
elapsed=$(python3 -c "print(round($t1-$t0,3))")

echo "  final state: $state (after ${elapsed}s)"

ok=1
if [ "$state" != "completed" ]; then
  echo "  ${RED}✗${NC} expected completed, got '$state'"
  ok=0
fi

# Runtime sanity check
case "$elapsed" in
  *)
    if python3 -c "import sys; sys.exit(0 if $elapsed < 5.0 else 1)" 2>/dev/null; then
      echo "  ${GREEN}✓${NC} runtime ${elapsed}s < 5s"
    else
      echo "  ${YELLOW}!${NC} runtime ${elapsed}s ≥ 5s (mock should be fast)"
      ok=0
    fi
    ;;
esac

# ── Fetch artifacts ──
arts=$(curl -sS --max-time 5 "$NEWCORE_URL/artifacts/$agent_id")
echo "  artifacts (first 200): $(echo "$arts" | head -c 200)"

types=$(echo "$arts" | python3 -c '
import json, sys
try:
  a = json.load(sys.stdin)
  print(" ".join(x.get("type","?") for x in a))
except Exception as e:
  print(f"ERR:{e}")
')
echo "  artifact types: $types"

# Assertions on artifact content
has_plan=0; has_log=0; has_verify=0
echo "$types" | grep -q execution_plan && has_plan=1
echo "$types" | grep -q '\blog\b' && has_log=1
echo "$types" | grep -q verification && has_verify=1

[ $has_plan -eq 1 ] && echo "  ${GREEN}✓${NC} ≥1 execution_plan artifact" || { echo "  ${RED}✗${NC} no execution_plan artifact"; ok=0; }
[ $has_log  -eq 1 ] && echo "  ${GREEN}✓${NC} ≥1 log artifact"            || { echo "  ${RED}✗${NC} no log artifact"; ok=0; }

if [ $has_verify -eq 1 ]; then
  echo "  ${GREEN}✓${NC} ≥1 verification artifact"
  [ $ok -eq 1 ] && pass "agent lifecycle works (plan + log + verification artifacts present)" || { fail "see above"; exit 1; }
else
  echo "  ${YELLOW}!${NC} no verification artifact emitted (only execution_plan + log)"
  if [ $ok -eq 1 ]; then
    partial "agent completed and emitted plan + log, but no verification artifact (artifact store doesn't expose verification type; see findings)"
  else
    fail "see above"; exit 1
  fi
fi
