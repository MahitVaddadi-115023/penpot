#!/usr/bin/env bash
# penpot-launch.sh — Start Penpot (if not running) and open the auto-login page.
#
# Resolves paths relative to this script's location, so it works wherever the
# Penpot fork lives.
#
# Startup sequence:
#   1. Docker Compose starts all Penpot services (frontend, backend, exporter, db, redis, mcp).
#   2. auto-login.html (from repo root) is copied into the frontend container.
#   3. Browser opens auto-login.html → logs in → sets mcp-enabled:true → redirects.
#   4. Workspace ClojureScript reads mcp-enabled and calls dp/start-plugin!.
#   5. Plugin opens WebSocket to ws://localhost:9001/mcp/ws → proxied to penpot-mcp.
#
# MCP container ports (images-penpot-mcp-1):
#   4401 — MCP HTTP API
#   4402 — WebSocket bridge (workspace plugin connects via the /mcp/ws proxy)
#   4403 — REPL HTTP server (POST /execute); success:true once plugin is connected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tools/portfolio-sync/ → repo root is two levels up
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DOCKER_DIR="$REPO_ROOT/docker/images"
AUTO_LOGIN_SRC="$REPO_ROOT/auto-login.html"
AUTO_LOGIN_URL="http://localhost:9001/auto-login.html"
WAIT_SECONDS=10

echo "==> Checking if Penpot containers are running..."

if docker ps --format '{{.Names}}' | grep -q 'penpot'; then
  echo "    Penpot containers are already running."
else
  echo "    Penpot is not running. Starting containers..."
  docker compose -f "$DOCKER_DIR/docker-compose.yaml" up -d
  echo "    Waiting ${WAIT_SECONDS}s for services to become ready..."
  sleep "$WAIT_SECONDS"
fi

if [ -f "$AUTO_LOGIN_SRC" ]; then
  echo "==> Ensuring auto-login.html is in the frontend container..."
  docker cp "$AUTO_LOGIN_SRC" images-penpot-frontend-1:/var/www/app/auto-login.html 2>/dev/null || \
    echo "    Warning: could not copy auto-login.html into container (container may not be ready yet)"
else
  echo "==> No auto-login.html at $AUTO_LOGIN_SRC — skipping copy."
fi

# ── Live Preview plugin server (port 9005) ────────────────────────────────────
# auto-login.html auto-registers a Penpot plugin pointing at
# http://localhost:9005/manifest.json. The Penpot workspace fetches that
# manifest to verify the registration, so the server must be live before we
# open the auto-login page.
LP_SCRIPT="$SCRIPT_DIR/live-preview-server.mjs"
if [ -f "$LP_SCRIPT" ]; then
  if lsof -nP -iTCP:9005 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "==> Live preview plugin server already running on :9005."
  elif command -v node >/dev/null 2>&1; then
    echo "==> Starting live preview plugin server on :9005..."
    nohup node "$LP_SCRIPT" >> /tmp/live-preview.log 2>&1 </dev/null & disown
    echo $! > /tmp/live-preview.pid
    for _i in $(seq 1 10); do
      if curl -sS -m 1 -o /dev/null -w '%{http_code}' http://localhost:9005/manifest.json 2>/dev/null | grep -q '^2'; then
        echo "    Live preview ready at http://localhost:9005/"
        break
      fi
      sleep 0.5
    done
  else
    echo "==> node not on PATH — skipping live preview plugin server."
  fi
fi

echo "==> Opening auto-login page: $AUTO_LOGIN_URL"
open "$AUTO_LOGIN_URL" 2>/dev/null || echo "    (open failed — visit $AUTO_LOGIN_URL manually)"

# Wait up to 30s for MCP plugin to connect
echo "==> Waiting for MCP plugin to connect..."
CONNECTED=false
for i in $(seq 1 30); do
  RESULT=$(curl -s -X POST http://localhost:4403/execute \
    -H "Content-Type: application/json" \
    -d '{"code":"return 1+1;"}' 2>/dev/null || true)
  if echo "$RESULT" | grep -q '"success":true'; then
    CONNECTED=true
    break
  fi
  sleep 1
done

if $CONNECTED; then
  echo "    MCP plugin connected ✓"
else
  echo "    MCP plugin not yet connected — workspace may still be loading."
  echo "    Once the workspace is fully open, MCP connects automatically."
  echo "    Verify with: curl -s -X POST http://localhost:4403/execute -H 'Content-Type: application/json' -d '{\"code\":\"return 1+1;\"}'"
fi
