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
RUN chmod +x ./entrypoint.sh

# Patch onnxruntime's .so to not require executable stack.
# Newer hardened kernels (hostinger, grsecurity) refuse .so files with
# READ_IMPLIES_EXEC personality. execstack -c clears the flag. Without this,
# chromadb's import-time DefaultEmbeddingFunction() raises:
#   ImportError: ... cannot enable executable stack as shared object requires
# We don't actually use chromadb's default EF (OpenAI embeddings via
# env_secret), so this is purely an import-time guard.
RUN apt-get update && apt-get install -y --no-install-recommends prelink \
    && execstack -c /usr/local/lib/python3.10/site-packages/onnxruntime/capi/*.so \
    && apt-get purge -y prelink && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8300
ENTRYPOINT ["./entrypoint.sh"]
