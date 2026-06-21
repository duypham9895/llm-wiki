import chromadb

COLLECTION = "prds"


class Store:
    def __init__(self, collection):
        self.collection = collection

    @classmethod
    def open(cls, path: str) -> "Store":
        client = chromadb.PersistentClient(path=path)
        return cls(client.get_or_create_collection(COLLECTION))

    def upsert(self, chunks, embeddings, body_hash: str) -> None:
        ids, metadatas, documents = [], [], []
        for ch, emb in zip(chunks, embeddings):
            ids.append(f"{ch.doc_stem}:{ch.chunk_type}:{ch.index}")
            metadatas.append({
                "doc_stem": ch.doc_stem, "doc_id": ch.doc_id, "title": ch.title,
                "source_url": ch.source_url, "status": ch.status,
                "platform": ",".join(ch.platform), "tags": ",".join(ch.tags),
                "chunk_type": ch.chunk_type, "body_hash": body_hash,
                "summary": ch.summary,
            })
            documents.append(ch.text)
        self.collection.upsert(ids=ids, embeddings=list(embeddings), metadatas=metadatas, documents=documents)

    def delete_by_doc(self, doc_stem: str) -> None:
        self.collection.delete(where={"doc_stem": doc_stem})

    def stored_hashes(self) -> dict:
        got = self.collection.get(include=["metadatas"])
        out = {}
        for md in got.get("metadatas", []) or []:
            out[md["doc_stem"]] = md["body_hash"]
        return out

    def has_keyword_chunk(self, doc_stem: str) -> bool:
        got = self.collection.get(where={"$and": [{"doc_stem": doc_stem}, {"chunk_type": "keyword"}]},
                                  include=[], limit=1)
        return bool(got.get("ids"))

    def query(self, embedding, k: int) -> list:
        res = self.collection.query(query_embeddings=[list(embedding)], n_results=k,
                                    where={"chunk_type": {"$ne": "keyword"}},
                                    include=["documents", "metadatas", "distances"])
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        return [{"text": t, "metadata": m, "distance": d} for t, m, d in zip(docs, metas, dists)]

    def list_cards(self, status: str | None = None, tag: str | None = None,
                   cursor: str | None = None, limit: int = 50) -> dict:
        """One Library card per PRD, built from stored chunk metadata. Dedupes by
        doc_stem (a PRD has many chunks), filters by status/tag, paginates by stem cursor."""
        got = self.collection.get(include=["metadatas"])
        by_stem = {}
        for md in got.get("metadatas", []) or []:
            stem = md["doc_stem"]
            # Prefer the summary chunk for card fields; Chroma .get() order isn't
            # guaranteed, so don't just keep the first chunk seen. Once we've taken a
            # summary chunk for a stem, never overwrite it.
            if stem in by_stem and by_stem[stem].get("_from_summary"):
                continue
            is_summary = md.get("chunk_type") == "summary"
            if stem in by_stem and not is_summary:
                continue
            tags = [t for t in (md.get("tags") or "").split(",") if t]
            by_stem[stem] = {"id": md.get("doc_id", stem), "stem": stem, "title": md.get("title", ""),
                             "status": md.get("status", ""), "tags": tags,
                             "summary": md.get("summary", "") or "", "source_url": md.get("source_url", ""),
                             "_from_summary": is_summary}
        cards = [c for c in by_stem.values()
                 if (status is None or c["status"] == status) and (tag is None or tag in c["tags"])]
        for c in cards:
            c.pop("_from_summary", None)
        cards.sort(key=lambda c: c["id"])
        start = next((i + 1 for i, c in enumerate(cards) if c["id"] == cursor), 0)
        limit = max(1, min(limit, 100))
        page = cards[start:start + limit]
        next_cursor = page[-1]["id"] if (start + limit) < len(cards) and page else None
        return {"results": page, "next_cursor": next_cursor}

    def keyword_query(self, terms: list, k: int) -> list:
        if not terms:
            return []
        where_doc = ({"$contains": terms[0]} if len(terms) == 1
                     else {"$and": [{"$contains": t} for t in terms]})
        res = self.collection.get(where={"chunk_type": "keyword"},
                                  where_document=where_doc,
                                  include=["documents", "metadatas"], limit=k)
        docs = res.get("documents") or []
        metas = res.get("metadatas") or []
        return [{"text": t, "metadata": m} for t, m in zip(docs, metas)]
