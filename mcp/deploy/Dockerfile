FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN pip install --no-cache-dir poetry==1.8.3

# deps first (layer cache)
COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false && poetry install --only main --no-root

COPY prd_mcp ./prd_mcp
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini
COPY deploy/entrypoint.sh ./entrypoint.sh
COPY deploy/scripts/patch_elf.py /tmp/patch_elf.py
RUN chmod +x ./entrypoint.sh

# Patch onnxruntime's .so to not require executable stack.
# Newer hardened kernels (hostinger, grsecurity) refuse .so files with
# READ_IMPLIES_EXEC personality. Clearing the PF_X bit on the PT_GNU_STACK
# ELF segment header avoids the "cannot enable executable stack" error.
# We don't actually use chromadb's default EF (OpenAI embeddings via
# env_secret), so this is purely an import-time guard.
RUN python3 /tmp/patch_elf.py /usr/local/lib/python3.10/site-packages/onnxruntime/capi/*.so

EXPOSE 8300
ENTRYPOINT ["./entrypoint.sh"]
