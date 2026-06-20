from prd_mcp.vault import Doc
from prd_mcp.chunk import chunk_doc


def mk(body, summary="S"):
    return Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
               platform=["CRM"], tags=["t"], summary=summary, body_hash="h", body=body)


def test_summary_is_own_chunk():
    cs = chunk_doc(mk("short body"), 1000, 150)
    s = [c for c in cs if c.chunk_type == "summary"]
    assert len(s) == 1 and s[0].text == "S" and s[0].doc_id == "EP-1"


def test_small_body_one_chunk():
    cs = [c for c in chunk_doc(mk("short body"), 1000, 150) if c.chunk_type == "body"]
    assert len(cs) == 1 and cs[0].text == "short body" and cs[0].index == 0


def test_large_body_overlap():
    cs = [c for c in chunk_doc(mk("x" * 2500), 1000, 150) if c.chunk_type == "body"]
    assert len(cs) >= 3
    assert cs[0].text[-150:] == cs[1].text[:150]
    assert [c.index for c in cs] == list(range(len(cs)))


def test_no_summary():
    cs = chunk_doc(mk("body", summary=None), 1000, 150)
    assert not any(c.chunk_type == "summary" for c in cs)


def test_empty_body():
    cs = chunk_doc(mk("", summary="only"), 1000, 150)
    assert not any(c.chunk_type == "body" for c in cs)
    assert any(c.chunk_type == "summary" for c in cs)
