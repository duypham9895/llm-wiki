import pytest
from prd_mcp.server import (search_prds_impl, ask_prds_impl,
                            keyword_search_impl, read_prd_impl)


class Cfg:
    top_k = 8
    score_threshold = -0.15
    prds_dir = "/v"


class FakeStore:
    def __init__(self, has_index=True, sem=None, kw=None):
        self._has = has_index
        self._sem = sem or []
        self._kw = kw or []
        self.touched = False
    def stored_hashes(self):
        self.touched = True
        return {"x": "h"} if self._has else {}
    def query(self, vec, k): self.touched = True; return self._sem[:k]
    def keyword_query(self, terms, k): self.touched = True; return self._kw[:k]


class BoomStore:
    # fails loudly if touched at all — proves empty-query guard runs first
    def stored_hashes(self): raise AssertionError("store touched on empty query")
    def query(self, vec, k): raise AssertionError("store touched on empty query")
    def keyword_query(self, terms, k): raise AssertionError("store touched on empty query")


class FakeLlm:
    def __init__(self): self.embed_calls = 0
    def embed(self, texts): self.embed_calls += 1; return [[0.0, 1.0]]
    def chat(self, msgs): return "answer prose"


def _doc_id(stem):
    # "EP-1-a" -> "EP-1" (the real id is the first two dash-segments, not stem[:5]
    # which would wrongly yield "EP-1-" with a trailing hyphen)
    return "-".join(stem.split("-")[:2])


def srow(stem, dist):
    return {"text": "body", "distance": dist, "metadata": {
        "doc_stem": stem, "doc_id": _doc_id(stem), "title": f"T {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": "sum", "chunk_type": "body"}}


def krow(stem):
    return {"text": "kw text lowercased", "metadata": {
        "doc_stem": stem, "doc_id": _doc_id(stem), "title": f"T {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": "Original Summary", "chunk_type": "keyword"}}


def _no_body(stem, prds_dir, **kw): return ""  # snippet falls back to summary in these tests


def test_search_prds_includes_verdict_match():
    store = FakeStore(sem=[srow("EP-1-a", 0.1)])
    out = search_prds_impl(Cfg(), store, FakeLlm(), "q", 8)
    assert out["verdict"] == "match" and out["count"] == 1
    assert out["results"][0]["id"] == "EP-1" and "score" in out["results"][0]
    # backward-compat: all v1 fields still present
    for f in ("id", "title", "summary", "tags", "status", "source_url", "obsidian_link", "snippet", "score"):
        assert f in out["results"][0]


def test_search_prds_verdict_no_match():
    out = search_prds_impl(Cfg(), FakeStore(sem=[srow("EP-9-z", 1.3)]), FakeLlm(), "q", 8)
    assert out["verdict"] == "no_match" and out["results"] == [] and out["count"] == 0


def test_search_prds_empty_query_does_not_touch_store():
    out = search_prds_impl(Cfg(), BoomStore(), FakeLlm(), "   ", 8)
    assert out["verdict"] == "no_match" and out["count"] == 0


def test_search_prds_empty_index_raises():
    with pytest.raises(RuntimeError, match="index"):
        search_prds_impl(Cfg(), FakeStore(has_index=False), FakeLlm(), "q", 8)


def test_ask_prds_no_match_no_llm():
    llm = FakeLlm()
    out = ask_prds_impl(Cfg(), FakeStore(sem=[srow("EP-9-z", 1.3)]), llm, "q")
    assert out["grounded"] is False and out["sources"] == []


def test_ask_prds_match_returns_answer():
    out = ask_prds_impl(Cfg(), FakeStore(sem=[srow("EP-1-a", 0.1)]), FakeLlm(), "q")
    assert out["grounded"] is True and out["answer"] == "answer prose"
    assert out["sources"][0]["id"] == "EP-1"


def test_keyword_search_returns_distinct_with_snippet(monkeypatch):
    # Patch the binding keyword_retrieve actually uses (retrieve module), so the
    # body read returns "" and the snippet falls back to the summary — by the
    # patch, not by accident (Codex/Claude minor).
    import prd_mcp.retrieve as ret
    monkeypatch.setattr(ret, "read_body_by_stem", _no_body)
    store = FakeStore(kw=[krow("EP-1-a"), krow("EP-2-b")])
    out = keyword_search_impl(Cfg(), store, FakeLlm(), "bank dashboard", 10)
    assert out["count"] == 2
    assert [r["id"] for r in out["results"]] == ["EP-1", "EP-2"]
    assert out["results"][0]["snippet"] == "Original Summary"  # snippet populated (not empty)
    assert out["results"][0]["obsidian_link"] == "[[EP-1-a]]"


def test_keyword_search_empty_query_does_not_touch_store():
    out = keyword_search_impl(Cfg(), BoomStore(), FakeLlm(), "  ", 10)
    assert out["count"] == 0 and out["results"] == []


def test_keyword_search_all_short_tokens_does_not_touch_store():
    # "a b" is non-blank but every token is <2 chars -> zero usable tokens.
    # Must return empty WITHOUT touching the store (Codex N2).
    out = keyword_search_impl(Cfg(), BoomStore(), FakeLlm(), "a b", 10)
    assert out["count"] == 0 and out["results"] == []


def test_keyword_search_empty_index_raises():
    with pytest.raises(RuntimeError, match="index"):
        keyword_search_impl(Cfg(), FakeStore(has_index=False), FakeLlm(), "kpr", 10)


def test_read_prd_impl_found_and_missing():
    from prd_mcp.vault import Doc
    docs = {"/v/EP-1-a.md": Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u",
                                status="x", platform=[], tags=["a"], summary="s",
                                body_hash="h", body="the body")}
    import prd_mcp.server as srv
    out = srv.read_prd_impl(Cfg(), "EP-1",
                            list_docs_fn=lambda p: list(docs.keys()), read_doc_fn=lambda p: docs[p])
    assert out["found"] is True and out["body"] == "the body"
    miss = srv.read_prd_impl(Cfg(), "EP-404",
                             list_docs_fn=lambda p: list(docs.keys()), read_doc_fn=lambda p: docs[p])
    assert miss["found"] is False
