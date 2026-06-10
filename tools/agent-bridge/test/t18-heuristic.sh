#!/usr/bin/env bash
# T18 — Smoke that the penpot_uptime_seconds helper used by T14/T15
# returns a sensible value. If docker / Penpot isn't running, SKIP
# cleanly (we can't verify end-to-end without a container).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T18 — penpot_uptime_seconds helper${NC}"
age=$(penpot_uptime_seconds)
echo "  reported age: ${age}s"

if [ "$age" = "999999" ]; then
  # No docker / Penpot not running → harness can't verify; SKIP cleanly.
  partial "Penpot frontend not running — can't verify the age helper end-to-end"
  exit 0
fi

# Sanity: age must be a non-negative integer.
case "$age" in
  ''|*[!0-9]*) fail "non-numeric age '$age'"; exit 1 ;;
esac

if [ "$age" -lt 0 ]; then
  fail "negative age '$age'"; exit 1
fi

pass "penpot_uptime_seconds returned a sensible value (${age}s)"
