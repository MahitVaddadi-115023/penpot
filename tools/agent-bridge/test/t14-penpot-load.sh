#!/usr/bin/env bash
# T14 wrapper — delegates to the .mjs Playwright script.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

echo "${BOLD}T14 — Penpot workspace load (Playwright)${NC}"
node "$DIR/t14-penpot-load.mjs" 2>&1 | tee /tmp/agent-bridge-t14.log
# The .mjs script already prints a "RESULT: <code>" line.
# Make sure THIS script's last line is also a RESULT: line.
grep -E '^RESULT:' /tmp/agent-bridge-t14.log | tail -1
