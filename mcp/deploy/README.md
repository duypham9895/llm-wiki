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

The `prd-cron` service runs scheduled maintenance on the PRD vault — no human in the loop.

| Time (UTC)        | Job                            | Command                                                                   |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `02:00` daily     | Full pipeline                  | `cd /app && npm run orchestrate` (sync → enrich → index)                  |
| `03:00` daily     | Force re-index (drift catch)   | `cd /app/mcp && .venv/bin/python -m prd_mcp.cli index --force`           |
| `06/10/14/18/22`  | Drift catch (5x/day, every 4h) | `cron-drift.sh` (sync → reindex; skip enrich)                            |

**Cadence decision:** the nightly 02:00 run is the only job that calls `enrich` — that's the slow + LLM-costly stage. The 4-hourly drift catches (`06, 10, 14, 18, 22 UTC`) do `sync + reindex` only, so daytime Notion edits surface in Library within ~4h instead of waiting for the nightly full pipeline. The 03:00 force-reindex remains as a safety net for the nightly run (in case 02:00 hit a Notion rate limit or transient LLM failure).

To change the cadence, edit `mcp/deploy/cron/crontab.txt` and `docker compose restart prd-cron`.

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

### Failure handling — auto-retry + dead-man alert

Both cron scripts wrap their commands in a retry + alert loop so a single
transient failure (Notion rate-limit, OpenAI 429, vault flake) doesn't
silently halt the nightly pipeline.

| Script            | Command                                            | Retries | Sleep between |
| ----------------- | -------------------------------------------------- | ------- | ------------- |
| `cron-pipeline.sh`  | `npm run orchestrate`                              | 1 (2 attempts total) | 10 min |
| `cron-reindex.sh`   | `python -m prd_mcp.cli index --force`              | 2 (3 attempts total) | 5 min  |

On every attempt, stdout + stderr are captured to
`/var/log/cron/<job>-<UTC-timestamp>.log` (these dirs are created at
container start by `cron/entrypoint.sh` with `chmod 777` so any user can
write).

**When every attempt fails**, the script:

1. Writes a structured failure summary to
   `/data/vault/.cron-failures/<UTC-timestamp>.json` with fields:
   ```json
   {
     "started_at": "...",
     "finished_at": "...",
     "attempt_1_exit": 1,
     "attempt_2_exit": 1,
     "last_50_lines_of_stderr": "..."
   }
   ```
   `cron-reindex.sh` also writes `attempt_3_exit`. The file lives inside
   the `prd_vault` volume, so it survives container restarts and can be
   inspected from the host or from `prd-app`.
2. POSTs to `${BACKUP_HEALTHCHECK_URL}/fail` (creating the suffix if it
   isn't already there). Healthchecks.io treats a hit on `/fail` as an
   explicit failure ping, paging the configured alert channel.
3. Exits non-zero so the cron daemon logs the failure visibly in
   `docker logs deploy-prd-cron-1`.

**Where to find failure summaries on the VPS:**

```bash
ssh openclaw 'docker exec deploy-prd-cron-1 ls -la /data/vault/.cron-failures/'
ssh openclaw 'docker exec deploy-prd-cron-1 cat /data/vault/.cron-failures/<timestamp>.json'
```

**Manually test the dead-man ping:**

```bash
ssh openclaw 'docker exec deploy-prd-cron-1 curl -X POST "${BACKUP_HEALTHCHECK_URL}"'
# should return "OK" and re-arm the healthcheck schedule
```

**Behavior on persistent failure (operator flow):** 1 retry → healthcheck
ping + failure JSON file → operator gets paged by healthchecks.io →
operator inspects `/data/vault/.cron-failures/*.json` for the failing
command's last 50 stderr lines and `/var/log/cron/*.log` for the full
output, then fixes the root cause (or kicks the pipeline manually via
`docker exec deploy-prd-app-1 bash -c "cd /app && npm run orchestrate"`).
