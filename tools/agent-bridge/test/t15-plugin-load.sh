#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"
echo "${BOLD}T15 — load Antigravity Bridge plugin via ?plugin= (Playwright)${NC}"
node "$DIR/t15-plugin-load.mjs" 2>&1 | tee /tmp/agent-bridge-t15.log
grep -E '^RESULT:' /tmp/agent-bridge-t15.log | tail -1
