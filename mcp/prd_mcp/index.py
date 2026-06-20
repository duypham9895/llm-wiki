import sys
from prd_mcp.vault import read_doc, list_docs
from prd_mcp.chunk import chunk_doc

EMBED_DIM = 1536  # text-embedding-3-small


def _embed_with_keyword_placeholder(chunks, embed_fn):
    # Embed only non-keyword chunks (keyword chunk text can exceed the embed token
    # limit). Keyword chunks get a zero placeholder vector spliced back in order.
    # The placeholder dim MUST match the real embeddings' dim (a Chroma collection
    # is single-dimension) - derive it from the returned vectors, not a constant,
    # so tests with small fake embedders and the live 1536-dim embedder both work.
    to_embed = [c.text for c in chunks if c.chunk_type != "keyword"]
    vecs = list(embed_fn(to_embed)) if to_embed else []
    dim = len(vecs[0]) if vecs else EMBED_DIM
    out, it = [], iter(vecs)
    for c in chunks:
        out.append([0.0] * dim if c.chunk_type == "keyword" else next(it))
    return out


def run_index(cfg, store, embed_fn, read_doc_fn=read_doc, list_docs_fn=list_docs,
              force: bool = False) -> dict:
    stored = store.stored_hashes()
    indexed = skipped = removed = errors = 0
    seen = set()
    for path in list_docs_fn(cfg.prds_dir):
        try:
            d = read_doc_fn(path)
            seen.add(d.stem)
            if (not force and stored.get(d.stem) == d.body_hash
                    and d.body_hash is not None and store.has_keyword_chunk(d.stem)):
                skipped += 1
                continue
            chunks = chunk_doc(d, cfg.chunk_size, cfg.chunk_overlap)
            if not chunks:
                skipped += 1
                continue
            if not any(c.chunk_type != "keyword" for c in chunks):
                skipped += 1
                continue
            embeddings = _embed_with_keyword_placeholder(chunks, embed_fn)
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
