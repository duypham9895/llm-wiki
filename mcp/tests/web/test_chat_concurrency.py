"""Out-of-process single-worker offload proof.

WHY THIS TEST EXISTS (and why the previous design was inadequate)
-----------------------------------------------------------------
The previous version ran the "blocking" stub and the /healthz probe inside the
same in-process ASGI transport (httpx.ASGITransport), sharing one event loop.
If the route regressed and called ``rewrite_query`` directly on the event loop,
the loop would freeze — but the same loop drives ``anyio.fail_after`` and the
``anyio.to_thread.run_sync(entered.wait, ...)`` barrier.  A watchdog thread
eventually called ``release.set()``, allowing the frozen loop to continue and
the assertion to pass — a **false-pass** on a regressed implementation.

THE FIX: subprocess + real socket
----------------------------------
This rewrite runs the app in a real uvicorn subprocess (single worker) and
probes /healthz over a genuine TCP socket using an external httpx client.  The
observation is made from *outside* the subprocess's event loop.

Proof structure:

1. The parent test owns a real Postgres testcontainer (session-scoped).
2. Before launching the subprocess, the parent creates the full schema + seeds a
   user with ``prd.ask`` + creates a conversation, all in that DB.
3. A uvicorn subprocess is launched with ``--workers 1``, inheriting the DB URL,
   the seeded user id, and the required settings via env vars.  The subprocess
   imports ``tests.web._concurrency_app:app``, which:
     - builds ``create_app(...)`` with a fake core whose ``llm.chat`` does
       ``time.sleep(BLOCK_SECONDS)`` (30 s default)
     - overrides ``current_user`` to re-fetch the seeded user by id
     - patches ``retrieve`` to return immediately so only ``llm.chat`` blocks
4. The parent polls /healthz until the subprocess is ready (≤ 15 s startup).
5. The parent fires the chat POST (which will block ~30 s inside the offloaded
   ``time.sleep``) in a background thread — does NOT await it.
6. After a brief pause to ensure the POST is mid-block, the parent issues
   ``GET /healthz`` with a 3 s external httpx timeout.
7. ASSERTION: /healthz returns 200/503 quickly (< 2 s).

FALSIFIABILITY
--------------
If ``chat.py`` ran ``rewrite_query`` directly on the event loop (no
``anyio.to_thread.run_sync``), the 30 s ``time.sleep`` would block uvicorn's
single event-loop thread.  The single worker cannot service any other connection
while the loop is frozen.  The external /healthz request would sit unprocessed
on the TCP socket for 30 s and the external httpx client would raise
``httpx.ReadTimeout`` or ``httpx.ConnectTimeout`` at the 3 s limit — the test
would then FAIL cleanly with a timeout exception, not hang.  (The subprocess is
killed in ``finally`` regardless, so no orphan process is left behind.)

This proof is bounded at both ends:
- **Upper bound on startup:** 15 s poll guards against the subprocess never
  becoming ready (configuration error, port clash, import failure).
- **Upper bound on regression detection:** 3 s external client timeout bounds
  the wait when the loop IS frozen, turning a potential hang into a clean fail.

Test is marked ``slow`` (it intentionally waits a few seconds in steady state)
and ``integration`` (it uses Docker/testcontainers + a subprocess).
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import text

from prd_mcp.web.db import Base, make_engine, make_sessionmaker
from prd_mcp.web import seed as seed_mod
from prd_mcp.web.settings import load_settings
import prd_mcp.web.models  # noqa: F401 – register auth tables on Base.metadata
import prd_mcp.web.chatmodels  # noqa: F401 – register chat tables on Base.metadata
from prd_mcp.web.chatmodels import Conversation

from tests.web.conftest import make_user_with_perms, TEST_ARGON


# ── helpers ───────────────────────────────────────────────────────────────────

def _free_port() -> int:
    """Return a currently-free TCP port on 127.0.0.1."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(base_url: str, timeout: float = 15.0) -> None:
    """Poll /healthz until the subprocess is ready or timeout is reached."""
    deadline = time.monotonic() + timeout
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{base_url}/healthz", timeout=1.0)
            if r.status_code in (200, 503):
                return  # server is up (even 503 means DB check ran → app is alive)
        except Exception as e:
            last_exc = e
        time.sleep(0.25)
    raise TimeoutError(
        f"uvicorn subprocess did not become ready within {timeout}s "
        f"(last error: {last_exc!r})"
    )


# ── test ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.slow
@pytest.mark.integration
async def test_healthz_responds_while_blocking_sync_core_is_in_flight(
    pg_url, pg_container
):
    """Real subprocess proof: /healthz responds while chat stream blocks in a worker thread.

    The blocking stub (time.sleep 30 s) in llm.chat is offloaded to a thread
    by anyio.to_thread.run_sync inside chat.py.  This test proves, over a real
    TCP socket observed from OUTSIDE the subprocess's event loop, that the loop
    stays free during that offloaded block.
    """
    # ── 1. Build schema + seed in the testcontainer DB ────────────────────────
    # Use the asyncpg URL from the pg_url fixture (session-scoped).
    eng = make_engine(pg_url)
    sm = make_sessionmaker(eng)

    # WebSettings-compatible env for seeding
    base_env = {
        "DATABASE_URL": pg_url,
        "CORS_ORIGIN": "https://prd.test",
        "ADMIN_EMAIL": "admin@ringkas.co.id",
        "ADMIN_PASSWORD": "break glass admin pw 123",
        "ENV": "dev",
        **TEST_ARGON,
    }
    settings = load_settings(base_env)

    user_id_str: str
    conv_id_str: str

    async with eng.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with sm() as s:
        await seed_mod.run_seed(s, settings)

    # Create a user with prd.ask + a conversation they own. Seed PRIOR history so the
    # next message's rewrite_query actually calls llm.chat (the offloaded blocking
    # call): rewrite_query short-circuits WITHOUT calling the LLM when history is empty
    # (the no-LLM-on-first-turn guard, Task 1). An empty conversation would never reach
    # the block — so we add one prior user+assistant turn.
    from prd_mcp.web.chatmodels import Message
    async with sm() as s:
        user = await make_user_with_perms(s, "concurrency@test.local", {"prd.read", "prd.ask"})
        await s.flush()
        user_id_str = str(user.id)

        conv = Conversation(user_id=user.id, title="prior")
        s.add(conv)
        await s.flush()
        s.add_all([
            Message(conversation_id=conv.id, seq=1, role="user", content="earlier question"),
            Message(conversation_id=conv.id, seq=2, role="assistant", content="earlier answer",
                    sources=[], grounded=True, finish_reason="complete"),
        ])
        await s.commit()
        await s.refresh(conv)
        conv_id_str = str(conv.id)

    await eng.dispose()

    # ── 2. Build env for the subprocess ───────────────────────────────────────
    # The subprocess needs an async-friendly URL (asyncpg) AND the other
    # WebSettings-required keys.  Also pass the seeded ids and the test-only
    # DOCKER_HOST so testcontainers inside subprocess would work if needed
    # (not needed here — schema is already created by the parent).
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    # Marker file the subprocess writes the instant llm.chat enters its block.
    # The parent waits for it (bounded) before probing — synchronizes the probe
    # with the block being genuinely in flight (Codex review: replaces sleep(1.5)).
    import tempfile
    marker_path = os.path.join(tempfile.mkdtemp(prefix="conc-proof-"), "entered")

    # Convert asyncpg URL → psycopg URL for the subprocess's asyncpg client.
    # The subprocess uses asyncpg (same as the parent); we just pass the same URL.
    child_env = {
        **os.environ,
        "DATABASE_URL": pg_url,
        "CORS_ORIGIN": "https://prd.test",
        "ADMIN_EMAIL": "admin@ringkas.co.id",
        "ADMIN_PASSWORD": "break glass admin pw 123",
        "ENV": "dev",
        "CONCURRENCY_USER_ID": user_id_str,
        "CONCURRENCY_BLOCK_SECONDS": "30",
        "CONCURRENCY_MARKER_FILE": marker_path,
        **TEST_ARGON,
    }

    # ── 3. Launch uvicorn subprocess (single worker) ───────────────────────────
    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "tests.web._concurrency_app:app",
                "--host", "127.0.0.1",
                "--port", str(port),
                "--workers", "1",
                "--log-level", "warning",
            ],
            env=child_env,
            cwd=str(
                # Run from mcp/ so that `tests.web._concurrency_app` is importable
                __import__("pathlib").Path(__file__).parent.parent.parent
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,  # capture for debugging on failure
        )

        # ── 4. Wait until server is ready ─────────────────────────────────────
        try:
            _wait_for_server(base_url, timeout=20.0)
        except TimeoutError:
            # Codex review: do NOT read stderr while the child is still running —
            # proc.stderr.read() would block until the pipe closes (i.e. the child
            # exits), which it may never do → the test hangs instead of failing.
            # Terminate first, THEN drain stderr via communicate() with a timeout.
            proc.terminate()
            try:
                _, stderr_out = proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                _, stderr_out = proc.communicate(timeout=5)
            pytest.fail(
                "uvicorn subprocess did not become ready.\n"
                f"stderr:\n{(stderr_out or b'').decode(errors='replace')}"
            )

        # ── 5. Fire the blocking chat POST in a background thread ─────────────
        # The POST triggers rewrite_query → llm.chat → time.sleep(30).
        # We fire it in a daemon thread so the test can continue concurrently.
        chat_started = threading.Event()
        chat_exception: list[Exception] = []

        def _fire_chat():
            try:
                httpx.post(
                    f"{base_url}/api/chat/conversations/{conv_id_str}/messages",
                    json={"content": "hello"},
                    headers={
                        "x-requested-with": "prd-app",
                        "Cookie": "",  # no real cookie; auth is overridden in subprocess
                    },
                    timeout=35.0,  # must be > BLOCK_SECONDS
                )
            except Exception as e:
                chat_exception.append(e)
            finally:
                chat_started.set()

        chat_thread = threading.Thread(target=_fire_chat, daemon=True)
        chat_thread.start()

        # Wait until the subprocess has PROVABLY entered the block (marker file
        # appears), not a fixed sleep (Codex review). This guarantees the /healthz
        # probe happens while the block is in flight — no false-pass if the POST is
        # slow to arrive. Bounded: if the block isn't entered within 10s, something
        # is wrong (POST failed before rewrite_query, auth error, etc.) → fail.
        marker_deadline = time.monotonic() + 10.0
        while time.monotonic() < marker_deadline:
            if os.path.exists(marker_path):
                break
            # If the POST thread already finished WITHOUT entering the block, the
            # block was never reached — surface that rather than waiting the full 10s.
            if chat_started.is_set() and not os.path.exists(marker_path):
                pytest.fail(
                    "chat POST completed/failed before entering llm.chat — block "
                    f"never started. POST error: {chat_exception[0] if chat_exception else 'none'}"
                )
            time.sleep(0.05)
        else:
            pytest.fail(
                "subprocess did not enter the blocking llm.chat within 10s "
                f"(marker {marker_path!r} never appeared). "
                f"POST error: {chat_exception[0] if chat_exception else 'none'}"
            )

        # ── 6. Probe /healthz from outside with a tight client timeout ─────────
        # Key invariant: this httpx request goes over a REAL TCP socket and is
        # processed by uvicorn's event loop.  If the loop is free (offload
        # working), /healthz finishes in milliseconds.  If the loop is frozen
        # (offload regressed), the connection will hang until our timeout fires.
        t0 = time.monotonic()
        try:
            healthz_resp = httpx.get(
                f"{base_url}/healthz",
                timeout=3.0,  # external timeout: bounds the wait on a frozen loop
            )
        except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.TimeoutException) as exc:
            elapsed = time.monotonic() - t0
            pytest.fail(
                f"/healthz timed out after {elapsed:.2f}s ({exc!r}).\n"
                "This means the event loop was FROZEN — the chat route ran a "
                "sync blocking call directly on the loop instead of offloading "
                "it via anyio.to_thread.run_sync.  Fix: ensure rewrite_query "
                "is called with `await anyio.to_thread.run_sync(rewrite_query, ...)`."
            )
        healthz_elapsed = time.monotonic() - t0

        # ── 7. Assertions ──────────────────────────────────────────────────────
        assert healthz_resp.status_code in (200, 503), (
            f"/healthz returned unexpected status {healthz_resp.status_code}"
        )
        assert healthz_elapsed < 2.0, (
            f"/healthz took {healthz_elapsed:.2f}s while chat was blocked — "
            "event loop was not free (sync call not offloaded to a thread)"
        )

    finally:
        # ── Teardown: kill the subprocess unconditionally ─────────────────────
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
