from prd_mcp.vault import Doc
from prd_mcp.store import Store
from prd_mcp.index import run_index


class Cfg:
    chunk_size = 1000; chunk_overlap = 150
    def __init__(self, prds_dir): self.prds_dir = prds_dir


def emb(texts): return [[float(len(t)), 0.0] for t in texts]


def doc(stem, h, body="some body", summary="S"):
    return Doc(stem=stem, id="EP-1", title="T", source_url="u", status="x",
               platform=[], tags=["t"], summary=summary, body_hash=h, body=body)


def test_index_new(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    docs = {"a.md": doc("EP-1-a", "h1"), "b.md": doc("EP-2-b", "h2")}
    res = run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    assert res == {"indexed": 2, "skipped": 0, "removed": 0, "errors": 0}


def test_index_skip_unchanged(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    docs = {"a.md": doc("EP-1-a", "h1")}
    run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    res = run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    assert res["indexed"] == 0 and res["skipped"] == 1


def test_index_reembed_changed(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    docs = {"a.md": doc("EP-1-a", "h1")}
    run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    docs["a.md"] = doc("EP-1-a", "h2", body="new")
    res = run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    assert res["indexed"] == 1 and s.stored_hashes()["EP-1-a"] == "h2"


def test_index_remove_deleted(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    docs = {"a.md": doc("EP-1-a", "h1"), "b.md": doc("EP-2-b", "h2")}
    run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    del docs["b.md"]
    res = run_index(Cfg("/x"), s, emb, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    assert res["removed"] == 1 and set(s.stored_hashes()) == {"EP-1-a"}


def test_bad_doc_continues(tmp_path):
    s = Store.open(str(tmp_path / "c"))
    docs = {"good.md": doc("EP-1-a", "h1"), "bad.md": doc("EP-2-b", "h2", body="BOOM")}
    def e(texts):
        if any("BOOM" in t for t in texts): raise RuntimeError("fail")
        return [[1.0, 0.0] for _ in texts]
    res = run_index(Cfg("/x"), s, e, read_doc_fn=lambda p: docs[p], list_docs_fn=lambda d: list(docs))
    assert res["errors"] == 1 and "EP-1-a" in s.stored_hashes()
