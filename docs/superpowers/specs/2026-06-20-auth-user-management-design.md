# Auth / User Management (v2 Phase 2) — Design

**Date:** 2026-06-20
**Status:** Draft — pending AI cross-review (Claude + Codex), then user approval.
**Scope:** A FastAPI auth backend with full RBAC, an admin-approval account lifecycle, server-side
sessions, an email-domain allowlist, and a registration on/off switch — deployed on the `openclaw`
VPS behind Caddy. Replaces Tailscale as the access gate. The user-facing admin UI is Phase 3; this
phase is the backend + data model + deployment, testable via HTTP/curl.
**Roadmap:** Phase 2 of `2026-06-20-llm-wiki-v2-roadmap.md` (Retrieval → **Auth** → Dashboard).

---

## 1. Context & Position

Phase 1 shipped the retrieval upgrades. Phase 3 will build a React dashboard (Library · Search ·
Ask · Status · **Admin/Users**). This phase builds the **auth foundation** the dashboard sits on:
every dashboard request will be gated by a session, and the Admin/Users tab (Phase 3 UI) will call
the user/role management endpoints defined here.

**Why this is security-sensitive:** dropping Tailscale means the login screen becomes the only moat
between the public internet and the PRD corpus. The bar rises accordingly: argon2 password hashing,
server-side sessions with instant revocation, httpOnly+Secure+SameSite cookies, HTTPS (via Caddy),
and login rate-limiting are all non-negotiable.

**Locked context (from the roadmap + brainstorm):**
- Deploy target: `openclaw` VPS (Ubuntu 24.04, Docker + Caddy on :80/:443 with automatic HTTPS,
  existing Postgres pattern). Reached at a Caddy subdomain (e.g. `prd.duyopenclaw.tech`).
- Backend: FastAPI inside the existing `mcp/` Poetry package, in a new `prd_mcp/web/` subpackage.
  The shared PRD core (`retrieve/answer/store/read/index/vault`) is **untouched** by this phase.
- Secrets: a root/app-user-only `.env` (chmod 600, gitignored) injected via docker-compose
  `env_file` — matches the existing foray/goclaw deployment pattern on the box.
- Session model: server sessions (Postgres) + signed httpOnly Secure SameSite cookie.
- Permission model: full RBAC (named permissions grouped into editable roles).
- Account lifecycle: register (allowed domain) → pending → admin approves + assigns role(s) →
  active → admin can disable.

---

## 2. Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Permission model | **Full RBAC** — code-defined permissions, admin-editable roles | Flexible where it matters (roles); permission vocabulary is fixed in code because a permission with no endpoint guard behind it is meaningless. |
| Account lifecycle | **register → pending → (admin approves+assigns role) → active → disabled** | Admin is the gatekeeper for every account; domain allowlist is a pre-filter, not the gate. |
| Sessions | **Server-side session rows + httpOnly Secure SameSite=Lax cookie**; store only the token HASH | XSS-resistant (JS can't read the cookie); instant revoke = delete the row; the raw token never persists server-side. |
| Password hashing | **argon2id** (via `argon2-cffi`) | Modern memory-hard KDF; the current OWASP default. |
| Secrets | **`.env`, chmod 600, gitignored, docker-compose `env_file`** | Single-owner VPS; matches existing apps; Docker-secrets gain doesn't apply to a root-controlled box. |
| DB | **Postgres** (own database `prd_auth` on the existing instance, dedicated app user) | Relational fit for RBAC; reuses the box's Postgres; isolated database keeps it separate from goclaw's data. |
| Bootstrap admin | **First admin seeded from `.env` on first boot** (status active, role admin) | Solves the chicken-and-egg: someone must approve the first users; the first admin can't itself need approval. |
| Email uniqueness | **`citext`** | Case-insensitive uniqueness so `Duy@` and `duy@` can't both register. |
| Migrations | **Alembic** | Versioned schema; standard with SQLAlchemy; matches Atlas's pattern. |

---

## 3. Architecture & File Layout

A new `web/` subpackage inside `prd_mcp`. The shared PRD core is not modified.

```
mcp/prd_mcp/
  web/
    __init__.py
    settings.py     WebSettings from env: DATABASE_URL, COOKIE_SECRET, COOKIE_NAME,
                    ALLOWED_EMAIL_DOMAINS (csv), REGISTRATION_ENABLED (bool),
                    ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_TTL_HOURS, ENV (dev|prod).
                    Validates on startup; fails fast on missing required vars.
    db.py           async SQLAlchemy engine + async_sessionmaker; get_db() dependency.
    models.py       ORM: User, Role, Permission, role_permissions, user_roles, Session.
    schemas.py      Pydantic request/response models (RegisterIn, LoginIn, UserOut, RoleOut, ...).
    security.py     argon2 hash/verify; secrets.token_urlsafe session token; sha256 token hash;
                    set/clear cookie helpers; constant-time compares.
    sessions.py     create_session / resolve_session / revoke_session / revoke_user_sessions /
                    purge_expired. The only module that reads/writes the sessions table.
    rbac.py         PERMISSIONS constant (the fixed vocabulary); current_user dependency;
                    require_permission(name) dependency factory.
    auth.py         router: POST /register, POST /login, POST /logout, GET /me.
    admin.py        router (all require the relevant permission): users list/get/approve/disable/
                    set-roles/delete; roles list/create/update/delete/set-permissions;
                    settings get/update (registration toggle, allowlist).
    seed.py         idempotent seeding of permissions, system roles, and the bootstrap admin.
    app.py          create_app(): FastAPI factory; CORS (same-origin in prod); mounts auth+admin
                    routers; rate-limit middleware on /login,/register; startup runs seed.
  cli.py            + `prd-mcp web` subcommand to run uvicorn (alongside index/serve).
migrations/         Alembic env + versioned revisions (new top-level dir under mcp/).
```

**Module boundaries (single-responsibility):**
- `security.py` is the ONLY place that hashes/verifies passwords or mints/hashes session tokens.
- `sessions.py` is the ONLY place that touches the sessions table.
- `rbac.py` is the ONLY source of permission names + the `require_permission` guard.
- `models.py` is the ONLY schema definition; Alembic migrations are generated from it.
- The PRD core is imported read-only later (Phase 3 web-API); Phase 2 doesn't touch it.

---

## 4. Data Model

Seven tables (Postgres + `citext` extension): `users`, `roles`, `permissions`, `role_permissions`,
`user_roles`, `sessions`, and `app_settings` (defined at the end of this section). UUID primary keys
throughout (except `app_settings`, a single fixed row).

```
users
  id            uuid       PK, default gen_random_uuid()
  email         citext     UNIQUE NOT NULL
  password_hash text       NOT NULL                       -- argon2id
  status        text       NOT NULL DEFAULT 'pending'     -- 'pending'|'active'|'disabled'
  created_at    timestamptz NOT NULL DEFAULT now()
  approved_at   timestamptz NULL
  approved_by   uuid       NULL  REFERENCES users(id)     -- which admin approved
  CHECK (status IN ('pending','active','disabled'))

roles
  id            uuid       PK
  name          text       UNIQUE NOT NULL                -- 'admin','member', or custom
  description   text       NOT NULL DEFAULT ''
  is_system     boolean    NOT NULL DEFAULT false         -- admin/member: seeded, undeletable
  created_at    timestamptz NOT NULL DEFAULT now()

permissions
  id            uuid       PK
  name          text       UNIQUE NOT NULL                -- from the code-defined vocabulary
  description   text       NOT NULL DEFAULT ''

role_permissions
  role_id       uuid       REFERENCES roles(id) ON DELETE CASCADE
  permission_id uuid       REFERENCES permissions(id) ON DELETE CASCADE
  PRIMARY KEY (role_id, permission_id)

user_roles
  user_id       uuid       REFERENCES users(id) ON DELETE CASCADE
  role_id       uuid       REFERENCES roles(id) ON DELETE RESTRICT   -- can't delete a role in use
  PRIMARY KEY (user_id, role_id)

sessions
  id            uuid       PK
  user_id       uuid       NOT NULL REFERENCES users(id) ON DELETE CASCADE
  token_hash    text       NOT NULL UNIQUE                -- sha256(raw cookie token); raw never stored
  created_at    timestamptz NOT NULL DEFAULT now()
  expires_at    timestamptz NOT NULL
  last_seen_at  timestamptz NOT NULL DEFAULT now()
  INDEX (token_hash), INDEX (user_id), INDEX (expires_at)
```

**The permission vocabulary (code-defined, seeded):**
- `prd.read` — Library + Search (read PRDs).
- `prd.ask` — Ask tab (LLM-grounded answers).
- `status.view` — Status tab (run health + coverage).
- `users.manage` — view/approve/disable/delete users, assign their roles.
- `roles.manage` — create/edit/delete roles, set role permissions, change settings (allowlist, register toggle).

**Seeded system roles:**
- `admin` (is_system) → all permissions.
- `member` (is_system) → `prd.read`, `prd.ask`.

**Bootstrap admin:** on first boot, `seed.py` (idempotent) creates the permission rows, the two
system roles, and — if no user exists — one admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (status
`active`, role `admin`). Re-running seed never duplicates and never resets an existing admin's
password.

**Settings storage:** `REGISTRATION_ENABLED` and `ALLOWED_EMAIL_DOMAINS` start from env defaults but
are **runtime-editable by `roles.manage`** and persisted in a single-row `app_settings` table (so
the admin can toggle registration without a redeploy). (7th table — small: `app_settings(id=1,
registration_enabled bool, allowed_domains text[])`, seeded from env on first boot.)

---

## 5. API Contract

All JSON. Auth via the session cookie. `4xx/5xx` share one error envelope
`{error:{code,message}}`. Endpoints under `/api/auth` and `/api/admin`.

### Auth (`auth.py`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | none | Register `{email,password}`. Rejects if registration disabled, domain not allowed, or email taken. Creates a `pending` user. Returns `202 {status:'pending'}`. Never reveals whether an email already exists beyond a generic "cannot register". |
| POST | `/api/auth/login` | none | `{email,password}`. Verifies argon2; rejects if status≠active. On success creates a session, sets the cookie, returns `{user: UserOut}`. Rate-limited. Generic error on any failure (no user-enumeration). |
| POST | `/api/auth/logout` | session | Deletes the current session row, clears the cookie. `204`. |
| GET | `/api/auth/me` | session | Returns the current `UserOut` (id, email, status, roles, permissions). |

### Admin — users (`admin.py`, requires `users.manage`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/users` | List users (filter by status; paginated). |
| GET | `/api/admin/users/{id}` | One user with roles. |
| POST | `/api/admin/users/{id}/approve` | pending→active, set `approved_at/by`, assign role(s) in the same call `{role_ids:[...]}`. |
| POST | `/api/admin/users/{id}/disable` | active→disabled AND revoke all their sessions (instant logout). |
| POST | `/api/admin/users/{id}/enable` | disabled→active. |
| PUT | `/api/admin/users/{id}/roles` | Replace a user's role set `{role_ids:[...]}`. |
| DELETE | `/api/admin/users/{id}` | Delete a user (cascades sessions/user_roles). |

### Admin — roles & settings (`admin.py`, requires `roles.manage`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/roles` | List roles + their permissions. |
| GET | `/api/admin/permissions` | List the fixed permission vocabulary. |
| POST | `/api/admin/roles` | Create a custom role `{name,description,permission_ids}`. |
| PUT | `/api/admin/roles/{id}` | Update name/description/permissions. Rejects edits that would remove `is_system` protection. |
| DELETE | `/api/admin/roles/{id}` | Delete a custom role. `is_system` roles cannot be deleted; a role still assigned to a user cannot be deleted (FK RESTRICT → 409). |
| GET | `/api/admin/settings` | `{registration_enabled, allowed_domains}`. |
| PUT | `/api/admin/settings` | Update the registration toggle and/or allowlist. |

### Pydantic shapes (`schemas.py`)
`UserOut{id,email,status,roles:[RoleBrief],permissions:[str],created_at}`,
`RoleOut{id,name,description,is_system,permissions:[str]}`, `RegisterIn{email,password}`,
`LoginIn{email,password}`, `SettingsOut/In{registration_enabled,allowed_domains:[str]}`.
Password input validated: min length 12 (configurable), max 128.

---

## 6. Security Design

| Concern | Mitigation |
|---|---|
| Password storage | argon2id (`argon2-cffi`), per-password salt; never logged. |
| Session token | `secrets.token_urlsafe(32)` raw token in the cookie; server stores only `sha256(token)`. Lookups hash the incoming token and match. A DB leak does not expose usable tokens. |
| Cookie flags | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, expiry = session TTL. (Lax allows top-level navigation; the API is same-origin behind Caddy.) |
| Transport | HTTPS only (Caddy auto-cert); app also sets HSTS in prod. The app refuses to set a Secure cookie over plain HTTP except in `ENV=dev`. |
| Session expiry/revoke | `expires_at` enforced on every resolve; expired/disabled → 401 + cookie cleared. Disable/logout deletes rows = instant revoke. A periodic `purge_expired` removes stale rows. |
| User enumeration | `register` and `login` return generic messages; identical timing where feasible (always run an argon2 verify even on unknown email — dummy-hash compare). |
| Brute force | Rate-limit `/login` and `/register` (per-IP token bucket, e.g. 5/min then backoff). Lockout escalation optional. |
| CSRF | SameSite=Lax + same-origin + a custom header check on state-changing requests (the SPA sends `X-Requested-With`); no cross-site form posts can carry the cookie meaningfully. |
| Authorization | Every protected endpoint declares `require_permission(...)`; the dependency loads the session user's effective permissions (union of role permissions) and 403s otherwise. No endpoint is protected by role NAME — always by permission. |
| Privilege escalation | A user cannot grant themselves roles (only `users.manage` holders can, and the UI/endpoint never lets a user edit their own roles to add permissions they lack — server-side check). The last remaining `admin` cannot be disabled/deleted (guard against locking everyone out). |
| Secrets | `.env` chmod 600, gitignored; never in logs, responses, or exceptions. `COOKIE_SECRET` and DB creds live only there. |
| Input | Pydantic validation on every body; email format checked; password length bounds; SQLAlchemy parameterized queries (no string SQL). |

---

## 7. Account & Request Flows

```
register:  POST /register {email,pw}
           → registration_enabled? domain in allowlist? email free?  (generic reject otherwise)
           → create user(status=pending, hash=argon2(pw))  → 202 {status:pending}

login:     POST /login {email,pw}
           → load user by email; ALWAYS argon2-verify (dummy hash if unknown) → constant-ish time
           → user exists AND active AND verify ok?  → create session + Set-Cookie → {user}
           → else generic 401

authed req: cookie → sha256 → sessions lookup → not expired? → load user → active?
           → attach (user, effective_permissions) to request
           → require_permission(name) checks membership → 200 or 403

approve:   admin POST /users/{id}/approve {role_ids}
           → user.status pending→active, approved_at/by set, user_roles replaced with role_ids

disable:   admin POST /users/{id}/disable
           → status active→disabled  AND  revoke_user_sessions(id)  (instant logout)
```

---

## 8. Deployment (openclaw)

- **Container:** a `prd-app` docker-compose project on the VPS: one service running
  `uvicorn prd_mcp.web.app:app`, `env_file: .env`, on a loopback port (e.g. 127.0.0.1:8300).
- **Caddy:** add a block `prd.duyopenclaw.tech { reverse_proxy 127.0.0.1:8300 }` → automatic HTTPS.
- **Postgres:** create database `prd_auth` + app user on the existing `goclaw-postgres` instance
  (or a dedicated `prd-postgres` container — chosen at build time; isolated DB either way).
  `DATABASE_URL` in `.env`.
- **Migrations:** `alembic upgrade head` runs on deploy (entrypoint or a one-shot). Seeding runs on
  app startup (idempotent).
- **Secrets in `.env`:** `DATABASE_URL`, `COOKIE_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
  `ALLOWED_EMAIL_DOMAINS`, `REGISTRATION_ENABLED`, `OPENAI`/`MINIMAX` keys (for Phase 3's API),
  `ENV=prod`. chmod 600, gitignored.
- **keychain.py adaptation:** the existing `read_secret(service, account)` becomes injectable — on
  the VPS it reads from `os.environ`; on the Mac it keeps the `security` CLI. `Config`/`WebSettings`
  already take the reader as a parameter, so this is a one-line entrypoint swap, not a rewrite.
- **Pipeline migration (A/B/C/index → VPS):** tracked as a deployment sub-task. The Node A/B jobs +
  Python index job move to cron/systemd on the box; the vault + `.chroma-mcp` live on the box; this
  is what makes Phase 3's Status tab read local run-manifests. (Full migration detail belongs to
  Phase 3's deploy section, but Phase 2's deploy establishes the box + Postgres + Caddy subdomain.)

---

## 9. Error Handling

| Situation | Behavior |
|---|---|
| Registration disabled / domain not allowed / email taken | `403`/`409` with a GENERIC "cannot register" — no enumeration. |
| Login bad credentials / inactive user | `401` generic; argon2 verify always runs (timing). |
| Expired/invalid/revoked session | `401`, clears the cookie. |
| Missing permission | `403 {error:{code:'forbidden'}}`. |
| Disable/delete the last admin | `409 {code:'last_admin'}` — refused. |
| Delete a role still assigned | `409 {code:'role_in_use'}` (FK RESTRICT). |
| Missing required env on boot | App fails fast naming the missing var. |
| DB unreachable | `503`; health endpoint reports it. |
| Rate limit exceeded | `429` with `Retry-After`. |

---

## 10. Testing Strategy

pytest + an async test client + a disposable Postgres (testcontainers or a test schema). No real
network; argon2 with reduced rounds in tests for speed.

| Layer | Tests |
|---|---|
| security | argon2 hash/verify round-trip; wrong password fails; token hash is sha256 and stable; cookie flags set correctly (HttpOnly/Secure/SameSite). |
| sessions | create→resolve→revoke; expired session resolves to None; revoke_user_sessions clears all of a user's rows. |
| rbac | effective permissions = union of role perms; require_permission allows/forbids correctly; a user with no roles has no permissions. |
| auth endpoints | register creates pending; disabled/pending can't log in; login sets cookie + returns user; logout deletes session; me reflects roles/permissions; user-enumeration resistance (same response for unknown vs wrong-pw). |
| admin endpoints | approve pending→active + assigns roles; disable revokes sessions; set-roles replaces; last-admin guard; role-in-use delete → 409; settings toggle persists; all admin endpoints 403 without the permission. |
| lifecycle (integration) | full flow: register → admin approve → login → access a prd.read-guarded route → disable → next request 401. |
| seed | idempotent: re-running doesn't duplicate or reset admin; first-boot creates admin + system roles + permissions. |
| security regressions | a non-admin cannot call admin endpoints; a user cannot escalate their own roles; Secure cookie not set over plain HTTP in prod. |

No real LLM/embed calls (this phase has none). Postgres is real (the RBAC/session logic is the
point — fakes would hide the bugs).

---

## 11. Out of Scope (Phase 2)

- The React UI for any of this (Admin/Users tab + login screen) — Phase 3.
- The PRD-serving web-API (Library/Search/Ask/Status endpoints over the shared core) — Phase 3.
- Password reset / email verification flows — deferred (admin-approval gate + small known team make
  it low-priority; can add later with an email provider).
- OAuth / SSO / 2FA — deferred (email+password is the agreed mechanism).
- Multi-tenancy — explicitly out of scope for all of v2.
- Audit log of admin actions — nice-to-have, deferred (not required for the gate).
