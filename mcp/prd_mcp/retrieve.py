from dataclasses import dataclass
from prd_mcp.read import read_body_by_stem


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


def _mk(md, text, score):
    tags = md.get("tags", "")
    return Retrieved(
        doc_stem=md["doc_stem"], doc_id=md["doc_id"], title=md["title"],
        summary=md.get("summary", "") or "",
        tags=[t for t in tags.split(",") if t] if tags else [],
        status=md.get("status", ""), source_url=md.get("source_url", ""),
        text=text, score=score,
    )


def retrieve(query: str, store, embed_fn, k: int, threshold: float):
    if not query or not query.strip():
        return [], "no_match"
    vec = embed_fn([query])[0]
    rows = store.query(vec, k)
    seen, out, best = set(), [], None
    for r in rows:
        score = round(1.0 - r.get("distance", 0.0), 4)
        if best is None or score > best:
            best = score
        stem = r["metadata"]["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        out.append(_mk(r["metadata"], r["text"], score))
    if best is None or best < threshold:
        return [], "no_match"
    return out, "match"


def _snippet(body: str, first_term: str, summary: str, title: str) -> str:
    # Spec order (design §3): summary FIRST when it contains the matched word
    # (the LLM-written summary is a cleaner, curated snippet), else a body window
    # around the match, else summary/title as-is. Never an arbitrary body[:200]
    # that doesn't contain the match (Codex F3).
    if first_term:
        if summary and first_term in summary.lower():
            return summary
        if body:
            idx = body.lower().find(first_term)
            if idx >= 0:
                start = max(0, idx - 100)
                return body[start:idx + 120]
    if summary:
        return summary
    if title:
        return title
    return body[:200] if body else ""


def tokenize(query: str) -> list:
    # Lowercase, split, drop tokens shorter than 2 chars (1-char tokens like "a"
    # match almost everything). Shared by the server's pre-store guard (Codex N2).
    return [t for t in (query or "").lower().split() if len(t) >= 2]


def keyword_retrieve(query: str, store, k: int, prds_dir: str,
                     read_body_fn=read_body_by_stem) -> list:
    terms = tokenize(query)
    if not terms:
        return []
    rows = store.keyword_query(terms, k)
    seen, out = set(), []
    for r in rows:
        md = r["metadata"]
        stem = md["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        body = read_body_fn(stem, prds_dir)
        snippet = _snippet(body, terms[0], md.get("summary", "") or "", md.get("title", ""))
        out.append(_mk(md, snippet, 0.0))
    return out
