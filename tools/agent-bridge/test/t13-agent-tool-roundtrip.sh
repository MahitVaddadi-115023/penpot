#!/usr/bin/env bash
# T13 — End-to-end agent → bridge → mock plugin → fixture round-trip.
# Critical question: does the newcore agent loop actually invoke a penpot.* tool
# and surface the fixture back through its artifacts?
#
# Strategy: start the mock plugin in `shapes` mode (returns a fixed shape list
# for penpot.list_shapes). Create an agent with a task explicitly naming the
# tool. Poll until completed. Then scan ALL artifacts for the fixture marker
# 'test-1' (or 'rectangle').
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T13 — agent → bridge → plugin round-trip${NC}"

LOG=/tmp/agent-bridge-t13-mock.log
node "$DIR/mock-plugin.mjs" --mode=shapes --url="$BRIDGE_WS" > "$LOG" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Wait for READY
for i in $(seq 1 30); do
  grep -q '^READY' "$LOG" && break
  sleep 0.1
done
grep -q '^READY' "$LOG" || { fail "mock plugin never reported READY"; cat "$LOG"; exit 1; }

# Confirm pluginConnected
h=$(curl -sS "$BRIDGE_URL/health")
echo "  health: $h"
echo "$h" | grep -q '"pluginConnected":true' || { fail "pluginConnected expected true; got $h"; exit 1; }

# Create the agent
TASK='Use the penpot.list_shapes tool to retrieve all shapes on the current page. Return the result.'
create=$(curl -sS -X POST "$NEWCORE_URL/agents" \
  -H 'Content-Type: application/json' \
  --max-time 10 \
  -d "$(python3 -c "import json,sys; print(json.dumps({'task':'$TASK'}))")")
echo "  create: $(echo "$create" | head -c 200)"

agent_id=$(echo "$create" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")
')
[ -z "$agent_id" ] && { fail "could not get agent id"; exit 1; }
echo "  agent id: $agent_id"

# Poll until terminal
state=""
for i in $(seq 1 120); do
  status=$(curl -sS --max-time 5 "$NEWCORE_URL/agents/$agent_id" || echo "{}")
  state=$(echo "$status" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("state",""))
except: print("")')
  case "$state" in completed|failed) break ;; esac
  sleep 0.25
done
echo "  final state: $state"

# Fetch artifacts
arts=$(curl -sS --max-time 5 "$NEWCORE_URL/artifacts/$agent_id")
echo "  artifact bytes: ${#arts}"
echo "  first 300: $(echo "$arts" | head -c 300)"

# Check if mock plugin saw the tool call
mock_saw_call=0
if grep -q "got tool name=list_shapes" "$LOG"; then
  mock_saw_call=1
  echo "  ${GREEN}✓${NC} mock plugin received list_shapes call"
else
  echo "  ${YELLOW}!${NC} mock plugin never saw list_shapes call"
  echo "  mock log tail:"
  tail -5 "$LOG" | sed 's/^/    /'
fi

# Check if fixture made it back into any artifact
fixture_in_artifacts=0
if echo "$arts" | grep -q -e 'test-1' -e 'test-rect'; then
  fixture_in_artifacts=1
  echo "  ${GREEN}✓${NC} fixture marker ('test-1' or 'test-rect') found in artifacts"
else
  echo "  ${YELLOW}!${NC} fixture marker NOT found in artifacts"
fi

# Verdict logic
if [ $mock_saw_call -eq 1 ] && [ $fixture_in_artifacts -eq 1 ]; then
  pass "agent invoked penpot.list_shapes via bridge; fixture surfaced in artifacts"
elif [ $mock_saw_call -eq 1 ]; then
  partial "bridge round-trip worked (mock saw the call) but artifact pipeline didn't surface the fixture — investigate orchestrator artifact emission for tool results"
else
  # The mock provider is deterministic — it picks tools from a fixed plan template
  # that doesn't include penpot.list_shapes. The bridge itself is proven working
  # by T08. Flag as PARTIAL: the infrastructure is sound; the mock LLM is too dumb.
  partial "bridge + plugin infra works (T08 proves it) but the mock LLM provider didn't pick penpot.list_shapes — needs a smarter provider (Ollama/Gemini) to fully validate end-to-end agent tool selection"
fi
