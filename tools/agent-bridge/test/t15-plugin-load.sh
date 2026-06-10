#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"
echo "${BOLD}T15 — load Antigravity Bridge plugin via ?plugin= (Playwright)${NC}"
# Pass container age to the .mjs so it can distinguish a fresh restart (where
# SPA boot timeouts are real regressions → FAIL) from a long-running container
# (where they're env-sensitive → SKIP). See lib.sh:penpot_uptime_seconds.
PENPOT_AGE_SEC="$(penpot_uptime_seconds)"
export PENPOT_AGE_SEC
node "$DIR/t15-plugin-load.mjs" 2>&1 | tee /tmp/agent-bridge-t15.log
grep -E '^RESULT:' /tmp/agent-bridge-t15.log | tail -1
