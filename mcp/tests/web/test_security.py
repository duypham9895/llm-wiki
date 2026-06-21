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
