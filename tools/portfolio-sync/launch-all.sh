#!/usr/bin/env bash
# launch-all.sh — Start the portfolio↔Penpot sync stack.
#
# Targets:
#   penpot        — bring up Penpot Docker (delegates to penpot-launch.sh)
#   portfolio     — start the portfolio dev server (Astro)
#   bridge        — start penpot-bridge (headless Playwright keeps MCP REPL alive)
#   watcher       — start portfolio-watcher (re-runs pipeline on file changes)
#   webhook       — start webhook-server (Vercel + GitHub push triggers)
#   live-preview  — serve the live-preview Penpot plugin iframe on :9005
#   html-render   — serve the canvas-as-HTML preview on :9006
#   canvas-export — serve the canvas → portfolio HTML sync API on :9007
#                   (also exposes /snapshots, /snapshots/restore, /snapshots/diff/:id
#                    — see snapshot.mjs; pre-sync snapshots are taken automatically)
#   source-watcher — V2 reverse-direction watcher (.astro/.css/.ts → Penpot)
#   screenshots   — one-shot run of the screenshot pipeline
#   sync          — bridge + watcher + webhook + live-preview + html-render + canvas-export + source-watcher
#   stop-sync     — kill the background services started by 'sync'
#   all           — penpot
#
# Usage:
#   ./launch-all.sh [target]

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPTS_DIR/portfolio-sync.config.json"

# Read portfolio_dir from config (falls back if config is missing)
read_config_key() {
  local key="$1"
  node -e "try { const c = require('$CONFIG'); console.log(c['$key'] || ''); } catch { process.exit(0); }" 2>/dev/null
}

start_penpot() {
  echo ""
  echo "━━━ Penpot (port 9001) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  bash "$SCRIPTS_DIR/penpot-launch.sh"
}

run_screenshots() {
  echo ""
  echo "━━━ Portfolio → Penpot Screenshot Pipeline ━━━━━━━━━━"
  node "$SCRIPTS_DIR/screenshot-pipeline.mjs" "${@:2}"
}

start_portfolio() {
  echo ""
  echo "━━━ Portfolio Dev Server (background) ━━━━━━━━━━━━━━"
  local portfolio_dir
  portfolio_dir="$(read_config_key portfolio_dir)"
  if [ -z "$portfolio_dir" ] || [ ! -d "$portfolio_dir" ]; then
    echo "  Error: portfolio_dir not set or does not exist in $CONFIG"
    exit 1
  fi
  (cd "$portfolio_dir" && npm run dev >> /tmp/portfolio-dev.log 2>&1) &
  echo $! > /tmp/portfolio-dev.pid
  echo "  Started PID $(cat /tmp/portfolio-dev.pid) — log: /tmp/portfolio-dev.log"
}

TARGET="${1:-all}"

case "$TARGET" in
  penpot)       start_penpot ;;
  screenshots)  run_screenshots "$@" ;;
  bridge)
    echo ""
    echo "━━━ Penpot Bridge (background) ━━━━━━━━━━━━━━━━━━━━━"
    nohup node "$SCRIPTS_DIR/penpot-bridge.mjs" >> /tmp/penpot-bridge.log 2>&1 </dev/null & disown
    echo $! > /tmp/penpot-bridge.pid
    echo "  Started PID $(cat /tmp/penpot-bridge.pid) — log: /tmp/penpot-bridge.log"
    ;;
  watcher)
    echo ""
    echo "━━━ Portfolio Watcher (background) ━━━━━━━━━━━━━━━━━"
    nohup node "$SCRIPTS_DIR/portfolio-watcher.mjs" >> /tmp/portfolio-watcher.log 2>&1 </dev/null & disown
    echo $! > /tmp/portfolio-watcher.pid
    echo "  Started PID $(cat /tmp/portfolio-watcher.pid) — log: /tmp/portfolio-watcher.log"
    ;;
  webhook)
    echo ""
    echo "━━━ Webhook Server (background) ━━━━━━━━━━━━━━━━━━━━"
    nohup node "$SCRIPTS_DIR/webhook-server.mjs" >> /tmp/webhook-server.log 2>&1 </dev/null & disown
    echo $! > /tmp/webhook-server.pid
    echo "  Started PID $(cat /tmp/webhook-server.pid) — log: /tmp/webhook-server.log"
    ;;
  live-preview)
    echo ""
    echo "━━━ Live Preview Plugin Server (port 9005, background) ━━"
    if lsof -nP -iTCP:9005 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Already listening on :9005 — leaving it alone."
    else
      nohup node "$SCRIPTS_DIR/live-preview-server.mjs" >> /tmp/live-preview.log 2>&1 </dev/null & disown
      echo $! > /tmp/live-preview.pid
      echo "  Started PID $(cat /tmp/live-preview.pid) — log: /tmp/live-preview.log"
    fi
    ;;
  html-render)
    echo ""
    echo "━━━ Canvas-to-HTML Render Server (port 9006, background) ━━"
    if lsof -nP -iTCP:9006 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Already listening on :9006 — leaving it alone."
    else
      nohup node "$SCRIPTS_DIR/canvas-to-html.mjs" --serve >> /tmp/canvas-to-html.log 2>&1 </dev/null & disown
      echo $! > /tmp/canvas-to-html.pid
      echo "  Started PID $(cat /tmp/canvas-to-html.pid) — log: /tmp/canvas-to-html.log"
    fi
    ;;
  canvas-export)
    echo ""
    echo "━━━ Canvas → Portfolio Sync API (port 9007, background) ━━"
    if lsof -nP -iTCP:9007 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  Already listening on :9007 — leaving it alone."
    else
      nohup node "$SCRIPTS_DIR/canvas-to-portfolio-server.mjs" >> /tmp/canvas-to-portfolio-server.log 2>&1 </dev/null & disown
      echo $! > /tmp/canvas-to-portfolio-server.pid
      echo "  Started PID $(cat /tmp/canvas-to-portfolio-server.pid) — log: /tmp/canvas-to-portfolio-server.log"
    fi
    ;;
  source-watcher)
    echo ""
    echo "━━━ Source → Canvas Watcher (V2 reverse direction, background) ━━"
    if [ -f /tmp/source-to-canvas-watcher.pid ] && kill -0 "$(cat /tmp/source-to-canvas-watcher.pid)" 2>/dev/null; then
      echo "  Already running (PID $(cat /tmp/source-to-canvas-watcher.pid)) — leaving it alone."
    else
      nohup node "$SCRIPTS_DIR/source-to-canvas-watcher.mjs" >> /tmp/source-to-canvas-watcher.log 2>&1 </dev/null & disown
      echo $! > /tmp/source-to-canvas-watcher.pid
      echo "  Started PID $(cat /tmp/source-to-canvas-watcher.pid) — log: /tmp/source-to-canvas-watcher.log"
    fi
    ;;
  sync)
    "$0" bridge
    "$0" watcher
    "$0" webhook
    "$0" live-preview
    "$0" html-render
    "$0" canvas-export
    "$0" source-watcher
    ;;
  stop-sync)
    echo ""
    echo "━━━ Stopping sync services ━━━━━━━━━━━━━━━━━━━━━━━━━"
    for pidfile in /tmp/penpot-bridge.pid /tmp/portfolio-watcher.pid /tmp/webhook-server.pid /tmp/live-preview.pid /tmp/canvas-to-html.pid /tmp/canvas-to-portfolio-server.pid /tmp/source-to-canvas-watcher.pid; do
      if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
          echo "  Empty/invalid PID in $pidfile — skipping kill"
        elif kill "$pid" 2>/dev/null; then
          echo "  Killed PID $pid ($pidfile)"
        else
          echo "  PID $pid not running ($pidfile)"
        fi
        rm -f "$pidfile"
      else
        echo "  No PID file: $pidfile"
      fi
    done
    ;;
  portfolio)    start_portfolio ;;
  all)          start_penpot ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: $0 [penpot|portfolio|bridge|watcher|webhook|live-preview|html-render|canvas-export|source-watcher|sync|stop-sync|screenshots|all]"
    exit 1
    ;;
esac

canvas_sync_status() {
  if curl -s --max-time 2 http://127.0.0.1:9007/healthz >/dev/null 2>&1; then
    echo "up"
  else
    echo "down"
  fi
}

echo ""
echo "━━━ Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Penpot         → http://localhost:9001"
echo "  Portfolio      → http://localhost:4321"
echo "  Bridge status  → http://localhost:9002/"
echo "  HTML render    → http://localhost:9006/"
echo "  Canvas sync    → http://localhost:9007/healthz   [$(canvas_sync_status)]"
echo "  Snapshots      → http://localhost:9007/snapshots  (POST /snapshots/restore {id} to roll back)"
echo "  Webhook        → http://localhost:9090/status"
echo "  Tunnel (opt)   → cloudflared tunnel --url http://localhost:9090"
echo ""
