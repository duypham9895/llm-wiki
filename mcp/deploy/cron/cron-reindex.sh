#!/bin/sh
# cron-reindex.sh — force re-index the Chroma store from the vault.
# Auto-retry + dead-man ping on persistent failure.
# POSIX sh (busybox ash).
set -u

LOG_DIR="/var/log/cron"
FAIL_DIR="/data/vault/.cron-failures"

mkdir -p "$LOG_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG_FILE="${LOG_DIR}/reindex-${TS}.log"

STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cd /app/mcp

# ── attempt 1 ────────────────────────────────────────────────────────────────
.venv/bin/python -m prd_mcp.cli index --force >"$LOG_FILE" 2>&1
EXIT_1=$?

if [ "$EXIT_1" -eq 0 ]; then
  exit 0
fi

# ── retry 1 (5 min) ──────────────────────────────────────────────────────────
sleep 300
.venv/bin/python -m prd_mcp.cli index --force >>"$LOG_FILE" 2>&1
EXIT_2=$?

# ── retry 2 (5 min) ──────────────────────────────────────────────────────────
if [ "$EXIT_2" -ne 0 ]; then
  sleep 300
  .venv/bin/python -m prd_mcp.cli index --force >>"$LOG_FILE" 2>&1
  EXIT_3=$?
else
  EXIT_3=0
fi

if [ "$EXIT_3" -eq 0 ]; then
  exit 0
fi

# ── all attempts failed: alert + persist ─────────────────────────────────────
FINISHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LAST_50=$(tail -n 50 "$LOG_FILE" | sed 's/[\"]/\\&/g' | tr '\n' ' ')

mkdir -p "$FAIL_DIR"
FAIL_FILE="${FAIL_DIR}/${TS}.json"

cat >"$FAIL_FILE" <<EOF
{"started_at":"${STARTED_AT}","finished_at":"${FINISHED_AT}","attempt_1_exit":${EXIT_1},"attempt_2_exit":${EXIT_2},"attempt_3_exit":${EXIT_3},"last_50_lines_of_stderr":"${LAST_50}"}
EOF
chmod 644 "$FAIL_FILE"

if [ -n "${BACKUP_HEALTHCHECK_URL:-}" ]; then
  BASE="${BACKUP_HEALTHCHECK_URL%/}"
  case "$BASE" in
    */fail) FAIL_URL="$BASE" ;;
    *)      FAIL_URL="${BASE}/fail" ;;
  esac
  curl -fsS -m 10 --retry 3 -X POST "$FAIL_URL" >/dev/null 2>&1 || true
fi

exit 1