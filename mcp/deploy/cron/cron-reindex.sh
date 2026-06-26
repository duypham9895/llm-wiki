#!/bin/sh
# cron-reindex.sh — force re-index the Chroma store from the vault.
# Mounted repo provides the Python venv at mcp/.venv/; vault is mounted rw.
set -eu

cd /app/mcp
.venv/bin/python -m prd_mcp.cli index --force
