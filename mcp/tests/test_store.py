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
