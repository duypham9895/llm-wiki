import pytest
from prd_mcp.server import search_prds_impl, ask_prds_impl
from prd_mcp.retrieve import Retrieved


class FakeStore:
    def __init__(self, hashes, rows): self._h = hashes; self.rows = rows
    def stored_hashes(self): return self._h
    def query(self, embedding, k): return self.rows[:k]


class FakeLlm:
    def embed(self, texts): return [[1.0, 0.0]]
    def chat(self, messages): return "synth answer"


def row(stem):
    return {"text": f"body {stem}", "distance": 0.1, "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"T {stem}", "source_url": f"https://n/{stem}",
        "status": "x", "tags": "a,b", "summary": "the summary", "chunk_type": "body"}}


class Cfg:
    top_k = 8


def test_search_returns_structured_results():
    store = FakeStore({"EP-1-a": "h"}, [row("EP-1-a")])
    out = search_prds_impl(Cfg(), store, FakeLlm(), "referral", 8)
    assert out["count"] == 1
    r0 = out["results"][0]
    assert r0["id"] == "EP-1-" and r0["title"] == "T EP-1-a"
    assert r0["summary"] == "the summary" and r0["tags"] == ["a", "b"]
    assert r0["obsidian_link"] == "[[EP-1-a]]" and r0["source_url"] == "https://n/EP-1-a"
    assert "snippet" in r0 and "score" in r0


def test_search_empty_index_errors():
    store = FakeStore({}, [])
    with pytest.raises(Exception, match="index"):
        search_prds_impl(Cfg(), store, FakeLlm(), "q", 8)


def test_ask_returns_answer_and_sources():
    store = FakeStore({"EP-1-a": "h"}, [row("EP-1-a")])
    out = ask_prds_impl(Cfg(), store, FakeLlm(), "what is EP-1?")
    assert out["answer"] == "synth answer" and out["grounded"] is True
    assert out["sources"][0]["obsidian_link"] == "[[EP-1-a]]"


def test_ask_empty_index_errors():
    store = FakeStore({}, [])
    with pytest.raises(Exception, match="index"):
        ask_prds_impl(Cfg(), store, FakeLlm(), "q")
