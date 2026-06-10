#!/usr/bin/env bash
# T4 — newcore penpot.test.ts (20 cases).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T4 — newcore penpot tool tests (src/tools/penpot.test.ts)${NC}"
NEWCORE_DIR="${NEWCORE_DIR:-$HOME/coding-agents/repos/open-antigravity/newcore}"

if [ ! -d "$NEWCORE_DIR" ]; then
  fail "newcore not found at $NEWCORE_DIR"
  exit 1
fi

out=$(cd "$NEWCORE_DIR" && npx --yes tsx --test src/tools/penpot.test.ts 2>&1)
echo "$out" | tail -10 | sed 's/^/  /'

pass_n=$(echo "$out" | grep -E '^ℹ pass [0-9]+$'  | awk '{print $3}' | tail -1)
fail_n=$(echo "$out" | grep -E '^ℹ fail [0-9]+$'  | awk '{print $3}' | tail -1)
tot_n=$(echo "$out" | grep -E '^ℹ tests [0-9]+$' | awk '{print $3}' | tail -1)

if [ "$pass_n" = "20" ] && [ "$fail_n" = "0" ] && [ "$tot_n" = "20" ]; then
  pass "newcore penpot: 20/20"
else
  fail "newcore penpot: $pass_n/$tot_n passed, $fail_n failures"
  exit 1
fi
