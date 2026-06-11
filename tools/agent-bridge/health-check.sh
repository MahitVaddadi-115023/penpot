#!/usr/bin/env bash
# health-check.sh — one-shot probe of every Antigravity Bridge stack
# component. Prints a status table; exits non-zero on any UNHEALTHY.
#
# Quick: ~3 seconds (uses curl -m 2 per probe). Safe to run from cron.

set -uo pipefail

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'

unhealthy=0

probe() {
  local label="$1" url="$2" auth="${3:-}"
  local code
  if [ -n "$auth" ]; then
    code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" -H "Authorization: Bearer $auth" "$url" || echo "000")
  else
    code=$(curl -s -o /dev/null -m 2 -w "%{http_code}" "$url" || echo "000")
  fi
  local color="${GREEN}"
  local verdict="OK"
  if [ "$code" = "000" ]; then color="${RED}"; verdict="UNHEALTHY"; unhealthy=$((unhealthy + 1));
  elif [ "$code" -ge 500 ] 2>/dev/null; then color="${RED}"; verdict="UNHEALTHY"; unhealthy=$((unhealthy + 1));
  elif [ "$code" -ge 400 ] 2>/dev/null && [ "$code" != "404" ]; then color="${YELLOW}"; verdict="WARN";
  fi
  printf "  %-32s %s%-9s%s HTTP %s\n" "$label" "$color" "$verdict" "$NC" "$code"
}

probe_process() {
  local label="$1" pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    printf "  %-32s %sOK%s       (running)\n" "$label" "$GREEN" "$NC"
  else
    printf "  %-32s %sUNHEALTHY%s (not running)\n" "$label" "$RED" "$NC"
    unhealthy=$((unhealthy + 1))
  fi
}

echo "── Antigravity Bridge health ──"
probe "LiteLLM gateway"            http://localhost:4000/v1/models sk-litemagic-123
probe "newcore /health"            http://localhost:3777/health
probe "newcore /info"              http://localhost:3777/info
probe "Penpot frontend"            http://localhost:9001/
probe "Penpot /css/ui.css"         http://localhost:9001/css/ui.css
probe "Penpot plugin manifest"     http://localhost:9001/plugins/agent-bridge/manifest.json
probe "Bridge /health"             http://localhost:9010/health
probe "Bridge manifest (:9010)"    http://localhost:9010/agent-plugin/manifest.json
probe_process "Auto-reinstall watcher"        "auto-reinstall-watch.sh"
probe_process "Agent-bridge dev-server"       "node dev-server.mjs"

echo
if [ "$unhealthy" -eq 0 ]; then
  echo "${GREEN}All checks green.${NC}"
  exit 0
else
  echo "${RED}${unhealthy} component(s) unhealthy.${NC} Run start-stack.sh." >&2
  exit 1
fi
