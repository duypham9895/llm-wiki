#!/bin/sh
# cron-pipeline.sh — full PRD pipeline (sync + enrich + index).
# Auto-retry + dead-man ping on persistent failure.
# POSIX sh (busybox ash).
set -u

LOG_DIR="/var/log/cron"
FAIL_DIR="/data/vault/.cron-failures"

mkdir -p "$LOG_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_FILE="${LOG_DIR}/pipeline-${TS}.log"

STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cd /app

# ── attempt 1 ────────────────────────────────────────────────────────────────
npm run orchestrate >"$LOG_FILE" 2>&1
EXIT_1=$?

if [ "$EXIT_1" -eq 0 ]; then
  exit 0
fi

# ── attempt 2 (after 10 min) ─────────────────────────────────────────────────
sleep 600
npm run orchestrate >>"$LOG_FILE" 2>&1
EXIT_2=$?

if [ "$EXIT_2" -eq 0 ]; then
  exit 0
fi

# ── both attempts failed: alert + persist ────────────────────────────────────
FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# last 50 lines of stderr (whole log since we merged stderr)
LAST_50=$(tail -n 50 "$LOG_FILE" | sed 's/[\"]/\\&/g' | tr '\n' ' ')

mkdir -p "$FAIL_DIR"
FAIL_FILE="${FAIL_DIR}/${TS}.json"

cat >"$FAIL_FILE" <<EOF
{"started_at":"${STARTED_AT}","finished_at":"${FINISHED_AT}","attempt_1_exit":${EXIT_1},"attempt_2_exit":${EXIT_2},"last_50_lines_of_stderr":"${LAST_50}"}
EOF
chmod 644 "$FAIL_FILE"

# dead-man ping — healthchecks.io: success-ping = /fail suffix = explicit FAIL signal.
# We do BOTH: hit the plain URL (lets the schedule re-arm) AND /fail (explicit failure).
if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
  BASE="${BACKUP_HEALTHCHECK_URL%/}"
  case "$BASE" in
    */fail) FAIL_URL="$BASE" ;;
    *)      FAIL_URL="${BASE}/fail" ;;
  esac
  curl -fsS -m 10 --retry 3 -X POST "$FAIL_URL" >/dev/null 2>&1 || true
fi

exit 1