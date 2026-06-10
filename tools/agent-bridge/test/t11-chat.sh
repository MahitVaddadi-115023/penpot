#!/usr/bin/env bash
# T11 — newcore /chat endpoint with the mock provider.
# Assert HTTP 200 and a non-empty `content` field.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T11 — newcore /chat (mock-default)${NC}"

BODYFILE=/tmp/agent-bridge-t11.body
status=$(curl -sS -o "$BODYFILE" -w '%{http_code}' \
  -X POST "$NEWCORE_URL/chat" \
  -H 'Content-Type: application/json' \
  --max-time 10 \
  -d '{"model":"mock-default","message":"hello"}')

body=$(cat "$BODYFILE")
echo "  status: $status"
echo "  body (first 200): $(echo "$body" | head -c 200)"

ok=1
assert_eq "200" "$status" "HTTP status" || ok=0

# Parse content field with python (stdlib only).
content=$(echo "$body" | python3 -c '
import json, sys
try:
  d = json.load(sys.stdin)
  c = d.get("content", "")
  print(c if isinstance(c, str) else "")
except Exception as e:
  print(f"PARSE_ERR:{e}", file=sys.stderr)
  sys.exit(2)
') || { fail "could not parse JSON response"; exit 1; }

clen=${#content}
echo "  content length: $clen"
if [ "$clen" -gt 0 ]; then
  echo "  ${GREEN}✓${NC} content field non-empty"
else
  echo "  ${RED}✗${NC} content field empty"
  ok=0
fi

[ $ok -eq 1 ] && pass "/chat returns 200 with non-empty content" || { fail "see above"; exit 1; }
