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
    # Thin card fields (Atlas pattern): metadata only.
    for f in ("id", "title", "summary", "tags", "status", "source_url", "obsidian_link", "score"):
        assert f in out["results"][0]
    # Hard guarantee: NO body/chunk text on search results.
    assert "text" not in out["results"][0]
    assert "body" not in out["results"][0]
    assert "snippet" not in out["results"][0]


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


def test_keyword_search_returns_distinct_thin_cards(monkeypatch):
    # Patches the binding keyword_retrieve uses (retrieve module) — by patching,
    # not by accident. Snippet is now intentionally absent (Atlas pattern).
    import prd_mcp.retrieve as ret
    monkeypatch.setattr(ret, "read_body_by_stem", _no_body)
    store = FakeStore(kw=[krow("EP-1-a"), krow("EP-2-b")])
    out = keyword_search_impl(Cfg(), store, FakeLlm(), "bank dashboard", 10)
    assert out["count"] == 2
    assert [r["id"] for r in out["results"]] == ["EP-1", "EP-2"]
    assert out["results"][0]["obsidian_link"] == "[[EP-1-a]]"
    # Thin card contract — no body, no snippet.
    assert "snippet" not in out["results"][0]
    assert "text" not in out["results"][0]
    assert "body" not in out["results"][0]
    # Summary IS present (it's metadata, not evidence).
    assert out["results"][0]["summary"] == "Original Summary"


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


# --- Atlas pattern: thin cards vs full bodies -------------------------------

def test_search_prds_returns_thin_cards_no_text_no_body():
    """Atlas pattern contract: search returns metadata only, no chunk text, no
    body. Agents triage cheaply off these and call read_prd() for evidence."""
    store = FakeStore(sem=[srow("EP-1-a", 0.1), srow("EP-2-b", 0.2)])
    out = search_prds_impl(Cfg(), store, FakeLlm(), "q", 8)
    assert out["count"] == 2
    for r in out["results"]:
        # These three fields MUST NOT appear — they would be evidence, not metadata.
        assert "text" not in r, f"card leaked chunk text: {r}"
        assert "body" not in r, f"card leaked vault body: {r}"
        assert "snippet" not in r, f"card leaked snippet: {r}"
        # Metadata fields ARE present.
        assert r["id"] and r["title"] and r["summary"] != "" or r["summary"] == ""
        assert isinstance(r["tags"], list)
        assert r["obsidian_link"].startswith("[[")


def test_ask_prds_still_returns_full_chunks_for_grounding():
    """ask_prds must keep its grounding contract: sources include bodies for
    the LLM to cite. Only search/library/card endpoints drop the body."""
    # ask_prds uses build_messages which embeds r.text into the prompt context.
    # We assert the prompt payload contains the chunk text — that's the whole
    # point of ask vs search.
    from prd_mcp.answer import build_messages
    from prd_mcp.retrieve import Retrieved
    r = Retrieved(doc_stem="EP-1-a", doc_id="EP-1", title="T", summary="s",
                  tags=["t"], status="x", source_url="u", text="chunk body text",
                  score=0.9)
    msgs = build_messages("what is X?", [r])
    assert "chunk body text" in msgs[1]["content"], "ask grounding lost the body"
    assert msgs[1]["content"].startswith("Question:")


def test_read_body_returns_vault_body_not_chunk_text():
    """read_body returns the canonical vault body (frontmatter stripped),
    not the chunk text from the index. Chunks carry overlap windows and are
    not canonical."""
    from prd_mcp.retrieve import read_body
    from prd_mcp.vault import Doc

    docs = {
        "/v/EP-437-long.md": Doc(
            stem="EP-437-long", id="EP-437", title="Long PRD", source_url="u",
            status="Released", platform=[], tags=["x"], summary="s",
            body_hash="h", body="# Full body\n\nThe canonical evidence.",
        )
    }
    list_fn = lambda prds_dir: list(docs.keys())
    read_fn = lambda path: docs[path]
    # Stem-first path: stem lookup hits, returns body directly.
    body = read_body(
        "EP-437-long", "/v",
        read_body_by_stem_fn=lambda stem, prds_dir: docs["/v/EP-437-long.md"].body,
    )
    assert body == "# Full body\n\nThe canonical evidence."
    # Id-fallback path: stem misses, walks vault to resolve EP-437 -> EP-437-long.
    body_by_id = read_body(
        "EP-437", "/v",
        read_body_by_stem_fn=lambda *a, **k: "",
        list_docs_fn=list_fn, read_doc_fn=read_fn,
    )
    assert body_by_id == "# Full body\n\nThe canonical evidence."
    # Unknown id -> None
    miss = read_body("EP-999", "/v",
                     read_body_by_stem_fn=lambda *a, **k: "",
                     list_docs_fn=list_fn, read_doc_fn=read_fn)
    assert miss is None
    # Blank -> None without walking vault
    blank = read_body("  ", "/v",
                      read_body_by_stem_fn=lambda *a, **k: "",
                      list_docs_fn=lambda p: (_ for _ in ()).throw(AssertionError("should not walk")),
                      read_doc_fn=read_fn)
    assert blank is None
