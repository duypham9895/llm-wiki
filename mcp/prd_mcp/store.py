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

    def query(self, embedding, k: int) -> list:
        res = self.collection.query(query_embeddings=[list(embedding)], n_results=k,
                                    include=["documents", "metadatas", "distances"])
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        return [{"text": t, "metadata": m, "distance": d} for t, m, d in zip(docs, metas, dists)]
