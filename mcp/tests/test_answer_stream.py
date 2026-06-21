import asyncio
import pytest
from prd_mcp.answer import rewrite_query, answer_stream
from prd_mcp.retrieve import Retrieved
from prd_mcp.llm import make_client


# ── rewrite_query (Task 1) ─────────────────────────────────────────────────

def test_rewrite_query_empty_history_returns_latest_no_llm():
    calls = []
    def chat_fn(messages):
        calls.append(messages)
        return "SHOULD NOT BE CALLED"
    assert rewrite_query([], "what is SP3K?", chat_fn) == "what is SP3K?"
    assert calls == []  # no LLM call when there's no prior context


def test_rewrite_query_uses_history_to_make_standalone():
    history = [
        {"role": "user", "content": "tell me about referral PRDs"},
        {"role": "assistant", "content": "EP-457 covers referrals..."},
    ]
    captured = {}
    def chat_fn(messages):
        captured["messages"] = messages
        return "referral bank report dashboard PRD"
    out = rewrite_query(history, "what about the bank report one?", chat_fn)
    assert out == "referral bank report dashboard PRD"
    # the prompt must include both the history and the latest follow-up
    blob = " ".join(m["content"] for m in captured["messages"])
    assert "bank report" in blob and "referral" in blob


def test_rewrite_query_blank_latest_returns_blank_no_llm():
    calls = []
    assert rewrite_query([{"role": "user", "content": "x"}], "   ", lambda m: calls.append(m) or "y") == "   "
    assert calls == []


# ── answer_stream helpers ──────────────────────────────────────────────────

def _mk(stem="EP-1"):
    return Retrieved(doc_stem=stem, doc_id=stem, title="T", summary="s", tags=[], status="", source_url="", text="ctx", score=0.5)


async def _collect(agen):
    return [tok async for tok in agen]


# ── answer_stream tests ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_answer_stream_no_match_yields_fixed_nonanswer_no_llm():
    called = False
    async def chat_stream_fn(messages):
        nonlocal called
        called = True
        yield "X"
    toks = await _collect(answer_stream("q", [], "no_match", chat_stream_fn))
    assert "".join(toks) == "No PRD covers this."
    assert called is False


@pytest.mark.asyncio
async def test_answer_stream_match_streams_tokens_from_fn():
    async def chat_stream_fn(messages):
        for t in ["He", "llo"]:
            yield t
    toks = await _collect(answer_stream("q", [_mk()], "match", chat_stream_fn))
    assert "".join(toks) == "Hello"


# ── chat_stream tests (LlmClient) ─────────────────────────────────────────
#
# All fakes: no network. The stream_opener returns (client, ctx) where ctx is
# an async context manager whose __aenter__ yields a response-like object with
# .status_code and .aiter_lines().

class FakeResponse:
    """Fake httpx streaming response."""
    def __init__(self, status_code, lines):
        self.status_code = status_code
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class FakeCtx:
    """Async context manager wrapping a FakeResponse."""
    def __init__(self, resp):
        self._resp = resp
        self.exited = False

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *args):
        self.exited = True


class FakeClient:
    """Tracks whether aclose was called."""
    def __init__(self):
        self.closed = False

    async def aclose(self):
        self.closed = True


def _sse_lines(tokens):
    """Build SSE data lines for a list of tokens, followed by [DONE]."""
    import json
    lines = []
    for tok in tokens:
        payload = {"choices": [{"delta": {"content": tok}}]}
        lines.append(f"data: {json.dumps(payload)}")
    lines.append("data: [DONE]")
    return lines


class Cfg:
    openai_key = "sk"
    openai_base = "https://api.openai.com/v1"
    embed_model = "text-embedding-3-small"
    minimax_key = "mm"
    minimax_base = "https://fake.test/v1"
    chat_model = "minimax/MiniMax-M3"
    request_timeout = 30
    max_retries = 2


@pytest.mark.asyncio
async def test_chat_stream_yields_tokens():
    """Happy path: tokens stream correctly."""
    client = FakeClient()
    ctx = FakeCtx(FakeResponse(200, _sse_lines(["He", "llo"])))
    sleep_calls = []

    def opener(url, headers, body, timeout):
        return client, ctx

    c = make_client(Cfg())
    toks = []
    async for tok in c.chat_stream([{"role": "user", "content": "hi"}],
                                   stream_opener=opener,
                                   async_sleep=lambda s: sleep_calls.append(s) or asyncio.sleep(0)):
        toks.append(tok)
    assert "".join(toks) == "Hello"
    assert client.closed is True
    assert ctx.exited is True
    assert sleep_calls == []  # no retries needed


@pytest.mark.asyncio
async def test_chat_stream_retries_once_on_503_before_tokens():
    """503 on first attempt → retry once → 200 → tokens stream; sleep called once."""
    client1, client2 = FakeClient(), FakeClient()
    ctx1 = FakeCtx(FakeResponse(503, []))
    ctx2 = FakeCtx(FakeResponse(200, _sse_lines(["ok"])))
    sleep_calls = []
    call_n = [0]

    def opener(url, headers, body, timeout):
        call_n[0] += 1
        if call_n[0] == 1:
            return client1, ctx1
        return client2, ctx2

    c = make_client(Cfg())
    toks = []
    async for tok in c.chat_stream([{"role": "user", "content": "hi"}],
                                   stream_opener=opener,
                                   async_sleep=lambda s: sleep_calls.append(s) or asyncio.sleep(0)):
        toks.append(tok)

    assert "".join(toks) == "ok"
    assert len(sleep_calls) == 1      # exactly one backoff before retry
    assert client1.closed is True     # failed client closed
    assert client2.closed is True     # success client closed in finally
    assert call_n[0] == 2


@pytest.mark.asyncio
async def test_chat_stream_mid_stream_error_does_not_retry():
    """Error raised AFTER first token (mid-stream) propagates; no retry; no duplicate tokens."""
    client = FakeClient()
    sleep_calls = []

    class BoomResponse:
        status_code = 200

        async def aiter_lines(self):
            yield _sse_lines(["first"])[0]   # first token line
            raise RuntimeError("mid-stream drop")

    ctx = FakeCtx(BoomResponse())

    def opener(url, headers, body, timeout):
        return client, ctx

    c = make_client(Cfg())
    toks = []
    with pytest.raises(RuntimeError, match="mid-stream drop"):
        async for tok in c.chat_stream([{"role": "user", "content": "hi"}],
                                       stream_opener=opener,
                                       async_sleep=lambda s: sleep_calls.append(s) or asyncio.sleep(0)):
            toks.append(tok)

    assert toks == ["first"]          # only the one token before the crash
    assert sleep_calls == []          # no retry backoff
    assert client.closed is True      # client still closed in finally


@pytest.mark.asyncio
async def test_chat_stream_client_closed_on_connect_error_exhausted():
    """ConnectError exhausts max_retries → raises; all clients closed."""
    import httpx
    closed = []
    sleep_calls = []

    class FailCtx:
        async def __aenter__(self):
            raise httpx.ConnectError("refused")
        async def __aexit__(self, *args):
            pass

    class TrackClient:
        async def aclose(self):
            closed.append(1)

    def opener(url, headers, body, timeout):
        return TrackClient(), FailCtx()

    c = make_client(Cfg())
    with pytest.raises(httpx.ConnectError):
        async for _ in c.chat_stream([],
                                     stream_opener=opener,
                                     async_sleep=lambda s: sleep_calls.append(s) or asyncio.sleep(0)):
            pass

    # max_retries=2 → 3 total attempts (0,1,2), 2 sleeps
    assert len(closed) == 3
    assert len(sleep_calls) == 2
