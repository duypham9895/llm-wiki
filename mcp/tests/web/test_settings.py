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
