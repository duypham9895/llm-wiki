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

EXPOSE 8300
ENTRYPOINT ["./entrypoint.sh"]
