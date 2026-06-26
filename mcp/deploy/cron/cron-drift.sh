#!/bin/sh
# cron-drift.sh — drift-catch job: sync + re-index, NO enrich.
#
# Purpose: catch Notion edits made during the day so the Library reflects
# changes within ~4h instead of waiting for the nightly 02:00 UTC full
# pipeline. Enrich (LLM cost + slow) stays in the nightly job.
#
# Behavior:
#   1. Run `npm run sync` (Notion → vault). 10-min timeout.
#   2. If sync exits 0, run `python -m prd_mcp.cli index --force`. 10-min timeout.
#   3. If sync exits non-zero, log + skip index (reindexing an unchanged vault is pointless).
#   4. Capture stderr to /var/log/cron/drift-<timestamp>.log.
#   5. Exit non-zero on any failure (so the dead-man ping in the orchestrator catches it).
#
# POSIX sh-compatible (busybox ash). Mounted repo provides /app/package.json + /app/mcp/.venv.
set -u

LOG_DIR="/var/log/cron"
mkdir -p "$LOG_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/drift-${TS}.log"

log() {
  # Echo to stdout (lands in cron stdout via crond -L /dev/stdout) AND append to per-run log.
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"
}

log "drift-catch start"

# ---- 1. Sync (Notion → vault) ----
if timeout 600 sh -c 'cd /app && npm run sync' >>"$LOG" 2>&1; then
  log "sync ok"
else
  rc=$?
  log "sync FAILED (rc=$rc); skipping reindex — vault unchanged, no point reindexing"
  exit 1
fi

# ---- 2. Re-index (vault → Chroma) ----
if timeout 600 sh -c 'cd /app/mcp && .venv/bin/python -m prd_mcp.cli index --force' >>"$LOG" 2>&1; then
  log "index ok"
else
  rc=$?
  log "index FAILED (rc=$rc)"
  exit 1
fi

log "drift-catch done"
exit 0