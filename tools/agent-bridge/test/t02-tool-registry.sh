#!/usr/bin/env bash
# T2 — newcore /info exposes exactly 7 penpot.* tools with the expected names.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T2 — newcore tool registry${NC}"

info=$(curl -sS --max-time 5 "$NEWCORE_URL/info" || echo "")
[ -z "$info" ] && { fail "/info returned nothing"; exit 1; }

# Pull the 7 expected names. Use python (always available, jq may not be).
got=$(echo "$info" | python3 -c '
import json, sys
data = json.load(sys.stdin)
names = sorted(t["name"] for t in data.get("tools", []) if t["name"].startswith("penpot."))
print("\n".join(names))
')

expected=$'penpot.export_shape\npenpot.high_level_overview\npenpot.list_shapes\npenpot.mutate_shape\npenpot.patch_markup\npenpot.search\npenpot.set_markup'

echo "  got:"
echo "$got" | sed 's/^/    /'
echo "  expected:"
echo "$expected" | sed 's/^/    /'

if [ "$got" = "$expected" ]; then
  pass "exactly 7 penpot.* tools, names match"
else
  diff <(echo "$got") <(echo "$expected") || true
  fail "tool list mismatch"
  exit 1
fi
