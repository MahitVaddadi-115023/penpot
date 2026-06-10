#!/usr/bin/env bash
# T6 — Static file serving. Verify all plugin assets are reachable with the
# correct Content-Type (specifically `text/javascript` for .mjs and .js per
# the dev-server's Phase 4 fix in MIME table).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T6 — static file serving${NC}"
ok=1

check() {
  local path="$1" exp_mime="$2"
  local hdr=$(curl -sSI "$BRIDGE_URL$path")
  local status=$(echo "$hdr" | head -1 | awk '{print $2}')
  local ctype=$(echo "$hdr" | awk -F': ' 'tolower($1)=="content-type"{print tolower($2)}' | tr -d '\r')
  echo "  $path → $status  $ctype"
  if [ "$status" != "200" ]; then echo "    ${RED}✗${NC} not 200"; return 1; fi
  if ! echo "$ctype" | grep -q "$exp_mime"; then
    echo "    ${RED}✗${NC} content-type missing '$exp_mime'"
    return 1
  fi
  return 0
}

check /agent-plugin/manifest.json application/json || ok=0
check /agent-plugin/index.html    text/html       || ok=0
check /agent-plugin/plugin.js     text/javascript || ok=0
check /agent-plugin/compiler.mjs  text/javascript || ok=0

[ $ok -eq 1 ] && pass "all static assets served with correct MIME" || { fail "see above"; exit 1; }
