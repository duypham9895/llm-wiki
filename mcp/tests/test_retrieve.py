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
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "match"
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
    assert out[0].text == "a1" and out[0].summary == "sum"
    assert round(out[0].score, 3) == 0.9
    assert related == []  # no wikilinks in this corpus


def test_verdict_no_match_when_all_below_threshold():
    store = FakeStore([row("EP-9-z", "x", 1.2)])  # score -0.2 < -0.15
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "no_match" and out == [] and related == []


def test_empty_query_no_embed_call():
    called = {"n": 0}
    def embed(texts): called["n"] += 1; return [[1.0]]
    out, verdict, related = retrieve("   ", FakeStore([row("EP-1-a", "x", 0.1)]), embed, 8, -0.15)
    assert verdict == "no_match" and out == [] and called["n"] == 0 and related == []


# ── wikilink graph following ───────────────────────────────────────────────

class FakeStoreWithCards(FakeStore):
    """Extends FakeStore with the subset of store API retrieve() now touches to
    resolve wikilink targets into CardMetadata."""
    def __init__(self, rows=None, kw_rows=None, cards=None):
        super().__init__(rows=rows, kw_rows=kw_rows)
        self._cards = cards or []
    def list_cards(self, limit=50, status=None, tag=None, cursor=None, limit_=None):
        return {"results": list(self._cards), "next_cursor": None}


def test_wikilink_following_resolves_related_prd():
    # EP-1's body wikilinks EP-9. Both should appear: EP-1 in top results,
    # EP-9 as a related card.
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "see [[EP-9]] for details", 0.1)],
        cards=[{"id": "EP-9", "title": "Title EP-9-z", "summary": "sum9"}],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "match"
    assert [r.doc_id for r in out] == ["EP-1-"]
    assert related == [{"id": "EP-9", "title": "Title EP-9-z", "summary": "sum9"}]


def test_wikilink_following_dedupes_top_wins():
    # EP-1 (top result) is wikilinked from EP-1-a's body -> dedupe suppresses.
    # The wikilink text `[[EP-1]]` resolves to id "EP-1", which matches
    # EP-1-a's truncated doc_id "EP-1-". In production doc_id is canonical,
    # so the dedupe works on full ids — same logic in both worlds.
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "see [[EP-1]]", 0.1),
              row("EP-9-z", "y", 0.2)],
        cards=[{"id": "EP-9", "title": "T9", "summary": "s9"}],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert [r.doc_id for r in out] == ["EP-1-", "EP-9-"]
    assert related == []  # dedupe: top wins (EP-1 == top's doc_id prefix)


def test_wikilink_caps_at_five():
    # Body wikilinks 10 PRDs; only first 5 should appear in related.
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "[[EP-2]] [[EP-3]] [[EP-4]] [[EP-5]] [[EP-6]] "
                          "[[EP-7]] [[EP-8]] [[EP-9]] [[EP-10]] [[EP-11]]", 0.1)],
        cards=[{"id": f"EP-{n}", "title": f"T{n}", "summary": f"s{n}"}
               for n in range(2, 12)],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert len(related) == 5
    # First-seen order preserved (EP-2 .. EP-6).
    assert [c["id"] for c in related] == ["EP-2", "EP-3", "EP-4", "EP-5", "EP-6"]


def test_wikilink_skips_unknown_targets():
    # EP-999 not in store -> silently skipped (no card for it).
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "[[EP-2]] [[EP-999]]", 0.1)],
        cards=[{"id": "EP-2", "title": "T2", "summary": "s2"}],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert [c["id"] for c in related] == ["EP-2"]


def test_wikilink_one_hop_only():
    # EP-1 wikilinks EP-2; EP-2's body (if it appeared) would wikilink EP-3.
    # We must NOT recurse — EP-3 should never appear even if its card exists.
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "see [[EP-2]]", 0.1)],
        cards=[{"id": "EP-2", "title": "T2", "summary": "s2"},
               {"id": "EP-3", "title": "T3", "summary": "s3"}],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert [c["id"] for c in related] == ["EP-2"]  # EP-3 NOT surfaced


def test_wikilink_dedupes_within_corpus():
    # Same EP referenced twice in different chunks -> only one entry in related.
    store = FakeStoreWithCards(
        rows=[row("EP-1-a", "see [[EP-9]] here", 0.1),
              row("EP-2-b", "and [[EP-9]] again", 0.2)],
        cards=[{"id": "EP-9", "title": "T9", "summary": "s9"}],
    )
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert [r.doc_id for r in out] == ["EP-1-", "EP-2-"]
    assert [c["id"] for c in related] == ["EP-9"]


def test_wikilink_no_match_no_related():
    # Verdict no_match -> related is empty list (not None).
    store = FakeStoreWithCards(rows=[row("EP-9-z", "[[EP-1]]", 1.2)])  # below threshold
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "no_match" and related == []


def test_wikilink_store_without_list_cards_safe():
    # Real chromadb Store has list_cards, but a degenerate test store that
    # doesn't must not crash retrieve.
    store = FakeStore(rows=[row("EP-1-a", "[[EP-9]]", 0.1)])  # no list_cards
    out, verdict, related = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert [r.doc_id for r in out] == ["EP-1-"]
    assert related == []  # unresolved, no crash


def kwrow(stem, summary="sum"):
    return {"text": "the lowercased keyword chunk text", "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": summary, "chunk_type": "keyword"}}


def test_keyword_retrieve_lowercases_splits_drops_short_tokens():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "Real Summary")])
    # original-case body contains "SP3K" -> snippet drawn from it
    bodies = {"EP-1-a": "Intro about the SP3K Notification flow and more"}
    out, related = keyword_retrieve("SP3K  A of", store, 10, "/v",
                                    read_body_fn=lambda stem, prds, **kw: bodies.get(stem, ""))
    # "a"(1) dropped, "of"(2) kept, "sp3k"(4) kept
    assert store.kw_calls[-1] == ["sp3k", "of"]
    assert [r.doc_stem for r in out] == ["EP-1-a"]
    # snippet is ORIGINAL case (from body), not the lowercased keyword text
    assert "SP3K Notification" in out[0].text
    assert related == []  # no wikilinks in this corpus


def test_keyword_retrieve_snippet_prefers_summary_when_it_contains_term():
    # Spec §3: summary FIRST when it contains the matched word, even if a body exists.
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The SP3K rollout summary")])
    out, _ = keyword_retrieve("sp3k", store, 10, "/v",
                              read_body_fn=lambda stem, prds, **kw: "a long body that ALSO has sp3k in it")
    assert out[0].text == "The SP3K rollout summary"  # summary chosen, not the body window


def test_keyword_retrieve_snippet_falls_back_to_summary_when_body_missing():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out, _ = keyword_retrieve("sp3k", store, 10, "/v",
                              read_body_fn=lambda stem, prds, **kw: "")  # no body
    assert out[0].text == "The Summary Text"  # fell back to summary


def test_keyword_retrieve_snippet_falls_back_when_term_absent_from_body():
    # body EXISTS but does not contain the matched term (it matched via title/id/tags)
    # -> must fall back to summary, NOT return an arbitrary body[:200] (Codex F3)
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out, _ = keyword_retrieve("sp3k", store, 10, "/v",
                              read_body_fn=lambda stem, prds, **kw: "body without the term at all")
    assert out[0].text == "The Summary Text"  # summary, not "body without..."


def test_keyword_retrieve_all_short_tokens_returns_empty():
    store = FakeStore(kw_rows=[kwrow("EP-1-a")])
    out, related = keyword_retrieve("a", store, 10, "/v",
                                    read_body_fn=lambda *a, **k: "")
    assert out == [] and store.kw_calls == [] and related == []  # never queried


def test_keyword_retrieve_dedupes_distinct_prds():
    store = FakeStore(kw_rows=[kwrow("EP-1-a"), kwrow("EP-2-b")])
    out, _ = keyword_retrieve("bank dashboard", store, 10, "/v",
                              read_body_fn=lambda *a, **k: "")
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]


# ── keyword_retrieve wikilink graph ─────────────────────────────────────────

def test_keyword_retrieve_wikilink_following():
    store = FakeStoreWithCards(
        kw_rows=[kwrow("EP-1-a")],
        cards=[{"id": "EP-9", "title": "T9", "summary": "s9"}],
    )
    bodies = {"EP-1-a": "see [[EP-9]] for context"}
    out, related = keyword_retrieve("sp3k", store, 10, "/v",
                                    read_body_fn=lambda s, p, **kw: bodies.get(s, ""))
    assert [r.doc_stem for r in out] == ["EP-1-a"]
    assert related == [{"id": "EP-9", "title": "T9", "summary": "s9"}]


def test_keyword_retrieve_empty_query_returns_empty_tuple():
    store = FakeStoreWithCards()
    out, related = keyword_retrieve("a", store, 10, "/v",
                                    read_body_fn=lambda *a, **k: "")
    assert out == [] and related == [] and store.kw_calls == []
