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
        samesite="Lax",
        path="/",
    )


def clear_session_cookie(response: Response, settings: WebSettings) -> None:
    response.delete_cookie(key=settings.cookie_name, path="/")
