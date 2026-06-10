#!/usr/bin/env bash
# Shared test helpers — sourced by every t*.sh script.
# Conventions:
#   - PASS  → green ✓, exits 0 from the calling script
#   - FAIL  → red ✗, exits 1 from the calling script
#   - PARTIAL / SKIP → yellow/grey markers, exits 0 (still counted distinctly)
# Every test prints "RESULT: <code>" on its last line so run-all.sh can grep it.

set -u

NC=$'\033[0m'
GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
GREY=$'\033[0;37m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'

NEWCORE_URL=${NEWCORE_URL:-http://localhost:3777}
BRIDGE_URL=${BRIDGE_URL:-http://localhost:9010}
BRIDGE_WS=${BRIDGE_WS:-ws://localhost:9010/ws}

pass() {
  echo "${GREEN}PASS${NC} — $*"
  echo "RESULT: PASS"
}

fail() {
  echo "${RED}FAIL${NC} — $*"
  echo "RESULT: FAIL"
}

partial() {
  echo "${YELLOW}PARTIAL${NC} — $*"
  echo "RESULT: PARTIAL"
}

skip() {
  echo "${GREY}SKIP${NC} — $*"
  echo "RESULT: SKIP"
}

# assert_eq EXPECTED ACTUAL [LABEL]
assert_eq() {
  local exp="$1" act="$2" label="${3:-value}"
  if [ "$exp" = "$act" ]; then
    echo "  ${GREEN}✓${NC} $label = $exp"
    return 0
  else
    echo "  ${RED}✗${NC} $label: expected $exp, got $act"
    return 1
  fi
}

# assert_contains NEEDLE HAYSTACK [LABEL]
assert_contains() {
  local needle="$1" hay="$2" label="${3:-substring}"
  if echo "$hay" | grep -q -- "$needle"; then
    echo "  ${GREEN}✓${NC} $label contains '$needle'"
    return 0
  else
    echo "  ${RED}✗${NC} $label missing '$needle' (got: $(echo "$hay" | head -c 200))"
    return 1
  fi
}
