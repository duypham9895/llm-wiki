"""FastAPI app factory. Task 8 mounts auth + the error envelope; Tasks 9-10 add
the admin router, CSRF/rate-limit/CORS/proxy middleware, healthz, and purge task."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
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
        headers = {}
        if exc.status_code == 429:
            # Standard Retry-After: 60 seconds (token bucket refills in 1 min).
            headers["Retry-After"] = "60"
        resp = JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
            headers=headers,
        )
        # Clear the session cookie only when the session itself is invalid
        # (expired / revoked / not present). A wrong current_password on
        # change-password is `invalid_credentials` (the user IS authenticated
        # — their session is fine). Clearing the cookie there would log the
        # user out on every wrong-password attempt, defeating the rate-limit.
        if exc.code == "unauthorized":
            resp.delete_cookie(key=settings.cookie_name, path="/")
        return resp

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(request: Request, exc: RequestValidationError):
        # Replace FastAPI's default {detail:[...]} with our canonical envelope.
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": str(exc.errors()[0]["msg"])}},
        )

    from prd_mcp.web.auth import router as auth_router

    app.include_router(auth_router)

    if run_startup:
        @app.on_event("startup")
        async def _startup():  # pragma: no cover - exercised in deployment
            from prd_mcp.web import seed as seed_mod

            async with sessionmaker() as s:
                await seed_mod.run_seed(s, settings)

    return app
