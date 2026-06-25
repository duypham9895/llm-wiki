FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# ---- Node 22 (for the Notion sync CLI invoked by mcp/prd_mcp/web/sources.py) ----
# We install Node inside the Python image rather than switching base to node:22-slim
# because the Python web server is the dominant runtime; the sync CLI runs only when
# an admin clicks "Run now" on /admin/sources.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && npm --version

# ---- Python deps (layer cache) ----
RUN pip install --no-cache-dir poetry==1.8.3
COPY mcp/pyproject.toml mcp/poetry.lock ./
RUN poetry config virtualenvs.create false && poetry install --only main --no-root

# ---- Python source ----
COPY mcp/prd_mcp ./prd_mcp
COPY mcp/migrations ./migrations
COPY mcp/alembic.ini ./alembic.ini
COPY mcp/deploy/entrypoint.sh ./entrypoint.sh
COPY mcp/deploy/scripts/patch_elf.py /tmp/patch_elf.py
RUN chmod +x ./entrypoint.sh

# ---- Node sync CLI (Notion → Obsidian PRD vault) ----
# Lives at the repo root (/src/, /package.json). `npm run sync` resolves to
# `tsx src/index.ts`. The cwd at subprocess time defaults to /app via
# RUN_CWD in mcp/prd_mcp/web/sources.py.
COPY src ./src
COPY tsconfig.json ./
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund tsx@4.19.0 \
 && npm cache clean --force

# Patch onnxruntime's .so to not require executable stack.
# Newer hardened kernels (hostinger, grsecurity) refuse .so files with
# READ_IMPLIES_EXEC personality. Clearing the PF_X bit on the PT_GNU_STACK
# ELF segment header avoids the "cannot enable executable stack" error.
# We don't actually use chromadb's default EF (OpenAI embeddings via
# env_secret), so this is purely an import-time guard.
RUN python3 /tmp/patch_elf.py /usr/local/lib/python3.10/site-packages/onnxruntime/capi/*.so

EXPOSE 8300
ENTRYPOINT ["./entrypoint.sh"]
