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
import logging
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

from prd_mcp.web import db as db_mod
from prd_mcp.web import sessions as sessions_mod
from prd_mcp.web.coredeps import set_core
from prd_mcp.web.errors import AppError
from prd_mcp.web.ratelimit import RateLimiter
from prd_mcp.web.security import make_password_hasher
from prd_mcp.web.settings import WebSettings

logger = logging.getLogger("prd_mcp.web")

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


def create_app(settings: WebSettings, sessionmaker, *, run_startup: bool = True, core=None) -> FastAPI:
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
        # Clear the session cookie only when the session itself is invalid
        # (expired/revoked/absent). `invalid_credentials` on change-password means
        # the user IS authenticated — their session is fine; clearing there would
        # log them out on every wrong-password attempt, defeating the rate-limit.
        if exc.code == "unauthorized":
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

    # spec §5: catch-all so unhandled RuntimeError/etc. return the envelope
    # instead of Starlette's plaintext "Internal Server Error". Starlette routes
    # specific-exception handlers via ExceptionMiddleware (innermost) and the
    # bare Exception handler via ServerErrorMiddleware (outermost), so AppError /
    # RequestValidationError / StarletteHTTPException still win their own handlers.
    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        logger.exception("unhandled error processing %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"error": {"code": "internal_error", "message": "internal server error"}})

    from prd_mcp.web.auth import router as auth_router
    from prd_mcp.web.admin import router as admin_router
    from prd_mcp.web.notifications import router as notifications_router
    from prd_mcp.web.sources import router as sources_router

    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(notifications_router)
    # sources router owns its own /api prefix; mount even when core is None
    # so the GET (which reads manifests via core) is registered early.
    app.include_router(sources_router)

    if core is not None:
        set_core(app, core)
        from prd_mcp.web.prd import router as prd_router
        from prd_mcp.web.chat import router as chat_router
        from prd_mcp.web.status import router as status_router
        app.include_router(prd_router)
        app.include_router(chat_router)
        app.include_router(status_router)

    @app.get("/healthz")
    async def healthz():
        try:
            async with sessionmaker() as s:
                await s.execute(text("SELECT 1"))
            return {"db": "ok"}
        except Exception:
            # 5xx must share the {error:{code,message}} envelope (spec §5/§9).
            return JSONResponse(
                status_code=503,
                content={"error": {"code": "service_unavailable", "message": "database unavailable"}},
            )

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


async def _purge_once(sessionmaker) -> None:
    """Run one purge cycle. Called by _purge_loop and directly in tests."""
    try:
        from prd_mcp.web.chat import sweep_stale_generating
        async with sessionmaker() as s:
            await sessions_mod.purge_expired(s, now=datetime.now(timezone.utc))
            await sweep_stale_generating(s, now=datetime.now(timezone.utc))
            await s.commit()
    except Exception:
        pass


async def _purge_loop(sessionmaker):  # pragma: no cover - timing loop
    while True:
        await asyncio.sleep(3600)
        await _purge_once(sessionmaker)
