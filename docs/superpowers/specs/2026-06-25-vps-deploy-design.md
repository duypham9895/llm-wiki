# VPS Deploy — Design Spec

**Date:** 2026-06-25
**Status:** Draft (pre-review)
**Author:** brainstorm session
**Related:** `2026-06-20-web-dashboard-design.md` (phase 3 frontend), `2026-06-20-auth-user-management-design.md` (phase 2 backend), existing `mcp/deploy/` skeleton.

## Goal

Ship `llm-wiki` (FastAPI backend + Vite/React web-ui + Postgres + Obsidian vault + Chroma index) to a single private VPS, fronted by Caddy with auto-TLS, with auto-deploys from `master` and nightly Postgres backups. Make the result verifiable end-to-end against the real backend before the first push.

## Non-Goals (v1)

- Horizontal scaling, multi-VPS, load balancer.
- High availability (single point of failure — the VPS itself).
- TLS termination other than via Caddy's Let's Encrypt HTTP-01.
- Application-level metrics, request tracing, uptime monitoring.
- Disk quotas or per-volume size alerts.
- Auto-rollback on deploy failure (manual rollback only).
- Image-based backup of vault (we back up Postgres only; vault is rebuilt from `master`).
- Public exposure of MCP server (`prd-mcp serve`) — only the FastAPI web app is exposed.

## Decisions Locked

| # | Decision | Rationale |
|---|---|---|
| D1 | **Push repo to github as `duypham9895/llm-wiki` (private)** | User's stated target. |
| D2 | **Scope: a → b → c → d sequentially** (PR phase3 → real-backend e2e → codify e2e → deploy package) | User chose "full" path. |
| D3 | **Caddy inside docker (not host-installed)** | Single `docker compose up -d` boots everything; no host-level TLS config. |
| D4 | **Web-ui built into its own image, served by Caddy as static** | Decouples UI rebuilds from API rebuilds; no Node runtime needed at runtime. |
| D5 | **Postgres inside docker, named volume** | Self-contained; backup via `pg_dump` is trivial. |
| D6 | **`prd-deployer` sidecar, not watchtower** | Watchtower is incompatible with pinned-sha deploys. Deployer is ~50 lines of bash and gives us atomic rollback via `.env` change. |
| D7 | **Container registry: GHCR (`ghcr.io/duypham9895/llm-wiki`)** | Free for private repos; auth works with `gh` CLI. |
| D8 | **Backup sidecar with cron + healthchecks.io dead-man's-notify** | Catches backup failure without us having to monitor anything. |
| D9 | **Hostname: placeholder `wiki.example.com` — user edits before first deploy** | User did not provide real hostname during brainstorming. Substitution documented in runbook. |
| D10 | **Caddy email: `duypham9895@users.noreply.github.com`** | Keeps real email out of cert registration. |
| D11 | **Single hostname, path-prefix routing** | Caddy serves `/` as static UI, reverse-proxies `/api/*`, `/healthz`, and SSE paths to backend. |
| D12 | **Real-backend e2e uses user's local keychain + real LLM calls** | User chose this. Means the e2e run costs a few API calls and exercises the actual LLM path. |

## Architecture

### Topology

```
internet ──:443──> caddy (caddy:2-alpine, pinned)
                 │
                 ├─ /              ──> file_server from prd_ui_dist:/srv (named volume)
                 ├─ /api/*         ──> reverse_proxy prd-app:8300
                 ├─ /healthz       ──> reverse_proxy prd-app:8300/healthz
                 └─ @sse matcher   ──> reverse_proxy with flush_interval=-1 (no buffering)

ghcr.io ──prd-deployer (every 6h)──> pulls new app:<sha>, webui:<sha>
                                   ──> writes IMAGE_TAG to .env
                                   ──> docker compose up -d prd-app prd-ui-build

prd-app ──> prd-postgres:5432 (docker network prd_net)
        ──> /data/vault → prd_vault volume (persistent PRD source + chroma index)
        ──> host.docker.internal:8300 (Caddy → app, keeps uvicorn's forwarded_allow_ips=127.0.0.1 trust)

prd-backup ──cron 03:00 UTC─> pg_dump prd-postgres → /backups/prd_<ts>.sql.gz (prd_backups vol)
                          ──> curl BACKUP_HEALTHCHECK_URL (healthchecks.io ping)
```

### Services

| Service | Image | Pinned? | Watched? | Restart | Purpose |
|---|---|---|---|---|---|
| `prd-postgres` | `postgres:16-alpine` | yes (no `:latest`) | no | unless-stopped | DB |
| `prd-app` | `ghcr.io/.../app:${IMAGE_TAG}` | yes (sha tag) | **yes** (deployer label) | unless-stopped | FastAPI backend |
| `prd-ui-build` | `ghcr.io/.../webui:${IMAGE_TAG}` | yes (sha tag) | **yes** (deployer label) | no (one-shot) | Init container: copies `/srv` from image into `prd_ui_dist` volume |
| `prd-caddy` | `caddy:2-alpine` | yes (no `:latest`) | no | unless-stopped | Reverse proxy + static UI server + TLS |
| `prd-backup` | `alpine:3.20` | yes | no | unless-stopped | Nightly `pg_dump` cron |
| `prd-deployer` | `alpine:3.20` | yes | no (self-exclude) | unless-stopped | Polls GHCR, bumps `IMAGE_TAG`, runs `compose up -d` |

### Volumes

| Volume | Mounted into | Survives `compose down`? | Survives `compose down -v`? |
|---|---|---|---|
| `prd_pgdata` | `/var/lib/postgresql/data` | yes | no (destructive) |
| `prd_vault` | `/data/vault` | yes | no (destructive; rebuild from `master`) |
| `prd_ui_dist` | `/srv` (caddy), `/srv_out` (ui-build) | yes | no (rebuilt on next ui-build run) |
| `prd_backups` | `/backups` | yes | no (destructive; off-host copy recommended) |
| `prd_caddy_data` | `/data` (caddy) | yes | no (cert re-issuance required) |
| `prd_caddy_config` | `/config` (caddy) | yes | no |

### Networks

Single bridge network `prd_net`. Caddy is the only service that publishes host ports (`80`, `443`). Postgres listens on the docker network only. App listens on `127.0.0.1:8300` (host loopback) AND inside `prd_net`. Caddy reaches the app via `host.docker.internal:8300` (added via compose `extra_hosts`) to preserve `forwarded_allow_ips="127.0.0.1"` trust in `prd_mcp/cli.py`.

## Components in Detail

### `prd-app` (existing skeleton, minor changes)

- Image: `ghcr.io/duypham9895/llm-wiki/app:${IMAGE_TAG}`.
- Build context: existing `mcp/deploy/Dockerfile` (no source changes).
- New env: `IMAGE_TAG` (required).
- New volume mount: `prd_vault:/data/vault` — fixes the bug in the existing skeleton where `/data/vault` is ephemeral.
- `depends_on: prd-postgres: { condition: service_healthy }` — replaces plain `depends_on: [prd-postgres]`.
- Healthcheck: HTTP GET `/healthz` every 30s, 3 retries, 20s start period.
- Host port publish: `127.0.0.1:8300:8300` — kept as-is so Caddy can reach via `host.docker.internal`.

### `prd-webui` image (new) + `prd-ui-build` service

**Image Dockerfile** — `mcp/web-ui/Dockerfile.build` (new), multi-stage:

```dockerfile
# stage 1: build
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# stage 2: runtime (carries the bundle only)
FROM caddy:2-alpine
COPY --from=build /src/dist /srv
```

The image is ~25 MB. It contains the static `dist/` at `/srv` and nothing else. **It is never run as a server** — see the init container pattern below.

**`prd-ui-build` service** — one-shot init container that copies `/srv` from the image into the `prd_ui_dist` named volume:

```yaml
prd-ui-build:
  image: ghcr.io/duypham9895/llm-wiki/webui:${IMAGE_TAG}
  command: ["sh", "-c", "cp -r /srv/. /srv_out/ && echo built"]
  volumes:
    - prd_ui_dist:/srv_out
  restart: "no"
  networks: [prd_net]
```

When `IMAGE_TAG` is bumped, deployer runs `docker compose up -d prd-ui-build`, which copies the new bundle into the shared volume. `prd-caddy` serves whatever is currently in the volume.

### `prd-caddy` (new)

- Image: `caddy:2-alpine` (pinned tag).
- Compose: published ports `80`, `443`. Mounted volumes: `./Caddyfile` (ro), `prd_ui_dist` (ro at `/srv`), `prd_caddy_data`, `prd_caddy_config`, `extra_hosts: host.docker.internal:host-gateway`.
- Env: `HOSTNAME`, `CADDY_EMAIL` (from `.env`; Caddy interpolates `{$HOSTNAME}` and `{$CADDY_EMAIL}` in the Caddyfile).

**Caddyfile** — `mcp/deploy/Caddyfile` (new, replaces `Caddyfile.snippet`):

```caddyfile
{
    email {$CADDY_EMAIL}
    auto_https off
}

{$HOSTNAME} {
    encode zstd gzip

    # SSE/streaming — disable buffering so chat tokens flush as they arrive.
    # Real path is POST /api/chat/conversations/{cid}/messages (sse_starlette.EventSourceResponse).
    @sse path /api/chat/conversations/*/messages
    reverse_proxy @sse prd-app:8300 {
        flush_interval -1
        buffer_requests off
    }

    # other API paths
    reverse_proxy /api/* prd-app:8300
    reverse_proxy /healthz prd-app:8300

    # static UI
    root * /srv
    try_files {path} /index.html
    file_server
}
```

Notes:
- `try_files {path} /index.html` lets the React Router client-side routes resolve to `index.html`.
- `@sse` matcher matches the streaming endpoints — must be declared before the generic `/api/*` matcher.
- `host.docker.internal` resolves via `extra_hosts`; Caddy talks to the app via the host loopback on `:8300` to preserve `forwarded_allow_ips="127.0.0.1"`.

### `prd-postgres` (existing, healthcheck added)

- Image: `postgres:16-alpine` (pinned).
- Healthcheck: `pg_isready -U prd_app -d prd_auth` every 10s, 5 retries.
- No change to env or volumes other than the named volume (unchanged from existing skeleton).

### `prd-backup` (new)

**`mcp/deploy/backup/entrypoint.sh`** — runs crond in foreground:

```sh
#!/bin/sh
set -eu
cat > /etc/crontabs/root <<EOF
0 3 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
EOF
exec crond -f -L /dev/stdout
```

**`mcp/deploy/backup/backup.sh`** — pg_dump + retention + healthchecks.io ping:

```sh
#!/bin/sh
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/backups/prd_${TS}.sql.gz

# pre-check: 1GB free minimum
FREE_KB=$(df -Pk /backups | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -lt 1048576 ]; then
  echo "INSUFFICIENT_DISK: ${FREE_KB}KB free" >&2
  exit 1   # no healthchecks ping → email alarm
fi

PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h prd-postgres -U prd_app -d prd_auth \
  --no-owner --no-privileges | gzip -9 > "$OUT"

curl -fsS --retry 3 -m 10 "${BACKUP_HEALTHCHECK_URL}" >/dev/null

find /backups -name "prd_*.sql.gz" -mtime +30 -delete
```

Compose: `alpine:3.20`, mounts `./backup/` (ro), `prd_backups`, env_file `.env`.

### `prd-deployer` (new, replaces watchtower)

**Why not watchtower:** watchtower re-pulls images but cannot change a container's pinned image tag. If `prd-app` is pinned to `app:abc123` and we push `app:def456`, watchtower pulls `def456` but cannot tell compose to run `app:def456`. The container keeps running `abc123`. To make pinned-sha deploys work with watchtower, you'd have to use floating tags (`app:latest`), which destroys the rollback story.

**`mcp/deploy/deployer/poll.sh`** (~50 lines):

```sh
#!/bin/sh
set -eu

REPO="duypham9895/llm-wiki"
ENV_FILE="/app/.env"
STATE_FILE="/state/deployer.state"
LATEST_TAG=$(cat "$ENV_FILE" 2>/dev/null | grep '^IMAGE_TAG=' | cut -d= -f2 || echo "")

poll() {
  local img=$1
  # GHCR anonymous pull token
  local token
  token=$(curl -fsS "https://ghcr.io/token?scope=repo:${REPO}/${img}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -z "$token" ] && return 1
  # list tags, pick the lexicographically greatest (we tag with git SHAs)
  curl -fsS -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/${REPO}/${img}/tags/list" \
    | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' \
    | sort | tail -1
}

new_app=$(poll app || echo "")
new_webui=$(poll webui || echo "")

if [ -n "$new_app" ] && [ "$new_app" != "$LATEST_TAG" ]; then
  sed -i.bak "s/^IMAGE_TAG=.*/IMAGE_TAG=${new_app}/" "$ENV_FILE"
  cd /app && docker compose pull prd-app prd-ui-build \
    && docker compose up -d prd-app prd-ui-build \
    && rm -f "$ENV_FILE.bak" \
    && echo "$(date -u +%FT%TZ) deployed ${new_app}" > "$STATE_FILE" \
    || { mv "$ENV_FILE.bak" "$ENV_FILE"; echo "deploy_failed" > "$STATE_FILE"; exit 1; }
fi
```

Compose: base image `docker:27-cli` (ships docker CLI; alpine does not). Mounts `./.env` (rw at `/app/.env`), `prd_deployer_state:/state`, `/var/run/docker.sock`. Entrypoint runs `while true; do poll.sh; sleep 21600; done` (6h polling).

## Data Flow

### Cold-start

1. Provision Ubuntu 22.04+ VPS, point domain A record to public IP, verify with `dig +short {$HOSTNAME}`.
2. `apt install docker.io docker-compose-v2` (only host-level setup).
3. Clone repo, `cd mcp/deploy`, `cp .env.example .env`, fill secrets (`POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `OPENAI_API_KEY`, `LLM_API_KEY`, `NOTION_TOKEN`, `HOSTNAME=wiki.example.com`, `CADDY_EMAIL`, `IMAGE_TAG=latest`, `BACKUP_HEALTHCHECK_URL`).
4. `chmod 600 .env`.
5. `docker compose pull && docker compose up -d`.
6. First boot: `prd-app` runs `alembic upgrade head`, `prd-caddy` issues Let's Encrypt cert for `{$HOSTNAME}`, `prd-backup` waits for 03:00 UTC.
7. Smoke: `curl -fsS https://{$HOSTNAME}/healthz` returns `{"db":"ok"}`. Browser load, log in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

### Hot path — user request

1. Browser → `https://{$HOSTNAME}/` → Caddy serves `index.html` from `prd_ui_dist` → SPA loads.
2. `POST /api/auth/login` → Caddy → `host.docker.internal:8300` → `prd-app:8300` → Postgres → session cookie.
3. `POST /api/chat/conversations/{cid}/messages` (SSE via `sse_starlette.EventSourceResponse`) → Caddy `@sse` matcher → `prd-app` with `flush_interval=-1` → tokens stream without buffering.
4. `GET /api/search` → Caddy → `prd-app` → Chroma on `prd_vault` volume → ranked results.
5. `GET /api/library` → Caddy → `prd-app` → Postgres.

### Hot path — deploy

1. Push to `master` on github.
2. GH Actions builds `app:<sha>` + `webui:<sha>`, pushes to GHCR (~3-5 min).
3. Within 6h, `prd-deployer` polls, sees new tag, updates `.env`, runs `docker compose pull && up -d`.
4. Verify: `curl -fsS https://{$HOSTNAME}/healthz` returns 200.

### Hot path — backup

1. 03:00 UTC: `prd-backup` cron → `pg_dump` to `/backups/prd_<ts>.sql.gz`.
2. On success: `curl BACKUP_HEALTHCHECK_URL` (dead-man's-notify ping).
3. Retention: delete files older than 30 days.

## Error Handling

| Failure | Detection | Mitigation | Recovery |
|---|---|---|---|
| TLS cert issuance fails (DNS not pointed) | Browser cert warning; `curl -v` shows self-signed | Caddy auto-retries every 30s | Verify DNS, wait 5 min, `docker compose restart prd-caddy` |
| Postgres won't start (bad pwd / OOM / disk full) | `prd-app` logs "waiting for postgres" | None (intentional) | `docker compose logs prd-postgres`; fix `.env`; `docker compose up -d` |
| App OOMs under chat load | App container exits, restart loop | None v1 | Bump VPS RAM, or reduce concurrent users |
| Deployer corrupts `.env` | `docker compose config` fails on next deploy | Deployer writes `.env.bak` first, validates, atomic `mv` | `mv .env.bak .env && docker compose up -d prd-app` |
| Backup script fails | No healthchecks.io ping within 24h+grace | Pre-check disk space | SSH, check `prd-backup` logs, run `backup.sh` manually |
| Disk fills (`prd_pgdata`) | App crashes, postgres won't write | None v1 | Backup → `docker volume rm prd_pgdata` (destructive) → restore from backup |
| Deployer can't reach GHCR | App keeps running on old IMAGE_TAG | None v1 (silent) | Check `prd-deployer` logs after 6h; manual `docker compose pull && up -d` if stuck |
| Cert expires | Browser warning; `curl -vI` shows near-expiry | Caddy auto-renews at 60d | Manual `caddy reload` if renewal fails |
| Caddy crashes | `502 Bad Gateway` to clients | `restart: unless-stopped` | None needed (auto-restart) |
| Secret leak (`.env` committed) | n/a (prevention) | `.env` in `.gitignore`, GHCR images never carry secrets | Rotate every key per runbook |

## Deploy & Rollback

### Initial deploy
See "Cold-start" above.

### Update deploy
1. Push to `master` → GH Actions builds images → GHCR.
2. Within 6h, deployer polls, bumps `IMAGE_TAG`, runs `compose up -d`.

### Manual update (faster)
```sh
ssh vps
cd ~/llm-wiki/mcp/deploy
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<sha>/' .env
docker compose pull prd-app prd-ui-build
docker compose up -d prd-app prd-ui-build
```

### Rollback (app only, no DB change)
```sh
ssh vps
cd ~/llm-wiki/mcp/deploy
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<prev-sha>/' .env
docker compose pull prd-app prd-ui-build
docker compose up -d prd-app prd-ui-build
```

### Rollback (DB)
1. `docker compose exec prd-postgres pg_dump ... > /tmp/pre-restore.sql.gz` (safety).
2. Pick a backup: `ls /var/lib/docker/volumes/prd_backups/_data/`.
3. `zcat <backup> | docker compose exec -T prd-postgres psql -U prd_app -d prd_auth`.
4. Restart app: `docker compose restart prd-app`.

### Emergency restart (everything)
```sh
cd ~/llm-wiki/mcp/deploy
docker compose down
docker compose up -d
```

### Nuclear (DESTRUCTIVE — deletes all volumes)
```sh
docker compose down -v
# restore from latest backup:
zcat /var/lib/docker/volumes/prd_backups/_data/prd_<latest>.sql.gz \
  | docker compose run --rm -T prd-postgres psql -U prd_app -d prd_auth
docker compose up -d
```

## Secrets

- `.env` on VPS only, `chmod 600`, in `.gitignore` (verify before first commit).
- Manual copy of `.env` to your password manager (1Password / Bitwarden) — documented in runbook.
- GHCR packages `app` and `webui` are public (anonymous pull required by deployer); secrets NEVER in image.
- Rotation list (runbook): `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `OPENAI_API_KEY`, `LLM_API_KEY`, `NOTION_TOKEN`, `CADDY_EMAIL`, `BACKUP_HEALTHCHECK_URL`.

## Backups

- Nightly `pg_dump` → `prd_backups` volume, retain 30 days.
- healthchecks.io dead-man's-notify URL pinged on success.
- v1: no off-host copy. Recommendation: weekly `scp` of `/var/lib/docker/volumes/prd_backups/_data/*.sql.gz` to your laptop or another VPS. Runbook has the command.
- Vault is **not** backed up (rebuilt from `master` on demand).

## Monitoring

- `/healthz` endpoint (already exists per `cli.py:44`).
- Caddy access logs to stdout (docker logs).
- Backup healthchecks.io ping (1 URL).
- **Out of scope v1:** app metrics, request tracing, uptime monitoring, deployer alerting.

## File Inventory

**New files:**
- `mcp/deploy/Caddyfile` (replaces `Caddyfile.snippet`; old snippet stays for backwards-compat reference, will be deleted in cleanup)
- `mcp/deploy/backup/entrypoint.sh`
- `mcp/deploy/backup/backup.sh`
- `mcp/deploy/deployer/poll.sh`
- `mcp/web-ui/Dockerfile.build`
- `.github/workflows/build-images.yml`
- `docs/runbooks/vps-deploy.md`

**Modified files:**
- `mcp/deploy/docker-compose.yml` (services: postgres +healthcheck; app: image+volumes+healthcheck; new: caddy, backup, deployer, ui-build)
- `mcp/deploy/.env.example` (add HOSTNAME, CADDY_EMAIL, IMAGE_TAG, BACKUP_HEALTHCHECK_URL)
- `mcp/prd_mcp/cli.py` — **no changes** (forwarded_allow_ips stays "127.0.0.1"; Caddy reaches app via `host.docker.internal`)

**Deleted files:**
- `mcp/deploy/Caddyfile.snippet` (after Caddyfile validated in production)

## Out of Scope (explicit)

- Migration to a multi-worker uvicorn setup (workaround: bump VPS RAM).
- Migration off uvicorn's `workers=1` to gunicorn+multiple workers (single-event-loop is intentional for shared `Core` state).
- TLS via DNS-01 (would require Cloudflare or another DNS provider hook).
- Off-host automated backup (manual `scp` only in v1).
- Auto-alerting on deployer failure (silent failure acceptable for single-user app).
- Rotation automation for any secret.