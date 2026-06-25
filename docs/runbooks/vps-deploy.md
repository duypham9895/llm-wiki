# VPS Deploy Runbook

Owner: Duy. Updated 2026-06-25.

## Prerequisites

- Ubuntu 22.04+ VPS with public IPv4.
- Domain's A record pointed at the VPS IP. Verify with `dig +short wiki.example.com` returns the IP.
- Local machine: `gh` CLI authenticated, `ssh` configured for the VPS.

## First-time VPS bootstrap

1. SSH: `ssh ubuntu@<vps-ip>`
2. Install docker:
   ```sh
   sudo apt update && sudo apt install -y docker.io docker-compose-v2
   sudo usermod -aG docker $USER && exit
   # log back in for group change to take effect
   ```
3. Clone the repo:
   ```sh
   git clone https://github.com/duypham9895/llm-wiki.git ~/llm-wiki
   cd ~/llm-wiki
   git checkout master
   ```
4. Configure `.env`:
   ```sh
   cd mcp/deploy
   cp .env.example .env
   chmod 600 .env
   $EDITOR .env
   ```
   Required edits:
   - `POSTGRES_PASSWORD`: generate with `openssl rand -hex 24`
   - `ADMIN_PASSWORD`: generate with `openssl rand -hex 24`
   - `OPENAI_API_KEY`: real key from your password manager
   - `LLM_API_KEY`: real key
   - `HOSTNAME`: your real hostname (e.g. `wiki.example.com`)
   - `IMAGE_TAG`: leave as `latest` for first boot (deployer will replace with a SHA on next cycle)
   - `BACKUP_HEALTHCHECK_URL`: from healthchecks.io (create a check, paste the URL)
   - `CORS_ORIGIN`: `https://{$HOSTNAME}`
5. Start the stack:
   ```sh
   docker compose pull
   docker compose up -d
   ```
6. Wait for first boot (~60s):
   ```sh
   docker compose ps
   docker compose logs prd-app | tail -20
   docker compose logs prd-caddy | tail -20
   ```
   Expect: `prd-app` healthy, `prd-caddy` shows `obtained certificate` for your hostname.
7. Smoke test:
   ```sh
   curl -fsS https://$HOSTNAME/healthz   # expect {"db":"ok"} or similar
   ```
8. Open `https://$HOSTNAME/` in a browser, log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Change the admin password from the UI.

## Day-to-day operations

### View logs
```sh
docker compose logs -f prd-app       # backend
docker compose logs -f prd-caddy     # reverse proxy
docker compose logs -f prd-backup    # backup cron
docker compose logs -f prd-deployer  # deployer
```

### Trigger a deploy immediately
```sh
docker compose exec prd-deployer sh /usr/local/bin/poll.sh
```

### Roll back to a previous image
1. List available tags: visit `https://github.com/duypham9895/llm-wiki/pkgs/container/llm-wiki%2Fapp`
2. Pick the SHA you want.
3. On the VPS:
   ```sh
   cd ~/llm-wiki/mcp/deploy
   sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<sha>/' .env
   docker compose pull prd-app prd-ui-build
   docker compose up -d prd-app prd-ui-build
   ```

### Restore database from backup
1. List backups:
   ```sh
   docker run --rm -v prd_backups:/backups alpine:3.20 ls /backups
   ```
2. Pick one, restore:
   ```sh
   zcat /var/lib/docker/volumes/prd_backups/_data/prd_<date>.sql.gz \
     | docker compose exec -T prd-postgres psql -U prd_app -d prd_auth
   docker compose restart prd-app
   ```

### Off-host backup of dumps
Weekly:
```sh
rsync -az /var/lib/docker/volumes/prd_backups/_data/ \
  your-backup-host:/backups/llm-wiki/
```

### Rotate secrets
For each key in `.env`:
1. Generate new value at the vendor (Postgres pw → `openssl rand -hex 24`; API keys → vendor's rotate-secret URL).
2. Edit `.env` on the VPS.
3. `docker compose up -d prd-postgres prd-app prd-caddy` (postgres password change requires `prd-postgres` restart; pgbouncer or rolling-restart is out of scope).

## Disaster recovery

### Full restart
```sh
cd ~/llm-wiki/mcp/deploy
docker compose down
docker compose up -d
```

### Nuclear (DELETES all volumes — destructive)
```sh
docker compose down -v
zcat /var/lib/docker/volumes/prd_backups/_data/prd_<latest>.sql.gz \
  | docker compose run --rm -T prd-postgres psql -U prd_app -d prd_auth
docker compose up -d
```

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Browser shows cert warning | DNS not pointed yet OR cert expired | `dig +short $HOSTNAME`; wait 5min; `docker compose restart prd-caddy` |
| `prd-app` in Restarting loop | alembic failed or env missing | `docker compose logs prd-app` |
| Backup emails say "no ping" | backup.sh failed | `docker compose logs prd-backup`; `docker compose exec prd-backup sh /usr/local/bin/backup.sh` to run manually |
| New UI features not visible | `prd-ui-build` not re-run after deploy | `docker compose up -d prd-ui-build` |
