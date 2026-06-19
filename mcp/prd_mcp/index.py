import sys
from prd_mcp.vault import read_doc, list_docs
from prd_mcp.chunk import chunk_doc


def run_index(cfg, store, embed_fn, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict:
    stored = store.stored_hashes()
    indexed = skipped = removed = errors = 0
    seen = set()
    for path in list_docs_fn(cfg.prds_dir):
        try:
            d = read_doc_fn(path)
            seen.add(d.stem)
            if stored.get(d.stem) == d.body_hash and d.body_hash is not None:
                skipped += 1
                continue
            chunks = chunk_doc(d, cfg.chunk_size, cfg.chunk_overlap)
            if not chunks:
                skipped += 1
                continue
            embeddings = embed_fn([c.text for c in chunks])
            store.delete_by_doc(d.stem)
            store.upsert(chunks, embeddings, body_hash=d.body_hash or "")
            indexed += 1
        except Exception as err:
            errors += 1
            print(f"error indexing {path}: {err}", file=sys.stderr)
    for stem in list(stored.keys()):
        if stem not in seen:
            store.delete_by_doc(stem)
            removed += 1
    return {"indexed": indexed, "skipped": skipped, "removed": removed, "errors": errors}
