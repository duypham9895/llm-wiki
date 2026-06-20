from dataclasses import dataclass, field


@dataclass
class Retrieved:
    doc_stem: str
    doc_id: str
    title: str
    summary: str
    tags: list
    status: str
    source_url: str
    text: str
    score: float


def retrieve(query: str, store, embed_fn, k: int) -> list:
    vec = embed_fn([query])[0]
    rows = store.query(vec, k)
    seen, out = set(), []
    for r in rows:
        md = r["metadata"]
        stem = md["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        tags = md.get("tags", "")
        out.append(Retrieved(
            doc_stem=stem, doc_id=md["doc_id"], title=md["title"],
            summary=md.get("summary", "") or "",
            tags=[t for t in tags.split(",") if t] if tags else [],
            status=md.get("status", ""), source_url=md.get("source_url", ""),
            text=r["text"], score=round(1.0 - r.get("distance", 0.0), 4),
        ))
    return out
