from dataclasses import dataclass, field
import re
from prd_mcp.read import read_body_by_stem


# Captures the bare PRD id inside a wikilink like [[EP-468-bank-report]] or [[EP-468]].
# Conservative: only the EP-prefixed form (Ringkas convention). Group 1 = id.
WIKILINK_RE = re.compile(r"\[\[(EP-[\w-]+?)\]\]")

RELATED_CAP = 5


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
    # CardMetadata fields, populated so search_cards can return the same shape
    # without re-reading chunk text from the store.
    chunk_type: str = ""
    # 1-hop wikilink graph: next-hop candidates surfaced from `[[EP-XXX]]` references
    # in the retrieved bodies. Shape: list[{id, title, summary}]. Empty when no
    # wikilinks resolve or no top results.
    related: list = field(default_factory=list)


@dataclass
class CardMetadata:
    """Thin card view of a PRD — selection signal, NOT evidence.

    Cards never carry body text or chunk text: agents triage cheaply off these,
    then call read_body(id) for the canonical vault body when they need to
    answer a question (Atlas pattern)."""
    id: str
    title: str
    summary: str
    tags: list = field(default_factory=list)
    status: str = ""
    source_url: str = ""
    obsidian_link: str = ""
    score: float = 0.0


def _mk(md, text, score):
    tags = md.get("tags", "")
    return Retrieved(
        doc_stem=md["doc_stem"], doc_id=md["doc_id"], title=md["title"],
        summary=md.get("summary", "") or "",
        tags=[t for t in tags.split(",") if t] if tags else [],
        status=md.get("status", ""), source_url=md.get("source_url", ""),
        text=text, score=score,
        chunk_type=md.get("chunk_type", ""),
    )


def _wikilink_ids(text: str) -> list:
    """Extract PRD ids from `[[EP-XXX]]` wikilinks in body/chunk text. Preserves
    first-seen order, dedupes. Empty/None yields []."""
    if not text:
        return []
    seen, out = set(), []
    for m in WIKILINK_RE.finditer(text):
        prd_id = m.group(1)
        if prd_id not in seen:
            seen.add(prd_id)
            out.append(prd_id)
    return out


def _fetch_cards(store, ids: list) -> dict:
    """Resolve id -> {"id","title","summary"} from the store's card index. Unknown
    ids (PRD not synced) are silently skipped. Order preserved per input `ids`."""
    if not ids:
        return {}
    if not hasattr(store, "list_cards"):
        return {}
    try:
        cards = store.list_cards(limit=100)["results"]
    except Exception:
        return {}
    by_id = {c["id"]: c for c in cards}
    out = {}
    for pid in ids:
        c = by_id.get(pid)
        if c:
            out[pid] = {"id": c["id"], "title": c.get("title", ""),
                        "summary": c.get("summary", "")}
    return out


def _related_from_bodies(bodies: list, store, top_ids: set,
                         cap: int = RELATED_CAP) -> list:
    """1-hop graph following: scan all bodies for [[EP-XXX]] wikilinks, resolve
    each referenced PRD's card metadata, dedupe against top-result ids (top
    wins), preserve first-seen order, cap at `cap`."""
    seen_ids, ordered = set(), []
    for body in bodies:
        for pid in _wikilink_ids(body):
            if pid in top_ids or pid in seen_ids:
                continue
            seen_ids.add(pid)
            ordered.append(pid)
    cards = _fetch_cards(store, ordered[:cap])
    return [cards[pid] for pid in ordered[:cap] if pid in cards]


def retrieve(query: str, store, embed_fn, k: int, threshold: float):
    """Returns (results, verdict, related). `related` is the 1-hop wikilink
    graph following the top results — see _related_from_bodies."""
    if not query or not query.strip():
        return [], "no_match", []
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
        return [], "no_match", []
    top_ids = {r.doc_id for r in out}
    related = _related_from_bodies([r.text for r in out], store, top_ids)
    return out, "match", related


def search_cards(query: str, store, embed_fn, k: int, threshold: float) -> tuple[list, str]:
    """Thin card search (Atlas pattern): same vector query as retrieve(), but
    returns ONLY metadata fields — no chunk text, no body snippets.

    Cards are cheap to triage: an agent can scan 8 cards to decide which PRDs
    to call read_body() on. The full body lives in the vault, not in index
    chunks (chunks carry overlap windows and aren't canonical).

    Returns (cards, verdict) — verdict semantics match retrieve() so callers
    can branch on the same match/no_match contract. The 1-hop related set is
    NOT returned here; callers needing it should call retrieve() directly or
    build the graph themselves from the chunk text.
    """
    rows, verdict, _related = retrieve(query, store, embed_fn, k, threshold)
    cards = []
    for r in rows:
        cards.append(CardMetadata(
            id=r.doc_id, title=r.title, summary=r.summary, tags=list(r.tags),
            status=r.status, source_url=r.source_url,
            obsidian_link=f"[[{r.doc_stem}]]", score=r.score,
        ))
    return cards, verdict


def read_body(id_or_stem: str, prds_dir: str,
              read_body_by_stem_fn=read_body_by_stem,
              list_docs_fn=None, read_doc_fn=None) -> str | None:
    """Read the canonical vault body for a PRD, identified by either its id
    (e.g. "EP-437") or its file stem (e.g. "EP-437-notion-backlog").

    Returns the body markdown (frontmatter stripped) or None if no matching
    PRD exists in the vault. The body returned here is the CANONICAL evidence
    — it is NOT the chunk text from the vector index, which carries overlap
    windows from the chunker's sliding pass.

    Lookup order: stem (cheap path, used by chunks that already know the stem)
    → id walk (handles the read_prd case where the caller has an EP-XXX id).
    """
    from prd_mcp.vault import list_docs as _list_docs
    from prd_mcp.vault import read_doc as _read_doc
    list_docs_fn = list_docs_fn or _list_docs
    read_doc_fn = read_doc_fn or _read_doc
    target = (id_or_stem or "").strip()
    if not target:
        return None
    body = read_body_by_stem_fn(target, prds_dir)
    if body:
        return body
    for path in list_docs_fn(prds_dir):
        try:
            doc = read_doc_fn(path)
        except Exception:
            continue
        if doc.id == target:
            return doc.body or ""
    return None


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
                     read_body_fn=read_body_by_stem) -> tuple[list, list]:
    """Returns (results, related). Same shape as retrieve()'s tuple."""
    terms = tokenize(query)
    if not terms:
        return [], []
    rows = store.keyword_query(terms, k)
    seen, out, bodies = set(), [], []
    for r in rows:
        md = r["metadata"]
        stem = md["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        body = read_body_fn(stem, prds_dir)
        snippet = _snippet(body, terms[0], md.get("summary", "") or "", md.get("title", ""))
        out.append(_mk(md, snippet, 0.0))
        bodies.append(body or "")
    top_ids = {r.doc_id for r in out}
    related = _related_from_bodies(bodies, store, top_ids)
    return out, related
