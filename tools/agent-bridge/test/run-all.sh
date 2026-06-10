#!/usr/bin/env bash
# run-all.sh — Run every t*.sh script in this dir, summarize results.
# Exit 0 iff there are no FAILs (PARTIAL/SKIP are allowed).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

# One-line description per test for the summary table.
declare -A DESC
DESC[t01-plumbing]="HTTP health"
DESC[t02-tool-registry]="newcore /info tool list (7 penpot.*)"
DESC[t03-compiler]="compiler unit suite (21 cases)"
DESC[t04-newcore-penpot]="newcore penpot tool tests (20 cases)"
DESC[t05-tool-noplugin]="POST /tool with no plugin → 503"
DESC[t06-static]="static asset MIME types"
DESC[t07-ws-handshake]="WebSocket handshake to /ws"
DESC[t08-tool-roundtrip]="POST /tool round-trip via mock plugin"
DESC[t09-tool-timeout]="/tool timeout → 504"
DESC[t10-plugin-replaced]="second plugin replaces first"
DESC[t11-chat]="newcore /chat (mock-default)"
DESC[t12-agents-lifecycle]="agent lifecycle (create → completed)"
DESC[t13-agent-tool-roundtrip]="agent → bridge → plugin round-trip"
DESC[t14-penpot-load]="Penpot workspace loads (Playwright)"
DESC[t15-plugin-load]="Antigravity Bridge plugin loads in Penpot"
DESC[t15b-same-origin]="F2 fix: same-origin manifest reachable + host-stripped"
DESC[t16-forward-render]="forward render: DSL → canvas mutation"
DESC[t17-agent-cancel]="POST /agents/:id/cancel → cancelled state + log artifact"
DESC[t18-heuristic]="penpot uptime helper sanity"

echo "${BOLD}─── Agent Bridge Test Suite ───${NC}"
SUITE_START=$(python3 -c 'import time; print(time.time())')

pass_n=0; fail_n=0; partial_n=0; skip_n=0; other_n=0
failing_tests=""
LOG_DIR=/tmp/agent-bridge-runall
mkdir -p "$LOG_DIR"

# Iterate t*.sh in numeric order.
shopt -s nullglob
for t in $(ls "$DIR"/t*.sh | sort); do
  base=$(basename "$t" .sh)
  desc=${DESC[$base]:-"(no description)"}
  log="$LOG_DIR/$base.log"

  t0=$(python3 -c 'import time; print(time.time())')
  bash "$t" > "$log" 2>&1
  rc=$?
  t1=$(python3 -c 'import time; print(time.time())')
  dur=$(python3 -c "print(round($t1-$t0,2))")

  result=$(grep -E '^RESULT:' "$log" | tail -1 | awk '{print $2}')
  result=${result:-UNKNOWN}

  case "$result" in
    PASS)    color=$GREEN; pass_n=$((pass_n+1)) ;;
    PARTIAL) color=$YELLOW; partial_n=$((partial_n+1)) ;;
    SKIP)    color=$GREY; skip_n=$((skip_n+1)) ;;
    FAIL)    color=$RED; fail_n=$((fail_n+1)); failing_tests="$failing_tests $base" ;;
    *)       color=$RED; other_n=$((other_n+1)); failing_tests="$failing_tests $base(rc=$rc/$result)" ;;
  esac

  # Padded test id + description.
  # Use printf for column alignment.
  id_short=$(echo "$base" | sed 's/^t0*//' | awk '{ printf "T%02d", $1 }' 2>/dev/null || echo "$base")
  # Fallback if id_short is weird
  if [ -z "$id_short" ] || [ "${id_short:0:1}" != "T" ]; then
    id_short=$(echo "$base" | grep -oE '^t[0-9]+' | tr 't' 'T')
  fi
  printf "[%s] %-42s %b%-7s%b (%ss)\n" "$id_short" "$desc" "$color" "$result" "$NC" "$dur"
done

SUITE_END=$(python3 -c 'import time; print(time.time())')
WALL=$(python3 -c "print(round($SUITE_END-$SUITE_START,2))")

echo ""
echo "${BOLD}Summary:${NC} ${GREEN}${pass_n} PASS${NC}  ${YELLOW}${partial_n} PARTIAL${NC}  ${RED}${fail_n} FAIL${NC}  ${GREY}${skip_n} SKIP${NC}    (wall: ${WALL}s)"

if [ $fail_n -gt 0 ] || [ $other_n -gt 0 ]; then
  echo ""
  echo "${RED}Failing tests:${NC}$failing_tests"
  echo "Logs: $LOG_DIR/"
  exit 1
fi
exit 0
