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
