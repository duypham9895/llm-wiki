from prd_mcp.retrieve import retrieve, keyword_retrieve


class FakeStore:
    def __init__(self, rows=None, kw_rows=None):
        self.rows = rows or []
        self.kw_rows = kw_rows or []
        self.kw_calls = []
    def query(self, embedding, k): return self.rows[:k]
    def keyword_query(self, terms, k):
        self.kw_calls.append(terms)
        return self.kw_rows[:k]


def row(stem, text, dist, summary="sum"):
    return {"text": text, "distance": dist, "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": summary, "chunk_type": "body"}}


def test_dedupe_distinct_prds_and_verdict_match():
    store = FakeStore([row("EP-1-a", "a1", 0.1), row("EP-1-a", "a2", 0.2), row("EP-2-b", "b1", 0.3)])
    out, verdict = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "match"
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
    assert out[0].text == "a1" and out[0].summary == "sum"
    assert round(out[0].score, 3) == 0.9


def test_verdict_no_match_when_all_below_threshold():
    store = FakeStore([row("EP-9-z", "x", 1.2)])  # score -0.2 < -0.15
    out, verdict = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "no_match" and out == []


def test_empty_query_no_embed_call():
    called = {"n": 0}
    def embed(texts): called["n"] += 1; return [[1.0]]
    out, verdict = retrieve("   ", FakeStore([row("EP-1-a", "x", 0.1)]), embed, 8, -0.15)
    assert verdict == "no_match" and out == [] and called["n"] == 0


def kwrow(stem, summary="sum"):
    return {"text": "the lowercased keyword chunk text", "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": summary, "chunk_type": "keyword"}}


def test_keyword_retrieve_lowercases_splits_drops_short_tokens():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "Real Summary")])
    # original-case body contains "SP3K" -> snippet drawn from it
    bodies = {"EP-1-a": "Intro about the SP3K Notification flow and more"}
    out = keyword_retrieve("SP3K  A of", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: bodies.get(stem, ""))
    # "a"(1) dropped, "of"(2) kept, "sp3k"(4) kept
    assert store.kw_calls[-1] == ["sp3k", "of"]
    assert [r.doc_stem for r in out] == ["EP-1-a"]
    # snippet is ORIGINAL case (from body), not the lowercased keyword text
    assert "SP3K Notification" in out[0].text


def test_keyword_retrieve_snippet_prefers_summary_when_it_contains_term():
    # Spec §3: summary FIRST when it contains the matched word, even if a body exists.
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The SP3K rollout summary")])
    out = keyword_retrieve("sp3k", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: "a long body that ALSO has sp3k in it")
    assert out[0].text == "The SP3K rollout summary"  # summary chosen, not the body window


def test_keyword_retrieve_snippet_falls_back_to_summary_when_body_missing():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out = keyword_retrieve("sp3k", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: "")  # no body
    assert out[0].text == "The Summary Text"  # fell back to summary


def test_keyword_retrieve_snippet_falls_back_when_term_absent_from_body():
    # body EXISTS but does not contain the matched term (it matched via title/id/tags)
    # -> must fall back to summary, NOT return an arbitrary body[:200] (Codex F3)
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out = keyword_retrieve("sp3k", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: "body without the term at all")
    assert out[0].text == "The Summary Text"  # summary, not "body without..."


def test_keyword_retrieve_all_short_tokens_returns_empty():
    store = FakeStore(kw_rows=[kwrow("EP-1-a")])
    out = keyword_retrieve("a", store, 10, "/v", read_body_fn=lambda *a, **k: "")
    assert out == [] and store.kw_calls == []  # never queried


def test_keyword_retrieve_dedupes_distinct_prds():
    store = FakeStore(kw_rows=[kwrow("EP-1-a"), kwrow("EP-2-b")])
    out = keyword_retrieve("bank dashboard", store, 10, "/v",
                           read_body_fn=lambda *a, **k: "")
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
