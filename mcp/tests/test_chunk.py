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


def test_build_keyword_chunk_lowercased_and_includes_metadata():
    from prd_mcp.chunk import build_keyword_chunk
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-7-x", id="EP-7", title="Referral CODE", source_url="u",
            status="Released", platform=["CRM"], tags=["KPR", "Affiliate"],
            summary="S", body_hash="h", body="The SP3K Notification flow")
    ch = build_keyword_chunk(d)
    assert ch.chunk_type == "keyword"
    assert ch.index == 0
    # everything lowercased; body + title + id + tags all present
    assert "sp3k notification" in ch.text
    assert "referral code" in ch.text
    assert "ep-7" in ch.text
    assert "kpr" in ch.text and "affiliate" in ch.text
    assert ch.text == ch.text.lower()


def test_chunk_doc_appends_one_keyword_chunk():
    from prd_mcp.chunk import chunk_doc
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-7-x", id="EP-7", title="T", source_url="u", status="x",
            platform=[], tags=["a"], summary="Sum", body_hash="h", body="hello world")
    chunks = chunk_doc(d, 1000, 150)
    kw = [c for c in chunks if c.chunk_type == "keyword"]
    assert len(kw) == 1
    assert chunks[-1].chunk_type == "keyword"  # appended last


def test_chunk_doc_keyword_chunk_for_unenriched_doc():
    # No summary -> still emits a keyword chunk built from the body.
    from prd_mcp.chunk import chunk_doc
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-9-y", id="EP-9", title="Title", source_url="u", status="x",
            platform=[], tags=[], summary=None, body_hash=None, body="some body text")
    chunks = chunk_doc(d, 1000, 150)
    kw = [c for c in chunks if c.chunk_type == "keyword"]
    assert len(kw) == 1
    assert "some body text" in kw[0].text
