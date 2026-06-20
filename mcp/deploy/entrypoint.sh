#!/usr/bin/env bash
set -euo pipefail

# Run migrations (sync driver; env.py strips +asyncpg) then start the app.
echo "[entrypoint] running alembic upgrade head"
ALEMBIC_DATABASE_URL="${DATABASE_URL}" alembic upgrade head

echo "[entrypoint] starting uvicorn (single worker)"
exec python -m prd_mcp.cli web --host 0.0.0.0 --port 8300
