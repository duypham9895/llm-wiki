import pytest
from prd_mcp.llm import make_client


class Cfg:
    openai_key="sk"; openai_base="https://api.openai.com/v1"; embed_model="text-embedding-3-small"
    minimax_key="mm"; minimax_base="https://9router-1.dat-nguyen.me/v1"; chat_model="minimax/MiniMax-M3"
    request_timeout=30; max_retries=2


def test_embed_parses():
    calls = []
    def fake(url, headers, body): calls.append((url, body)); return {"data":[{"embedding":[0.1,0.2]},{"embedding":[0.3,0.4]}]}
    c = make_client(Cfg(), http_post=fake, sleep_fn=lambda s: None)
    assert c.embed(["a","b"]) == [[0.1,0.2],[0.3,0.4]]
    assert calls[0][0].endswith("/embeddings") and calls[0][1]["model"] == "text-embedding-3-small"


def test_chat_stream_false_and_content():
    cap = {}
    def fake(url, headers, body): cap.update(body); return {"choices":[{"message":{"content":"the answer"}}]}
    c = make_client(Cfg(), http_post=fake, sleep_fn=lambda s: None)
    assert c.chat([{"role":"user","content":"hi"}]) == "the answer"
    assert cap["stream"] is False and cap["model"] == "minimax/MiniMax-M3"


def test_retries_then_succeeds():
    st = {"n":0}
    def flaky(url, headers, body):
        st["n"] += 1
        if st["n"] < 2:
            e = Exception("503"); e.status = 503; raise e
        return {"data":[{"embedding":[1.0]}]}
    c = make_client(Cfg(), http_post=flaky, sleep_fn=lambda s: None)
    assert c.embed(["x"]) == [[1.0]] and st["n"] == 2
