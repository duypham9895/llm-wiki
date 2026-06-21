# PRD Auth — openclaw deployment

1. `cp .env.example .env` → fill real values → `chmod 600 .env`.
2. `docker compose build`
3. `docker compose up -d` (entrypoint runs `alembic upgrade head`, then starts uvicorn; app seeds on startup).
4. Add the Caddy block from `Caddyfile.snippet` to the box's Caddyfile, `caddy reload`.
5. Smoke: `curl https://prd.duyopenclaw.tech/healthz` → `{"db":"ok"}`;
   login as `ADMIN_EMAIL` via `POST /api/auth/login` (header `X-Requested-With: prd-app`).

Break-glass: if every admin is disabled/deleted, a restart re-asserts the `.env` admin.
To permanently retire it, remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` after another admin exists.
