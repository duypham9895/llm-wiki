# VPS Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `llm-wiki` (FastAPI backend + Vite/React web-ui + Postgres + Obsidian vault + Chroma) to a single private VPS with Caddy+TLS, GHCR-backed auto-deploys, nightly backups, and runbook-grade operational docs — fully verified end-to-end against the real backend before the first VPS push.

**Architecture:** Extend the existing `mcp/deploy/` skeleton (FastAPI on :8300 + Postgres). Add a Caddy container (TLS + static UI + reverse-proxy), a one-shot `prd-ui-build` init container (publishes built Vite bundle into a named volume), a `prd-backup` sidecar (nightly `pg_dump` + healthchecks.io ping), and a `prd-deployer` sidecar (polls GHCR, bumps `IMAGE_TAG`, runs `docker compose up -d` — replacing watchtower because watchtower can't do pinned-sha deploys with rollback). GH Actions builds images on push to `master` and pushes to `ghcr.io/duypham9895/llm-wiki`. Single-host bridge network; Caddy is the only host-published service.

**Tech Stack:** Docker Compose v2, Caddy 2, GHCR (anonymous pull for `app`/`webui` packages), GitHub Actions, PostgreSQL 16-alpine, Alpine 3.20 (backup), `docker:27-cli` (deployer), Playwright (e2e codification), Python 3.10-slim + poetry (existing app image), Node 22-alpine + Vite 8 (existing web-ui build).

## Global Constraints

These are project-wide requirements carried verbatim from the spec. Every task's requirements implicitly include this section.

- **Repo target:** `github.com/duypham9895/llm-wiki` (private). Created via `gh repo create` on the existing local repo. Initial push from `feat/phase3-frontend` branch.
- **Branch:** All implementation work happens on `feat/phase3-frontend`. PR to `master` after T1–T3.
- **Image registry:** `ghcr.io/duypham9895/llm-wiki`. Two packages: `app` and `webui`. Both PUBLIC (anonymous pull required by deployer). Secrets NEVER in image — `.env` only on the VPS, `chmod 600`.
- **Image tag scheme:** short git SHA. Lexicographic sort = chronological. Pinned via `IMAGE_TAG` env var in `.env`.
- **Caddy email:** `duypham9895@users.noreply.github.com` (Let's Encrypt registration; placeholder — user may edit).
- **Hostname:** `wiki.example.com` placeholder. User MUST edit `HOSTNAME` in `.env` and `Caddyfile` `{$HOSTNAME}` interpolation before first VPS deploy.
- **Single hostname, path-prefix routing:** `/` = static UI; `/api/*`, `/healthz`, `/api/chat/conversations/*/messages` = reverse-proxy to `prd-app:8300` via `host.docker.internal:8300` (preserves `forwarded_allow_ips="127.0.0.1"` in `prd_mcp/cli.py`).
- **SSE matcher:** exact path `/api/chat/conversations/*/messages` only. Do not match other `/api/*` paths.
- **Volumes (named):** `prd_pgdata`, `prd_vault`, `prd_ui_dist`, `prd_backups`, `prd_caddy_data`, `prd_caddy_config`, `prd_deployer_state`. All survive `compose down`; all destroyed by `compose down -v`.
- **Networks:** single bridge `prd_net`. Only Caddy publishes host ports (80, 443). App publishes `127.0.0.1:8300` only.
- **Backup:** nightly `pg_dump` cron at 03:00 UTC, retain 30 days, healthchecks.io dead-man's-notify on success. Pre-check 1 GB free; exit non-zero (no ping) if insufficient.
- **Deployer polling:** every 21600 s (6h). Writes `.env.bak` before edit, validates with `docker compose config`, atomic `mv` on success. Restores from `.env.bak` on failure.
- **Watchtower:** NOT used. No `com.centurylinklabs.watchtower.enable` labels anywhere.
- **Caddy image:** pinned to `caddy:2-alpine`. NOT watched by deployer.
- **Postgres image:** pinned to `postgres:16-alpine`. NOT watched by deployer.
- **Backup image:** pinned to `alpine:3.20`. NOT watched by deployer.
- **Deployer base image:** `docker:27-cli` (NOT alpine — alpine doesn't ship docker CLI).
- **Pinned-sha deploys:** compose uses `${IMAGE_TAG}` interpolation. The string `latest` is allowed in `.env` ONLY for first boot before any image exists in GHCR — deployer replaces it on first cycle. After first deploy, `.env` should hold a git SHA. Rollback = edit `.env` to a previous SHA + `docker compose pull && up -d`.
- **`.env` in `.gitignore`:** verify before any commit that touches env files.
- **Out of scope v1:** HA, multi-worker uvicorn, TLS via DNS-01, off-host automated backup, deployer alerting, request tracing, disk quotas, secret rotation automation.
- **Real-backend e2e:** uses user's local keychain + real LLM API calls. Acceptable to consume a few tokens during T5.
- **Backup-time race window:** if `prd-postgres` is restarting when backup cron fires, `pg_dump` fails; that's the desired behavior (no silent zero-byte dump).

---

## Phase A: GitHub push + PR

### Task 1: Create github repo and push initial branch

**Files:**
- Create: (none, github-side)
- Modify: `.git/config` (remote added by `gh`)
- Verify: `git log --oneline -1` shows the current commit on github

**Interfaces:**
- Consumes: existing `feat/phase3-frontend` branch with `2fca022 polish(web-ui): whole-branch review fixes` as HEAD
- Produces: github repo `duypham9895/llm-wiki` (private), `master` and `feat/phase3-frontend` both present

- [ ] **Step 1: Verify gh auth and preflight**

```bash
gh auth status
```
Expected: `Logged in to github.com account duypham9895 (keyring)` + scopes include `repo`.

- [ ] **Step 2: Verify no git remote exists (sanity check)**

```bash
git remote -v
```
Expected: empty output. If something prints, STOP and report — there may be an existing push target we're overwriting.

- [ ] **Step 3: Confirm .env is gitignored before any push**

```bash
grep -E '^\.env$|^\.env\b' .gitignore
```
Expected: a line matching `.env` (existing skeleton should already have this; verify it does). If missing, add `.env` to `.gitignore` and commit before proceeding.

- [ ] **Step 4: Create the github repo and push**

```bash
gh repo create duypham9895/llm-wiki \
  --private \
  --description "llm-wiki: PRD-grounded RAG chat + web dashboard (FastAPI + Vite)" \
  --source=. \
  --push \
  --remote=origin
```
Expected: `✓ Created repository duypham9895/llm-wiki on github.com` followed by `✓ Pushed commits to https://github.com/duypham9895/llm-wiki.git`.

- [ ] **Step 5: Verify both branches exist on github**

```bash
gh repo view duypham9895/llm-wiki --json defaultBranchRef -q .defaultBranchRef.name
git fetch origin
git branch -r
```
Expected: default branch = `master` (or whatever gh defaults to); `origin/master` and `origin/feat/phase3-frontend` both listed.

- [ ] **Step 6: Commit**

No code changes — but record the repo creation in `.git/config` is automatic. If a `.gitignore` change was made in Step 3:
```bash
git add .gitignore
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "chore: ensure .env is gitignored before first push"
```

### Task 2: Open PR from feat/phase3-frontend to master

**Files:**
- Create: PR on github (no local file)
- Verify: PR URL captured for later reference

- [ ] **Step 1: Push the branch explicitly (defensive — `--push` flag in T1 may not push non-master branches in all gh versions)**

```bash
git push -u origin feat/phase3-frontend
```
Expected: `Branch 'feat/phase3-frontend' set up to track 'origin/feat/phase3-frontend'`.

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --base master \
  --head feat/phase3-frontend \
  --title "feat(web-ui): phase3 frontend (grouped sidebar, ask stream, status, admin, login)" \
  --body "Closes the phase3 frontend spec. See docs/superpowers/plans/2026-06-20-phase3-frontend.md for the original plan.

Commits: see feat/phase3-frontend branch log (e8bb337 → 2fca022).

This PR is part of the VPS-deploy sequence (spec: docs/superpowers/specs/2026-06-25-vps-deploy-design.md). Once merged, GH Actions workflow (.github/workflows/build-images.yml — added in T11) will start building app/webui images on every push to master."
```
Expected: PR URL printed. Capture it.

- [ ] **Step 3: Confirm PR exists**

```bash
gh pr list --head feat/phase3-frontend --state open
```
Expected: one PR listed with the title from Step 2.

- [ ] **Step 4: Do NOT merge yet**

Leave the PR open. Subsequent tasks (T4–T5, e2e verification) gate on having a green PR. Final merge happens after T14.

---

## Phase B: Real-backend e2e verification

### Task 3: Boot the local docker stack with real env

**Files:**
- Create: `mcp/deploy/.env` (gitignored, local only)
- Modify: (none in repo)

- [ ] **Step 1: Copy .env.example to .env**

```bash
cd mcp/deploy
cp .env.example .env
chmod 600 .env
```

- [ ] **Step 2: Fill in secrets from your local keychain**

Required edits in `.env`:
- `POSTGRES_PASSWORD`: pick a strong password (will only be used locally; will be regenerated for VPS later).
- `ADMIN_PASSWORD`: pick a strong password.
- `OPENAI_API_KEY`: read from your keychain — the local stack uses real LLM calls in this phase per D12.
- `LLM_API_KEY`: read from your keychain.
- `LLM_BASE_URL`: keep default `https://9router-1.dat-nguyen.me/v1`.
- `LLM_MODEL`: keep default `minimax/MiniMax-M3`.
- `NOTION_TOKEN`: leave the placeholder; the chat endpoint doesn't need it for e2e (it only matters for the sync pipeline).
- `VAULT_PATH`: keep `/data/vault` (this is the in-container path; host bind is via the named volume in T12 — for now this works because we have no volume mount).
- `DATABASE_URL`: keep the default (compose service name).
- `CORS_ORIGIN`: set to `http://localhost:5173` for local dev (Vite dev server default).

- [ ] **Step 3: Start the local stack**

```bash
cd mcp/deploy
docker compose up -d
```
Expected: `prd-postgres` and `prd-app` both `running` after ~30s. If `prd-app` is in `Restarting`, run `docker compose logs prd-app` and report the error.

- [ ] **Step 4: Wait for migrations to complete**

```bash
docker compose logs prd-app | grep -E "alembic upgrade head|running on|http"
```
Expected: within ~30s, log shows `alembic upgrade head` followed by `Uvicorn running on http://0.0.0.0:8300`.

- [ ] **Step 5: Smoke test the API**

```bash
curl -s http://127.0.0.1:8300/healthz
```
Expected: `{"db":"ok"}` (or whatever the actual healthz shape is — capture whatever prints).

- [ ] **Step 6: Smoke test login**

```bash
curl -s -X POST http://127.0.0.1:8300/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Requested-With: prd-app" \
  -d "{\"email\":\"$(grep ^ADMIN_EMAIL .env | cut -d= -f2)\",\"password\":\"$(grep ^ADMIN_PASSWORD .env | cut -d= -f2)\"}"
```
Expected: 200 with `{"user":{...}}` and a `Set-Cookie` header containing a session cookie. Capture the cookie value for T4.

### Task 4: Run end-to-end flow against the real backend

**Files:**
- Create: `/tmp/e2e_evidence/` (evidence directory, not committed)
- Verify: each step produces a screenshot or response capture

**Interfaces:**
- Consumes: running `prd-app` on `http://127.0.0.1:8300`, session cookie from T3 Step 6
- Produces: evidence of every phase3 page working end-to-end

- [ ] **Step 1: Start the web-ui dev server**

```bash
cd mcp/web-ui
npm install   # if node_modules not present
npm run dev
```
Expected: Vite serves on `http://localhost:5173`.

- [ ] **Step 2: Open the app in a real browser**

Use chrome-devtools MCP to navigate to `http://localhost:5173`:
```
mcp__chrome-devtools__new_page url=http://localhost:5173
```
Expected: login page loads. Capture screenshot to `/tmp/e2e_evidence/01_login.png`.

- [ ] **Step 3: Log in as admin**

Fill the login form with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`, submit.
Expected: redirect to Library or default authenticated landing. Capture `/tmp/e2e_evidence/02_post_login.png`.

- [ ] **Step 4: Exercise the Library tab**

Click the Library nav item.
Expected: grid of PRDs (or empty state if vault is unindexed). Capture screenshot.

- [ ] **Step 5: Exercise Search**

Type a known PRD identifier (e.g. `EP-437`) into the search box.
Expected: results appear with verdict-aware messaging. Capture screenshot.

- [ ] **Step 6: Exercise Ask (streaming)**

Click the Ask tab. Type a question about a known PRD topic. Submit.
Expected: tokens stream in real time (verify by capturing two screenshots ~1s apart and confirming more text appeared). Note: this exercises the SSE endpoint against the real LLM.

- [ ] **Step 7: Exercise admin pages**

Navigate to `/admin/approvals`, `/admin/directory`, `/admin/roles`, `/admin/settings`.
Expected: each renders without console errors. Capture one screenshot per page.

- [ ] **Step 8: Exercise Status page (halt banner if applicable)**

Navigate to `/status`.
Expected: status page renders. If a halt banner shows, verify the message matches the spec (`h` key in any phase3 doc); otherwise verify "all systems operational" copy.

- [ ] **Step 9: Verify console is clean**

```bash
# via chrome-devtools
mcp__chrome-devtools__list_console_messages types=[\"error\",\"warn\"]
```
Expected: no error-level messages. Warnings OK if from third-party libraries (Tanstack Query, etc.).

- [ ] **Step 10: Save evidence and stop dev servers**

```bash
# kill vite
pkill -f \"vite\"
# leave prd-app + prd-postgres running for T5 (Playwright will reuse)
ls /tmp/e2e_evidence/
```
Expected: ≥6 PNG files in `/tmp/e2e_evidence/`.

### Task 5: Codify the e2e flow into a Playwright suite

**Files:**
- Create: `mcp/web-ui/playwright.config.ts`
- Create: `mcp/web-ui/e2e/phase3.spec.ts`
- Create: `mcp/web-ui/e2e/fixtures.ts`
- Modify: `mcp/web-ui/package.json` (add `@playwright/test` devDep + `test:e2e` script)

**Interfaces:**
- Consumes: running `prd-app` on `http://127.0.0.1:8300`, `prd-postgres`, `web-ui` dev server on `:5173`. Same `.env` as T3.
- Produces: a single `npm run test:e2e` command that re-runs the T4 journey against any future deploy.

- [ ] **Step 1: Install Playwright**

```bash
cd mcp/web-ui
npm install -D @playwright/test
npx playwright install --with-deps chromium
```
Expected: chromium downloaded, no errors.

- [ ] **Step 2: Add test script to package.json**

In `mcp/web-ui/package.json`, add to `"scripts"`:
```json
"test:e2e": "playwright test",
"test:e2e:ui": "playwright test --ui"
```
Verify by running `npm run test:e2e --help` (will fail because no config yet, but should print playwright help, not \"command not found\").

- [ ] **Step 3: Write playwright.config.ts**

Create `mcp/web-ui/playwright.config.ts`:
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_NO_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
```

- [ ] **Step 4: Write the e2e fixture (login helper)**

Create `mcp/web-ui/e2e/fixtures.ts`:
```typescript
import { test as base, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadEnv(): { email: string; password: string } {
  const envPath = path.resolve(__dirname, '../../deploy/.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const get = (k: string) =>
    text.split('\n').find((l) => l.startsWith(`${k}=`))?.split('=')[1]?.trim() ?? '';
  return { email: get('ADMIN_EMAIL'), password: get('ADMIN_PASSWORD') };
}

export const test = base.extend<{ admin: { email: string; password: string } }>({
  admin: async ({}, use) => {
    await use(loadEnv());
  },
});

export { expect };
```

- [ ] **Step 5: Write the phase3 spec**

Create `mcp/web-ui/e2e/phase3.spec.ts`:
```typescript
import { test, expect } from './fixtures';

test.describe('Phase 3 end-to-end', () => {
  test('login as admin', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('library renders without console errors', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.getByRole('link', { name: /library/i }).click();
    await expect(page.getByRole('main')).toBeVisible();
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });

  test('search returns results for a known PRD id', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.getByRole('searchbox').fill('EP-437');
    await expect(page.getByText(/EP-437/i)).toBeVisible({ timeout: 10_000 });
  });

  test('ask tab streams tokens (SSE works)', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.getByRole('link', { name: /ask/i }).click();
    const input = page.getByRole('textbox', { name: /question|prompt/i });
    await input.fill('What does EP-1 cover?');
    await input.press('Enter');
    // wait for first token
    const answer = page.getByTestId('ask-answer');
    await expect(answer).toBeVisible({ timeout: 15_000 });
    const first = await answer.textContent();
    await page.waitForTimeout(1500);
    const second = await answer.textContent();
    expect(second?.length ?? 0).toBeGreaterThan(first?.length ?? 0);
  });

  test('admin pages render for an admin user', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    for (const path of ['/admin/approvals', '/admin/directory', '/admin/roles', '/admin/settings']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
    }
  });

  test('status page renders', async ({ page, admin }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.goto('/status');
    await expect(page.getByRole('main')).toBeVisible();
  });
});
```

- [ ] **Step 6: Run the suite — expect green**

```bash
cd mcp/web-ui
# prd-app + prd-postgres still running from T3
npm run dev &  # if not already
sleep 5
npm run test:e2e
```
Expected: 6 tests passed. If any fails, the failure screenshot in `test-results/` is the debugging starting point — DO NOT mark this task complete until all 6 pass.

- [ ] **Step 7: Commit**

```bash
cd mcp/web-ui
git add package.json package-lock.json playwright.config.ts e2e/
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "test(web-ui): Playwright e2e suite codifying phase3 journey"
```

- [ ] **Step 8: Stop local dev stack**

```bash
cd mcp/deploy
docker compose down
# leaves volumes intact for T6+ if needed
```
---

## Phase C: Deploy package files

### Task 6: web-ui Dockerfile.build

**Files:**
- Create: `mcp/web-ui/Dockerfile.build`
- Verify: image builds locally

- [ ] **Step 1: Write the Dockerfile**

Create `mcp/web-ui/Dockerfile.build`:
```dockerfile
# stage 1: build
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# stage 2: runtime — carries the bundle only
FROM caddy:2-alpine
COPY --from=build /src/dist /srv
```

- [ ] **Step 2: Verify it builds**

```bash
cd mcp/web-ui
docker build -f Dockerfile.build -t llm-wiki-webui:localtest .
```
Expected: builds in ~60s, ends with `naming to docker.io/library/llm-wiki-webui:localtest`. No `npm` errors.

- [ ] **Step 3: Verify the bundle is at /srv**

```bash
docker run --rm llm-wiki-webui:localtest ls /srv | head -5
```
Expected: `index.html` plus an `assets/` directory.

- [ ] **Step 4: Clean up the local test image**

```bash
docker rmi llm-wiki-webui:localtest
```

- [ ] **Step 5: Commit**

```bash
cd mcp/web-ui
git add Dockerfile.build
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "build(web-ui): Dockerfile.build for GHCR-published static bundle"
```

### Task 7: Full Caddyfile (replaces snippet)

**Files:**
- Create: `mcp/deploy/Caddyfile`
- Delete: `mcp/deploy/Caddyfile.snippet`
- Verify: `docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter ""`

- [ ] **Step 1: Write the Caddyfile**

Create `mcp/deploy/Caddyfile`:
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

    # static UI (volume-mounted at /srv)
    root * /srv
    try_files {path} /index.html
    file_server
}
```

- [ ] **Step 2: Validate with a real CADDY_EMAIL/HOSTNAME substitution**

```bash
cd mcp/deploy
CADDY_EMAIL=duypham9895@users.noreply.github.com HOSTNAME=wiki.example.com \
  docker run --rm \
    -e CADDY_EMAIL -e HOSTNAME \
    -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro \
    caddy:2-alpine \
    caddy adapt --config /etc/caddy/Caddyfile --pretty
```
Expected: emits a JSON Caddy config with the two env vars substituted into `email` and the site address. No parse errors.

- [ ] **Step 3: Delete the old snippet**

```bash
git rm mcp/deploy/Caddyfile.snippet
```

- [ ] **Step 4: Commit**

```bash
cd mcp/deploy
git add Caddyfile
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "feat(deploy): full Caddyfile with SSE matcher + static UI routing"
```

### Task 8: Backup sidecar (entrypoint.sh + backup.sh)

**Files:**
- Create: `mcp/deploy/backup/entrypoint.sh`
- Create: `mcp/deploy/backup/backup.sh`
- Verify: scripts run cleanly via `docker run --rm` against the local postgres from T3

- [ ] **Step 1: Write entrypoint.sh**

Create `mcp/deploy/backup/entrypoint.sh`:
```sh
#!/bin/sh
set -eu

cat > /etc/crontabs/root <<EOF
0 3 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1
EOF

exec crond -f -L /dev/stdout
```

- [ ] **Step 2: Write backup.sh**

Create `mcp/deploy/backup/backup.sh`:
```sh
#!/bin/sh
set -eu

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/backups/prd_${TS}.sql.gz

FREE_KB=$(df -Pk /backups | awk 'NR==2 {print $4}')
if [ "$FREE_KB" -lt 1048576 ]; then
  echo "INSUFFICIENT_DISK: ${FREE_KB}KB free" >&2
  exit 1
fi

PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h prd-postgres -U prd_app -d prd_auth \
  --no-owner --no-privileges | gzip -9 > "$OUT"

curl -fsS --retry 3 -m 10 "${BACKUP_HEALTHCHECK_URL}" >/dev/null

find /backups -name "prd_*.sql.gz" -mtime +30 -delete

echo "backup_ok: ${OUT}"
```

- [ ] **Step 3: Make executable + commit (no functional test yet — full test in T14)**

```bash
cd mcp/deploy
chmod +x backup/entrypoint.sh backup/backup.sh
git add backup/
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "feat(deploy): backup sidecar with nightly pg_dump + healthchecks.io ping"
```

### Task 9: Deployer sidecar (poll.sh + Dockerfile)

**Files:**
- Create: `mcp/deploy/deployer/poll.sh`
- Create: `mcp/deploy/deployer/Dockerfile`
- Create: `mcp/deploy/deployer/entrypoint.sh`
- Verify: deployer image builds; `poll.sh` syntax check with `sh -n`

- [ ] **Step 1: Write poll.sh**

Create `mcp/deploy/deployer/poll.sh`:
```sh
#!/bin/sh
set -eu

REPO="duypham9895/llm-wiki"
ENV_FILE="/app/.env"
STATE_FILE="/state/deployer.state"

LATEST_TAG=$(grep '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "")

poll() {
  local img=$1
  local token
  token=$(curl -fsS "https://ghcr.io/token?scope=repo:${REPO}/${img}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || return 1
  [ -z "$token" ] && return 1
  curl -fsS -H "Authorization: Bearer $token" \
    "https://ghcr.io/v2/${REPO}/${img}/tags/list" \
    | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' \
    | sort | tail -1
}

new_app=$(poll app || echo "")
new_webui=$(poll webui || echo "")

if [ -z "$new_app" ] || [ "$new_app" = "$LATEST_TAG" ]; then
  echo "$(date -u +%FT%TZ) no_update app=${new_app:-none} current=${LATEST_TAG}" > "$STATE_FILE"
  exit 0
fi

# Both app and webui should be at the same SHA (built by the same GH Actions run).
# Use app as the source of truth; webui is optional.
cp "$ENV_FILE" "${ENV_FILE}.bak"

sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${new_app}/" "$ENV_FILE"

cd /app
if docker compose config >/dev/null 2>&1 \
   && docker compose pull prd-app prd-ui-build \
   && docker compose up -d prd-app prd-ui-build; then
  rm -f "${ENV_FILE}.bak"
  echo "$(date -u +%FT%TZ) deployed ${new_app}" > "$STATE_FILE"
else
  mv "${ENV_FILE}.bak" "$ENV_FILE"
  echo "$(date -u +%FT%TZ) deploy_failed; rolled back" > "$STATE_FILE"
  exit 1
fi
```

- [ ] **Step 2: Write entrypoint.sh**

Create `mcp/deploy/deployer/entrypoint.sh`:
```sh
#!/bin/sh
set -eu

# Wait for docker.sock to be ready (compose-side mount may race).
while [ ! -S /var/run/docker.sock ]; do sleep 1; done

while true; do
  sh /usr/local/bin/poll.sh || echo "poll error (continuing)"
  sleep 21600
done
```

- [ ] **Step 3: Write the deployer Dockerfile**

Create `mcp/deploy/deployer/Dockerfile`:
```dockerfile
FROM docker:27-cli

RUN apk add --no-cache bash curl

COPY poll.sh /usr/local/bin/poll.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/poll.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 4: Syntax-check poll.sh + entrypoint.sh**

```bash
cd mcp/deploy
sh -n deployer/poll.sh && sh -n deployer/entrypoint.sh
```
Expected: silent success.

- [ ] **Step 5: Build the deployer image (smoke test)**

```bash
cd mcp/deploy
docker build -t llm-wiki-deployer:localtest deployer/
```
Expected: builds in ~30s.

- [ ] **Step 6: Clean up**

```bash
docker rmi llm-wiki-deployer:localtest
```

- [ ] **Step 7: Commit**

```bash
cd mcp/deploy
git add deployer/
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "feat(deploy): prd-deployer sidecar (GHCR poll + atomic rollback)"
```

### Task 10: GH Actions workflow (build + push images)

**Files:**
- Create: `.github/workflows/build-images.yml`
- Verify: workflow YAML parses with `actionlint` or `yamllint` if available; otherwise `python -c "import yaml; yaml.safe_load(open('.github/workflows/build-images.yml'))"`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/build-images.yml`:
```yaml
name: build-images

on:
  push:
    branches: [master]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target: [app, webui]
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image tag
        id: tag
        run: echo "tag=${GITHUB_SHA}" >> "$GITHUB_OUTPUT"

      - name: Build and push app
        if: matrix.target == 'app'
        uses: docker/build-push-action@v6
        with:
          context: ./mcp
          file: ./mcp/deploy/Dockerfile
          push: true
          tags: ghcr.io/duypham9895/llm-wiki/app:${{ steps.tag.outputs.tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push webui
        if: matrix.target == 'webui'
        uses: docker/build-push-action@v6
        with:
          context: ./mcp/web-ui
          file: ./mcp/web-ui/Dockerfile.build
          push: true
          tags: ghcr.io/duypham9895/llm-wiki/webui:${{ steps.tag.outputs.tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-images.yml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-images.yml
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "ci: GH Actions workflow to build+push app/webui images to GHCR on master"
```

### Task 11: Expanded docker-compose.yml + .env.example

**Files:**
- Modify: `mcp/deploy/docker-compose.yml`
- Modify: `mcp/deploy/.env.example`
- Verify: `docker compose config` parses after `cp .env.example .env && sed -i 's/change-me/x/' .env`

- [ ] **Step 1: Write the new compose file**

Replace `mcp/deploy/docker-compose.yml`:
```yaml
services:
  prd-postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: prd_auth
      POSTGRES_USER: prd_app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - prd_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U prd_app -d prd_auth"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks: [prd_net]

  prd-app:
    image: ghcr.io/duypham9895/llm-wiki/app:${IMAGE_TAG}
    restart: unless-stopped
    env_file: .env
    depends_on:
      prd-postgres: { condition: service_healthy }
    ports:
      - "127.0.0.1:8300:8300"
    volumes:
      - prd_vault:/data/vault
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8300/healthz', timeout=2)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    networks: [prd_net]

  prd-ui-build:
    image: ghcr.io/duypham9895/llm-wiki/webui:${IMAGE_TAG}
    command: ["sh", "-c", "cp -r /srv/. /srv_out/ && echo built"]
    volumes:
      - prd_ui_dist:/srv_out
    restart: "no"
    networks: [prd_net]

  prd-caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    env_file: .env
    environment:
      HOSTNAME: ${HOSTNAME}
      CADDY_EMAIL: ${CADDY_EMAIL}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - prd_ui_dist:/srv:ro
      - prd_caddy_data:/data
      - prd_caddy_config:/config
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      prd-app: { condition: service_healthy }
    networks: [prd_net]

  prd-backup:
    image: alpine:3.20
    restart: unless-stopped
    env_file: .env
    command: ["sh", "/usr/local/bin/entrypoint.sh"]
    volumes:
      - ./backup/entrypoint.sh:/usr/local/bin/entrypoint.sh:ro
      - ./backup/backup.sh:/usr/local/bin/backup.sh:ro
      - prd_backups:/backups
    networks: [prd_net]

  prd-deployer:
    build: ./deployer
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./.env:/app/.env:rw
      - prd_deployer_state:/state
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [prd_net]

volumes:
  prd_pgdata:
  prd_vault:
  prd_ui_dist:
  prd_backups:
  prd_caddy_data:
  prd_caddy_config:
  prd_deployer_state:

networks:
  prd_net:
```

- [ ] **Step 2: Add new keys to .env.example**

Append to `mcp/deploy/.env.example` (do not delete existing keys):
```
# ── VPS deploy additions ─────────────────────────────────────────────────────
# Pinned image tag for app + webui. Set to a git SHA on VPS, "latest" only for first boot.
IMAGE_TAG=latest

# Hostname Caddy will serve + request a Let's Encrypt cert for. REPLACE before first VPS deploy.
HOSTNAME=wiki.example.com

# Email for Let's Encrypt account registration.
CADDY_EMAIL=duypham9895@users.noreply.github.com

# healthchecks.io dead-man's-notify ping URL (backup cron pings on success). Create one at healthchecks.io, paste the URL here.
BACKUP_HEALTHCHECK_URL=https://hc-ping.com/00000000-0000-0000-0000-000000000000
```

Also update the existing `CORS_ORIGIN` comment to note that on VPS it should be `https://{$HOSTNAME}`.

- [ ] **Step 3: Validate compose parses**

```bash
cd mcp/deploy
cp .env.example .env
sed -i 's/change-me/x/g' .env
docker compose config > /tmp/compose-config.yml 2>&1
grep -c '^  ' /tmp/compose-config.yml
```
Expected: at least 6 services (`prd-postgres`, `prd-app`, `prd-ui-build`, `prd-caddy`, `prd-backup`, `prd-deployer`). If `docker compose config` prints errors, fix them before proceeding.

- [ ] **Step 4: Remove the local .env (we don't commit it; the cp above was just for validation)**

```bash
cd mcp/deploy
rm -f .env
```

- [ ] **Step 5: Commit**

```bash
cd mcp/deploy
git add docker-compose.yml .env.example
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "feat(deploy): expand compose to 6 services (caddy, ui-build, backup, deployer) + vault volume"
```

### Task 12: VPS runbook

**Files:**
- Create: `docs/runbooks/vps-deploy.md`
- Verify: every command in the runbook runs locally against the local docker stack

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/vps-deploy.md`:
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/vps-deploy.md
git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
  commit -m "docs(runbook): VPS deploy + day-to-day operations + DR"
```

---

## Phase D: Integration verification

### Task 13: End-to-end integration smoke (local stack simulates VPS topology)

**Files:**
- Create: `/tmp/integration_evidence/` (not committed)
- Verify: every component from T6–T12 runs against the local docker stack with mocked GHCR

- [ ] **Step 1: Bring the stack up**

```bash
cd mcp/deploy
cp .env.example .env
sed -i 's/change-me/x/g; s/IMAGE_TAG=latest/IMAGE_TAG=localtest/' .env
# build app + webui locally for the smoke test (don't pull from GHCR)
docker build -t ghcr.io/duypham9895/llm-wiki/app:localtest -f Dockerfile ..
cd ../web-ui
docker build -f Dockerfile.build -t ghcr.io/duypham9895/llm-wiki/webui:localtest .
cd ../deploy
docker compose build prd-deployer  # uses deployer/Dockerfile
docker compose up -d
```
Expected: all 6 services start. `prd-caddy` will fail TLS because we have no real hostname — expected for local smoke. Other 5 services should be healthy.

- [ ] **Step 2: Verify Caddy serves the UI**

```bash
# disable TLS temporarily for local smoke
docker compose exec prd-caddy sh -c 'echo ":80 { root * /srv; file_server }" > /tmp/local-caddyfile && caddy run --config /tmp/local-caddyfile --adapter "" &'
sleep 2
curl -sI http://127.0.0.1:80/ | head -3
```
Expected: `HTTP/1.1 200 OK`.

- [ ] **Step 3: Verify the API path is reverse-proxied**

```bash
curl -s http://127.0.0.1:80/healthz
```
Expected: same response as `curl http://127.0.0.1:8300/healthz` (proves the `/healthz` Caddy rule works).

- [ ] **Step 4: Run the Playwright suite against the Caddy-served URL**

```bash
cd ../web-ui
E2E_BASE_URL=http://127.0.0.1:80 E2E_NO_WEBSERVER=1 npm run test:e2e
```
Expected: 6 tests pass.

- [ ] **Step 5: Verify backup.sh works**

```bash
cd ../deploy
docker compose exec prd-backup sh /usr/local/bin/backup.sh
docker compose exec prd-backup ls -la /backups
```
Expected: backup.log line `backup_ok: /backups/prd_<ts>.sql.gz`, and at least one `.sql.gz` file present.

- [ ] **Step 6: Verify deployer can read GHCR tags (read-only check, won't actually deploy)**

```bash
docker compose exec prd-deployer sh /usr/local/bin/poll.sh
docker compose exec prd-deployer cat /state/deployer.state
```
Expected: `deployer.state` shows either `deployed <sha>` or `no_update app=<sha-or-none> current=localtest`. No error.

- [ ] **Step 7: Stop everything**

```bash
cd ../deploy
docker compose down
docker rmi ghcr.io/duypham9895/llm-wiki/app:localtest ghcr.io/duypham9895/llm-wiki/webui:localtest
```

- [ ] **Step 8: No commit (verification task; no code changed)**

Record the result in your memory file: `/Users/edwardpham/.claude/projects/-Users-edwardpham-Documents-Workspace-Ringkas-Programming-Personal-llm-wiki/memory/vps-deploy-integration-verified.md` (note: this is local — not in the repo). Body: `Integration smoke passed YYYY-MM-DD. All 6 services start. Caddy serves UI + proxies /healthz. Playwright suite green. Backup.sh produced dump. Deployer poll ran without error.`

### Task 14: Merge phase3 PR and confirm CI green

**Files:**
- Modify: PR merged on github
- Verify: GH Actions workflow runs and pushes images

- [ ] **Step 1: Re-check the PR has no merge conflicts**

```bash
gh pr view --json mergeable -q .mergeable
```
Expected: `true`. If `false`, rebase `feat/phase3-frontend` onto `master` and force-push.

- [ ] **Step 2: Merge**

```bash
gh pr merge --squash --delete-branch
```
Expected: PR closed, branch deleted, master updated.

- [ ] **Step 3: Watch the GH Actions workflow run**

```bash
gh run watch
```
Expected: `build-images` workflow completes in ~5-8 min, shows two matrix jobs (`app`, `webui`) both succeeded.

- [ ] **Step 4: Verify images are in GHCR**

```bash
gh api /users/duypham9895/packages/container/llm-wiki%2Fapp/versions \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print([v['metadata']['container']['tags'] for v in d[:3]])"
```
Expected: array with at least one tag (the merge commit SHA).

- [ ] **Step 5: Hand off to user**

Tell the user:
- VPS deploy package is ready (`mcp/deploy/`, `mcp/web-ui/Dockerfile.build`, `.github/workflows/build-images.yml`, `docs/runbooks/vps-deploy.md`).
- All 13 implementation tasks complete.
- GitHub: `duypham9895/llm-wiki` private repo, `master` has all commits, PR phase3 merged.
- Images: `ghcr.io/duypham9895/llm-wiki/app:<sha>` and `webui:<sha>` published.
- **Next step is the user-side VPS bootstrap** — the runbook at `docs/runbooks/vps-deploy.md` walks through it step by step.
- I cannot SSH to the VPS from this session. The user runs the runbook.
