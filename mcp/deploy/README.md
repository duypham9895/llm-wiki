# PRD Auth — openclaw deployment

> One-brain-two-doors. The FastAPI web app (HTTP) and the MCP stdio server (Claude Code/Codex)
> share the same Python core (`mcp/prd_mcp/{retrieve,answer,store,read,index,llm,config}`).
> Vault on disk + Chroma index are the source of truth; Notion is upstream; the dashboard is downstream.

## What's deployed

| Service        | Image                              | Role                                                    | Port (internal) |
| -------------- | ---------------------------------- | ------------------------------------------------------- | ---------------- |
| `prd-postgres` | `postgres:16-alpine`              | User/session/role/recent_views tables                   | 5432             |
| `prd-app`      | `ghcr.io/.../llm-wiki/app`          | FastAPI web (HTTP) + `npm` + sync CLI in same container | 8300             |
| `prd-ui-build` | `ghcr.io/.../llm-wiki/webui`        | One-shot Vite build → static bundle                     | —                |
| `prd-caddy`    | `caddy:2-alpine`                   | HTTPS + SPA routing + `/api/*` proxy                    | 80 → 443         |
| `prd-backup`   | `alpine:3.20`                      | Nightly `pg_dump` → `/backups` + healthchecks.io ping   | —                |
| `prd-deployer` | custom                             | Watches master branch → rebuilds + restarts on push     | —                |
| `prd-cron`     | `node:22-alpine`                   | Nightly sync + re-index + enrich (see below)            | —                |

## One-shot setup

1. `cp .env.example .env` → fill real values → `chmod 600 .env`.
2. `docker compose build`
3. `docker compose up -d` (entrypoint runs `alembic upgrade head`, then starts uvicorn; app seeds on startup).
4. Add the Caddy block from `Caddyfile.snippet` to the box's Caddyfile, `caddy reload`.
5. Smoke: `curl https://prd.duyopenclaw.tech/healthz` → `{"db":"ok"}`;
   login as `ADMIN_EMAIL` via `POST /api/auth/login` (header `X-Requested-With: prd-app`).

Break-glass: if every admin is disabled/deleted, a restart re-asserts the `.env` admin.
To permanently retire it, remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` after another admin exists.

## What lives where

| Concern             | Lives in                                                        | Why                                  |
| ------------------- | --------------------------------------------------------------- | ------------------------------------ |
| PRD source of truth | Notion (Product Backlog DB) + local vault `<vault>/PRDs/*.md`   | Notion is editor; vault is canonical |
| Search index        | ChromaDB at `<vault>/.chroma-mcp/`                              | Vector + keyword, rebuilt on sync    |
| User data           | Postgres `prd_app` user + `session` + `role` + `recent_views`   | Shared between web + MCP             |
| Embeddings / LLM    | OpenAI `text-embedding-3-small` (1536-dim) + MiniMax router chat | Hybrid creds in `env_secret`         |
| Backups             | `/opt/llm-wiki/backups/*.dump.gz`                               | Nightly pg_dump, 7-day rotation      |

## Pipeline stages (and how to trigger each)

| Stage  | What                                     | Trigger                                 | When |
| ------ | ---------------------------------------- | --------------------------------------- | ---- |
| Sync   | Notion → vault (.md files)               | `npm run sync` (UI: Sources → Run now)  | nightly + on demand |
| Enrich | LLM fills `llm:` block in each .md       | `npm run enrich`                        | nightly |
| Index  | Build Chroma embeddings from vault       | `python -m prd_mcp.cli index`           | nightly + on demand |
| Orchestrate | Sync + Enrich + Index in sequence    | `npm run orchestrate`                   | nightly (02:00 UTC) |

The `prd-cron` service runs `npm run orchestrate` nightly. The Sources page "Run now" button
runs `npm run sync` only (faster — does not enrich or re-index). After a sync, the web UI's
`sources.py:_run_subprocess` automatically chains `python -m prd_mcp.cli index` so the
Library/Search/Status tabs reflect the new files within ~30 seconds.

## Common operations

```bash
# Trigger full pipeline on demand (from VPS)
ssh openclaw 'docker exec deploy-prd-app-1 bash -c "cd /app && npm run orchestrate"'

# Trigger sync only (UI "Run now" equivalent, no enrich)
ssh openclaw 'docker exec deploy-prd-app-1 bash -c "cd /app && npm run sync"'

# Trigger re-index only
ssh openclaw 'docker exec deploy-prd-app-1 bash -c "python -m prd_mcp.cli index --force"'

# Tail app logs
ssh openclaw 'docker logs deploy-prd-app-1 -f'

# Run database migration manually (usually automatic on app start)
ssh openclaw 'docker exec deploy-prd-app-1 bash -c "alembic upgrade head"'

# Reset admin password (breaks-glass)
# Edit ADMIN_PASSWORD in /opt/llm-wiki/mcp/deploy/.env, then:
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose up -d prd-app'

# Restart one service
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose restart prd-app'

# Tail cron logs
ssh openclaw 'docker logs deploy-prd-cron-1 -f'
```

## Debugging recipes

| Symptom                                  | Cause                              | Fix                                |
| ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| `Library` shows "No PRDs found"           | Chroma empty                       | `python -m prd_mcp.cli index --force` |
| `Search` returns 500                       | Chroma broken or no embeddings     | Same as above                      |
| `Status` shows "0 / 0 enriched" forever   | Index never ran                    | Same as above                      |
| Sources page Run now stays "Running" forever | Notion API rate-limited           | Wait, or reduce sync frequency     |
| Login fails with 401                      | Bad credentials OR session cookie expired | Log in again                    |
| `webui` build fails                        | TS error                            | `cd /opt/llm-wiki/mcp/web-ui && npm run build` |
| `app` image won't start                    | Migration failed                    | `docker logs deploy-prd-app-1`     |

## Rollback

```bash
# Pin to a previous SHA on VPS
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && sed -i "s/IMAGE_TAG=.*/IMAGE_TAG=<previous-sha>/" .env && docker compose pull && docker compose up -d'
```

The deployer sidecar (`prd-deployer`) watches master on GitHub and rebuilds + restarts on every
push. To stop auto-deploys temporarily: `ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose stop prd-deployer'`.

## Cron schedule (`prd-cron`)

The `prd-cron` service runs nightly maintenance on the PRD vault — no human in the loop.

| Time (UTC) | Job                          | Command                                                                   |
| ---------- | ---------------------------- | ------------------------------------------------------------------------- |
| `02:00`    | Full pipeline                | `cd /app && npm run orchestrate` (sync → enrich → index)                  |
| `03:00`    | Force re-index (drift catch) | `cd /app/mcp && .venv/bin/python -m prd_mcp.cli index --force`           |

**Why two jobs?** The 02:00 job may bump into Notion rate limits or transient LLM failures; the 03:00 force re-index guarantees the Chroma store is coherent with the vault even if the morning pipeline skipped/errored on a doc.

### Implementation

- `node:22-alpine` image (needs `npm` + `tsx` to run `npm run orchestrate`).
- Repo mounted `:ro` at `/app`; vault volume `prd_vault` mounted `rw` at `/data/vault` (the pipeline writes new PRD `.md` files).
- `busybox crond` reads `/etc/crontabs/root` from `cron/crontab.txt` and streams its log to stdout (`crond -f -L /dev/stdout`) — visible in `docker logs`.
- **No `depends_on`** on `prd-app` / `prd-postgres` — cron runs even if the app is down (the index step uses the mounted vault + env, not the live app process).
- Runs as `root` (busybox crond requirement to read `/etc/crontabs/root`).

### Manual operations

```bash
# Trigger the full pipeline on demand (from VPS)
ssh openclaw 'docker exec deploy-prd-app-1 bash -c "cd /app && npm run orchestrate"'

# Tail cron logs (jobs + cron daemon chatter)
ssh openclaw 'docker logs deploy-prd-cron-1 -f'

# Disable cron (e.g. while debugging) — container exits, no jobs run
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose stop prd-cron'

# Re-enable
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose start prd-cron'

# Edit the schedule — modify mcp/deploy/cron/crontab.txt, then:
ssh openclaw 'cd /opt/llm-wiki/mcp/deploy && docker compose restart prd-cron'
```

### Assumptions baked into the schedule

- **Vault location**: cron reads `/data/vault` (the same `prd_vault` volume the app uses). Anything written by sync/enrich at 02:00 is immediately visible to the re-index at 03:00.
- **CLI image**: the cron container needs `tsx` to run TypeScript and the Python venv at `mcp/.venv/` for `prd-mcp`. The mounted repo provides both — no separate image build required.
- **Env**: cron reads the same `.env` (via `env_file`) so `NOTION_TOKEN`, `LLM_API_KEY`, `PRD_SECRETS=env`, `VAULT_PATH`, etc. are all available. `HEALTHCHECK_URL` is optional (orchestrator pings on pipeline success).
- **No host cron**: keep host crontab clean — all scheduled work lives in the container, so `docker compose down/up` keeps the schedule intact.
