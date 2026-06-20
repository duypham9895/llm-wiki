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
- Session model: server sessions (Postgres) + httpOnly Secure SameSite OPAQUE-random cookie (not signed).
- Permission model: full RBAC (named permissions grouped into editable roles).
- Account lifecycle: register (allowed domain) → pending → admin approves + assigns role(s) →
  active → admin can disable.

---

## 2. Decisions (locked from brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Permission model | **Full RBAC** — code-defined permissions, admin-editable roles | Flexible where it matters (roles); permission vocabulary is fixed in code because a permission with no endpoint guard behind it is meaningless. |
| Admin-equivalence | **`users.manage` + `roles.manage` together = admin-equivalent, and this is ENFORCED, not just declared: no role and no user may ever end up holding exactly ONE of the pair — it must hold NEITHER or BOTH.** | Both reviewers showed a `roles.manage` holder can edit a role they belong to and grant themselves any permission, and a `users.manage` holder can mint an admin via a second account. Rather than pretend these are isolatable, we make them genuinely inseparable: a `assert_pair_integrity()` check rejects (422) any role create/update or user role-assignment/approval whose resulting permission set would contain exactly one of `{users.manage, roles.manage}`. Declaring it in prose is not enough — without this enforcement a custom role could grant `roles.manage` alone and reopen the Round-1 escalation. The UI surfaces the two as one "Admin" capability. |
| Account lifecycle | **register → pending → (admin approves+assigns role) → active → disabled**; admin may also **reject** a pending user (→ deleted). | Admin is the gatekeeper for every account; domain allowlist is a pre-filter, not the gate. |
| Sessions | **Server-side session rows + httpOnly Secure SameSite=Lax OPAQUE-random cookie** (NOT signed); store only the token HASH. **Absolute + idle expiry.** | XSS-resistant; instant revoke = delete the row; raw token never persists. A 256-bit random token looked up server-side needs no signing, so there is NO `COOKIE_SECRET` (dropped — an unused secret is a false-confidence liability). |
| Permission resolution | **Per-request, from live `user_roles`/`role_permissions`** — NEVER cached in the session row | A role change (grant OR revoke) takes effect on the user's very next request. Caching effective perms in the session would let a revoked role persist until expiry — a real escalation-persistence bug. |
| Last-admin invariant | **The system must always retain ≥1 `active` user whose effective permissions include BOTH `users.manage` AND `roles.manage`** | Defined in permission terms (matching the permission-first guard model), not by the role name `admin`. Enforced on EVERY mutating path that can reduce privilege (see §6). |
| Password hashing | **argon2id** (via `argon2-cffi`) | Modern memory-hard KDF; the current OWASP default. |
| Secrets | **`.env`, chmod 600, gitignored, docker-compose `env_file`** | Single-owner VPS; matches existing apps; Docker-secrets gain doesn't apply to a root-controlled box. |
| DB | **Postgres** (own database `prd_auth` on the existing instance, dedicated app user) | Relational fit for RBAC; reuses the box's Postgres; isolated database keeps it separate from goclaw's data. |
| Bootstrap admin | **Seed/re-assert the `.env` admin whenever NO active admin-equivalent user exists** (not merely "if no user exists") — status active, role admin | Solves the chicken-and-egg AND acts as break-glass: if the admin is later deleted/disabled while other users exist, the next boot re-creates/re-activates the `.env` admin. The predicate is "no active user with `users.manage`+`roles.manage`", so a healthy instance is never touched. Idempotent: never duplicates, never resets an existing healthy admin's password. |
| Email uniqueness | **`citext`** | Case-insensitive uniqueness so `Duy@` and `duy@` can't both register. |
| Migrations | **Alembic** | Versioned schema; standard with SQLAlchemy; matches Atlas's pattern. |

---

## 3. Architecture & File Layout

A new `web/` subpackage inside `prd_mcp`. The shared PRD core is not modified.

```
mcp/prd_mcp/
  web/
    __init__.py
    settings.py     WebSettings from env: DATABASE_URL, COOKIE_NAME, CORS_ORIGIN,
                    ALLOWED_EMAIL_DOMAINS (csv, first-boot seed only), REGISTRATION_ENABLED
                    (first-boot seed only), ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_IDLE_HOURS,
                    SESSION_ABSOLUTE_DAYS, LAST_SEEN_THROTTLE_MIN, RATE_LIMIT_PER_MIN,
                    PASSWORD_MIN_LENGTH, ENV (dev|prod). No COOKIE_SECRET (opaque tokens).
                    Validates on startup; fails fast on missing required vars (no silent "" defaults).
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
  approved_by   uuid       NULL  REFERENCES users(id) ON DELETE SET NULL  -- approver; survives approver deletion
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
  created_at    timestamptz NOT NULL DEFAULT now()        -- absolute-lifetime anchor
  idle_expires_at timestamptz NOT NULL                    -- now + SESSION_IDLE_HOURS; slides on activity
  absolute_expires_at timestamptz NOT NULL                -- created_at + SESSION_ABSOLUTE_DAYS; never slides
  last_seen_at  timestamptz NOT NULL DEFAULT now()        -- updated only when stale by > LAST_SEEN_THROTTLE_MIN
  INDEX (token_hash), INDEX (user_id), INDEX (idle_expires_at)
```

**Session expiry semantics (resolve on every request):** a session is valid iff
`now < idle_expires_at AND now < absolute_expires_at`. On a valid resolve, slide
`idle_expires_at = now + SESSION_IDLE_HOURS` and (throttled) bump `last_seen_at` only if it is
older than `LAST_SEEN_THROTTLE_MIN` (avoids a write on every request). `absolute_expires_at` never
moves — a session dies at that cap regardless of activity. Defaults: idle 24h, absolute 30d,
throttle 5 min (all env-tunable).

app_settings
  id                   integer    PK DEFAULT 1  CHECK (id = 1)   -- enforced singleton
  registration_enabled boolean    NOT NULL
  allowed_domains      text[]     NOT NULL DEFAULT '{}'
  updated_at           timestamptz NOT NULL DEFAULT now()
  updated_by           uuid       NULL REFERENCES users(id) ON DELETE SET NULL
```

**The permission vocabulary (code-defined, seeded):**
- `prd.read` — Library + Search (read PRDs).
- `prd.ask` — Ask tab (LLM-grounded answers).
- `status.view` — Status tab (run health + coverage).
- `users.manage` — view/approve/disable/delete users, assign their roles.
- `roles.manage` — create/edit/delete roles, set role permissions, change settings (allowlist, register toggle).

> **Admin-equivalence (locked, see §2 + §6):** `users.manage` + `roles.manage` held together = full
> admin. We do NOT try to make them independently *safe* — instead we make them genuinely
> *inseparable*: **`assert_pair_integrity` (§6) makes a "half-admin" un-representable** — no role or
> user may ever hold exactly one of the pair (422). On top of that, the **last-admin invariant** (§6)
> keeps ≥1 active full-admin. The UI presents the two as a single "Admin" capability.

**Seeded system roles:**
- `admin` (is_system) → all permissions. **`is_system` roles are fully locked: name, `is_system`
  flag, AND permission set are immutable via the API** (closes the "strip `users.manage` from the
  admin role" lockout path). Only undeletable AND uneditable.
- `member` (is_system) → `prd.read`, `prd.ask`.

**Bootstrap admin:** on every boot, `seed.py` (idempotent) ensures the permission rows + the two
locked system roles exist, then checks the break-glass predicate: **if NO active user has both
`users.manage` and `roles.manage`**, it creates-or-reactivates the `ADMIN_EMAIL` user (status
`active`, role `admin`, password = argon2(`ADMIN_PASSWORD`)). A healthy instance (≥1 active admin)
is never touched — existing passwords/roles are never reset. This makes `.env` a genuine recovery
path if the admin is deleted/disabled.

**Startup integrity guard (defense against DB-surgery / bad-migration bypass):** the API-layer
`assert_pair_integrity` only governs requests, not direct SQL or a flawed Alembic migration. So on
every boot, AFTER migrations + seeding, `seed.py` runs `assert_global_pair_integrity()`: it scans
every role's permission set and every active user's effective union; if any holds exactly one of
`{users.manage, roles.manage}`, it re-asserts the locked system roles and **fails startup** (loud,
naming the offending role/user) rather than serving a half-admin state. This closes the only
remaining path to a half-admin (a write that bypasses the API).

**Settings storage (single source of truth = DB after first boot):** the `app_settings` row is
**seeded from `REGISTRATION_ENABLED` / `ALLOWED_EMAIL_DOMAINS` env vars ONLY on first boot (when the
row does not yet exist)**. Thereafter the DB row is authoritative and the env vars are ignored — so
an admin toggling registration off is NOT silently reverted by the next redeploy. Runtime edits
require `roles.manage`. (A test asserts a redeploy with a different env value does not overwrite an
existing row.) **Domain matching:** an email is allowed iff its domain (the part after the last `@`,
lowercased + trimmed, IDNA/punycode-normalized) is an EXACT member of `allowed_domains` (no suffix
matching — `evilringkas.co.id` must not match `ringkas.co.id`). An empty `allowed_domains` means no
self-registration is possible.

---

## 5. API Contract

All JSON. Auth via the session cookie. `4xx/5xx` share one error envelope
`{error:{code,message}}`. Endpoints under `/api/auth` and `/api/admin`.

### Auth (`auth.py`)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | none | Register `{email,password}`. Internally creates a `pending` user ONLY if registration is enabled AND the domain is allowed AND the email is free; otherwise no account is created. In ALL cases returns the IDENTICAL `202 {status:'accepted'}` with equivalent work/timing (see §6 register-enumeration), so the response never reveals which (or whether any) account was created. |
| POST | `/api/auth/login` | none | `{email,password}`. Verifies argon2; rejects if status≠active. On success creates a session, sets the cookie, returns `{user: UserOut}`. Rate-limited. Generic error on any failure (no user-enumeration). |
| POST | `/api/auth/logout` | session | Deletes the current session row, clears the cookie. `204`. |
| GET | `/api/auth/me` | session | Returns the current `UserOut` (id, email, status, roles, permissions). |

### Admin — users (`admin.py`, requires `users.manage`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/users` | List users (filter by status; paginated). |
| GET | `/api/admin/users/{id}` | One user with roles. |
| POST | `/api/admin/users/{id}/approve` | pending→active, set `approved_at/by`, assign role(s) in the same call `{role_ids:[...]}`. `assert_pair_integrity` on the resulting user (no exactly-one of the admin pair). |
| POST | `/api/admin/users/{id}/disable` | active→disabled AND revoke all their sessions (instant logout). |
| POST | `/api/admin/users/{id}/enable` | disabled→active. |
| POST | `/api/admin/users/{id}/reject` | pending→deleted (deny a registration). |
| POST | `/api/admin/users/{id}/reset-password` | Admin sets a new password for a user `{password}` (the operational recovery path, since there is no self-service reset this phase); revokes that user's sessions. |
| PUT | `/api/admin/users/{id}/roles` | Replace a user's role set `{role_ids:[...]}`. `assert_pair_integrity` (resulting effective perms hold neither or both of the admin pair) AND the last-admin invariant; revokes the target's sessions on any change so new perms resolve cleanly. |
| DELETE | `/api/admin/users/{id}` | Delete a user (cascades sessions/user_roles). Subject to the last-admin invariant. |

### Auth — self-service (`auth.py`, requires own session)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/change-password` | `{current_password,new_password}` — the logged-in user changes their own password; verifies current, revokes all OTHER sessions of theirs. |

### Admin — roles & settings (`admin.py`, requires `roles.manage`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/roles` | List roles + their permissions. |
| GET | `/api/admin/permissions` | List the fixed permission vocabulary. |
| POST | `/api/admin/roles` | Create a custom role `{name,description,permission_ids}`. `assert_pair_integrity` on the role's permission set → 422 if it contains exactly one of `{users.manage, roles.manage}`. |
| PUT | `/api/admin/roles/{id}` | Update a CUSTOM role's name/description/permissions. **`is_system` roles are fully immutable → 409.** `assert_pair_integrity` on the new permission set (422 on exactly-one of the admin pair) AND the last-admin invariant (a permission removal that would drop the last admin-equivalent below the threshold is rejected). |
| DELETE | `/api/admin/roles/{id}` | Delete a custom role. `is_system` roles cannot be deleted (409); a role still assigned to any user cannot be deleted (FK RESTRICT → 409). |
| GET | `/api/admin/settings` | `{registration_enabled, allowed_domains}`. |
| PUT | `/api/admin/settings` | Update the registration toggle and/or allowlist; sets `updated_at/by`. |

### Health (`app.py`, no auth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness + DB reachability check; `200 {db:'ok'}` or `503`. No auth, no data. |

### Pydantic shapes (`schemas.py`)
`UserOut{id,email,status,roles:[RoleBrief],permissions:[str],created_at}`,
`RoleOut{id,name,description,is_system,permissions:[str]}`, `RegisterIn{email,password}`,
`LoginIn{email,password}`, `SettingsOut/In{registration_enabled,allowed_domains:[str]}`,
`ChangePasswordIn{current_password,new_password}`, `SetPasswordIn{password}`.
Password input validated: min length 12 (configurable), max 128. `permissions:[str]` in `UserOut`
is computed per-request from live role membership (never read from a cached session value), so it
always matches what the guards enforce.

---

## 6. Security Design

| Concern | Mitigation |
|---|---|
| Password storage | argon2id (`argon2-cffi`), per-password salt; never logged. |
| Session token | `secrets.token_urlsafe(32)` (256-bit) OPAQUE random token in the cookie; server stores only `sha256(token)`. Lookups hash the incoming token and match. A DB leak exposes no usable tokens. The token is NOT signed — a random server-side-looked-up value needs no signature, so there is **no `COOKIE_SECRET`**. |
| Session fixation | On EVERY successful login the server mints a BRAND-NEW token and session row and ignores/overwrites any cookie the client already presents. No pre-auth session is ever "upgraded". |
| Cookie flags | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age` = idle TTL. |
| Transport | HTTPS only (Caddy auto-cert); app sets HSTS in prod. Refuses to set a `Secure` cookie over plain HTTP except `ENV=dev`. |
| Session expiry/revoke | Valid iff `now < idle_expires_at AND now < absolute_expires_at` (§4). Idle window slides on activity; absolute cap never moves. Expired/disabled-user → 401 + cookie cleared. Disable/logout/role-change deletes rows = instant revoke. `purge_expired` runs on a schedule (a background asyncio task started at app boot, hourly) AND opportunistically on resolve of an already-expired row. |
| Authorization (per-request) | Every protected endpoint declares `require_permission(name)`. The dependency loads the session user's effective permissions **freshly from `user_roles`/`role_permissions` on every request** (NEVER cached in the session) and 403s otherwise. No endpoint is guarded by role NAME — always by permission. So revoking a role takes effect on the user's next request. |
| Last-admin invariant | The system must always retain ≥1 `active` user whose effective permissions include BOTH `users.manage` AND `roles.manage`. A central `assert_admin_invariant()` is called inside the transaction of EVERY mutating path that could reduce privilege — `disable`, `delete user`, `set-roles`, `role.update` (custom-role perm removal), `role.delete` — and rolls back with `409 last_admin` if the post-mutation state would violate it. (`reject` only acts on a `pending` user, who can never be an admin-equivalent, so the check there always passes — harmless to include. `reset-password` doesn't change roles/status, so it is NOT in the guarded set. `is_system` admin role is immutable, so `role.update` can't strip it; this guard catches the custom-role and user-role paths.) |
| Admin-pair integrity (ENFORCED) | `assert_pair_integrity(perm_set)` rejects (`422 admin_pair`) any operation whose result would leave a role's permission set — or a user's effective permission set — holding EXACTLY ONE of `{users.manage, roles.manage}`. Called on: role create, role update, user approve, user set-roles. This is what makes "admin-equivalent" a real data-model invariant rather than a prose hope: you can never carve off `roles.manage` alone (which would reopen the self-escalation path) or `users.manage` alone. The seeded `member` role has neither; `admin` has both. **Evaluation order:** pair-integrity (`422`, input shape) is checked BEFORE the last-admin invariant (`409`, system state) so a single failing op returns a deterministic code. |
| Privilege escalation (accepted model) | Given pair-integrity above, `users.manage`+`roles.manage` only ever travel together = admin-equivalent (§2); an admin minting another admin is by-design. The escalation guards are: (a) pair-integrity (no half-admin role can exist), (b) the last-admin invariant (can't drop below one admin). Self-demotion is allowed (footgun) except where it breaks the last-admin invariant. |
| User enumeration (register) | ALL register outcomes — success(pending), registration-disabled, domain-not-allowed, email-taken — return the SAME status (`202`) and the SAME body `{status:'accepted'}`. The server performs equivalent work in every branch (incl. a dummy argon2 hash on the email-taken path) so neither status code, body, nor timing distinguishes them. A real account is created only when all checks pass. |
| User enumeration (login) | Fixed order: (1) load user by email, (2) ALWAYS run argon2-verify — against the real hash if found, else a precomputed dummy hash with IDENTICAL argon2 parameters, (3) THEN check `status == active`, (4) any failure → identical generic `401`. Status is never checked before the verify. |
| Brute force | Rate-limit `/login`, `/register`, `/change-password` per CLIENT IP. The app runs a SINGLE uvicorn worker; the limiter is an in-process token bucket (5/min then backoff) — acceptable because single-worker. Client IP is taken from `X-Forwarded-For` via Starlette `ProxyHeadersMiddleware` trusting ONLY `127.0.0.1` (Caddy); the app binds to loopback so XFF cannot be spoofed by external clients. Additionally a per-email failure counter (in the same in-process store) imposes an increasing delay after N consecutive failures (defense against single-account targeting across IPs). **Both the IP bucket and the per-email counter are in-process and reset on restart** — an accepted minor weakness on an operator-controlled single-owner box. Account lockout is intentionally NOT used (avoids a trivial DoS-by-lockout); the chain is argon2-cost + 12-char-min + IP-limit + per-email-delay + monitoring. |
| CSRF | Enforced as a rule, not assumed: (1) NO state-changing GET — every mutation is POST/PUT/DELETE; (2) every state-changing request MUST carry the custom header `X-Requested-With: prd-app` or it is rejected `403` regardless of SameSite; (3) CORS is locked to the exact same origin in prod (the `Origin` is never reflected/wildcarded); (4) SameSite=Lax is defense-in-depth on top, not the sole control. |
| Secrets | `.env` chmod 600, gitignored; never in logs, responses, or exceptions. DB creds + `ADMIN_PASSWORD` live only there. LLM/embed keys are NOT in this phase's `.env` (no LLM calls in Phase 2 — added in Phase 3 to keep the auth container's blast radius small). `ADMIN_PASSWORD` is read only by the bootstrap predicate; document that it may be rotated out after first successful admin login. |
| Input | Pydantic validation on every body; email format + IDNA-normalized domain check; password length bounds (12–128); SQLAlchemy parameterized queries only (no string SQL). |

---

## 7. Account & Request Flows

```
register:  POST /register {email,pw}   — EVERY branch does equivalent work + returns 202 {status:'accepted'}
           → always: validate body; compute argon2(pw) (or a dummy argon2 on reject paths)
           → if registration_enabled AND domain∈allowlist AND email free: create user(pending, hash)
           → else: discard (no user created)
           → ALWAYS respond 202 {status:'accepted'}  (no status/body/timing difference → no enumeration)

login:     POST /login {email,pw}   — fixed order, no early exits
           → (1) load user by email
           → (2) ALWAYS argon2-verify: real hash if found, else precomputed dummy hash (identical params)
           → (3) THEN check status == active
           → (4) all of {found, verify ok, active}? → mint a FRESH session token (ignore any
                 presented cookie) + Set-Cookie → {user}.  Any failure → identical generic 401.

authed req: cookie → sha256 → sessions lookup → now < idle_expires_at AND now < absolute_expires_at?
           → load user → status==active?  (else 401 + clear cookie)
           → slide idle_expires_at; throttled-bump last_seen_at
           → resolve effective_permissions FRESH from user_roles/role_permissions (never cached)
           → require_permission(name) checks membership → 200 or 403

approve:   admin POST /users/{id}/approve {role_ids}   (one transaction)
           → status pending→active, approved_at/by set, user_roles replaced with role_ids
           → assert_pair_integrity(effective_perms_after)  (422 admin_pair if exactly one of the pair)
           → commit

disable:   admin POST /users/{id}/disable   (all in ONE transaction)
           → set status active→disabled → assert_admin_invariant(post-state) → revoke_user_sessions(id)
           → commit; on invariant violation ROLL BACK and return 409 last_admin (status unchanged)

set-roles: admin PUT /users/{id}/roles {role_ids}   (one transaction)
           → replace user_roles
           → assert_pair_integrity(effective_perms_after) (422)  THEN  assert_admin_invariant(after) (409)
           → revoke_user_sessions(id) so the next request resolves the new permission set cleanly
           → commit; rollback on either violation
```

---

## 8. Deployment (openclaw)

- **Container:** a `prd-app` docker-compose project on the VPS: one service running
  `uvicorn prd_mcp.web.app:app` with a **single worker** (`--workers 1`, required — the in-process
  rate-limit bucket is not shared across workers), `env_file: .env`, bound to loopback `127.0.0.1:8300`.
- **Proxy / client IP:** the app uses Starlette `ProxyHeadersMiddleware` (or uvicorn
  `--forwarded-allow-ips=127.0.0.1`) trusting `X-Forwarded-For` ONLY from `127.0.0.1` (Caddy). Because
  the app binds to loopback, no external client can reach it directly to spoof XFF. This is what makes
  per-IP rate limiting see the real client, not Caddy.
- **Caddy:** add a block `prd.duyopenclaw.tech { reverse_proxy 127.0.0.1:8300 }` → automatic HTTPS
  (Caddy sets `X-Forwarded-For`/`X-Forwarded-Proto` by default).
- **Postgres:** create database `prd_auth` + app user on the existing `goclaw-postgres` instance
  (or a dedicated `prd-postgres` container — chosen at build time; isolated DB either way).
  `DATABASE_URL` in `.env`. Enable the `citext` extension.
- **Migrations:** `alembic upgrade head` runs on deploy (entrypoint or a one-shot). Seeding runs on
  app startup (idempotent, break-glass predicate per §4).
- **Secrets in `.env`** (chmod 600, gitignored; NO `COOKIE_SECRET` — opaque tokens aren't signed; NO
  LLM keys this phase): `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ALLOWED_EMAIL_DOMAINS`,
  `REGISTRATION_ENABLED`, `SESSION_IDLE_HOURS`, `SESSION_ABSOLUTE_DAYS`, `LAST_SEEN_THROTTLE_MIN`,
  `RATE_LIMIT_PER_MIN`, `PASSWORD_MIN_LENGTH`, `ENV=prod`, `CORS_ORIGIN=https://prd.duyopenclaw.tech`.
- **Secrets reading:** the web app's `settings.py` reads its config straight from `os.environ` (the
  `.env` injected by docker-compose) — no macOS `security` CLI on Linux. The shared PRD core's
  existing `read_secret(service, account)` (already injectable — `load_config` takes it as a param,
  verified in `config.py`) is given a `os.environ`-backed implementation on the VPS; the Mac keeps
  the `security` CLI version. One entrypoint swap, not a rewrite.
- **Pipeline migration (A/B/C/index → VPS):** tracked as a deployment sub-task. The Node A/B jobs +
  Python index job move to cron/systemd on the box; the vault + `.chroma-mcp` live on the box; this
  is what makes Phase 3's Status tab read local run-manifests. (Full migration detail belongs to
  Phase 3's deploy section, but Phase 2's deploy establishes the box + Postgres + Caddy subdomain.)

---

## 9. Error Handling

| Situation | Behavior |
|---|---|
| Registration: disabled / domain not allowed / email taken / success | **All identical: `202 {status:'accepted'}`**, same timing (dummy argon2 on reject paths) — no enumeration via code, body, or timing. |
| Login bad credentials / inactive / unknown user | `401 {error:{code:'invalid_credentials'}}` — identical for all; argon2 verify always runs before any status check. |
| Expired/invalid/revoked session | `401`, clears the cookie. |
| Missing permission | `403 {error:{code:'forbidden'}}`. |
| Any mutation that would break the last-admin invariant | `409 {code:'last_admin'}` — transaction rolled back. Covers disable/delete/set-roles/role.update/role.delete. (`reject` acts only on a `pending` user, never an admin-equivalent, so it can't trip this.) |
| Role/user op that would create a half-admin (exactly one of users.manage/roles.manage) | `422 {code:'admin_pair'}` — rejected. |
| Edit or delete an `is_system` role | `409 {code:'system_role_immutable'}`. |
| Delete a role still assigned to a user | `409 {code:'role_in_use'}` (FK RESTRICT). |
| Missing custom CSRF header on a state-changing request | `403 {code:'csrf'}`. |
| Missing required env on boot | App fails fast naming the missing var (no silent empty-string defaults for required secrets). |
| DB unreachable | `503`; `/healthz` reports it. |
| Rate limit exceeded | `429` with `Retry-After`. |

---

## 10. Testing Strategy

pytest + an async test client + a disposable Postgres (testcontainers or a test schema). No real
network; argon2 with reduced rounds in tests for speed.

| Layer | Tests |
|---|---|
| security | argon2 hash/verify round-trip; wrong password fails; token hash is sha256 and stable; cookie flags HttpOnly/Secure/SameSite; Secure cookie NOT set over plain HTTP when ENV=prod. |
| sessions | create→resolve→revoke; idle expiry (past `idle_expires_at`→invalid) AND absolute expiry (past `absolute_expires_at`→invalid even if recently active); idle window slides on resolve but absolute does not; `last_seen_at` write is throttled; revoke_user_sessions clears all of a user's rows; **login mints a fresh token and ignores a presented cookie (fixation)**. |
| rbac | effective permissions = union of role perms (live, not cached); require_permission allows/forbids; no-roles → no permissions; **changing a user's roles changes the next request's effective perms WITHOUT re-login (per-request resolution)**. |
| auth endpoints | register ALWAYS returns identical `202 {status:'accepted'}` for success/disabled/bad-domain/email-taken (no enumeration); login fixed-order (verify before status), identical 401 for unknown/wrong-pw/inactive; logout deletes session; me reflects live roles/permissions; change-password verifies current + revokes other sessions. |
| admin endpoints | approve pending→active + assigns roles; reject pending→deleted; disable revokes sessions; set-roles replaces + revokes target sessions; reset-password sets + revokes; role-in-use delete → 409; is_system role edit/delete → 409; settings toggle persists; all admin endpoints 403 without the permission. |
| last-admin invariant | EACH path that could break it is rejected with 409 and rolled back: disable the last admin; delete the last admin; set-roles removing admin-equiv from the last admin; delete/edit a custom role that holds the last admin-equiv perms. The invariant is satisfied again after adding a second admin. |
| admin-pair integrity | creating/updating a custom role with ONLY `users.manage` → 422; with ONLY `roles.manage` → 422; with BOTH or NEITHER → ok. Assigning a user (approve/set-roles) a role-set whose union is exactly one of the pair → 422. The seeded `admin` (both) and `member` (neither) pass. **Startup guard:** a half-admin row injected directly via SQL makes `assert_global_pair_integrity()` fail boot (loud) rather than serve it. |
| escalation (accepted model) | a full admin (both perms) CAN mint another admin — assert the model holds; a user with ONLY `prd.read` cannot reach any admin endpoint; a user cannot call admin endpoints to act before approval; there is NO reachable state where a user holds exactly one of the admin pair (pair-integrity). |
| settings authority | env seeds the row on first boot; a second boot with a DIFFERENT env value does NOT overwrite the existing DB row (single source of truth after first boot). |
| domain matching | `evilringkas.co.id` is rejected when only `ringkas.co.id` is allowed (exact match, no suffix); case/whitespace/IDNA normalized. |
| rate limit / proxy | client IP is taken from X-Forwarded-For (trusted from loopback only), so two different XFF IPs get independent buckets while same IP is throttled; per-email delay after N failures; 429 + Retry-After. |
| lifecycle (integration) | register → admin approve → login → access a prd.read-guarded route → admin disables → next request 401 + cookie cleared. |
| seed / break-glass | idempotent (re-run doesn't duplicate or reset a healthy admin); first boot creates admin+system roles+permissions; **if the only admin is deleted, next boot re-asserts the .env admin (break-glass); a healthy instance is untouched.** |

No real LLM/embed calls (this phase has none). Postgres is real (the RBAC/session/invariant logic is
the point — fakes would hide the bugs); argon2 uses reduced rounds in tests for speed but the dummy
hash uses the SAME params as real hashes (timing test).

---

## 11. Out of Scope (Phase 2)

- The React UI for any of this (Admin/Users tab + login screen) — Phase 3.
- The PRD-serving web-API (Library/Search/Ask/Status endpoints over the shared core) — Phase 3.
- SELF-SERVICE password reset via email + email verification — deferred (no email provider yet). The
  operational recovery path IS covered this phase: a logged-in user can `change-password`, and a
  `users.manage` admin can `reset-password` for any user; only the "forgot password while logged out"
  email-link flow is deferred.
- OAuth / SSO / 2FA — deferred (email+password is the agreed mechanism).
- Multi-tenancy — explicitly out of scope for all of v2.
- Audit log of admin actions — nice-to-have, deferred (not required for the gate).

**Operator note (break-glass):** the bootstrap admin re-asserts from `.env` only when NO active
admin-equivalent exists. While `ADMIN_EMAIL`/`ADMIN_PASSWORD` remain configured in `.env`, disabling
that account in-app is NOT permanent — a restart with zero other admins re-activates it (this is the
intended recovery behavior). To permanently retire the bootstrap admin, remove/rotate
`ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` and redeploy, after another admin exists.
