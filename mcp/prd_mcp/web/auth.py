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
