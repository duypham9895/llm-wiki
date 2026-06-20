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


def test_keyword_chunk_not_embedded_and_gets_zero_vector():
    # The keyword chunk must NOT be passed to embed_fn; it gets a zero vector instead.
    from prd_mcp.index import run_index, EMBED_DIM
    from prd_mcp.vault import Doc

    class Cfg:
        prds_dir = "/v"; chunk_size = 1000; chunk_overlap = 150

    embedded_texts = []
    def embed(texts):
        embedded_texts.extend(texts)
        return [[0.1] * EMBED_DIM for _ in texts]

    upserted = {}
    class FakeStore:
        def stored_hashes(self): return {}
        def delete_by_doc(self, stem): pass
        def upsert(self, chunks, embs, body_hash):
            upserted["chunks"] = chunks; upserted["embs"] = embs

    doc = Doc(stem="EP-1-a", id="EP-1", title="Title", source_url="u", status="x",
              platform=[], tags=["kpr"], summary="s", body_hash="h1", body="real body text")
    res = run_index(Cfg(), FakeStore(), embed,
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"])
    assert res["indexed"] == 1
    # the lowercased keyword text must NOT appear in what was embedded
    kw_texts = [c.text for c in upserted["chunks"] if c.chunk_type == "keyword"]
    assert kw_texts, "expected a keyword chunk"
    assert kw_texts[0] not in embedded_texts
    # the keyword chunk's embedding is the zero placeholder of correct dim
    kw_idx = [i for i, c in enumerate(upserted["chunks"]) if c.chunk_type == "keyword"][0]
    assert upserted["embs"][kw_idx] == [0.0] * EMBED_DIM
    # body chunks DID get real (non-zero) embeddings
    body_idx = [i for i, c in enumerate(upserted["chunks"]) if c.chunk_type == "body"][0]
    assert upserted["embs"][body_idx] != [0.0] * EMBED_DIM


def test_keyword_placeholder_matches_embedder_dim_not_hardcoded():
    # CRITICAL regression guard: with a 2-dim fake embedder, the keyword chunk's
    # placeholder MUST be 2-dim (matching the collection), NOT a hardcoded 1536.
    # This test FAILS if _embed_with_keyword_placeholder hardcodes EMBED_DIM.
    from prd_mcp.index import run_index
    from prd_mcp.vault import Doc

    class Cfg:
        prds_dir = "/v"; chunk_size = 1000; chunk_overlap = 150

    def embed2(texts):  # 2-dim embedder
        return [[float(len(t)), 0.0] for t in texts]

    upserted = {}
    class FakeStore:
        def stored_hashes(self): return {}
        def delete_by_doc(self, stem): pass
        def upsert(self, chunks, embs, body_hash): upserted["chunks"] = chunks; upserted["embs"] = embs

    doc = Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
              platform=[], tags=["t"], summary="s", body_hash="h1", body="real body text")
    run_index(Cfg(), FakeStore(), embed2,
              read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"])
    kw_idx = [i for i, c in enumerate(upserted["chunks"]) if c.chunk_type == "keyword"][0]
    assert upserted["embs"][kw_idx] == [0.0, 0.0]  # 2-dim, matches body - NOT 1536
    assert all(len(v) == 2 for v in upserted["embs"])  # whole collection is uniform 2-dim


def test_force_reindexes_unchanged_docs():
    from prd_mcp.index import run_index, EMBED_DIM
    from prd_mcp.vault import Doc

    class Cfg:
        prds_dir = "/v"; chunk_size = 1000; chunk_overlap = 150

    class FakeStore:
        def __init__(self): self.upserts = []
        def stored_hashes(self): return {"EP-1-a": "h1"}  # already indexed, same hash
        def delete_by_doc(self, stem): pass
        def upsert(self, chunks, embs, body_hash): self.upserts.append(body_hash)

    doc = Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
              platform=[], tags=["t"], summary="s", body_hash="h1", body="b")
    store = FakeStore()
    res = run_index(Cfg(), store, lambda t: [[0.0] * EMBED_DIM for _ in t],
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"])
    assert res["skipped"] == 1 and store.upserts == []
    res = run_index(Cfg(), store, lambda t: [[0.0] * EMBED_DIM for _ in t],
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"], force=True)
    assert res["indexed"] == 1 and store.upserts == ["h1"]
