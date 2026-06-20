# Auth / User Management (v2 Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a FastAPI auth backend with full RBAC, admin-approval account lifecycle, server-side sessions, an email-domain allowlist, and a registration on/off switch — inside the existing `mcp/prd_mcp/web/` subpackage, deployed on the `openclaw` VPS behind Caddy.

**Architecture:** A new `web/` subpackage next to the untouched PRD core. Async SQLAlchemy + asyncpg over Postgres, Alembic migrations, argon2id passwords, opaque server-side session tokens (sha256 stored). Five code-defined permissions grouped into admin-editable roles, with two enforced invariants — admin-pair integrity (no half-admin) and last-admin (≥1 active full admin). FastAPI app factory mounts auth + admin routers behind a per-request permission resolver, an in-process rate limiter (single uvicorn worker), and CSRF controls.

**Tech Stack:** Python 3.10, FastAPI, uvicorn, SQLAlchemy 2.x async, asyncpg, Alembic, argon2-cffi, pydantic + pydantic-settings, pytest + testcontainers[postgres] (real Postgres in tests).

**Spec:** `docs/superpowers/specs/2026-06-20-auth-user-management-design.md` (the authoritative contract; every task implements a slice of it).

## Global Constraints

These bind EVERY task. Exact values copied from the spec.

- **Permission vocabulary (the only 5, code-defined, seeded):** `prd.read`, `prd.ask`, `status.view`, `users.manage`, `roles.manage`. No endpoint is guarded by role NAME — always by permission.
- **Admin-pair integrity (ENFORCED, not declared):** no role's permission set and no user's effective permission set may ever hold EXACTLY ONE of `{users.manage, roles.manage}` — it must hold NEITHER or BOTH. Violations return `422 {code:'admin_pair'}`. Checked on: role create, role update, user approve, user set-roles.
- **Last-admin invariant:** the system must always retain ≥1 `active` user whose effective permissions include BOTH `users.manage` AND `roles.manage`. Any mutating path that could reduce privilege (disable, delete user, set-roles, role.update, role.delete) calls `assert_admin_invariant()` inside its transaction and rolls back with `409 {code:'last_admin'}` on violation.
- **Evaluation order:** pair-integrity (`422`, input shape) is checked BEFORE last-admin (`409`, system state), so a single failing op returns a deterministic code.
- **Permission resolution is per-request** from live `user_roles`/`role_permissions` — NEVER cached in the session row. `UserOut.permissions` is computed the same way.
- **Sessions:** opaque `secrets.token_urlsafe(32)` token in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie; store only `sha256(token)`. Valid iff `now < idle_expires_at AND now < absolute_expires_at`. Idle slides (default 24h), absolute never moves (default 30d). NO `COOKIE_SECRET` (tokens are not signed). Login always mints a FRESH token and ignores any presented cookie (fixation defense).
- **Passwords:** argon2id via `argon2-cffi`; per-password salt; never logged or returned. Length bounds 12–128 (min configurable via `PASSWORD_MIN_LENGTH`, default 12). The login dummy hash uses the SAME argon2 params as real hashes (timing). Tests use reduced argon2 rounds for speed.
- **User-enumeration resistance:** register returns identical `202 {status:'accepted'}` for ALL outcomes (success/disabled/bad-domain/email-taken), equivalent work + timing (dummy argon2 on reject paths). Login runs fixed order — load → ALWAYS argon2-verify (real or dummy, identical params) → THEN status check → identical generic `401` on any failure.
- **CSRF:** every state-changing request (POST/PUT/DELETE) MUST carry header `X-Requested-With: prd-app` or be rejected `403 {code:'csrf'}`. No state-changing GET. CORS locked to the exact `CORS_ORIGIN` in prod (never reflected/wildcarded).
- **`is_system` roles (`admin`, `member`) are fully immutable via the API** — name, `is_system` flag, AND permission set. Edit/delete → `409 {code:'system_role_immutable'}`. `admin` = all 5 permissions; `member` = `prd.read`+`prd.ask`.
- **Error envelope:** all `4xx/5xx` share `{error:{code,message}}`.
- **Secrets:** read from `os.environ` (docker-compose `.env`); never logged, returned, or in exceptions. NO `COOKIE_SECRET`, NO LLM/embed keys in this phase. Settings (`registration_enabled`, `allowed_domains`) seed from env ONLY on first boot; the DB row is authoritative thereafter.
- **The PRD core is untouched.** Everything lives under `mcp/prd_mcp/web/` + `mcp/migrations/` + `mcp/pyproject.toml` deps + `mcp/prd_mcp/cli.py` (one new subcommand).
- **DRY / YAGNI / TDD / frequent commits.** `security.py` is the only module that hashes passwords or mints/hashes tokens; `sessions.py` is the only module that touches the sessions table; `rbac.py` is the only source of permission names + guards; `models.py` is the only schema definition.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp/pyproject.toml` | Add deps: fastapi, uvicorn[standard], sqlalchemy, asyncpg, alembic, argon2-cffi, pydantic-settings, python-multipart; dev: testcontainers[postgres], httpx, pytest-asyncio, greenlet. |
| `mcp/prd_mcp/web/__init__.py` | Package marker. |
| `mcp/prd_mcp/web/settings.py` | `WebSettings` (pydantic-settings) from env; fail-fast on missing required; `ENV` dev/prod; argon2 + session + rate-limit knobs. |
| `mcp/prd_mcp/web/db.py` | Async engine + `async_sessionmaker`; `get_db()` FastAPI dependency; `Base`. |
| `mcp/prd_mcp/web/models.py` | ORM: `User, Role, Permission, role_permissions, user_roles, Session, AppSettings`. Only schema definition. |
| `mcp/prd_mcp/web/schemas.py` | Pydantic request/response models + password-length validation. |
| `mcp/prd_mcp/web/security.py` | argon2 hash/verify (shared PasswordHasher); token mint + sha256; cookie set/clear; dummy hash. |
| `mcp/prd_mcp/web/sessions.py` | `create_session/resolve_session/revoke_session/revoke_user_sessions/purge_expired`. Only module touching `sessions`. |
| `mcp/prd_mcp/web/rbac.py` | `PERMISSIONS` vocabulary; `effective_permissions`; `assert_pair_integrity`; `assert_admin_invariant`; `current_user` + `require_permission` dependencies. |
| `mcp/prd_mcp/web/ratelimit.py` | In-process token-bucket per IP + per-email failure delay (single worker). |
| `mcp/prd_mcp/web/auth.py` | Router: register, login, logout, me, change-password. |
| `mcp/prd_mcp/web/admin.py` | Router: users + roles + settings management (permission-guarded). |
| `mcp/prd_mcp/web/seed.py` | Idempotent seed of permissions + system roles + break-glass admin; `assert_global_pair_integrity()` startup guard. |
| `mcp/prd_mcp/web/app.py` | `create_app()` factory: middleware (proxy headers, CORS, CSRF, rate-limit, error envelope), mounts routers, `/healthz`, startup seed + purge task. |
| `mcp/prd_mcp/cli.py` | Add `prd-mcp web` subcommand (uvicorn, single worker). |
| `mcp/migrations/` | Alembic `env.py` + `versions/` (one initial revision). |
| `mcp/alembic.ini` | Alembic config (script_location, sqlalchemy.url from env). |
| `mcp/tests/web/conftest.py` | testcontainers Postgres fixture; app + async client; reduced argon2 rounds. |
| `mcp/tests/web/test_*.py` | One test module per concern (security, sessions, rbac, auth, admin, invariants, settings, ratelimit, lifecycle, seed). |
| `mcp/deploy/` | `docker-compose.yml`, `Dockerfile`, `Caddyfile.snippet`, `.env.example`, `entrypoint.sh`. |

**Task → spec mapping:** T1 deps+settings+db (§3); T2 models+migration (§4); T3 security (§6); T4 sessions (§4,§6); T5 rbac+invariants (§2,§6); T6 schemas+ratelimit (§5,§6); T7 seed+break-glass (§4); T8 auth endpoints (§5,§7); T9 admin endpoints (§5,§7); T10 app factory+CSRF+CLI (§6,§8); T11 deployment artifacts (§8).

---

### Task 1: Dependencies, `web/` scaffold, settings, db engine

**Files:**
- Modify: `mcp/pyproject.toml`
- Create: `mcp/prd_mcp/web/__init__.py`
- Create: `mcp/prd_mcp/web/settings.py`
- Create: `mcp/prd_mcp/web/db.py`
- Create: `mcp/tests/web/__init__.py`
- Test: `mcp/tests/web/test_settings.py`

**Interfaces:**
- Produces: `WebSettings` (pydantic-settings `BaseSettings`) with fields `database_url:str`, `cookie_name:str='prd_session'`, `cors_origin:str`, `allowed_email_domains:str=''` (csv, first-boot seed only), `registration_enabled:bool=False` (first-boot seed only), `admin_email:str`, `admin_password:str`, `session_idle_hours:int=24`, `session_absolute_days:int=30`, `last_seen_throttle_min:int=5`, `rate_limit_per_min:int=5`, `password_min_length:int=12`, `env:str='prod'`, `argon2_time_cost:int=3`, `argon2_memory_kib:int=65536`, `argon2_parallelism:int=4`. Helper `load_settings(env_map=None) -> WebSettings`. Property `allowed_domains_seed -> list[str]` (split csv, strip, lower, drop empties); `is_prod -> bool`.
- Produces: `db.Base` (DeclarativeBase), `db.make_engine(url)`, `db.make_sessionmaker(engine)`, `db.set_sessionmaker(sm)`, async `db.get_db()` dependency (yields `AsyncSession`).

- [ ] **Step 1: Add dependencies to pyproject**

Edit `mcp/pyproject.toml`, in `[tool.poetry.dependencies]` add after `onnxruntime = "<1.17"`:

```toml
fastapi = "^0.115.0"
uvicorn = {extras = ["standard"], version = "^0.30.0"}
sqlalchemy = {extras = ["asyncio"], version = "^2.0.30"}
asyncpg = "^0.29.0"
psycopg = {extras = ["binary"], version = "^3.1.0"}
alembic = "^1.13.0"
argon2-cffi = "^23.1.0"
pydantic-settings = "^2.3.0"
python-multipart = "^0.0.9"
pydantic = {extras = ["email"], version = "^2.7.0"}
idna = "^3.7"
```

> **Why these:**
> - `pydantic[email]` — `schemas.py` (Task 6) uses `pydantic.EmailStr`, which imports the optional `email-validator` package; without the `[email]` extra, importing `schemas.py` raises `ImportError` at module load.
> - `idna` — `auth.py` (Task 8) imports it for punycode domain normalization; only a transitive dep of httpx, so declare it explicitly.
> - `psycopg[binary]` — Alembic migrations run with a SYNCHRONOUS driver. `migrations/env.py` rewrites the URL to `postgresql+psycopg://` (psycopg3) explicitly; asyncpg cannot drive Alembic's sync engine, so without psycopg3 `alembic upgrade head` (Task 11 entrypoint) fails before the app starts.
>
> All three MUST be in this Task-1 dependency block (do not defer to a later `poetry lock`).

In `[tool.poetry.group.dev.dependencies]` add after `pytest = "^8.0"` (NOTE: `httpx` is already in the main `[tool.poetry.dependencies]` from the v1 build — do NOT add it again here, Poetry rejects duplicate keys):

```toml
pytest-asyncio = "^0.23.0"
testcontainers = {extras = ["postgres"], version = "^4.5.0"}
greenlet = "^3.0.0"
```

Add a new section at the end of the file:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

Run: `cd mcp && poetry lock && poetry install`
Expected: resolves and installs; `poetry run python -c "import fastapi, sqlalchemy, asyncpg, alembic, argon2, pydantic_settings, email_validator, idna"` exits 0.

- [ ] **Step 2: Write the failing settings test**

Create `mcp/tests/web/__init__.py` (empty). Create `mcp/tests/web/test_settings.py`:

```python
import pytest
from prd_mcp.web.settings import load_settings

BASE = {
    "DATABASE_URL": "postgresql+asyncpg://u:p@localhost/prd_auth",
    "CORS_ORIGIN": "https://prd.example.tech",
    "ADMIN_EMAIL": "admin@ringkas.co.id",
    "ADMIN_PASSWORD": "correct horse battery staple",
}


def test_loads_required_and_defaults():
    s = load_settings(BASE)
    assert s.database_url.endswith("/prd_auth")
    assert s.cookie_name == "prd_session"
    assert s.session_idle_hours == 24
    assert s.session_absolute_days == 30
    assert s.password_min_length == 12
    assert s.env == "prod"
    assert s.registration_enabled is False


def test_missing_required_fails_fast():
    broken = dict(BASE)
    del broken["DATABASE_URL"]
    with pytest.raises(Exception):
        load_settings(broken)


def test_allowed_domains_seed_normalizes():
    s = load_settings({**BASE, "ALLOWED_EMAIL_DOMAINS": " Ringkas.co.id ,, EXAMPLE.com "})
    assert s.allowed_domains_seed == ["ringkas.co.id", "example.com"]


def test_registration_enabled_parses_bool():
    s = load_settings({**BASE, "REGISTRATION_ENABLED": "true"})
    assert s.registration_enabled is True
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/web/test_settings.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'prd_mcp.web'`.

- [ ] **Step 4: Create the web package + settings**

Create `mcp/prd_mcp/web/__init__.py` (empty file).

Create `mcp/prd_mcp/web/settings.py`:

```python
"""Web-app configuration, read from the process environment (docker-compose .env).

No macOS keychain here (this runs on Linux); secrets come straight from os.environ.
Fails fast on missing required vars rather than booting with silent "" defaults.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class WebSettings(BaseSettings):
    # case_sensitive=False makes field `database_url` read env `DATABASE_URL`
    # automatically — no explicit Field(alias=...) needed (and avoiding alias
    # sidesteps a pydantic-v2 serialization-alias footgun with model_copy()).
    model_config = SettingsConfigDict(case_sensitive=False, extra="ignore")

    # Required (no defaults -> missing => validation error => fail fast)
    database_url: str
    cors_origin: str
    admin_email: str
    admin_password: str

    # Optional with defaults (env var name = UPPERCASE of the field name)
    cookie_name: str = "prd_session"
    allowed_email_domains: str = ""
    registration_enabled: bool = False
    session_idle_hours: int = 24
    session_absolute_days: int = 30
    last_seen_throttle_min: int = 5
    rate_limit_per_min: int = 5
    password_min_length: int = 12
    env: str = "prod"

    # argon2 cost (overridable so tests can use cheap rounds)
    argon2_time_cost: int = 3
    argon2_memory_kib: int = 65536
    argon2_parallelism: int = 4

    @property
    def allowed_domains_seed(self) -> list[str]:
        return [d.strip().lower() for d in self.allowed_email_domains.split(",") if d.strip()]

    @property
    def is_prod(self) -> bool:
        return self.env.lower() == "prod"


def load_settings(env_map: dict | None = None) -> WebSettings:
    """Build settings from an explicit mapping (tests) or os.environ (default).

    With no aliases, the model's fields are lowercase. Callers pass UPPERCASE
    env-style keys (DATABASE_URL=...), so map them to lowercase field names
    before constructing. pydantic still coerces "true"/"30"/etc. from strings.
    """
    if env_map is None:
        return WebSettings()  # reads os.environ (case-insensitive)
    kwargs = {k.lower(): v for k, v in env_map.items()}
    return WebSettings(**kwargs)
```

- [ ] **Step 5: Run settings test to verify it passes**

Run: `cd mcp && poetry run pytest tests/web/test_settings.py -v`
Expected: 4 passed.

- [ ] **Step 6: Create db engine module**

Create `mcp/prd_mcp/web/db.py`:

```python
"""Async SQLAlchemy engine, sessionmaker, and the get_db() FastAPI dependency."""
from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def make_engine(database_url: str):
    return create_async_engine(database_url, pool_pre_ping=True, future=True)


def make_sessionmaker(engine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


# Set by create_app() at startup so the dependency can reach the live sessionmaker.
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def set_sessionmaker(sm: async_sessionmaker[AsyncSession]) -> None:
    global _sessionmaker
    _sessionmaker = sm


async def get_db() -> AsyncIterator[AsyncSession]:
    if _sessionmaker is None:  # pragma: no cover - misconfiguration guard
        raise RuntimeError("sessionmaker not initialized; call set_sessionmaker in create_app")
    async with _sessionmaker() as session:
        try:
            yield session
        except Exception:
            # Guarantee the "rolls back with 409/422" contract for any handler
            # that raised after a flush — never let a flushed-but-uncommitted
            # mutation leak. (async-with close also rolls back an open txn, but
            # this makes the rollback explicit and ordering-independent.)
            await session.rollback()
            raise
```

- [ ] **Step 7: Commit**

```bash
cd mcp && git add pyproject.toml poetry.lock prd_mcp/web/__init__.py prd_mcp/web/settings.py prd_mcp/web/db.py tests/web/__init__.py tests/web/test_settings.py
git commit -m "feat(web): add auth deps, web package scaffold, settings, db engine"
```

---

### Task 2: ORM models + Alembic initial migration

**Files:**
- Create: `mcp/prd_mcp/web/models.py`
- Create: `mcp/alembic.ini`
- Create: `mcp/migrations/env.py`
- Create: `mcp/migrations/script.py.mako`
- Create: `mcp/migrations/versions/0001_initial.py`
- Test: `mcp/tests/web/conftest.py`
- Test: `mcp/tests/web/test_models.py`
- Test: `mcp/tests/web/test_migration.py`

**Interfaces:**
- Consumes: `db.Base` (Task 1).
- Produces: ORM classes `User, Role, Permission, Session, AppSettings` and association tables `role_permissions, user_roles`. Column contracts match spec §4 exactly. `User.status` ∈ {`pending`,`active`,`disabled`}. `Session.token_hash` unique. `AppSettings` single row id=1.
- Produces: `tests/web/conftest.py` fixtures: `pg_url` (session-scoped testcontainers Postgres URL with citext enabled + schema created), `engine`, `db` (function-scoped `AsyncSession` with rollback), `settings` (test `WebSettings` with cheap argon2).

- [ ] **Step 1: Write models**

Create `mcp/prd_mcp/web/models.py`:

```python
"""ORM schema — the single source of truth for the auth database.

Postgres-specific: citext email, text[] allowed_domains, uuid PKs via
gen_random_uuid(). Alembic migrations are written to match these tables.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Table,
    Column,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, CITEXT, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from prd_mcp.web.db import Base

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", UUID(as_uuid=True), ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)

user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", UUID(as_uuid=True), ForeignKey("roles.id", ondelete="RESTRICT"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("status IN ('pending','active','disabled')", name="ck_users_status"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    email: Mapped[str] = mapped_column(CITEXT, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    roles: Mapped[list["Role"]] = relationship(secondary=user_roles, lazy="selectin")


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, server_default="")
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    permissions: Mapped[list["Permission"]] = relationship(secondary=role_permissions, lazy="selectin")


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False, server_default="")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AppSettings(Base):
    __tablename__ = "app_settings"
    __table_args__ = (CheckConstraint("id = 1", name="ck_app_settings_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, server_default=text("1"))
    registration_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    allowed_domains: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, server_default=text("'{}'"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
```

- [ ] **Step 2: Create the testcontainers conftest**

Create `mcp/tests/web/conftest.py`:

```python
"""Real-Postgres test fixtures via testcontainers. The RBAC/session/invariant
logic is the whole point of this phase; SQLite/fakes would hide citext, text[],
FK cascades, and transactional rollback — the security-critical behaviors."""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from testcontainers.postgres import PostgresContainer

from prd_mcp.web.db import Base, make_engine, make_sessionmaker
from prd_mcp.web.settings import load_settings
import prd_mcp.web.models  # noqa: F401  (register tables on Base.metadata)

TEST_ARGON = {"ARGON2_TIME_COST": "1", "ARGON2_MEMORY_KIB": "8", "ARGON2_PARALLELISM": "1"}


@pytest.fixture(scope="session")
def pg_container():
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture(scope="session")
def pg_url(pg_container) -> str:
    # testcontainers returns a psycopg2 URL; convert to asyncpg driver.
    raw = pg_container.get_connection_url()  # postgresql+psycopg2://...
    return raw.replace("postgresql+psycopg2://", "postgresql+asyncpg://")


@pytest.fixture(scope="session")
def base_env(pg_url) -> dict:
    return {
        "DATABASE_URL": pg_url,
        "CORS_ORIGIN": "https://prd.test",
        "ADMIN_EMAIL": "admin@ringkas.co.id",
        "ADMIN_PASSWORD": "break glass admin pw 123",
        "ENV": "dev",
        **TEST_ARGON,
    }


@pytest.fixture
def settings(base_env):
    return load_settings(base_env)


@pytest_asyncio.fixture
async def engine(pg_url):
    eng = make_engine(pg_url)
    async with eng.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def sessionmaker_(engine):
    return make_sessionmaker(engine)


@pytest_asyncio.fixture
async def db(sessionmaker_):
    async with sessionmaker_() as session:
        yield session
```

- [ ] **Step 3: Write the failing models test**

Create `mcp/tests/web/test_models.py`:

```python
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from prd_mcp.web.models import User, Role, Permission, AppSettings


async def test_user_email_is_case_insensitive_unique(db):
    db.add(User(email="Duy@ringkas.co.id", password_hash="x"))
    await db.commit()
    db.add(User(email="duy@ringkas.co.id", password_hash="y"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_user_status_check_constraint(db):
    db.add(User(email="a@ringkas.co.id", password_hash="x", status="bogus"))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_status_defaults_to_pending(db):
    u = User(email="b@ringkas.co.id", password_hash="x")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert u.status == "pending"
    assert isinstance(u.id, uuid.UUID)


async def test_app_settings_singleton_constraint(db):
    db.add(AppSettings(id=1, registration_enabled=True, allowed_domains=["ringkas.co.id"]))
    await db.commit()
    db.add(AppSettings(id=2, registration_enabled=False))
    with pytest.raises(IntegrityError):
        await db.commit()


async def test_allowed_domains_is_text_array(db):
    s = AppSettings(id=1, registration_enabled=False, allowed_domains=["ringkas.co.id", "example.com"])
    db.add(s)
    await db.commit()
    await db.refresh(s)
    assert s.allowed_domains == ["ringkas.co.id", "example.com"]
```

- [ ] **Step 4: Run models test to verify it passes (schema created from metadata)**

Run: `cd mcp && poetry run pytest tests/web/test_models.py -v`
Expected: 5 passed (Docker pulls postgres:16-alpine on first run).

- [ ] **Step 5: Scaffold Alembic config**

Create `mcp/alembic.ini`:

```ini
[alembic]
script_location = migrations
prepend_sys_path = .
sqlalchemy.url =

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

Create `mcp/migrations/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

Create `mcp/migrations/env.py`:

```python
"""Alembic environment — sync engine, URL from ALEMBIC_DATABASE_URL or DATABASE_URL.

Migrations run with the SYNCHRONOUS psycopg3 driver; the app uses asyncpg at
runtime. We rewrite the URL's driver to `+psycopg` (psycopg3) so SQLAlchemy does
not default to psycopg2 (which is not a declared dependency).
"""
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from prd_mcp.web.db import Base
import prd_mcp.web.models  # noqa: F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _url() -> str:
    url = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    # Force the sync psycopg3 driver regardless of how the URL was written.
    for drv in ("+asyncpg", "+psycopg2", "+psycopg"):
        url = url.replace(drv, "")
    return url.replace("postgresql://", "postgresql+psycopg://", 1)


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 6: Write the initial migration**

Create `mcp/migrations/versions/0001_initial.py`:

```python
"""initial auth schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-20
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("email", postgresql.CITEXT(), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.CheckConstraint("status IN ('pending','active','disabled')", name="ck_users_status"),
    )
    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
        sa.Column("description", sa.String(), nullable=False, server_default=""),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "permissions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
        sa.Column("description", sa.String(), nullable=False, server_default=""),
    )
    op.create_table(
        "role_permissions",
        sa.Column("role_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("permission_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_table(
        "user_roles",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roles.id", ondelete="RESTRICT"), primary_key=True),
    )
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("idle_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_token_hash", "sessions", ["token_hash"])
    op.create_index("ix_sessions_idle_expires_at", "sessions", ["idle_expires_at"])
    op.create_table(
        "app_settings",
        sa.Column("id", sa.Integer(), server_default=sa.text("1"), primary_key=True),
        sa.Column("registration_enabled", sa.Boolean(), nullable=False),
        sa.Column("allowed_domains", postgresql.ARRAY(sa.String()), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_app_settings_singleton"),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
    op.drop_index("ix_sessions_idle_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_token_hash", table_name="sessions")
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("user_roles")
    op.drop_table("role_permissions")
    op.drop_table("permissions")
    op.drop_table("roles")
    op.drop_table("users")
```

- [ ] **Step 7: Write the migration-parity test**

Add to `mcp/tests/web/test_models.py`:

Create a SEPARATE file `mcp/tests/web/test_migration.py` (isolated so its destructive `DROP SCHEMA` on the shared session container runs apart from the per-test `engine` fixture):

```python
import os
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from prd_mcp.web.db import Base
import prd_mcp.web.models  # noqa: F401  (register tables on Base.metadata)

# mcp/ package root = three parents up from tests/web/test_migration.py
MCP_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_migration_produces_same_tables_as_metadata(pg_url):
    """`alembic upgrade head` must build exactly the tables the ORM declares.

    env.py rewrites the +asyncpg URL to the sync +psycopg driver, so passing the
    asyncpg pg_url through ALEMBIC_DATABASE_URL is correct.
    """
    env = dict(os.environ, ALEMBIC_DATABASE_URL=pg_url)
    # fresh DB state: drop everything first via a throwaway engine
    eng = create_async_engine(pg_url)
    async with eng.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    await eng.dispose()

    # cwd = the mcp/ dir (where alembic.ini lives), resolved absolutely so this
    # works regardless of where pytest was launched from.
    r = subprocess.run(
        ["poetry", "run", "alembic", "upgrade", "head"],
        cwd=str(MCP_ROOT), env=env, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr

    eng = create_async_engine(pg_url)
    async with eng.connect() as conn:
        rows = await conn.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
        ))
        tables = {row[0] for row in rows}
    await eng.dispose()
    expected = set(Base.metadata.tables.keys())
    assert expected.issubset(tables), f"missing {expected - tables}"
```

NOTE for implementer: `test_migration.py` is a SEPARATE file (not appended to `test_models.py`) precisely because its `DROP SCHEMA public CASCADE` mutates the shared session-scoped container. The `engine` fixture other tests use does its own `drop_all/create_all`, so it heals afterward; still, keeping this test isolated avoids cross-test ordering coupling. Keep the parity assertion regardless.

- [ ] **Step 8: Run the full web suite**

Run: `cd mcp && poetry run pytest tests/web/ -v`
Expected: all green (settings 4 + models 5 + migration 1).

- [ ] **Step 9: Commit**

```bash
cd mcp && git add prd_mcp/web/models.py alembic.ini migrations/ tests/web/conftest.py tests/web/test_models.py tests/web/test_migration.py
git commit -m "feat(web): ORM models + Alembic initial migration + testcontainers conftest"
```

---

### Task 3: `security.py` — argon2 hashing, token mint/hash, cookie helpers

**Files:**
- Create: `mcp/prd_mcp/web/security.py`
- Test: `mcp/tests/web/test_security.py`

**Interfaces:**
- Consumes: `WebSettings` (Task 1) for argon2 params, cookie name, env.
- Produces:
  - `class PasswordHasher` wrapper built from settings: `hash(pw:str)->str`, `verify(hash:str, pw:str)->bool` (returns False, never raises, on mismatch), `dummy_hash:str` (precomputed, same params).
  - `make_password_hasher(settings)->PasswordHasher`.
  - `new_session_token()->str` (`secrets.token_urlsafe(32)`).
  - `hash_token(token:str)->str` (`sha256` hexdigest).
  - `set_session_cookie(response, settings, token, max_age:int)->None` and `clear_session_cookie(response, settings)->None`. Secure flag = `settings.is_prod`; HttpOnly always; SameSite=Lax; Path=/.

- [ ] **Step 1: Write the failing test**

Create `mcp/tests/web/test_security.py`:

```python
from starlette.responses import Response

from prd_mcp.web.security import (
    make_password_hasher,
    new_session_token,
    hash_token,
    set_session_cookie,
    clear_session_cookie,
)


def test_hash_verify_roundtrip(settings):
    h = make_password_hasher(settings)
    digest = h.hash("correct horse battery staple")
    assert digest != "correct horse battery staple"
    assert h.verify(digest, "correct horse battery staple") is True
    assert h.verify(digest, "wrong password aaaa") is False


def test_verify_returns_false_not_raises_on_garbage(settings):
    h = make_password_hasher(settings)
    assert h.verify("not-a-valid-argon2-hash", "whatever") is False


def test_dummy_hash_has_same_params_and_verifies_nothing_real(settings):
    h = make_password_hasher(settings)
    # dummy hash is a real argon2 hash (so verify against it costs the same)
    assert h.dummy_hash.startswith("$argon2id$")
    assert h.verify(h.dummy_hash, "any password here xx") is False


def test_token_mint_is_unguessable_and_unique():
    a, b = new_session_token(), new_session_token()
    assert a != b
    assert len(a) >= 32


def test_hash_token_is_sha256_stable():
    t = "abc123"
    assert hash_token(t) == hash_token(t)
    assert len(hash_token(t)) == 64  # sha256 hex
    assert hash_token(t) != t


def test_cookie_flags_prod_secure(settings):
    prod = settings.model_copy(update={"env": "prod"})
    r = Response()
    set_session_cookie(r, prod, "tok", max_age=3600)
    header = r.headers["set-cookie"]
    assert "prd_session=tok" in header
    assert "HttpOnly" in header
    assert "Secure" in header
    assert "SameSite=Lax" in header
    assert "Path=/" in header


def test_cookie_not_secure_in_dev(settings):
    dev = settings.model_copy(update={"env": "dev"})
    r = Response()
    set_session_cookie(r, dev, "tok", max_age=3600)
    assert "Secure" not in r.headers["set-cookie"]


def test_clear_cookie_expires(settings):
    r = Response()
    clear_session_cookie(r, settings)
    header = r.headers["set-cookie"]
    assert "prd_session=" in header
    assert ("Max-Age=0" in header) or ("expires=" in header.lower())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/web/test_security.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.security'`.

- [ ] **Step 3: Implement security.py**

Create `mcp/prd_mcp/web/security.py`:

```python
"""The ONLY module that hashes/verifies passwords or mints/hashes session tokens.

Passwords: argon2id (argon2-cffi). Tokens: opaque 256-bit random, stored only as
sha256. No COOKIE_SECRET — tokens are looked up server-side, not signed.
"""
from __future__ import annotations

import hashlib
import secrets

from argon2 import PasswordHasher as _Argon2Hasher
from argon2 import exceptions as argon2_exceptions
from starlette.responses import Response

from prd_mcp.web.settings import WebSettings


class PasswordHasher:
    def __init__(self, hasher: _Argon2Hasher):
        self._h = hasher
        # A real argon2 hash of a random throwaway secret, with identical params,
        # so verify() on the no-such-user path costs the same as a real verify.
        self.dummy_hash: str = self._h.hash(secrets.token_urlsafe(32))

    def hash(self, password: str) -> str:
        return self._h.hash(password)

    def verify(self, password_hash: str, password: str) -> bool:
        try:
            return self._h.verify(password_hash, password)
        except argon2_exceptions.VerifyMismatchError:
            return False
        except argon2_exceptions.InvalidHash:
            return False
        except argon2_exceptions.VerificationError:
            return False


def make_password_hasher(settings: WebSettings) -> PasswordHasher:
    hasher = _Argon2Hasher(
        time_cost=settings.argon2_time_cost,
        memory_cost=settings.argon2_memory_kib,
        parallelism=settings.argon2_parallelism,
    )
    return PasswordHasher(hasher)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def set_session_cookie(response: Response, settings: WebSettings, token: str, max_age: int) -> None:
    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.is_prod,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response, settings: WebSettings) -> None:
    response.delete_cookie(key=settings.cookie_name, path="/")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/web/test_security.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
cd mcp && git add prd_mcp/web/security.py tests/web/test_security.py
git commit -m "feat(web): argon2 password hashing, opaque session tokens, cookie helpers"
```

---

### Task 4: `sessions.py` — create/resolve/revoke + expiry semantics

**Files:**
- Create: `mcp/prd_mcp/web/sessions.py`
- Test: `mcp/tests/web/test_sessions.py`

**Interfaces:**
- Consumes: `models.Session/User` (Task 2), `security.new_session_token/hash_token` (Task 3), `WebSettings`.
- Produces (all async, all take an explicit `now: datetime` so expiry is deterministic in tests):
  - `create_session(db, user_id, settings, *, now) -> tuple[str, Session]` — mints token, stores `hash_token(token)`, sets `idle_expires_at = now + idle`, `absolute_expires_at = now + absolute`, `last_seen_at = now`. Returns the RAW token (only time it exists) + the row.
  - `resolve_session(db, raw_token, settings, *, now) -> Session | None` — hashes token, loads row; returns None if absent OR `now >= idle_expires_at` OR `now >= absolute_expires_at` (and opportunistically deletes an expired row). On valid: slides `idle_expires_at = now + idle`; bumps `last_seen_at` only if older than `last_seen_throttle_min`. Never extends `absolute_expires_at`.
  - `revoke_session(db, raw_token) -> None` — delete by token hash.
  - `revoke_user_sessions(db, user_id, *, except_token_hash: str | None = None) -> int` — delete all of a user's rows (optionally keep one); returns count deleted.
  - `purge_expired(db, *, now) -> int` — delete rows where `now >= idle_expires_at OR now >= absolute_expires_at`.
- All commits are the CALLER's responsibility EXCEPT `resolve_session` (which may write slide/purge) — document that `resolve_session` flushes but does not commit; the request lifecycle commits.

- [ ] **Step 1: Write the failing test**

Create `mcp/tests/web/test_sessions.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from prd_mcp.web.models import User
from prd_mcp.web import sessions as S
from prd_mcp.web.security import hash_token


def utc(**kw):
    return datetime(2026, 6, 20, 12, 0, 0, tzinfo=timezone.utc) + timedelta(**kw)


async def _user(db) -> User:
    u = User(email="s@ringkas.co.id", password_hash="x", status="active")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_create_then_resolve(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    assert row.token_hash == hash_token(token)
    resolved = await S.resolve_session(db, token, settings, now=now + timedelta(minutes=1))
    assert resolved is not None
    assert resolved.user_id == u.id


async def test_idle_expiry_invalidates(db, settings):
    u = await _user(db)
    now = utc()
    token, _ = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    later = now + timedelta(hours=settings.session_idle_hours, minutes=1)
    assert await S.resolve_session(db, token, settings, now=later) is None


async def test_absolute_expiry_invalidates_even_if_recently_active(db, settings):
    u = await _user(db)
    now = utc()
    token, _ = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    # keep sliding idle right up to the absolute cap
    t = now
    for _ in range(40):
        t = t + timedelta(hours=settings.session_idle_hours - 1)
        r = await S.resolve_session(db, token, settings, now=t)
        if r is None:
            break
    past_absolute = now + timedelta(days=settings.session_absolute_days, minutes=1)
    assert await S.resolve_session(db, token, settings, now=past_absolute) is None


async def test_idle_slides_on_resolve(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    first_idle = row.idle_expires_at
    await S.resolve_session(db, token, settings, now=now + timedelta(hours=1))
    await db.commit()
    await db.refresh(row)
    assert row.idle_expires_at > first_idle


async def test_last_seen_throttled_within_window(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    created_last_seen = row.last_seen_at
    # resolve within the throttle window -> last_seen must NOT move
    await S.resolve_session(db, token, settings, now=now + timedelta(minutes=1))
    await db.commit()
    await db.refresh(row)
    assert row.last_seen_at == created_last_seen


async def test_last_seen_bumps_past_throttle(db, settings):
    u = await _user(db)
    now = utc()
    token, row = await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    created_last_seen = row.last_seen_at
    # resolve past the throttle window -> last_seen advances
    later = now + timedelta(minutes=settings.last_seen_throttle_min + 1)
    await S.resolve_session(db, token, settings, now=later)
    await db.commit()
    await db.refresh(row)
    assert row.last_seen_at > created_last_seen


async def test_revoke_user_sessions_clears_all(db, settings):
    u = await _user(db)
    now = utc()
    await S.create_session(db, u.id, settings, now=now)
    await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    n = await S.revoke_user_sessions(db, u.id)
    await db.commit()
    assert n == 2


async def test_revoke_user_sessions_can_keep_one(db, settings):
    u = await _user(db)
    now = utc()
    keep_token, keep_row = await S.create_session(db, u.id, settings, now=now)
    await S.create_session(db, u.id, settings, now=now)
    await db.commit()
    n = await S.revoke_user_sessions(db, u.id, except_token_hash=keep_row.token_hash)
    await db.commit()
    assert n == 1
    assert await S.resolve_session(db, keep_token, settings, now=now + timedelta(minutes=1)) is not None


async def test_purge_expired(db, settings):
    u = await _user(db)
    now = utc()
    await S.create_session(db, u.id, settings, now=now - timedelta(days=40))  # already past absolute
    await db.commit()
    n = await S.purge_expired(db, now=now)
    await db.commit()
    assert n == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/web/test_sessions.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.sessions'`.

- [ ] **Step 3: Implement sessions.py**

Create `mcp/prd_mcp/web/sessions.py`:

```python
"""The ONLY module that reads/writes the sessions table.

All functions take an explicit `now` so expiry is deterministic under test.
Expiry rule: valid iff now < idle_expires_at AND now < absolute_expires_at.
Idle slides on resolve; absolute never moves.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, select

from prd_mcp.web.models import Session
from prd_mcp.web.security import hash_token, new_session_token
from prd_mcp.web.settings import WebSettings


async def create_session(db, user_id: uuid.UUID, settings: WebSettings, *, now: datetime) -> tuple[str, Session]:
    token = new_session_token()
    row = Session(
        user_id=user_id,
        token_hash=hash_token(token),
        created_at=now,
        idle_expires_at=now + timedelta(hours=settings.session_idle_hours),
        absolute_expires_at=now + timedelta(days=settings.session_absolute_days),
        last_seen_at=now,
    )
    db.add(row)
    await db.flush()
    return token, row


async def resolve_session(db, raw_token: str, settings: WebSettings, *, now: datetime) -> Session | None:
    token_hash = hash_token(raw_token)
    row = (await db.execute(select(Session).where(Session.token_hash == token_hash))).scalar_one_or_none()
    if row is None:
        return None
    if now >= row.idle_expires_at or now >= row.absolute_expires_at:
        await db.execute(delete(Session).where(Session.id == row.id))  # opportunistic purge
        await db.flush()
        return None
    # slide idle window (capped implicitly by absolute on the next resolve)
    row.idle_expires_at = now + timedelta(hours=settings.session_idle_hours)
    if now - row.last_seen_at >= timedelta(minutes=settings.last_seen_throttle_min):
        row.last_seen_at = now
    await db.flush()
    return row


async def revoke_session(db, raw_token: str) -> None:
    await db.execute(delete(Session).where(Session.token_hash == hash_token(raw_token)))
    await db.flush()


async def revoke_user_sessions(db, user_id: uuid.UUID, *, except_token_hash: str | None = None) -> int:
    stmt = delete(Session).where(Session.user_id == user_id)
    if except_token_hash is not None:
        stmt = stmt.where(Session.token_hash != except_token_hash)
    result = await db.execute(stmt)
    await db.flush()
    return result.rowcount or 0


async def purge_expired(db, *, now: datetime) -> int:
    stmt = delete(Session).where((Session.idle_expires_at <= now) | (Session.absolute_expires_at <= now))
    result = await db.execute(stmt)
    await db.flush()
    return result.rowcount or 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/web/test_sessions.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd mcp && git add prd_mcp/web/sessions.py tests/web/test_sessions.py
git commit -m "feat(web): server-side sessions with idle+absolute expiry and revocation"
```

---

### Task 5: `rbac.py` — permission vocabulary, resolution, both invariants, guards

**Files:**
- Create: `mcp/prd_mcp/web/errors.py`
- Create: `mcp/prd_mcp/web/rbac.py`
- Test: `mcp/tests/web/test_rbac.py`
- Test: `mcp/tests/web/test_invariants.py`

**Interfaces:**
- Consumes: `models` (Task 2), `sessions.resolve_session` (Task 4), `security` (Task 3), `db.get_db` (Task 1).
- Produces in `errors.py`:
  - `class AppError(Exception)` with `status_code:int`, `code:str`, `message:str`.
  - Helpers: `pair_error()` (422, `admin_pair`), `last_admin_error()` (409, `last_admin`), `forbidden()` (403, `forbidden`), `csrf_error()` (403, `csrf`), `system_role_error()` (409, `system_role_immutable`), `role_in_use_error()` (409, `role_in_use`), `invalid_credentials()` (401), `unauthorized()` (401, `unauthorized`).
- Produces in `rbac.py`:
  - `PERMISSIONS: dict[str,str]` — the 5 names→descriptions. `ADMIN_PAIR = frozenset({"users.manage","roles.manage"})`.
  - `ALL_PERMISSION_NAMES`, `MEMBER_PERMISSION_NAMES = {"prd.read","prd.ask"}`.
  - `effective_permissions(user) -> set[str]` — union over the user's roles' permissions (uses the eager `selectin` relationships).
  - `assert_pair_integrity(perm_names: set[str]) -> None` — raises `pair_error()` if `len(perm_names & ADMIN_PAIR) == 1`.
  - `async assert_admin_invariant(db) -> None` — after a flush, counts active users whose effective perms ⊇ ADMIN_PAIR; raises `last_admin_error()` if 0. Implemented with a SQL query over user_roles/role_permissions (see Step 4) so it sees flushed-but-uncommitted state.
  - `async current_user(request, db=Depends(get_db)) -> User` — reads cookie, `resolve_session`, loads active user, attaches raw token hash to `request.state`; raises `unauthorized()` (caller clears cookie) on any failure.
  - `def require_permission(name: str)` -> a FastAPI dependency that calls `current_user`, computes `effective_permissions`, raises `forbidden()` if `name` not in them.

- [ ] **Step 1: Write errors.py**

Create `mcp/prd_mcp/web/errors.py`:

```python
"""Single error type + the canonical error envelope {error:{code,message}}."""
from __future__ import annotations


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def pair_error() -> AppError:
    return AppError(422, "admin_pair", "users.manage and roles.manage must be held together or not at all")


def last_admin_error() -> AppError:
    return AppError(409, "last_admin", "operation would remove the last active administrator")


def forbidden() -> AppError:
    return AppError(403, "forbidden", "insufficient permission")


def csrf_error() -> AppError:
    return AppError(403, "csrf", "missing or invalid CSRF header")


def system_role_error() -> AppError:
    return AppError(409, "system_role_immutable", "system roles cannot be modified or deleted")


def role_in_use_error() -> AppError:
    return AppError(409, "role_in_use", "role is still assigned to one or more users")


def invalid_credentials() -> AppError:
    return AppError(401, "invalid_credentials", "invalid email or password")


def unauthorized() -> AppError:
    return AppError(401, "unauthorized", "authentication required")
```

- [ ] **Step 2: Write the failing rbac test**

Create `mcp/tests/web/test_rbac.py`:

```python
import pytest

from prd_mcp.web import rbac
from prd_mcp.web.errors import AppError
from prd_mcp.web.models import User, Role, Permission


async def _perm(db, name) -> Permission:
    p = Permission(name=name)
    db.add(p)
    await db.flush()
    return p


async def _role(db, name, perm_names, is_system=False) -> Role:
    role = Role(name=name, is_system=is_system)
    for pn in perm_names:
        role.permissions.append(await _perm(db, pn))
    db.add(role)
    await db.flush()
    return role


def test_permissions_vocabulary_is_exactly_five():
    assert set(rbac.PERMISSIONS) == {"prd.read", "prd.ask", "status.view", "users.manage", "roles.manage"}


def test_assert_pair_integrity_rejects_exactly_one():
    with pytest.raises(AppError) as e:
        rbac.assert_pair_integrity({"roles.manage", "prd.read"})
    assert e.value.code == "admin_pair"
    with pytest.raises(AppError):
        rbac.assert_pair_integrity({"users.manage"})


def test_assert_pair_integrity_allows_both_or_neither():
    rbac.assert_pair_integrity({"users.manage", "roles.manage"})  # both
    rbac.assert_pair_integrity({"prd.read", "prd.ask"})  # neither
    rbac.assert_pair_integrity(set())  # empty


async def test_effective_permissions_is_union(db):
    role_a = await _role(db, "a", ["prd.read"])
    role_b = await _role(db, "b", ["prd.ask", "status.view"])
    u = User(email="u@ringkas.co.id", password_hash="x", status="active")
    u.roles.extend([role_a, role_b])
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert rbac.effective_permissions(u) == {"prd.read", "prd.ask", "status.view"}


async def test_no_roles_no_permissions(db):
    u = User(email="z@ringkas.co.id", password_hash="x", status="active")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert rbac.effective_permissions(u) == set()
```

- [ ] **Step 3: Write the failing invariants test**

Create `mcp/tests/web/test_invariants.py`:

```python
import pytest

from prd_mcp.web import rbac
from prd_mcp.web.errors import AppError
from prd_mcp.web.models import User, Role, Permission


async def _admin_role(db) -> Role:
    role = Role(name="admin", is_system=True)
    for pn in ["users.manage", "roles.manage"]:
        p = Permission(name=pn)
        db.add(p)
        await db.flush()
        role.permissions.append(p)
    db.add(role)
    await db.flush()
    return role


async def _active_admin(db, email) -> User:
    role = await _admin_role(db)
    u = User(email=email, password_hash="x", status="active")
    u.roles.append(role)
    db.add(u)
    await db.flush()
    return u


async def test_invariant_holds_with_one_admin(db):
    await _active_admin(db, "admin@ringkas.co.id")
    await rbac.assert_admin_invariant(db)  # no raise


async def test_invariant_violated_with_zero_active_admins(db):
    u = await _active_admin(db, "admin@ringkas.co.id")
    u.status = "disabled"
    await db.flush()
    with pytest.raises(AppError) as e:
        await rbac.assert_admin_invariant(db)
    assert e.value.code == "last_admin"


async def test_invariant_counts_only_effective_pair_holders(db):
    # a user with only prd.read does not satisfy the invariant
    p = Permission(name="prd.read")
    db.add(p)
    await db.flush()
    role = Role(name="reader")
    role.permissions.append(p)
    u = User(email="r@ringkas.co.id", password_hash="x", status="active")
    u.roles.append(role)
    db.add(role)
    db.add(u)
    await db.flush()
    with pytest.raises(AppError):
        await rbac.assert_admin_invariant(db)


async def test_admin_invariant_takes_advisory_lock(db):
    """The check must acquire the xact advisory lock so concurrent disables of
    two different admins can't both pass (TOCTOU). We assert the lock is held by
    this transaction after the call (pg_advisory_xact_lock is recorded in
    pg_locks for the session's backend)."""
    from sqlalchemy import text

    await _active_admin(db, "a1@ringkas.co.id")
    await _active_admin(db, "a2@ringkas.co.id")
    await rbac.assert_admin_invariant(db)  # passes (2 admins) and takes the lock
    held = (await db.execute(text(
        "SELECT count(*) FROM pg_locks WHERE locktype='advisory' "
        "AND pid = pg_backend_pid()"
    ))).scalar_one()
    assert held >= 1
```

NOTE for implementer: a true two-connection interleaving test (open two sessions, disable a different admin in each, prove the second blocks then fails) is the gold standard but flaky/slow under testcontainers. The lock-held assertion above plus the application-level guarded-path tests (disable/delete/set-roles last-admin → 409) are the required coverage; add the two-connection test only if time permits.

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd mcp && poetry run pytest tests/web/test_rbac.py tests/web/test_invariants.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.rbac'`.

- [ ] **Step 5: Implement rbac.py**

Create `mcp/prd_mcp/web/rbac.py`:

```python
"""The ONLY source of permission names and the authorization guards.

- PERMISSIONS: the fixed code-defined vocabulary.
- assert_pair_integrity: no role/user may hold exactly one of the admin pair.
- assert_admin_invariant: >=1 active user with BOTH admin-pair perms must remain.
- current_user / require_permission: per-request session + permission resolution.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, Request
from sqlalchemy import func, select

from sqlalchemy import text

from prd_mcp.web.db import get_db
from prd_mcp.web.errors import forbidden, last_admin_error, pair_error, unauthorized
from prd_mcp.web.models import (
    Permission,
    Role,
    User,
    role_permissions,
    user_roles,
)
from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.settings import WebSettings

# Arbitrary fixed key for the transaction-scoped advisory lock that serializes
# the last-admin check-then-mutate across concurrent requests.
_ADMIN_INVARIANT_LOCK_KEY = 4827310199

PERMISSIONS: dict[str, str] = {
    "prd.read": "Read PRDs (Library + Search).",
    "prd.ask": "Ask tab (LLM-grounded answers).",
    "status.view": "Status tab (run health + coverage).",
    "users.manage": "View/approve/disable/delete users and assign their roles.",
    "roles.manage": "Create/edit/delete roles, set role permissions, change settings.",
}
ALL_PERMISSION_NAMES = frozenset(PERMISSIONS)
MEMBER_PERMISSION_NAMES = frozenset({"prd.read", "prd.ask"})
ADMIN_PAIR = frozenset({"users.manage", "roles.manage"})


def effective_permissions(user: User) -> set[str]:
    out: set[str] = set()
    for role in user.roles:
        for perm in role.permissions:
            out.add(perm.name)
    return out


def assert_pair_integrity(perm_names: set[str]) -> None:
    """Reject any permission set holding exactly one of the admin pair."""
    if len(set(perm_names) & ADMIN_PAIR) == 1:
        raise pair_error()


async def assert_admin_invariant(db) -> None:
    """>=1 active user whose EFFECTIVE permissions include BOTH admin-pair perms.

    SQL over the join tables so it sees flushed-but-uncommitted state in the
    current transaction. Counts users who, across all their roles, hold both.

    Concurrency: without serialization this is a TOCTOU — two requests each
    disabling a different admin can both observe the other still active and both
    commit, leaving zero admins. A transaction-scoped Postgres advisory lock
    serializes the check-then-mutate: the second request blocks until the first
    commits, then re-evaluates against the post-commit state. The lock auto-
    releases at txn end (commit OR rollback), so a rejected op holds nothing.
    Callers MUST run this AFTER their flush and BEFORE their commit.
    """
    await db.execute(text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=_ADMIN_INVARIANT_LOCK_KEY))
    pair = list(ADMIN_PAIR)
    stmt = (
        select(func.count())
        .select_from(
            select(User.id)
            .join(user_roles, user_roles.c.user_id == User.id)
            .join(role_permissions, role_permissions.c.role_id == user_roles.c.role_id)
            .join(Permission, Permission.id == role_permissions.c.permission_id)
            .where(User.status == "active", Permission.name.in_(pair))
            .group_by(User.id)
            .having(func.count(func.distinct(Permission.name)) == len(pair))
            .subquery()
        )
    )
    count = (await db.execute(stmt)).scalar_one()
    if count < 1:
        raise last_admin_error()


async def _load_active_user_by_session(request: Request, db, settings: WebSettings) -> tuple[User, str] | None:
    token = request.cookies.get(settings.cookie_name)
    if not token:
        return None
    now = datetime.now(timezone.utc)
    session_row = await sessions_mod.resolve_session(db, token, settings, now=now)
    if session_row is None:
        return None
    user = (await db.execute(select(User).where(User.id == session_row.user_id))).scalar_one_or_none()
    if user is None or user.status != "active":
        return None
    return user, session_row.token_hash


def get_settings(request: Request) -> WebSettings:
    return request.app.state.settings


async def current_user(
    request: Request,
    db=Depends(get_db),
    settings: WebSettings = Depends(get_settings),
) -> User:
    loaded = await _load_active_user_by_session(request, db, settings)
    if loaded is None:
        raise unauthorized()
    user, token_hash = loaded
    # resolve_session slid idle_expires_at (and maybe last_seen_at) but only
    # flushed. get_db does NOT commit on success, and read-only handlers (e.g.
    # /me) never commit, so without this the slide rolls back and the idle window
    # never actually moves in production (spec §4 requires it to slide on
    # activity). Commit the slide here; mutating handlers commit again later,
    # which is a harmless no-op on an already-committed slide.
    await db.commit()
    request.state.session_token_hash = token_hash
    request.state.current_user = user
    return user


def require_permission(name: str):
    async def _dep(user: User = Depends(current_user)) -> User:
        if name not in effective_permissions(user):
            raise forbidden()
        return user

    return _dep
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd mcp && poetry run pytest tests/web/test_rbac.py tests/web/test_invariants.py -v`
Expected: rbac 5 + invariants 4 passed.

- [ ] **Step 7: Commit**

```bash
cd mcp && git add prd_mcp/web/errors.py prd_mcp/web/rbac.py tests/web/test_rbac.py tests/web/test_invariants.py
git commit -m "feat(web): RBAC vocabulary, per-request resolution, pair-integrity + last-admin invariants"
```

---

### Task 6: `schemas.py` (Pydantic shapes + password validation) + `ratelimit.py`

**Files:**
- Create: `mcp/prd_mcp/web/schemas.py`
- Create: `mcp/prd_mcp/web/ratelimit.py`
- Test: `mcp/tests/web/test_schemas.py`
- Test: `mcp/tests/web/test_ratelimit.py`

**Interfaces:**
- Produces in `schemas.py`:
  - `RoleBrief{id:UUID, name:str}`, `UserOut{id:UUID, email:str, status:str, roles:list[RoleBrief], permissions:list[str], created_at:datetime}`, `RoleOut{id:UUID, name:str, description:str, is_system:bool, permissions:list[str]}`, `PermissionOut{name:str, description:str}`.
  - `RegisterIn{email:EmailStr, password:str}`, `LoginIn{email:EmailStr, password:str}`, `ChangePasswordIn{current_password:str, new_password:str}`, `SetPasswordIn{password:str}`, `ApproveIn{role_ids:list[UUID]}`, `SetRolesIn{role_ids:list[UUID]}`, `RoleCreateIn{name:str, description:str='', permission_ids:list[UUID]}`, `RoleUpdateIn{name:str|None, description:str|None, permission_ids:list[UUID]|None}`, `SettingsIn{registration_enabled:bool, allowed_domains:list[str]}`, `SettingsOut{registration_enabled:bool, allowed_domains:list[str]}`, `AcceptedOut{status:str='accepted'}`.
  - A reusable password constraint: a factory `password_field(settings)` is NOT used (settings not available at class-def time); instead each password field is plain `str` and length is validated in the endpoint via `validate_password(pw, settings)` raising `AppError(422,'weak_password',...)`. Provide `validate_password(pw:str, settings:WebSettings)->None`.
- Produces in `ratelimit.py`:
  - `class RateLimiter` (in-process): `__init__(per_min:int)`; `check_ip(ip:str, *, now:float)->bool` (token bucket, returns False when exhausted); `record_email_failure(email:str, *, now:float)->None` + `email_delay(email:str, *, now:float)->float` (increasing backoff after N consecutive failures); `reset_email(email:str)->None` (on success). Takes `now` (monotonic float) for deterministic tests.

- [ ] **Step 1: Write schemas.py**

Create `mcp/prd_mcp/web/schemas.py`:

```python
"""Pydantic request/response shapes. Password LENGTH is enforced in endpoints via
validate_password (needs runtime settings); format/email validated here."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr

from prd_mcp.web.errors import AppError
from prd_mcp.web.settings import WebSettings


def validate_password(pw: str, settings: WebSettings) -> None:
    if not (settings.password_min_length <= len(pw) <= 128):
        raise AppError(422, "weak_password", f"password must be {settings.password_min_length}-128 characters")


class RoleBrief(BaseModel):
    id: uuid.UUID
    name: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    status: str
    roles: list[RoleBrief]
    permissions: list[str]
    created_at: datetime


class RoleOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    is_system: bool
    permissions: list[str]


class PermissionOut(BaseModel):
    name: str
    description: str


class RegisterIn(BaseModel):
    email: EmailStr
    password: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class SetPasswordIn(BaseModel):
    password: str


class ApproveIn(BaseModel):
    role_ids: list[uuid.UUID]


class SetRolesIn(BaseModel):
    role_ids: list[uuid.UUID]


class RoleCreateIn(BaseModel):
    name: str
    description: str = ""
    permission_ids: list[uuid.UUID]


class RoleUpdateIn(BaseModel):
    name: str | None = None
    description: str | None = None
    permission_ids: list[uuid.UUID] | None = None


class SettingsIn(BaseModel):
    registration_enabled: bool
    allowed_domains: list[str]


class SettingsOut(BaseModel):
    registration_enabled: bool
    allowed_domains: list[str]


class AcceptedOut(BaseModel):
    status: str = "accepted"
```

- [ ] **Step 2: Write the failing schemas test**

Create `mcp/tests/web/test_schemas.py`:

```python
import pytest

from prd_mcp.web.schemas import RegisterIn, validate_password
from prd_mcp.web.errors import AppError


def test_register_requires_valid_email():
    with pytest.raises(Exception):
        RegisterIn(email="not-an-email", password="x" * 12)


def test_validate_password_min_length(settings):
    with pytest.raises(AppError) as e:
        validate_password("short", settings)
    assert e.value.code == "weak_password"


def test_validate_password_max_length(settings):
    with pytest.raises(AppError):
        validate_password("x" * 129, settings)


def test_validate_password_ok(settings):
    validate_password("x" * 12, settings)  # no raise
```

- [ ] **Step 3: Write the failing ratelimit test**

Create `mcp/tests/web/test_ratelimit.py`:

```python
from prd_mcp.web.ratelimit import RateLimiter


def test_ip_bucket_allows_then_blocks():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        assert rl.check_ip("1.2.3.4", now=t) is True
    assert rl.check_ip("1.2.3.4", now=t) is False  # 6th within the minute


def test_ip_bucket_refills_over_time():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        rl.check_ip("1.2.3.4", now=t)
    assert rl.check_ip("1.2.3.4", now=t) is False
    assert rl.check_ip("1.2.3.4", now=t + 61) is True  # a minute later, refilled


def test_distinct_ips_have_independent_buckets():
    rl = RateLimiter(per_min=1)
    t = 1000.0
    assert rl.check_ip("1.1.1.1", now=t) is True
    assert rl.check_ip("2.2.2.2", now=t) is True  # different IP not throttled


def test_email_delay_increases_with_failures():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    assert rl.email_delay("a@x.com", now=t) == 0
    for _ in range(4):
        rl.record_email_failure("a@x.com", now=t)
    assert rl.email_delay("a@x.com", now=t) > 0


def test_email_reset_clears_delay():
    rl = RateLimiter(per_min=5)
    t = 1000.0
    for _ in range(5):
        rl.record_email_failure("a@x.com", now=t)
    rl.reset_email("a@x.com")
    assert rl.email_delay("a@x.com", now=t) == 0
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd mcp && poetry run pytest tests/web/test_schemas.py tests/web/test_ratelimit.py -v`
Expected: FAIL (`ModuleNotFoundError` for ratelimit; schemas import ok but module exists — ensure failure is on ratelimit import + the schemas tests pass once schemas.py is written).

- [ ] **Step 5: Implement ratelimit.py**

Create `mcp/prd_mcp/web/ratelimit.py`:

```python
"""In-process rate limiting (single uvicorn worker). Per-IP token bucket +
per-email increasing-backoff counter. State is in memory and resets on restart —
accepted on a single-owner box. All methods take an explicit monotonic `now`."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


@dataclass
class _EmailState:
    failures: int = 0
    last_failure: float = 0.0


class RateLimiter:
    def __init__(self, per_min: int):
        self.per_min = max(1, per_min)
        self.refill_rate = self.per_min / 60.0  # tokens per second
        self._ip: dict[str, _Bucket] = {}
        self._email: dict[str, _EmailState] = {}

    def check_ip(self, ip: str, *, now: float) -> bool:
        b = self._ip.get(ip)
        if b is None:
            b = _Bucket(tokens=float(self.per_min), last_refill=now)
            self._ip[ip] = b
        # refill
        elapsed = max(0.0, now - b.last_refill)
        b.tokens = min(float(self.per_min), b.tokens + elapsed * self.refill_rate)
        b.last_refill = now
        if b.tokens >= 1.0:
            b.tokens -= 1.0
            return True
        return False

    def record_email_failure(self, email: str, *, now: float) -> None:
        st = self._email.setdefault(email.lower(), _EmailState())
        st.failures += 1
        st.last_failure = now

    def email_delay(self, email: str, *, now: float) -> float:
        st = self._email.get(email.lower())
        if st is None or st.failures < 3:
            return 0.0
        # exponential-ish backoff capped at 30s, starting after 3 consecutive failures
        return float(min(30, 2 ** (st.failures - 2)))

    def reset_email(self, email: str) -> None:
        self._email.pop(email.lower(), None)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd mcp && poetry run pytest tests/web/test_schemas.py tests/web/test_ratelimit.py -v`
Expected: schemas 4 + ratelimit 5 passed.

- [ ] **Step 7: Commit**

```bash
cd mcp && git add prd_mcp/web/schemas.py prd_mcp/web/ratelimit.py tests/web/test_schemas.py tests/web/test_ratelimit.py
git commit -m "feat(web): pydantic schemas + password validation + in-process rate limiter"
```

---

### Task 7: `seed.py` — permissions, system roles, break-glass admin, startup integrity guard

**Files:**
- Create: `mcp/prd_mcp/web/seed.py`
- Test: `mcp/tests/web/test_seed.py`

**Interfaces:**
- Consumes: `models`, `rbac.PERMISSIONS/ALL_PERMISSION_NAMES/MEMBER_PERMISSION_NAMES/ADMIN_PAIR`, `security.make_password_hasher`, `WebSettings`.
- Produces (all async):
  - `seed_permissions(db) -> None` — upsert the 5 permission rows (idempotent by name).
  - `seed_system_roles(db) -> None` — ensure `admin`(all 5) + `member`(prd.read,prd.ask) exist, `is_system=True`, and RE-ASSERT their permission sets every boot (closes drift).
  - `seed_bootstrap_admin(db, settings) -> None` — break-glass predicate: if NO active user has BOTH admin-pair perms, create-or-reactivate `ADMIN_EMAIL` (status active, role admin, argon2(ADMIN_PASSWORD)). Never resets a healthy admin's password.
  - `seed_app_settings(db, settings) -> None` — create the single `app_settings` row (id=1) from `settings.registration_enabled` + `settings.allowed_domains_seed` ONLY if the row does not yet exist. If it exists, do nothing (DB is authoritative after first boot — a redeploy with different env must NOT clobber an admin's runtime change). Idempotent.
  - `assert_global_pair_integrity(db) -> None` — scan every role's perm set AND every active user's effective union; if any holds exactly one of ADMIN_PAIR, raise `RuntimeError` naming the offender (fails startup loud).
  - `run_seed(db, settings) -> None` — orchestrates: permissions → system roles → app_settings → bootstrap admin → assert_global_pair_integrity; commits once.

- [ ] **Step 1: Write the failing seed test**

Create `mcp/tests/web/test_seed.py`:

```python
import pytest
from sqlalchemy import select

from prd_mcp.web import rbac, seed
from prd_mcp.web.models import User, Role, Permission
from prd_mcp.web.security import make_password_hasher


async def test_seed_is_idempotent_and_creates_admin(db, settings):
    await seed.run_seed(db, settings)
    await seed.run_seed(db, settings)  # second run must not duplicate
    perms = (await db.execute(select(Permission))).scalars().all()
    assert {p.name for p in perms} == set(rbac.PERMISSIONS)
    roles = {r.name: r for r in (await db.execute(select(Role))).scalars().all()}
    assert roles["admin"].is_system and roles["member"].is_system
    assert {p.name for p in roles["admin"].permissions} == set(rbac.PERMISSIONS)
    assert {p.name for p in roles["member"].permissions} == {"prd.read", "prd.ask"}
    admins = (await db.execute(select(User).where(User.email == settings.admin_email))).scalars().all()
    assert len(admins) == 1 and admins[0].status == "active"


async def test_break_glass_reactivates_when_no_active_admin(db, settings):
    await seed.run_seed(db, settings)
    admin = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
    admin.status = "disabled"
    await db.commit()
    await seed.run_seed(db, settings)  # break-glass: no active admin -> reactivate
    await db.refresh(admin)
    assert admin.status == "active"


async def test_healthy_admin_password_not_reset(db, settings):
    await seed.run_seed(db, settings)
    admin = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
    original_hash = admin.password_hash
    await seed.run_seed(db, settings)  # healthy -> untouched
    await db.refresh(admin)
    assert admin.password_hash == original_hash


async def test_global_pair_integrity_fails_on_half_admin(db, settings):
    await seed.run_seed(db, settings)
    # inject a custom role holding ONLY roles.manage and assign to an active user
    rm = (await db.execute(select(Permission).where(Permission.name == "roles.manage"))).scalar_one()
    bad = Role(name="half_admin")
    bad.permissions.append(rm)
    u = User(email="half@ringkas.co.id", password_hash="x", status="active")
    u.roles.append(bad)
    db.add(bad)
    db.add(u)
    await db.commit()
    with pytest.raises(RuntimeError) as e:
        await seed.assert_global_pair_integrity(db)
    assert "half" in str(e.value).lower() or "roles.manage" in str(e.value)


async def test_app_settings_seeded_from_env_on_first_boot(db, settings):
    from prd_mcp.web.models import AppSettings
    from sqlalchemy import select

    enabled_env = settings.model_copy(update={"registration_enabled": True, "allowed_email_domains": "ringkas.co.id"})
    await seed.run_seed(db, enabled_env)
    row = (await db.execute(select(AppSettings))).scalar_one()
    assert row.registration_enabled is True
    assert row.allowed_domains == ["ringkas.co.id"]


async def test_app_settings_not_clobbered_on_redeploy(db, settings):
    """A second boot with DIFFERENT env must NOT overwrite the existing DB row."""
    from prd_mcp.web.models import AppSettings
    from sqlalchemy import select

    first = settings.model_copy(update={"registration_enabled": True, "allowed_email_domains": "ringkas.co.id"})
    await seed.run_seed(db, first)
    # admin later turns registration OFF at runtime
    row = (await db.execute(select(AppSettings))).scalar_one()
    row.registration_enabled = False
    await db.commit()
    # redeploy with env still saying ON -> must stay OFF (DB authoritative)
    await seed.run_seed(db, first)
    row = (await db.execute(select(AppSettings))).scalar_one()
    assert row.registration_enabled is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/web/test_seed.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.seed'`.

- [ ] **Step 3: Implement seed.py**

Create `mcp/prd_mcp/web/seed.py`:

```python
"""Idempotent boot seeding + the startup integrity guard.

Order on every boot: permissions -> system roles (re-asserted) -> app_settings
(first-boot only) -> break-glass admin (only when no active admin-equivalent) ->
assert_global_pair_integrity.
"""
from __future__ import annotations

from sqlalchemy import select

from prd_mcp.web import rbac
from prd_mcp.web.models import AppSettings, Permission, Role, User
from prd_mcp.web.security import make_password_hasher
from prd_mcp.web.settings import WebSettings


async def seed_permissions(db) -> None:
    existing = {p.name: p for p in (await db.execute(select(Permission))).scalars().all()}
    for name, desc in rbac.PERMISSIONS.items():
        p = existing.get(name)
        if p is None:
            db.add(Permission(name=name, description=desc))
        elif p.description != desc:
            p.description = desc
    await db.flush()


async def _perms_by_name(db) -> dict[str, Permission]:
    return {p.name: p for p in (await db.execute(select(Permission))).scalars().all()}


async def seed_system_roles(db) -> None:
    perms = await _perms_by_name(db)
    wanted = {
        "admin": set(rbac.ALL_PERMISSION_NAMES),
        "member": set(rbac.MEMBER_PERMISSION_NAMES),
    }
    roles = {r.name: r for r in (await db.execute(select(Role))).scalars().all()}
    for name, perm_names in wanted.items():
        role = roles.get(name)
        if role is None:
            role = Role(name=name, is_system=True)
            db.add(role)
        role.is_system = True
        # re-assert the exact permission set every boot (drift defense)
        role.permissions[:] = [perms[pn] for pn in perm_names]
    await db.flush()


async def _active_admin_equivalents(db) -> list[User]:
    users = (await db.execute(select(User).where(User.status == "active"))).scalars().all()
    return [u for u in users if rbac.ADMIN_PAIR <= rbac.effective_permissions(u)]


async def seed_bootstrap_admin(db, settings: WebSettings) -> None:
    if await _active_admin_equivalents(db):
        return  # healthy instance — never touch existing admins
    hasher = make_password_hasher(settings)
    admin_role = (await db.execute(select(Role).where(Role.name == "admin"))).scalar_one()
    user = (await db.execute(select(User).where(User.email == settings.admin_email))).scalar_one_or_none()
    if user is None:
        user = User(
            email=settings.admin_email,
            password_hash=hasher.hash(settings.admin_password),
            status="active",
        )
        user.roles.append(admin_role)
        db.add(user)
    else:
        # Break-glass recovery: we only reach this branch when NO active admin
        # exists, so restore a KNOWN-GOOD credential from .env — reactivate AND
        # reset the password to argon2(ADMIN_PASSWORD) (spec §4). The "never reset
        # a healthy admin" guarantee is upheld by the early return above: a healthy
        # instance never enters seed_bootstrap_admin's mutation path at all.
        user.status = "active"
        user.password_hash = hasher.hash(settings.admin_password)
        if admin_role not in user.roles:
            user.roles.append(admin_role)
    await db.flush()


async def seed_app_settings(db, settings: WebSettings) -> None:
    """Create the singleton app_settings row from env on FIRST boot only.

    If the row already exists, leave it untouched — the DB is authoritative after
    first boot, so an admin's runtime toggle is never reverted by a redeploy.
    """
    existing = (await db.execute(select(AppSettings))).scalar_one_or_none()
    if existing is not None:
        return
    db.add(
        AppSettings(
            id=1,
            registration_enabled=settings.registration_enabled,
            allowed_domains=settings.allowed_domains_seed,
        )
    )
    await db.flush()


async def assert_global_pair_integrity(db) -> None:
    # every role's own permission set
    roles = (await db.execute(select(Role))).scalars().all()
    for role in roles:
        names = {p.name for p in role.permissions}
        if len(names & rbac.ADMIN_PAIR) == 1:
            raise RuntimeError(f"half-admin role detected: {role.name} holds exactly one of {set(rbac.ADMIN_PAIR)}")
    # every active user's effective union
    users = (await db.execute(select(User).where(User.status == "active"))).scalars().all()
    for u in users:
        eff = rbac.effective_permissions(u)
        if len(eff & rbac.ADMIN_PAIR) == 1:
            raise RuntimeError(f"half-admin user detected: {u.email} effectively holds exactly one of {set(rbac.ADMIN_PAIR)}")


async def run_seed(db, settings: WebSettings) -> None:
    await seed_permissions(db)
    await seed_system_roles(db)
    await seed_app_settings(db, settings)
    await seed_bootstrap_admin(db, settings)
    await assert_global_pair_integrity(db)
    await db.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/web/test_seed.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd mcp && git add prd_mcp/web/seed.py tests/web/test_seed.py
git commit -m "feat(web): idempotent seeding, break-glass admin, startup integrity guard"
```

---

### Task 8: `auth.py` endpoints + first `create_app()` + test client

**Files:**
- Create: `mcp/prd_mcp/web/auth.py`
- Create: `mcp/prd_mcp/web/app.py`
- Modify: `mcp/tests/web/conftest.py` (add `app` + `client` fixtures)
- Test: `mcp/tests/web/test_auth_endpoints.py`

**Interfaces:**
- Consumes: `schemas`, `security`, `sessions`, `rbac`, `seed`, `ratelimit`, `errors`, `models`, `settings`.
- Produces `auth.py`: `router = APIRouter(prefix="/api/auth")` with `register`, `login`, `logout`, `me`, `change-password`. Helpers: `user_to_out(user) -> UserOut` (computes permissions via `rbac.effective_permissions`); `domain_allowed(email, allowed:list[str]) -> bool` (IDNA-normalized exact match on the part after the last `@`).
- Produces `app.py`: `create_app(settings, sessionmaker, *, run_startup=True) -> FastAPI` mounting the auth router, an `AppError` exception handler (envelope), and storing `settings`+`ratelimiter` on `app.state`. (Admin router, CSRF, rate-limit, CORS, proxy headers, healthz, purge task are added in Tasks 9–10.)
- Produces conftest additions: `app` fixture (calls `create_app(settings, sessionmaker_, run_startup=False)` then runs `seed.run_seed`); `client` fixture (httpx `AsyncClient` over `ASGITransport`, default header `X-Requested-With: prd-app`).

- [ ] **Step 1: Add app + client fixtures to conftest**

Append to `mcp/tests/web/conftest.py`:

```python
import httpx
import pytest_asyncio
from prd_mcp.web.app import create_app
from prd_mcp.web import db as db_mod, seed as seed_mod


@pytest_asyncio.fixture
async def app(settings, sessionmaker_):
    db_mod.set_sessionmaker(sessionmaker_)
    application = create_app(settings, sessionmaker_, run_startup=False)
    async with sessionmaker_() as s:
        await seed_mod.run_seed(s, settings)
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}
    ) as c:
        yield c
```

- [ ] **Step 2: Write the failing auth-endpoints test**

Create `mcp/tests/web/test_auth_endpoints.py`:

```python
import pytest
from sqlalchemy import select, update

from prd_mcp.web.auth import domain_allowed
from prd_mcp.web.models import AppSettings, User


async def _enable_registration(sessionmaker_, domains):
    async with sessionmaker_() as s:
        row = (await s.execute(select(AppSettings))).scalar_one_or_none()
        if row is None:
            s.add(AppSettings(id=1, registration_enabled=True, allowed_domains=domains))
        else:
            await s.execute(update(AppSettings).values(registration_enabled=True, allowed_domains=domains))
        await s.commit()


def test_domain_allowed_exact_match_no_suffix():
    allowed = ["ringkas.co.id"]
    assert domain_allowed("duy@ringkas.co.id", allowed) is True
    assert domain_allowed("duy@RINGKAS.co.id", allowed) is True       # case-insensitive
    assert domain_allowed("attacker@evilringkas.co.id", allowed) is False  # NOT a suffix match
    assert domain_allowed("attacker@ringkas.co.id.evil.com", allowed) is False
    assert domain_allowed("nodomain", allowed) is False


async def test_register_always_returns_202_accepted(client, sessionmaker_):
    await _enable_registration(sessionmaker_, ["ringkas.co.id"])
    r = await client.post("/api/auth/register", json={"email": "new@ringkas.co.id", "password": "x" * 12})
    assert r.status_code == 202
    assert r.json() == {"status": "accepted"}


async def test_register_bad_domain_also_202_no_account(client, sessionmaker_):
    await _enable_registration(sessionmaker_, ["ringkas.co.id"])
    r = await client.post("/api/auth/register", json={"email": "x@evil.com", "password": "x" * 12})
    assert r.status_code == 202 and r.json() == {"status": "accepted"}
    async with sessionmaker_() as s:
        assert (await s.execute(select(User).where(User.email == "x@evil.com"))).scalar_one_or_none() is None


async def test_register_disabled_also_202_no_account(client, sessionmaker_):
    # default settings row from seed has registration disabled
    r = await client.post("/api/auth/register", json={"email": "y@ringkas.co.id", "password": "x" * 12})
    assert r.status_code == 202 and r.json() == {"status": "accepted"}
    async with sessionmaker_() as s:
        assert (await s.execute(select(User).where(User.email == "y@ringkas.co.id"))).scalar_one_or_none() is None


async def test_login_success_sets_cookie(client, settings):
    r = await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    assert r.status_code == 200
    assert settings.cookie_name in r.cookies
    assert r.json()["user"]["email"].lower() == settings.admin_email.lower()


async def test_login_wrong_password_generic_401(client, settings):
    r = await client.post("/api/auth/login", json={"email": settings.admin_email, "password": "wrong-password-xx"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_credentials"


async def test_login_unknown_user_same_401(client):
    r = await client.post("/api/auth/login", json={"email": "ghost@ringkas.co.id", "password": "whatever-xxxx"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_credentials"


async def test_me_requires_session(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401


async def test_me_persists_idle_slide(client, settings, sessionmaker_):
    """The idle window must actually slide+COMMIT on a read request (regression
    guard: current_user must commit the slide; get_db does not commit on success)."""
    from sqlalchemy import select
    from prd_mcp.web.models import Session as SessionRow

    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    async with sessionmaker_() as s:
        row = (await s.execute(select(SessionRow))).scalars().first()
        before = row.idle_expires_at
    # a read request resolves the session, sliding idle_expires_at to ~now+idle
    assert (await client.get("/api/auth/me")).status_code == 200
    async with sessionmaker_() as s:
        row = (await s.execute(select(SessionRow))).scalars().first()
        after = row.idle_expires_at
    # The slide must be PERSISTED (committed), not rolled back at request end.
    # Strict `>`: real wall-clock elapses between login and /me, so a committed
    # slide is strictly greater; if current_user's commit were removed the slide
    # rolls back and after == before — which a `>=` assertion would wrongly pass.
    assert after > before


async def test_register_is_rate_limited_with_retry_after(client):
    """register is brute-forceable -> per-IP throttled (default 5/min) + Retry-After."""
    last = None
    for _ in range(7):
        last = await client.post("/api/auth/register", json={"email": "rl@ringkas.co.id", "password": "x" * 12})
        if last.status_code == 429:
            break
    assert last.status_code == 429
    assert last.json()["error"]["code"] == "rate_limited"
    assert "retry-after" in {k.lower() for k in last.headers}


async def test_validation_error_uses_envelope(client):
    """A malformed body returns the shared {error:{code,message}} envelope, not
    FastAPI's default {detail:[...]} (spec §5)."""
    r = await client.post("/api/auth/login", json={"email": "not-an-email", "password": "x"})
    assert r.status_code == 422
    body = r.json()
    assert "error" in body and "code" in body["error"]
    assert "detail" not in body


async def test_change_password_is_rate_limited(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    codes = []
    for _ in range(7):
        r = await client.post("/api/auth/change-password", json={
            "current_password": "wrong-pw-xxxxx", "new_password": "new-" + "x" * 12})
        codes.append(r.status_code)
    assert 429 in codes


async def test_login_then_me_then_logout(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert "roles.manage" in me.json()["permissions"]
    out = await client.post("/api/auth/logout")
    assert out.status_code == 204
    # logout MUST emit a Set-Cookie that clears the session cookie (the 204 it
    # returns carries the deletion; a regression here silently leaves it set).
    assert "set-cookie" in {k.lower() for k in out.headers}
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_change_password_revokes_other_sessions(settings, app):
    import httpx
    transport = httpx.ASGITransport(app=app)
    headers = {"X-Requested-With": "prd-app"}
    # session A
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=headers) as a:
        await a.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
        # session B (separate cookie jar)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=headers) as b:
            await b.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
            # A changes password -> B's session revoked, A still valid
            r = await a.post("/api/auth/change-password", json={
                "current_password": settings.admin_password, "new_password": "new-" + "x" * 12})
            assert r.status_code == 204
            assert (await a.get("/api/auth/me")).status_code == 200
            assert (await b.get("/api/auth/me")).status_code == 401
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/web/test_auth_endpoints.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.app'`.

- [ ] **Step 4: Implement app.py (first incarnation)**

Create `mcp/prd_mcp/web/app.py`:

```python
"""FastAPI app factory. Task 8 mounts auth + the error envelope; Tasks 9-10 add
the admin router, CSRF/rate-limit/CORS/proxy middleware, healthz, and purge task."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from prd_mcp.web import db as db_mod
from prd_mcp.web.errors import AppError
from prd_mcp.web.ratelimit import RateLimiter
from prd_mcp.web.security import make_password_hasher
from prd_mcp.web.settings import WebSettings


def create_app(settings: WebSettings, sessionmaker, *, run_startup: bool = True) -> FastAPI:
    app = FastAPI(title="PRD Auth")
    app.state.settings = settings
    app.state.ratelimiter = RateLimiter(settings.rate_limit_per_min)
    # Build the argon2 hasher ONCE (it precomputes a dummy hash); rebuilding it
    # per-request would run a second argon2 op on every login/register.
    app.state.password_hasher = make_password_hasher(settings)
    db_mod.set_sessionmaker(sessionmaker)

    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError):
        resp = JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})
        if exc.status_code == 401:
            resp.delete_cookie(key=settings.cookie_name, path="/")
        return resp

    from prd_mcp.web.auth import router as auth_router

    app.include_router(auth_router)

    if run_startup:
        @app.on_event("startup")
        async def _startup():  # pragma: no cover - exercised in deployment
            from prd_mcp.web import seed as seed_mod

            async with sessionmaker() as s:
                await seed_mod.run_seed(s, settings)

    return app
```

- [ ] **Step 5: Implement auth.py**

Create `mcp/prd_mcp/web/auth.py`:

```python
"""Auth router: register, login, logout, me, change-password.

Enumeration resistance: register always returns 202 {status:'accepted'} with a
dummy argon2 on reject paths; login always argon2-verifies before any status
check and returns one generic 401.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import idna
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.db import get_db
from prd_mcp.web.errors import invalid_credentials, unauthorized
from prd_mcp.web.models import AppSettings, User
from prd_mcp.web.rbac import current_user, effective_permissions
from prd_mcp.web.schemas import (
    AcceptedOut,
    ChangePasswordIn,
    LoginIn,
    RegisterIn,
    RoleBrief,
    UserOut,
    validate_password,
)
from prd_mcp.web.security import (
    PasswordHasher,
    clear_session_cookie,
    set_session_cookie,
)
from prd_mcp.web.settings import WebSettings

router = APIRouter(prefix="/api/auth")


def _settings(request: Request) -> WebSettings:
    return request.app.state.settings


def _hasher(request: Request) -> PasswordHasher:
    # The single app-wide hasher built in create_app (avoids a per-request dummy hash).
    return request.app.state.password_hasher


def user_to_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=str(user.email),
        status=user.status,
        roles=[RoleBrief(id=r.id, name=r.name) for r in user.roles],
        permissions=sorted(effective_permissions(user)),
        created_at=user.created_at,
    )


def _normalize_domain(domain: str) -> str:
    d = domain.strip().lower().rstrip(".")
    try:
        return idna.encode(d).decode("ascii")
    except idna.IDNAError:
        return d


def domain_allowed(email: str, allowed: list[str]) -> bool:
    if "@" not in email:
        return False
    domain = _normalize_domain(email.rsplit("@", 1)[1])
    allowset = {_normalize_domain(a) for a in allowed}
    return domain in allowset


async def _load_settings_row(db) -> AppSettings | None:
    return (await db.execute(select(AppSettings))).scalar_one_or_none()


def _enforce_ip_rate_limit(request: Request) -> None:
    """Per-client-IP token bucket on every brute-forceable endpoint (login,
    register, change-password). 429 + Retry-After when exhausted."""
    from prd_mcp.web.errors import AppError

    rl = request.app.state.ratelimiter
    ip = request.client.host if request.client else "unknown"
    if not rl.check_ip(ip, now=time.monotonic()):
        raise AppError(429, "rate_limited", "too many attempts")


@router.post("/register", status_code=202, response_model=AcceptedOut)
async def register(payload: RegisterIn, request: Request, db=Depends(get_db)) -> AcceptedOut:
    settings = _settings(request)
    hasher = _hasher(request)
    _enforce_ip_rate_limit(request)
    # Equivalent work on every branch: always compute an argon2 hash AND always
    # run the email-existence query, so neither timing nor body reveals which (or
    # whether any) account was created — incl. the registration-disabled and
    # bad-domain branches (otherwise those skip the query and respond faster).
    computed_hash = hasher.hash(payload.password)
    row = await _load_settings_row(db)
    enabled = bool(row and row.registration_enabled)
    allowed = list(row.allowed_domains) if row else []
    try:
        validate_password(payload.password, settings)
        ok_pw = True
    except Exception:
        ok_pw = False
    existing = (await db.execute(select(User).where(User.email == str(payload.email)))).scalar_one_or_none()
    if enabled and ok_pw and existing is None and domain_allowed(str(payload.email), allowed):
        db.add(User(email=str(payload.email), password_hash=computed_hash, status="pending"))
        try:
            await db.commit()
        except IntegrityError:
            # lost a unique-email race; still indistinguishable to the caller
            await db.rollback()
    # ALL paths return the identical response.
    return AcceptedOut()


@router.post("/login")
async def login(payload: LoginIn, request: Request, response: Response, db=Depends(get_db)):
    settings = _settings(request)
    hasher = _hasher(request)
    rl = request.app.state.ratelimiter
    _enforce_ip_rate_limit(request)
    # per-email backoff delay (defense against single-account targeting).
    # MUST be asyncio.sleep, not time.sleep — a blocking sleep in an async handler
    # stalls the whole single-worker event loop (every other request, incl /healthz).
    delay = rl.email_delay(str(payload.email), now=time.monotonic())
    if delay:
        await asyncio.sleep(min(delay, 1.0))  # capped in-request; full backoff tracked across calls

    user = (await db.execute(select(User).where(User.email == str(payload.email)))).scalar_one_or_none()
    # ALWAYS verify (real hash or dummy) BEFORE any status check.
    real_hash = user.password_hash if user else hasher.dummy_hash
    verified = hasher.verify(real_hash, payload.password)
    if not user or not verified or user.status != "active":
        rl.record_email_failure(str(payload.email), now=time.monotonic())
        raise invalid_credentials()
    rl.reset_email(str(payload.email))
    now = datetime.now(timezone.utc)
    token, _ = await sessions_mod.create_session(db, user.id, settings, now=now)  # fresh token, ignores any cookie
    await db.commit()
    await db.refresh(user)
    set_session_cookie(response, settings, token, max_age=settings.session_idle_hours * 3600)
    return {"user": user_to_out(user).model_dump(mode="json")}


@router.post("/logout", status_code=204)
async def logout(request: Request, db=Depends(get_db)):
    settings = _settings(request)
    token = request.cookies.get(settings.cookie_name)
    if token:
        await sessions_mod.revoke_session(db, token)
        await db.commit()
    # Build the 204 FIRST, then clear the cookie ON IT — clearing a separate
    # `response` object and returning a fresh one would drop the Set-Cookie.
    resp = Response(status_code=204)
    clear_session_cookie(resp, settings)
    return resp


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> UserOut:
    return user_to_out(user)


@router.post("/change-password", status_code=204)
async def change_password(
    payload: ChangePasswordIn, request: Request, db=Depends(get_db), user: User = Depends(current_user)
):
    settings = _settings(request)
    hasher = _hasher(request)
    _enforce_ip_rate_limit(request)  # brute-force guard on current_password
    if not hasher.verify(user.password_hash, payload.current_password):
        raise invalid_credentials()
    validate_password(payload.new_password, settings)
    user.password_hash = hasher.hash(payload.new_password)
    # keep THIS session, revoke all others
    keep = getattr(request.state, "session_token_hash", None)
    await sessions_mod.revoke_user_sessions(db, user.id, except_token_hash=keep)
    await db.commit()
    return Response(status_code=204)
```

NOTE for implementer: `idna` and `pydantic[email]` are already declared in Task 1's dependency block (see the "Why" note there). No dependency edit is needed in this task — if `import idna` fails, Task 1 was applied incompletely; fix Task 1's pyproject block and `poetry lock` rather than adding it here.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/web/test_auth_endpoints.py -v`
Expected: 14 passed.

- [ ] **Step 7: Run the whole web suite (no regressions)**

Run: `cd mcp && poetry run pytest tests/web/ -v`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
cd mcp && git add prd_mcp/web/auth.py prd_mcp/web/app.py pyproject.toml poetry.lock tests/web/conftest.py tests/web/test_auth_endpoints.py
git commit -m "feat(web): auth endpoints (register/login/logout/me/change-password) + app factory"
```

---

### Task 9: `admin.py` endpoints — users, roles, settings (invariant-guarded)

**Files:**
- Create: `mcp/prd_mcp/web/admin.py`
- Modify: `mcp/prd_mcp/web/app.py` (mount admin router)
- Test: `mcp/tests/web/test_admin_users.py`
- Test: `mcp/tests/web/test_admin_roles.py`
- Test: `mcp/tests/web/test_admin_settings.py`

**Interfaces:**
- Consumes: `schemas`, `rbac` (`require_permission`, `assert_pair_integrity`, `assert_admin_invariant`, `effective_permissions`), `sessions.revoke_user_sessions`, `security`, `errors`, `models`.
- Produces `admin.py`: `router = APIRouter(prefix="/api/admin")`. Endpoints exactly per spec §5. Shared helpers: `role_to_out(role)`, `_load_user_or_404(db,id)`, `_load_roles(db, role_ids) -> list[Role]` (404 on any missing), `_effective_perm_names_for_role_ids(db, role_ids) -> set[str]` (union of the given roles' permissions — used to pre-check pair-integrity before assigning).
- Modifies `app.py`: include the admin router inside `create_app`.

- [ ] **Step 1: Write the failing admin-users test**

Create `mcp/tests/web/test_admin_users.py`:

```python
import pytest
from sqlalchemy import select

from prd_mcp.web.models import Role, User


async def _login_admin(client, settings):
    r = await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
    assert r.status_code == 200


async def _role_id(sessionmaker_, name) -> str:
    async with sessionmaker_() as s:
        role = (await s.execute(select(Role).where(Role.name == name))).scalar_one()
        return str(role.id)


async def _make_pending(sessionmaker_, email, hasher_hash="x") -> str:
    async with sessionmaker_() as s:
        u = User(email=email, password_hash=hasher_hash, status="pending")
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return str(u.id)


async def test_list_users_requires_permission(client):
    r = await client.get("/api/admin/users")
    assert r.status_code == 401  # no session


async def test_admin_can_list_users(client, settings):
    await _login_admin(client, settings)
    r = await client.get("/api/admin/users")
    assert r.status_code == 200
    assert any(u["email"].lower() == settings.admin_email.lower() for u in r.json()["users"])


async def test_approve_pending_assigns_member_role(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "pend@ringkas.co.id")
    member_id = await _role_id(sessionmaker_, "member")
    r = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert r.status_code == 200
    assert r.json()["status"] == "active"
    assert "prd.read" in r.json()["permissions"]


async def test_approve_with_half_admin_role_set_is_422(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "halfp@ringkas.co.id")
    # build a custom role with only roles.manage to attempt a half-admin assignment
    async with sessionmaker_() as s:
        from prd_mcp.web.models import Permission
        rm = (await s.execute(select(Permission).where(Permission.name == "roles.manage"))).scalar_one()
        bad = Role(name="only_roles_manage")
        bad.permissions.append(rm)
        s.add(bad)
        await s.commit()
        await s.refresh(bad)
        bad_id = str(bad.id)
    r = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [bad_id]})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "admin_pair"


async def test_approve_non_pending_user_is_409(client, settings, sessionmaker_):
    """approve is pending->active ONLY; re-approving an active user is rejected."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "twice@ringkas.co.id")
    first = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert first.status_code == 200
    again = await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "invalid_state"


async def test_approve_persists_after_commit(client, settings, sessionmaker_):
    """The approval must be committed (get_db only yields) — re-read sees active."""
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "persist@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    async with sessionmaker_() as s:
        u = (await s.execute(select(User).where(User.email == "persist@ringkas.co.id"))).scalar_one()
        assert u.status == "active"
        assert u.approved_at is not None
        assert u.approved_by is not None  # spec §4: approver recorded


async def test_reject_non_pending_user_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "rejactive@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    r = await client.post(f"/api/admin/users/{uid}/reject")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "invalid_state"


async def test_enable_pending_user_is_409(client, settings, sessionmaker_):
    """enable is disabled->active ONLY; a pending user must go through approve."""
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "enpend@ringkas.co.id")
    r = await client.post(f"/api/admin/users/{uid}/enable")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "invalid_state"


async def test_disable_then_enable_round_trips(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    # second admin so we can disable a non-last-admin member
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "rt@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    dis = await client.post(f"/api/admin/users/{uid}/disable")
    assert dis.status_code == 200 and dis.json()["status"] == "disabled"
    en = await client.post(f"/api/admin/users/{uid}/enable")
    assert en.status_code == 200 and en.json()["status"] == "active"


async def test_disable_last_admin_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        admin = (await s.execute(select(User).where(User.email == settings.admin_email))).scalar_one()
        admin_id = str(admin.id)
    r = await client.post(f"/api/admin/users/{admin_id}/disable")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "last_admin"


async def test_disable_revokes_sessions(app, client, settings, sessionmaker_):
    import uuid as _uuid
    import httpx
    from sqlalchemy import select
    from prd_mcp.web.models import Session as SessionRow

    await _login_admin(client, settings)
    # create a SECOND admin so disabling them doesn't trip the last-admin invariant
    admin_role_id = await _role_id(sessionmaker_, "admin")
    uid = await _make_pending(sessionmaker_, "second@ringkas.co.id")
    uid_u = _uuid.UUID(uid)
    # give the second admin a known password via reset-password, then approve as admin
    await client.post(f"/api/admin/users/{uid}/reset-password", json={"password": "second-admin-pw-1"})
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [admin_role_id]})

    # the second admin logs in on their own client -> a session row exists
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as second:
        li = await second.post("/api/auth/login", json={"email": "second@ringkas.co.id", "password": "second-admin-pw-1"})
        assert li.status_code == 200
        async with sessionmaker_() as s:
            before = (await s.execute(select(SessionRow).where(SessionRow.user_id == uid_u))).scalars().all()
            assert len(before) >= 1

        # first admin disables the second -> their sessions are revoked, next request 401
        r = await client.post(f"/api/admin/users/{uid}/disable")
        assert r.status_code == 200 and r.json()["status"] == "disabled"
        async with sessionmaker_() as s:
            after = (await s.execute(select(SessionRow).where(SessionRow.user_id == uid_u))).scalars().all()
            assert len(after) == 0
        assert (await second.get("/api/auth/me")).status_code == 401


async def test_reject_pending_deletes(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    uid = await _make_pending(sessionmaker_, "rej@ringkas.co.id")
    r = await client.post(f"/api/admin/users/{uid}/reject")
    assert r.status_code == 200
    async with sessionmaker_() as s:
        assert (await s.execute(select(User).where(User.email == "rej@ringkas.co.id"))).scalar_one_or_none() is None


async def test_set_roles_replaces_and_invariant(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    member_id = await _role_id(sessionmaker_, "member")
    uid = await _make_pending(sessionmaker_, "sr@ringkas.co.id")
    await client.post(f"/api/admin/users/{uid}/approve", json={"role_ids": [member_id]})
    r = await client.put(f"/api/admin/users/{uid}/roles", json={"role_ids": []})
    assert r.status_code == 200
    assert r.json()["permissions"] == []
```

- [ ] **Step 2: Write the failing admin-roles test**

Create `mcp/tests/web/test_admin_roles.py`:

```python
import pytest
from sqlalchemy import select

from prd_mcp.web.models import Permission, Role, User


async def _login_admin(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})


async def _perm_ids(sessionmaker_, names):
    async with sessionmaker_() as s:
        rows = (await s.execute(select(Permission).where(Permission.name.in_(names)))).scalars().all()
        return [str(p.id) for p in rows]


async def test_list_roles_and_permissions(client, settings):
    await _login_admin(client, settings)
    roles = await client.get("/api/admin/roles")
    assert roles.status_code == 200
    perms = await client.get("/api/admin/permissions")
    assert {p["name"] for p in perms.json()["permissions"]} == {
        "prd.read", "prd.ask", "status.view", "users.manage", "roles.manage"}


async def test_create_custom_role_ok(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["prd.read", "status.view"])
    r = await client.post("/api/admin/roles", json={"name": "viewer", "permission_ids": ids})
    assert r.status_code == 201
    assert set(r.json()["permissions"]) == {"prd.read", "status.view"}


async def test_create_half_admin_role_422(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["roles.manage"])
    r = await client.post("/api/admin/roles", json={"name": "halfadmin", "permission_ids": ids})
    assert r.status_code == 422 and r.json()["error"]["code"] == "admin_pair"


async def test_edit_system_role_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        admin_role = (await s.execute(select(Role).where(Role.name == "admin"))).scalar_one()
        rid = str(admin_role.id)
    r = await client.put(f"/api/admin/roles/{rid}", json={"description": "hijack"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "system_role_immutable"


async def test_delete_system_role_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    async with sessionmaker_() as s:
        member_role = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
        rid = str(member_role.id)
    r = await client.delete(f"/api/admin/roles/{rid}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "system_role_immutable"


async def test_delete_role_in_use_is_409(client, settings, sessionmaker_):
    await _login_admin(client, settings)
    ids = await _perm_ids(sessionmaker_, ["prd.read"])
    created = await client.post("/api/admin/roles", json={"name": "temprole", "permission_ids": ids})
    rid = created.json()["id"]
    # assign to a user
    async with sessionmaker_() as s:
        role = (await s.execute(select(Role).where(Role.name == "temprole"))).scalar_one()
        u = User(email="hold@ringkas.co.id", password_hash="x", status="active")
        u.roles.append(role)
        s.add(u)
        await s.commit()
    r = await client.delete(f"/api/admin/roles/{rid}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "role_in_use"
```

- [ ] **Step 3: Write the failing admin-settings test**

Create `mcp/tests/web/test_admin_settings.py`:

```python
async def _login_admin(client, settings):
    await client.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})


async def test_get_settings(client, settings):
    await _login_admin(client, settings)
    r = await client.get("/api/admin/settings")
    assert r.status_code == 200
    assert "registration_enabled" in r.json()
    assert "allowed_domains" in r.json()


async def test_update_settings_persists(client, settings):
    await _login_admin(client, settings)
    r = await client.put("/api/admin/settings", json={"registration_enabled": True, "allowed_domains": ["ringkas.co.id"]})
    assert r.status_code == 200
    g = await client.get("/api/admin/settings")
    assert g.json()["registration_enabled"] is True
    assert g.json()["allowed_domains"] == ["ringkas.co.id"]


async def test_settings_forbidden_for_member_without_roles_manage(app, settings, sessionmaker_):
    """A logged-in member (prd.read+prd.ask, no roles.manage) gets 403, not 401."""
    import httpx
    from sqlalchemy import select
    from prd_mcp.web.models import Role, User
    from prd_mcp.web.security import make_password_hasher

    hasher = make_password_hasher(settings)
    async with sessionmaker_() as s:
        member = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
        u = User(email="memberonly@ringkas.co.id", password_hash=hasher.hash("member-pw-1234"), status="active")
        u.roles.append(member)
        s.add(u)
        await s.commit()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as c:
        li = await c.post("/api/auth/login", json={"email": "memberonly@ringkas.co.id", "password": "member-pw-1234"})
        assert li.status_code == 200
        # member can NOT reach a roles.manage-guarded endpoint
        assert (await c.get("/api/admin/settings")).status_code == 403
        # ...nor a users.manage-guarded one
        assert (await c.get("/api/admin/users")).status_code == 403
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd mcp && poetry run pytest tests/web/test_admin_users.py tests/web/test_admin_roles.py tests/web/test_admin_settings.py -v`
Expected: FAIL `ModuleNotFoundError: No module named 'prd_mcp.web.admin'`.

- [ ] **Step 5: Implement admin.py**

Create `mcp/prd_mcp/web/admin.py`:

```python
"""Admin router: users (users.manage), roles + settings (roles.manage).

Every privilege-reducing path calls assert_admin_invariant inside the txn;
every role/user perm assignment calls assert_pair_integrity FIRST (422 before 409).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.db import get_db
from prd_mcp.web.errors import (
    AppError,
    role_in_use_error,
    system_role_error,
)
from prd_mcp.web.models import Permission, Role, User, AppSettings
from prd_mcp.web.rbac import (
    assert_admin_invariant,
    assert_pair_integrity,
    effective_permissions,
    require_permission,
)
from prd_mcp.web.schemas import (
    ApproveIn,
    PermissionOut,
    RoleCreateIn,
    RoleOut,
    RoleUpdateIn,
    SetPasswordIn,
    SetRolesIn,
    SettingsIn,
    SettingsOut,
    UserOut,
)
from prd_mcp.web.auth import user_to_out

router = APIRouter(prefix="/api/admin")


def role_to_out(role: Role) -> RoleOut:
    return RoleOut(
        id=role.id, name=role.name, description=role.description,
        is_system=role.is_system, permissions=sorted(p.name for p in role.permissions),
    )


async def _user_or_404(db, user_id: uuid.UUID) -> User:
    u = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if u is None:
        raise AppError(404, "not_found", "user not found")
    return u


async def _roles_or_404(db, role_ids: list[uuid.UUID]) -> list[Role]:
    if not role_ids:
        return []
    rows = (await db.execute(select(Role).where(Role.id.in_(role_ids)))).scalars().all()
    if len(rows) != len(set(role_ids)):
        raise AppError(404, "not_found", "one or more roles not found")
    return rows


def _union_perm_names(roles: list[Role]) -> set[str]:
    return {p.name for r in roles for p in r.permissions}


# ---- users (require users.manage) ----

@router.get("/users", dependencies=[Depends(require_permission("users.manage"))])
async def list_users(
    db=Depends(get_db),
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    base = select(User)
    if status:
        base = base.where(User.status == status)
    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    rows = (await db.execute(base.order_by(User.created_at).limit(limit).offset(offset))).scalars().all()
    return {
        "users": [user_to_out(u).model_dump(mode="json") for u in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/users/{user_id}", dependencies=[Depends(require_permission("users.manage"))])
async def get_user(user_id: uuid.UUID, db=Depends(get_db)):
    return user_to_out(await _user_or_404(db, user_id)).model_dump(mode="json")


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: uuid.UUID,
    payload: ApproveIn,
    db=Depends(get_db),
    actor: User = Depends(require_permission("users.manage")),
):
    user = await _user_or_404(db, user_id)
    # approve is pending->active ONLY. Without this guard, approving an ACTIVE
    # last-admin with non-admin roles would strip their admin perms while skipping
    # the last-admin check (approve isn't in that guarded set) -> lockout.
    if user.status != "pending":
        raise AppError(409, "invalid_state", "only pending users can be approved")
    roles = await _roles_or_404(db, payload.role_ids)
    assert_pair_integrity(_union_perm_names(roles))  # 422 before any state change
    user.status = "active"
    user.approved_at = datetime.now(timezone.utc)
    user.approved_by = actor.id  # spec §4: approver recorded
    user.roles[:] = roles
    await db.commit()  # get_db only yields; without commit the approval rolls back
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/disable", dependencies=[Depends(require_permission("users.manage"))])
async def disable_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    user.status = "disabled"
    await db.flush()
    await assert_admin_invariant(db)  # 409 + rollback if this drops the last admin
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/enable", dependencies=[Depends(require_permission("users.manage"))])
async def enable_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    # enable is disabled->active ONLY. A pending user must go through approve
    # (which sets approved_at/by + assigns roles); enabling one would skip that.
    if user.status != "disabled":
        raise AppError(409, "invalid_state", "only disabled users can be enabled")
    # Re-activating must not produce a half-admin: if the disabled user's effective
    # perms hold exactly one of the admin pair, reactivating them would violate
    # pair-integrity (which only the request layer enforces). Check before activating.
    assert_pair_integrity(effective_permissions(user))  # 422 if half-admin
    user.status = "active"
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.post("/users/{user_id}/reject", dependencies=[Depends(require_permission("users.manage"))])
async def reject_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    # reject is pending->deleted ONLY (spec §5). Guard so it can't become a
    # backdoor delete path for active users that skips delete_user's semantics.
    if user.status != "pending":
        raise AppError(409, "invalid_state", "only pending users can be rejected")
    await db.delete(user)
    await db.commit()
    return {"status": "rejected"}


@router.post("/users/{user_id}/reset-password", dependencies=[Depends(require_permission("users.manage"))])
async def reset_password(user_id: uuid.UUID, payload: SetPasswordIn, request: Request, db=Depends(get_db)):
    settings = request.app.state.settings
    from prd_mcp.web.schemas import validate_password

    validate_password(payload.password, settings)
    user = await _user_or_404(db, user_id)
    user.password_hash = request.app.state.password_hasher.hash(payload.password)
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    return {"status": "ok"}


@router.put("/users/{user_id}/roles", dependencies=[Depends(require_permission("users.manage"))])
async def set_user_roles(user_id: uuid.UUID, payload: SetRolesIn, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    roles = await _roles_or_404(db, payload.role_ids)
    assert_pair_integrity(_union_perm_names(roles))  # 422 first
    user.roles[:] = roles
    await db.flush()
    await assert_admin_invariant(db)  # 409 second
    await sessions_mod.revoke_user_sessions(db, user.id)
    await db.commit()
    await db.refresh(user)
    return user_to_out(user).model_dump(mode="json")


@router.delete("/users/{user_id}", dependencies=[Depends(require_permission("users.manage"))])
async def delete_user(user_id: uuid.UUID, db=Depends(get_db)):
    user = await _user_or_404(db, user_id)
    await db.delete(user)
    await db.flush()
    await assert_admin_invariant(db)
    await db.commit()
    return {"status": "deleted"}


# ---- roles + settings (require roles.manage) ----

@router.get("/roles", dependencies=[Depends(require_permission("roles.manage"))])
async def list_roles(db=Depends(get_db)):
    roles = (await db.execute(select(Role))).scalars().all()
    return {"roles": [role_to_out(r).model_dump(mode="json") for r in roles]}


@router.get("/permissions", dependencies=[Depends(require_permission("roles.manage"))])
async def list_permissions(db=Depends(get_db)):
    perms = (await db.execute(select(Permission))).scalars().all()
    return {"permissions": [PermissionOut(name=p.name, description=p.description).model_dump() for p in perms]}


@router.post("/roles", status_code=201, dependencies=[Depends(require_permission("roles.manage"))])
async def create_role(payload: RoleCreateIn, db=Depends(get_db)):
    perms = (await db.execute(select(Permission).where(Permission.id.in_(payload.permission_ids)))).scalars().all()
    if len(perms) != len(set(payload.permission_ids)):
        raise AppError(404, "not_found", "one or more permissions not found")
    assert_pair_integrity({p.name for p in perms})  # 422
    role = Role(name=payload.name, description=payload.description, is_system=False)
    role.permissions[:] = perms
    db.add(role)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError(409, "role_exists", "a role with that name already exists")
    await db.refresh(role)
    return role_to_out(role).model_dump(mode="json")


@router.put("/roles/{role_id}", dependencies=[Depends(require_permission("roles.manage"))])
async def update_role(role_id: uuid.UUID, payload: RoleUpdateIn, db=Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise AppError(404, "not_found", "role not found")
    if role.is_system:
        raise system_role_error()  # 409, fully immutable
    if payload.name is not None:
        role.name = payload.name
    if payload.description is not None:
        role.description = payload.description
    if payload.permission_ids is not None:
        perms = (await db.execute(select(Permission).where(Permission.id.in_(payload.permission_ids)))).scalars().all()
        if len(perms) != len(set(payload.permission_ids)):
            raise AppError(404, "not_found", "one or more permissions not found")
        assert_pair_integrity({p.name for p in perms})  # 422
        role.permissions[:] = perms
    await db.flush()
    await assert_admin_invariant(db)  # 409 if a perm removal drops the last admin
    await db.commit()
    await db.refresh(role)
    return role_to_out(role).model_dump(mode="json")


@router.delete("/roles/{role_id}", dependencies=[Depends(require_permission("roles.manage"))])
async def delete_role(role_id: uuid.UUID, db=Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if role is None:
        raise AppError(404, "not_found", "role not found")
    if role.is_system:
        raise system_role_error()
    await db.delete(role)
    try:
        await db.flush()
        await assert_admin_invariant(db)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise role_in_use_error()  # FK RESTRICT
    return {"status": "deleted"}


@router.get("/settings", dependencies=[Depends(require_permission("roles.manage"))])
async def get_settings_endpoint(db=Depends(get_db)):
    row = (await db.execute(select(AppSettings))).scalar_one_or_none()
    if row is None:
        return SettingsOut(registration_enabled=False, allowed_domains=[]).model_dump()
    return SettingsOut(registration_enabled=row.registration_enabled, allowed_domains=list(row.allowed_domains)).model_dump()


@router.put("/settings", dependencies=[Depends(require_permission("roles.manage"))])
async def update_settings_endpoint(payload: SettingsIn, request: Request, db=Depends(get_db)):
    row = (await db.execute(select(AppSettings))).scalar_one_or_none()
    domains = [d.strip().lower() for d in payload.allowed_domains if d.strip()]
    actor = getattr(request.state, "current_user", None)
    if row is None:
        row = AppSettings(id=1, registration_enabled=payload.registration_enabled, allowed_domains=domains)
        db.add(row)
    else:
        row.registration_enabled = payload.registration_enabled
        row.allowed_domains = domains
        row.updated_at = datetime.now(timezone.utc)
    if actor is not None:
        row.updated_by = actor.id
    await db.commit()
    await db.refresh(row)
    return SettingsOut(registration_enabled=row.registration_enabled, allowed_domains=list(row.allowed_domains)).model_dump()
```

- [ ] **Step 6: Mount the admin router in app.py**

In `mcp/prd_mcp/web/app.py`, after `app.include_router(auth_router)`, add:

```python
    from prd_mcp.web.admin import router as admin_router

    app.include_router(admin_router)
```

- [ ] **Step 7: Run the admin tests + full suite**

Run: `cd mcp && poetry run pytest tests/web/ -v`
Expected: all green (admin users/roles/settings + prior tasks).

- [ ] **Step 8: Commit**

```bash
cd mcp && git add prd_mcp/web/admin.py prd_mcp/web/app.py tests/web/test_admin_users.py tests/web/test_admin_roles.py tests/web/test_admin_settings.py
git commit -m "feat(web): admin endpoints for users, roles, settings with invariant enforcement"
```

---

### Task 10: middleware (CSRF, CORS, proxy headers), `/healthz`, purge task, CLI `web` subcommand, lifecycle test

**Files:**
- Modify: `mcp/prd_mcp/web/app.py` (CSRF middleware, CORS, ProxyHeaders, healthz, purge task, HSTS)
- Modify: `mcp/prd_mcp/cli.py` (add `web` subcommand)
- Test: `mcp/tests/web/test_csrf.py`
- Test: `mcp/tests/web/test_lifecycle.py`
- Test: `mcp/tests/web/test_healthz.py`

**Interfaces:**
- Consumes everything prior.
- Modifies `app.py`: add a CSRF middleware that rejects any `POST/PUT/DELETE/PATCH` lacking header `X-Requested-With: prd-app` with `403 {error:{code:'csrf'}}`; add `CORSMiddleware` locked to `settings.cors_origin` (no wildcard); add `ProxyHeadersMiddleware` trusting only `127.0.0.1`; add `/healthz`; add an HSTS response header in prod; start an hourly `purge_expired` background task on startup.
- Modifies `cli.py`: `prd-mcp web` runs `uvicorn` with the app, single worker, host/port from args (default `127.0.0.1:8300`), `--forwarded-allow-ips=127.0.0.1`.

- [ ] **Step 1: Write the failing CSRF + healthz tests**

Create `mcp/tests/web/test_csrf.py`:

```python
import httpx
import pytest


@pytest.mark.asyncio
async def test_post_without_csrf_header_is_403(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        # no X-Requested-With header
        r = await c.post("/api/auth/login", json={"email": "a@b.co", "password": "x" * 12})
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "csrf"


@pytest.mark.asyncio
async def test_get_does_not_require_csrf(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
        assert r.status_code in (200, 503)  # no CSRF on GET


@pytest.mark.asyncio
async def test_post_with_csrf_header_passes_csrf_gate(app, settings):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers={"X-Requested-With": "prd-app"}) as c:
        r = await c.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})
        assert r.status_code == 200  # passed CSRF (and login succeeded)
```

Create `mcp/tests/web/test_healthz.py`:

```python
import httpx
import pytest


@pytest.mark.asyncio
async def test_healthz_reports_db_ok(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/healthz")
        assert r.status_code == 200
        assert r.json()["db"] == "ok"
```

- [ ] **Step 2: Write the failing lifecycle integration test**

Create `mcp/tests/web/test_lifecycle.py`:

```python
import httpx
import pytest
from sqlalchemy import select, update

from prd_mcp.web.models import AppSettings, Role, User


@pytest.mark.asyncio
async def test_full_lifecycle_register_approve_login_access_disable(app, settings, sessionmaker_):
    """register → admin approve → login → access guarded route → admin disable → 401."""
    transport = httpx.ASGITransport(app=app)
    H = {"X-Requested-With": "prd-app"}

    # enable registration for ringkas.co.id
    async with sessionmaker_() as s:
        await s.execute(update(AppSettings).values(registration_enabled=True, allowed_domains=["ringkas.co.id"]))
        await s.commit()

    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as admin:
        await admin.post("/api/auth/login", json={"email": settings.admin_email, "password": settings.admin_password})

        # 1. self-register
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as anon:
            reg = await anon.post("/api/auth/register", json={"email": "alice@ringkas.co.id", "password": "alice-pw-1234"})
            assert reg.status_code == 202

        # 2. admin approves alice as member
        async with sessionmaker_() as s:
            alice = (await s.execute(select(User).where(User.email == "alice@ringkas.co.id"))).scalar_one()
            member = (await s.execute(select(Role).where(Role.name == "member"))).scalar_one()
            alice_id, member_id = str(alice.id), str(member.id)
        appr = await admin.post(f"/api/admin/users/{alice_id}/approve", json={"role_ids": [member_id]})
        assert appr.status_code == 200 and appr.json()["status"] == "active"

        # 3. alice logs in and reads her profile
        async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=H) as alice_c:
            li = await alice_c.post("/api/auth/login", json={"email": "alice@ringkas.co.id", "password": "alice-pw-1234"})
            assert li.status_code == 200
            me = await alice_c.get("/api/auth/me")
            assert "prd.read" in me.json()["permissions"]
            # alice cannot reach admin endpoints
            assert (await alice_c.get("/api/admin/users")).status_code == 403

            # 4. admin disables alice -> her next request is 401 + cookie cleared
            dis = await admin.post(f"/api/admin/users/{alice_id}/disable")
            assert dis.status_code == 200
            assert (await alice_c.get("/api/auth/me")).status_code == 401
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd mcp && poetry run pytest tests/web/test_csrf.py tests/web/test_healthz.py tests/web/test_lifecycle.py -v`
Expected: FAIL — CSRF not enforced yet (login returns 200/401 not 403), `/healthz` 404.

- [ ] **Step 4: Extend app.py with middleware + healthz + purge**

Replace `mcp/prd_mcp/web/app.py` with:

```python
"""FastAPI app factory: routers + error envelope + CSRF/CORS middleware +
healthz + hourly session purge.

Client-IP trust (for rate limiting) is established at the uvicorn layer via
`--forwarded-allow-ips=127.0.0.1` (set in cli.py), NOT a per-app middleware —
that keeps trust config in one place and avoids uvicorn-version drift in the
ProxyHeadersMiddleware constructor signature.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

from prd_mcp.web import db as db_mod
from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.errors import AppError
from prd_mcp.web.ratelimit import RateLimiter
from prd_mcp.web.security import make_password_hasher
from prd_mcp.web.settings import WebSettings

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class CSRFMiddleware(BaseHTTPMiddleware):
    """Reject state-changing requests lacking the custom header."""

    async def dispatch(self, request: Request, call_next):
        if request.method not in _SAFE_METHODS:
            if request.headers.get("x-requested-with") != "prd-app":
                return JSONResponse(status_code=403, content={"error": {"code": "csrf", "message": "missing or invalid CSRF header"}})
        response = await call_next(request)
        return response


class HSTSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response


def create_app(settings: WebSettings, sessionmaker, *, run_startup: bool = True) -> FastAPI:
    app = FastAPI(title="PRD Auth")
    app.state.settings = settings
    app.state.ratelimiter = RateLimiter(settings.rate_limit_per_min)
    app.state.password_hasher = make_password_hasher(settings)  # built ONCE (see Task 8)
    db_mod.set_sessionmaker(sessionmaker)

    # Starlette applies add_middleware in REVERSE order, so the LAST added is
    # outermost. We want CORS outermost (so even a CSRF-rejected cross-origin
    # response carries CORS headers and the browser surfaces our JSON error),
    # then HSTS, then CSRF innermost. Add order below = CSRF, HSTS, CORS.
    app.add_middleware(CSRFMiddleware)
    if settings.is_prod:
        app.add_middleware(HSTSMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError):
        resp = JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})
        if exc.status_code == 401:
            resp.delete_cookie(key=settings.cookie_name, path="/")
        if exc.code == "rate_limited":
            # spec §9/§10: 429 carries Retry-After. The in-process bucket refills
            # at per_min/60 tokens/sec, so ~60/per_min seconds buys one token.
            resp.headers["Retry-After"] = str(max(1, 60 // max(1, settings.rate_limit_per_min)))
        return resp

    # spec §5: EVERY 4xx/5xx shares {error:{code,message}}. FastAPI's own
    # validation + HTTP errors would otherwise emit their default shapes, so wrap
    # them into the same envelope.
    from fastapi.exceptions import RequestValidationError
    from starlette.exceptions import HTTPException as StarletteHTTPException

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "invalid request body"}})

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException):
        code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": code, "message": str(exc.detail)}})

    from prd_mcp.web.auth import router as auth_router
    from prd_mcp.web.admin import router as admin_router

    app.include_router(auth_router)
    app.include_router(admin_router)

    @app.get("/healthz")
    async def healthz():
        try:
            async with sessionmaker() as s:
                await s.execute(text("SELECT 1"))
            return {"db": "ok"}
        except Exception:
            return JSONResponse(status_code=503, content={"db": "unreachable"})

    if run_startup:
        @app.on_event("startup")
        async def _startup():  # pragma: no cover - deployment path
            from prd_mcp.web import seed as seed_mod

            async with sessionmaker() as s:
                await seed_mod.run_seed(s, settings)
            app.state._purge_task = asyncio.create_task(_purge_loop(sessionmaker))

        @app.on_event("shutdown")
        async def _shutdown():  # pragma: no cover
            task = getattr(app.state, "_purge_task", None)
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    return app


async def _purge_loop(sessionmaker):  # pragma: no cover - timing loop
    while True:
        await asyncio.sleep(3600)
        try:
            async with sessionmaker() as s:
                await sessions_mod.purge_expired(s, now=datetime.now(timezone.utc))
                await s.commit()
        except Exception:
            pass
```

- [ ] **Step 5: Add the `web` subcommand to cli.py (and gate the keychain/Chroma init)**

The existing `main()` (verified) runs these two lines UNCONDITIONALLY near the top, before any `args.cmd` dispatch:

```python
    cfg = load_config(os.environ, read_secret)
    store = Store.open(cfg.chroma_path)
```

`prd-mcp web` runs on the Linux VPS where there is NO macOS keychain and NO Chroma index, so these lines would crash it. This step has TWO required edits — the gate is NOT optional.

First, replace the subparser section so `web` is registered (after the `serve` subparser):

```python
    serve = sub.add_parser("serve", help="run the MCP server")
    serve.add_argument("--http", action="store_true", help="streamable-http transport (token-gated)")
    web = sub.add_parser("web", help="run the FastAPI auth web app (uvicorn, single worker)")
    web.add_argument("--host", default="127.0.0.1")
    web.add_argument("--port", type=int, default=8300)
    args = parser.parse_args()
```

Then replace the unconditional `cfg=`/`store=` lines with a `web`-handling branch that returns BEFORE them, so the keychain/Chroma init only runs for `index`/`serve`:

```python
    if args.cmd == "web":
        import uvicorn
        from prd_mcp.web.settings import load_settings
        from prd_mcp.web.db import make_engine, make_sessionmaker
        from prd_mcp.web.app import create_app

        web_settings = load_settings()  # reads os.environ; NO keychain, NO Chroma
        engine = make_engine(web_settings.database_url)
        sm = make_sessionmaker(engine)
        application = create_app(web_settings, sm, run_startup=True)
        uvicorn.run(
            application, host=args.host, port=args.port,
            workers=1, forwarded_allow_ips="127.0.0.1",  # trust XFF only from Caddy on loopback
        )
        return 0

    # index/serve only past this point — these require the keychain + Chroma:
    cfg = load_config(os.environ, read_secret)
    store = Store.open(cfg.chroma_path)
```

(The `web` branch must sit ABOVE the `cfg`/`store` lines; everything below — the `if args.cmd == "index":` and serve blocks — is unchanged.)

- [ ] **Step 6: Run the full web suite**

Run: `cd mcp && poetry run pytest tests/web/ -v`
Expected: all green (CSRF 3 + healthz 1 + lifecycle 1 + all prior).

- [ ] **Step 7: Verify CLI wiring didn't break existing commands**

Run: `cd mcp && poetry run prd-mcp --help && poetry run prd-mcp web --help`
Expected: both print help; `web` shows `--host/--port`; `index`/`serve` still listed.

- [ ] **Step 8: Commit**

```bash
cd mcp && git add prd_mcp/web/app.py prd_mcp/cli.py tests/web/test_csrf.py tests/web/test_healthz.py tests/web/test_lifecycle.py
git commit -m "feat(web): CSRF/CORS/proxy middleware, healthz, purge task, prd-mcp web subcommand"
```

---

### Task 11: Deployment artifacts (docker-compose, Dockerfile, Caddy, .env.example, entrypoint)

**Files:**
- Create: `mcp/deploy/Dockerfile`
- Create: `mcp/deploy/docker-compose.yml`
- Create: `mcp/deploy/entrypoint.sh`
- Create: `mcp/deploy/Caddyfile.snippet`
- Create: `mcp/deploy/.env.example`
- Create: `mcp/deploy/README.md`
- Modify: `mcp/.gitignore` (ignore `deploy/.env`)

**Interfaces:** No code interfaces; this task produces the deploy bundle the operator runs on `openclaw`. No automated test — verification is `docker compose config` parse + a documented manual smoke.

- [ ] **Step 1: Dockerfile**

Create `mcp/deploy/Dockerfile`:

```dockerfile
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
```

- [ ] **Step 2: entrypoint.sh (migrate then serve)**

Create `mcp/deploy/entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run migrations (sync driver; env.py strips +asyncpg) then start the app.
echo "[entrypoint] running alembic upgrade head"
ALEMBIC_DATABASE_URL="${DATABASE_URL}" alembic upgrade head

echo "[entrypoint] starting uvicorn (single worker)"
exec python -m prd_mcp.cli web --host 0.0.0.0 --port 8300
```

NOTE: inside the container the app binds `0.0.0.0:8300`, but docker-compose publishes it ONLY to host loopback (`127.0.0.1:8300:8300`), so it is not reachable except via Caddy. `forwarded_allow_ips` stays `127.0.0.1` because Caddy connects from the host.

- [ ] **Step 3: docker-compose.yml**

Create `mcp/deploy/docker-compose.yml`:

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
    networks: [prd_net]

  prd-app:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    restart: unless-stopped
    env_file: .env
    depends_on: [prd-postgres]
    ports:
      - "127.0.0.1:8300:8300"   # host loopback only; Caddy reverse-proxies here
    networks: [prd_net]

volumes:
  prd_pgdata:

networks:
  prd_net:
```

- [ ] **Step 4: Caddyfile snippet + .env.example + README**

Create `mcp/deploy/Caddyfile.snippet`:

```
prd.duyopenclaw.tech {
    reverse_proxy 127.0.0.1:8300
}
```

Create `mcp/deploy/.env.example`:

```bash
# Copy to .env, fill real values, chmod 600. NEVER commit .env.
# Postgres (compose builds DATABASE_URL host = service name prd-postgres)
POSTGRES_PASSWORD=change-me-strong
DATABASE_URL=postgresql+asyncpg://prd_app:change-me-strong@prd-postgres:5432/prd_auth

# Bootstrap admin (break-glass; rotate out of .env after first login if desired)
ADMIN_EMAIL=duy@ringkas.co.id
ADMIN_PASSWORD=change-me-strong-admin-pw

# First-boot-only seeds (DB authoritative thereafter)
REGISTRATION_ENABLED=false
ALLOWED_EMAIL_DOMAINS=ringkas.co.id

# Session + security knobs (defaults shown)
SESSION_IDLE_HOURS=24
SESSION_ABSOLUTE_DAYS=30
LAST_SEEN_THROTTLE_MIN=5
RATE_LIMIT_PER_MIN=5
PASSWORD_MIN_LENGTH=12

# Deployment
ENV=prod
CORS_ORIGIN=https://prd.duyopenclaw.tech
# NO COOKIE_SECRET (opaque tokens). NO LLM/embed keys this phase.
```

Create `mcp/deploy/README.md`:

```markdown
# PRD Auth — openclaw deployment

1. `cp .env.example .env` → fill real values → `chmod 600 .env`.
2. `docker compose build`
3. `docker compose up -d` (entrypoint runs `alembic upgrade head`, then starts uvicorn; app seeds on startup).
4. Add the Caddy block from `Caddyfile.snippet` to the box's Caddyfile, `caddy reload`.
5. Smoke: `curl https://prd.duyopenclaw.tech/healthz` → `{"db":"ok"}`;
   login as `ADMIN_EMAIL` via `POST /api/auth/login` (header `X-Requested-With: prd-app`).

Break-glass: if every admin is disabled/deleted, a restart re-asserts the `.env` admin.
To permanently retire it, remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` after another admin exists.
```

- [ ] **Step 5: gitignore the real .env**

Append to `mcp/.gitignore`:

```
deploy/.env
```

- [ ] **Step 6: Validate compose parses**

Run: `cd mcp/deploy && POSTGRES_PASSWORD=x docker compose config >/dev/null && echo OK`
Expected: `OK` (compose file is syntactically valid). If `docker compose` is unavailable in the build env, skip with a note; the file is still reviewed.

- [ ] **Step 7: Commit**

```bash
cd mcp && git add deploy/ .gitignore
git commit -m "feat(web): openclaw deployment bundle (Dockerfile, compose, Caddy, entrypoint, .env.example)"
```

---

## Final whole-branch review

After Task 11, run the cross-model whole-branch review (BOTH Claude + Codex) per subagent-driven-development:
- Generate the review package from `git merge-base main HEAD` to `HEAD`.
- Claude (opus) reviews for execution correctness + spec compliance; Codex reviews for contract/security-invariant gaps.
- Fix all Critical/Important in ONE fix subagent dispatch; re-review until both are clean.
- Then `finishing-a-development-branch` (run full `pytest tests/`, present merge options).

**Cross-cutting checks for the final review (the spec's invariants that span tasks):**
1. NO endpoint guarded by role NAME — every guard is `require_permission(<perm>)`.
2. `assert_pair_integrity` is called on ALL of: role create, role update, user approve, user set-roles, AND user enable (re-activation). (422, before any 409.)
3. `assert_admin_invariant` is called inside the txn on ALL of: disable, delete user, set-roles, role.update, role.delete.
4. State preconditions: `approve` and `reject` act ONLY on `pending` users (409 `invalid_state` otherwise) — approve can't strip an active last-admin, reject can't become a backdoor delete.
5. Every mutating handler COMMITS (get_db only yields); `approve` records `approved_by`+`approved_at`. The `get_db` dependency rolls back on any raised exception so a flushed-then-rejected (422/409) mutation never leaks.
6. Login: load → ALWAYS argon2-verify (dummy same params) → THEN status — no early status exit; identical 401.
7. Register: every branch returns identical `202 {status:'accepted'}` with an argon2 hash computed (timing).
8. Sessions: only `sessions.py` touches the table; login mints a fresh token ignoring any presented cookie; logout emits the cookie-clearing Set-Cookie on the returned 204.
9. `security.py` is the only module hashing passwords/tokens; the argon2 hasher is built ONCE on `app.state` (no per-request dummy hash); cookie `Secure` only when `is_prod`.
10. Settings seed from env on first boot only; DB authoritative after (the redeploy-doesn't-clobber test exists).
11. Break-glass: reactivation path resets the password from `ADMIN_PASSWORD` (recovery), reached ONLY when no active admin exists; a healthy admin is never touched.
12. CSRF: every mutation requires `X-Requested-With: prd-app`; no state-changing GET. CORS outermost (exact-origin), CSRF inner.
13. Alembic migrations run on the sync psycopg3 driver (`+psycopg`); `alembic upgrade head` succeeds in the Task 11 entrypoint.
14. The PRD core (`retrieve/answer/store/read/index/server/vault/chunk/llm/config/keychain`) is unchanged; `cli.py` only gains the `web` branch, gated so `index`/`serve` keychain+Chroma init is skipped for `web`.
