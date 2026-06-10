#!/usr/bin/env bash
# install-into-penpot.sh — Copy the agent-bridge plugin assets into Penpot's
# frontend container so Penpot serves them SAME-ORIGIN at :9001.
#
# WHY:
#   Penpot's Plugin Manager auto-open path (?plugin=<manifest>) silently drops
#   cross-origin manifests (ours lives on :9010, Penpot is on :9001). The
#   plugin runtime never mounts the iframe in that case, which blocks every
#   Playwright-driven E2E test of the UI flow (T15-T18).
#
#   We sidestep the gap by piggy-backing on the existing nginx alias:
#     location /plugins  →  /var/www/app/plugins (alias)
#   Drop our assets at /var/www/app/plugins/agent-bridge/<files> and they're
#   reachable at http://localhost:9001/plugins/agent-bridge/<files> with the
#   right MIME types — no nginx config edit required.
#
# IDEMPOTENT: safe to re-run. The directory is cleared and re-copied each time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="${SCRIPT_DIR}/agent-plugin"

CONTAINER_FILTER="${PENPOT_FRONTEND_FILTER:-name=penpot-frontend}"
DOC_ROOT="/var/www/app"
DEST_DIR="${DOC_ROOT}/plugins/agent-bridge"
PENPOT_ORIGIN="${PENPOT_ORIGIN:-http://localhost:9001}"
MANIFEST_URL="${PENPOT_ORIGIN}/plugins/agent-bridge/manifest.json"

log() { echo "[install-into-penpot] $*"; }
err() { echo "[install-into-penpot] ERROR: $*" >&2; }

# 1. Sanity: docker available
if ! command -v docker >/dev/null 2>&1; then
  err "docker not on PATH — install Docker Desktop, then re-run."
  exit 2
fi

# 2. Find the Penpot frontend container
matches="$(docker ps --filter "${CONTAINER_FILTER}" --format '{{.Names}}' || true)"
match_count="$(printf '%s\n' "${matches}" | grep -c . || true)"

if [ "${match_count}" -eq 0 ]; then
  err "No running Penpot frontend container matched filter: ${CONTAINER_FILTER}"
  err ""
  err "  Likely Penpot isn't running. Start it with:"
  err "    bash tools/portfolio-sync/penpot-launch.sh"
  err ""
  err "  Or override the filter:"
  err "    PENPOT_FRONTEND_FILTER='name=my-penpot-frontend' $0"
  exit 1
fi

if [ "${match_count}" -gt 1 ]; then
  err "Multiple containers matched filter ${CONTAINER_FILTER}:"
  printf '    %s\n' "${matches}" >&2
  err "Narrow with PENPOT_FRONTEND_FILTER='name=images-penpot-frontend-1'."
  exit 1
fi

CONTAINER="${matches}"
log "frontend container: ${CONTAINER}"

# 3. Sanity: plugin source exists
if [ ! -d "${PLUGIN_SRC}" ]; then
  err "plugin source not found at ${PLUGIN_SRC}"
  exit 1
fi
if [ ! -f "${PLUGIN_SRC}/manifest.json" ]; then
  err "manifest.json missing in ${PLUGIN_SRC}"
  exit 1
fi

# 4. Wipe + re-create dest dir (idempotent)
log "preparing ${CONTAINER}:${DEST_DIR}"
docker exec "${CONTAINER}" sh -c "rm -rf '${DEST_DIR}' && mkdir -p '${DEST_DIR}'"

# 5. Copy assets. `docker cp <local>/.  <ctr>:<remote>` copies *contents*.
log "copying ${PLUGIN_SRC}/ → ${CONTAINER}:${DEST_DIR}/"
docker cp "${PLUGIN_SRC}/." "${CONTAINER}:${DEST_DIR}/"

# 6. Permissions: nginx must be able to read. The frontend image runs as
#    the `penpot` user but the doc root is world-readable by default; we
#    still chmod defensively so docker cp's preserved perms don't bite us.
docker exec "${CONTAINER}" sh -c "
  chmod -R a+rX '${DEST_DIR}' 2>/dev/null || true
" || true

# 7. Verify nginx serves it. Retry briefly in case of a beat-delay.
log "verifying ${MANIFEST_URL}"
verify_ok=0
for _i in 1 2 3 4 5; do
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' "${MANIFEST_URL}" || echo "000")"
  if [ "${http_code}" = "200" ]; then
    verify_ok=1
    break
  fi
  sleep 0.4
done

if [ "${verify_ok}" -ne 1 ]; then
  err "manifest verify failed: HTTP ${http_code} for ${MANIFEST_URL}"
  err "Inspecting container layout for clues:"
  docker exec "${CONTAINER}" sh -c "ls -la '${DEST_DIR}' 2>&1" >&2 || true
  exit 3
fi

log "manifest reachable: HTTP 200"
log ""
log "  Same-origin plugin manifest URL:"
log "    ${MANIFEST_URL}"
log ""
log "  Use this URL in Penpot's Plugin Manager (Ctrl/Cmd+Alt+P)"
log "  or as the ?plugin= query param for Playwright auto-load tests."
log ""
