from prd_mcp.vault import Doc
from prd_mcp.chunk import chunk_doc
from prd_mcp.store import Store


def mk(stem, body, summary="S"):
    d = Doc(stem=stem, id="EP-1", title="T", source_url="u", status="x",
            platform=[], tags=["t"], summary=summary, body_hash="h", body=body)
    return chunk_doc(d, 1000, 150)


def test_upsert_query_hashes(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    ch = mk("EP-1-a", "alpha beta")
    s.upsert(ch, [[1.0, 0.0]] * len(ch), "hash-1")
    assert s.stored_hashes() == {"EP-1-a": "hash-1"}
    res = s.query([1.0, 0.0], 5)
    assert len(res) >= 1 and res[0]["metadata"]["doc_stem"] == "EP-1-a"
    assert "title" in res[0]["metadata"]


def test_delete(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    a = mk("EP-1-a", "x"); b = mk("EP-2-b", "y")
    s.upsert(a, [[1.0, 0.0]] * len(a), "h1"); s.upsert(b, [[0.0, 1.0]] * len(b), "h2")
    s.delete_by_doc("EP-1-a")
    assert set(s.stored_hashes().keys()) == {"EP-2-b"}


def test_query_excludes_keyword_chunk(tmp_path):
    # A keyword chunk with a vector identical to the query must NOT be returned by semantic query.
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    d = Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
            platform=[], tags=["t"], summary="S", body_hash="h", body="alpha beta")
    chunks = chunk_doc(d, 1000, 150)
    # give EVERY chunk the same embedding so the keyword chunk would rank top if not excluded
    s.upsert(chunks, [[1.0, 0.0]] * len(chunks), "h1")
    res = s.query([1.0, 0.0], 10)
    assert res, "semantic query returned nothing"
    assert all(r["metadata"]["chunk_type"] != "keyword" for r in res)


def test_keyword_query_case_insensitive_and_and_of_words(tmp_path):
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    d1 = Doc(stem="EP-1-a", id="EP-1", title="Bank Report Dashboard", source_url="u",
             status="x", platform=[], tags=["KPR"], summary="S", body_hash="h",
             body="The SP3K notification and KPR flow")
    d2 = Doc(stem="EP-2-b", id="EP-2", title="Other", source_url="u",
             status="x", platform=[], tags=[], summary="S", body_hash="h", body="unrelated content")
    for d in (d1, d2):
        ch = chunk_doc(d, 1000, 150)
        s.upsert(ch, [[0.0, 1.0]] * len(ch), "h")
    # case-insensitive single term (query already lowercased by caller)
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["sp3k"], 10)} == {"EP-1-a"}
    # id (lives in keyword-chunk text) still matched
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["ep-1"], 10)} == {"EP-1-a"}
    # AND-of-words: both present, any order
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["bank", "dashboard"], 10)} == {"EP-1-a"}
    assert s.keyword_query(["bank", "nonexistentword"], 10) == []


def test_keyword_query_respects_k_limit(tmp_path):
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    # 3 docs all containing "shared" in their keyword chunk
    for i in range(3):
        d = Doc(stem=f"EP-{i}-x", id=f"EP-{i}", title="T", source_url="u", status="x",
                platform=[], tags=[], summary="S", body_hash="h", body="shared term here")
        ch = chunk_doc(d, 1000, 150)
        s.upsert(ch, [[0.0, 1.0]] * len(ch), "h")
    rows = s.keyword_query(["shared"], 2)
    assert len(rows) == 2  # capped at k even though 3 match
