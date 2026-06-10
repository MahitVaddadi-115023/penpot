#!/usr/bin/env bash
# T15b — Verify F2 (cross-origin fix) substance.
# Penpot silently drops cross-origin plugin manifests. Our fix installs the
# plugin into the Penpot frontend container at /plugins/agent-bridge/ via
# install-into-penpot.sh, with the manifest's `host` field stripped so `code`
# resolves same-origin.
#
# This test verifies what F2 actually delivers (same-origin loadability).
# T15 separately attempts auto-mount via ?plugin= but that has Penpot routing
# nuances unrelated to F2.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

PENPOT="http://localhost:9001"
PLUGIN_BASE="$PENPOT/plugins/agent-bridge"

echo "${BOLD}T15b — F2 cross-origin fix: same-origin reachability${NC}"

# 1) All four critical assets must be reachable with correct MIME types
declare -a checks=(
  "manifest.json|application/json"
  "plugin.js|application/javascript"
  "index.html|text/html"
  "compiler.mjs|application/javascript"
)

fail_reason=""
for spec in "${checks[@]}"; do
  IFS='|' read -r path expected_mime <<< "$spec"
  url="$PLUGIN_BASE/$path"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  mime=$(curl -sI "$url" | awk -F': ' 'tolower($1)=="content-type" {print $2}' | tr -d '\r' | head -1)
  if [[ "$code" != "200" ]]; then
    fail_reason="$path → HTTP $code (expected 200)"
    break
  fi
  if [[ "$mime" != "$expected_mime"* ]]; then
    fail_reason="$path served with $mime (expected $expected_mime)"
    break
  fi
  echo "  ✓ $path → 200 $mime"
done

if [[ -n "$fail_reason" ]]; then
  fail "$fail_reason — has install-into-penpot.sh been run? cd \$(dirname \"\$0\")/.. && bash install-into-penpot.sh"
  exit 0
fi

# 2) The served manifest must NOT have a `host` field (it would defeat the fix).
host_present=$(curl -s "$PLUGIN_BASE/manifest.json" | grep -c '"host"' || true)
if [[ "$host_present" != "0" ]]; then
  fail "served manifest still has a \"host\" field — install-into-penpot.sh isn't stripping it. Penpot would resolve code cross-origin and the fix is moot."
  exit 0
fi
echo "  ✓ served manifest has no \"host\" field (resolves code relative to manifest URL → same-origin)"

# 3) The bridge dev-server on :9010 still works (we serve both for compatibility).
bridge_code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:9010/agent-plugin/manifest.json")
if [[ "$bridge_code" != "200" ]]; then
  partial "same-origin OK but dev-server on :9010 isn't serving (HTTP $bridge_code). Bridge tool proxy still needs :9010 for newcore tool-call delivery."
  exit 0
fi
echo "  ✓ dev-server on :9010 still reachable (for tool proxy / newcore)"

pass "F2 cross-origin fix verified: 4 assets reachable same-origin, manifest host-stripped, dev-server intact"
