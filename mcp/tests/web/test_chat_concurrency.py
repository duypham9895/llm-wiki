"""Single-worker non-blocking proof.

Verifies the load-bearing design claim: a slow (blocking) sync core call that
the chat route offloads via anyio.to_thread.run_sync does NOT freeze the event
loop.  While the blocking call is provably in flight, a concurrent /healthz
request must still return in milliseconds.

Design (Codex iter-4 / iter-5 hardened):
  - ``blocking_rewrite`` sets ``entered`` then parks on ``release.wait()`` with
    NO timeout — so the block is held open indefinitely until the test releases
    it.  This makes the concurrent /healthz probe deterministic: entered.set()
    guarantees the thread is blocked; release.wait() guarantees it STAYS blocked
    while /healthz is being measured.
  - Correct (offloaded) design: rewrite runs in a worker thread, event loop is
    free, /healthz returns in ms.
  - Broken (non-offloaded) design: rewrite runs on the event loop, loop is
    frozen, /healthz cannot complete — anyio.fail_after(1.0) trips and the test
    fails.
  - ``finally: release.set()`` lets the held thread finish so the task group
    can exit cleanly.  The pytest/anyio test-level timeout prevents any hang.
"""
from __future__ import annotations

import threading
import time
import anyio
import pytest


class _FakeR:
    doc_stem = "EP-1"
    doc_id = "EP-1"
    title = "T"
    source_url = ""
    summary = "s"
    tags = []
    status = ""
    text = "ctx"
    score = 0.5


@pytest.mark.asyncio
async def test_healthz_responds_while_blocking_sync_core_is_in_flight(
    client_prd_ask, conv_id, monkeypatch
):
    """Proves the event loop stays free while a sync core call is in flight.

    The monkeypatched ``blocking_rewrite`` is a REAL synchronous block
    (threading.Event.wait with no timeout), NOT a fast lambda.  If the route
    ran it on the event loop the loop would be frozen; /healthz would be
    unable to return until ``release`` is set.  Only an offloaded (worker
    thread) design keeps the loop free and lets /healthz respond in ms.
    """
    import prd_mcp.web.chat as chatmod

    # Two events make the probe DETERMINISTIC (Codex iter-4):
    #   entered — set the moment blocking_rewrite begins executing (in whichever
    #             context runs it — worker thread if offloaded, loop if not).
    #   release — held open until the test explicitly releases it, keeping the
    #             blocking call in flight for the entire duration of the probe.
    entered = threading.Event()
    release = threading.Event()

    def blocking_rewrite(history, latest, fn):
        entered.set()       # signal: the blocking section is now executing
        release.wait()      # NO timeout (Codex iter-5): hold until test lets go.
                            # A non-offloaded event loop stays frozen here until
                            # release is set; fail_after(1.0) will then trip.
        return latest

    def blocking_retrieve(q, store, embed, k, th):
        return ([_FakeR()], "match")

    async def fast_stream(question, retrieved, verdict, fn):
        yield "ok"

    monkeypatch.setattr(chatmod, "rewrite_query", blocking_rewrite)
    monkeypatch.setattr(chatmod, "retrieve", blocking_retrieve)
    monkeypatch.setattr(chatmod, "answer_stream", fast_stream)

    async with anyio.create_task_group() as tg:

        async def start_stream():
            await client_prd_ask.post(
                f"/api/chat/conversations/{conv_id}/messages",
                json={"content": "hi"},
                headers={"x-requested-with": "prd-app"},
            )

        tg.start_soon(start_stream)
        try:
            # Wait (in a worker thread so the loop stays free) until the blocking
            # call is provably entered.  Timeout of 2 s prevents a deadlock if
            # the route never reaches rewrite_query (e.g. auth failure).
            entered_in_time = await anyio.to_thread.run_sync(entered.wait, 2.0)
            assert entered_in_time, (
                "blocking_rewrite was never entered within 2 s — "
                "stream may have failed before reaching rewrite_query"
            )

            # The block is NOW held open (release not yet set).
            # In a correct offloaded design:
            #   rewrite runs in a worker thread → loop is free → /healthz
            #   returns in ms.
            # In a broken non-offloaded design:
            #   rewrite runs on the loop → loop is frozen → /healthz cannot
            #   complete → fail_after(1.0) trips → test fails.
            h0 = time.monotonic()
            with anyio.fail_after(1.0):
                r = await client_prd_ask.get("/healthz")
            h_elapsed = time.monotonic() - h0

            assert r.status_code in (200, 503), (
                f"/healthz returned unexpected status {r.status_code}"
            )
            assert h_elapsed < 0.3, (
                f"/healthz blocked for {h_elapsed:.2f}s while rewrite_query "
                f"was in flight — event loop was NOT free (sync call not offloaded)"
            )
        finally:
            # Let the held blocking call finish so start_stream can complete
            # and the task group exits cleanly.
            release.set()
