from prd_mcp.read import read_body_by_stem, read_prd
from prd_mcp.vault import Doc


def make_docs():
    docs = {
        "/v/EP-43-short.md": Doc(
            stem="EP-43-short",
            id="EP-43",
            title="Short",
            source_url="u43",
            status="x",
            platform=[],
            tags=["a"],
            summary="s",
            body_hash="h",
            body="short body",
        ),
        "/v/EP-437-long.md": Doc(
            stem="EP-437-long",
            id="EP-437",
            title="Long",
            source_url="u437",
            status="Released",
            platform=[],
            tags=["b", "c"],
            summary="s",
            body_hash="h",
            body="full long body text",
        ),
        "/v/EP-9-noenrich.md": Doc(
            stem="EP-9-noenrich",
            id="EP-9",
            title="NoEnrich",
            source_url="u9",
            status="x",
            platform=[],
            tags=[],
            summary=None,
            body_hash=None,
            body="body of unenriched doc",
        ),
    }
    list_fn = lambda prds_dir: list(docs.keys())
    read_fn = lambda path: docs[path]
    return list_fn, read_fn


def test_read_prd_returns_full_body_by_exact_id():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-437", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True
    assert out["id"] == "EP-437" and out["title"] == "Long"
    assert out["body"] == "full long body text"
    assert out["obsidian_link"] == "[[EP-437-long]]"
    assert out["tags"] == ["b", "c"] and out["source_url"] == "u437"


def test_read_prd_exact_id_no_prefix_collision():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-43", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True and out["title"] == "Short"
    assert out["id"] == "EP-43" and out["title"] != "Long"


def test_read_prd_unknown_id_found_false():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-999", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is False and out["body"] == ""


def test_read_prd_unenriched_doc_still_returns_body():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-9", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True and out["body"] == "body of unenriched doc"


def test_read_body_by_stem():
    list_fn, read_fn = make_docs()
    assert (
        read_body_by_stem("EP-437-long", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
        == "full long body text"
    )
    assert read_body_by_stem("nope", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn) == ""


def test_read_body_by_stem_blank_stem_returns_empty_without_listing():
    def list_fn(_prds_dir):
        raise AssertionError("blank stem should not list docs")

    assert read_body_by_stem("", "/v", list_docs_fn=list_fn) == ""
