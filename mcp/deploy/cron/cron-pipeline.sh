#!/bin/sh
# cron-pipeline.sh — full PRD pipeline (sync + enrich + index).
# Mounted repo provides /app/package.json + src/ + tsx; vault is mounted rw.
set -eu

cd /app
npm run orchestrate
