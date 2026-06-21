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
