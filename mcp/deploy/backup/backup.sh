#!/bin/sh
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/backups/prd_${TS}.sql.gz

FREE_KB=$(df -Pk /backups | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -lt 1048576 ]; then
  echo "INSUFFICIENT_DISK: ${FREE_KB}KB free" >&2
  exit 1
fi

PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h prd-postgres -U prd_app -d prd_auth \
  --no-owner --no-privileges | gzip -9 > "$OUT"

curl -fsS --retry 3 -m 10 "${BACKUP_HEALTHCHECK_URL}" >/dev/null

find /backups -name "prd_*.sql.gz" -mtime +30 -delete

echo "backup_ok: ${OUT}"
