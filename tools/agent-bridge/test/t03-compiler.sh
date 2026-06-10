#!/usr/bin/env bash
# T3 — compiler.test.mjs (21 cases).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T3 — compiler unit tests (agent-plugin/compiler.test.mjs)${NC}"
PLUGIN_DIR="$(cd "$DIR/../agent-plugin" && pwd)"

out=$(cd "$PLUGIN_DIR" && node --test compiler.test.mjs 2>&1)
echo "$out" | tail -8 | sed 's/^/  /'

pass_n=$(echo "$out" | grep -E '^ℹ pass [0-9]+$'  | awk '{print $3}' | tail -1)
fail_n=$(echo "$out" | grep -E '^ℹ fail [0-9]+$'  | awk '{print $3}' | tail -1)
tot_n=$(echo "$out" | grep -E '^ℹ tests [0-9]+$' | awk '{print $3}' | tail -1)

if [ "$pass_n" = "21" ] && [ "$fail_n" = "0" ] && [ "$tot_n" = "21" ]; then
  pass "compiler: 21/21"
else
  fail "compiler: $pass_n/$tot_n passed, $fail_n failures"
  exit 1
fi
