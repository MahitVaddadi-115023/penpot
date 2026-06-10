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

# Echoes Penpot frontend container uptime in seconds, or 999999 if not running
# / docker missing / timestamp unparseable. Used by T14/T15 to distinguish a
# fresh restart (where SPA boot timeouts are real regressions and should FAIL)
# from a long-running container (where they're env-sensitive and should SKIP).
#
# Portable across BSD `date` (macOS) and GNU `date` (Linux): tries BSD's
# `-j -f` form first, falls back to GNU's `-d` form, then gives up.
#
# Usage:  age=$(penpot_uptime_seconds)
penpot_uptime_seconds() {
  if ! command -v docker >/dev/null 2>&1; then echo 999999; return; fi
  local started_at
  started_at=$(docker inspect --format '{{.State.StartedAt}}' images-penpot-frontend-1 2>/dev/null || echo "")
  if [ -z "$started_at" ]; then echo 999999; return; fi
  local now_s started_s trimmed
  now_s=$(date -u +%s)
  # Penpot's StartedAt looks like "2026-06-10T08:14:13.123456789Z" — trim
  # fractional seconds and trailing Z so both BSD and GNU date can parse.
  trimmed="${started_at%%.*}"
  trimmed="${trimmed%Z}"
  # Try BSD date first (macOS).
  started_s=$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$trimmed" +%s 2>/dev/null || echo 0)
  # Fall back to GNU date (Linux) if BSD form failed.
  if [ "$started_s" = "0" ]; then
    started_s=$(date -u -d "$started_at" +%s 2>/dev/null || echo 0)
  fi
  if [ "$started_s" = "0" ]; then echo 999999; return; fi
  echo $((now_s - started_s))
}
