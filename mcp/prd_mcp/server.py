from mcp.server.fastmcp import FastMCP
from prd_mcp.retrieve import retrieve, keyword_retrieve, tokenize, CardMetadata
from prd_mcp.answer import answer as build_answer
from prd_mcp.read import read_prd as _read_prd
from prd_mcp.vault import read_doc, list_docs


def _ensure_index(store):
    if not store.stored_hashes():
        raise RuntimeError("PRD index not built — run `prd-mcp index` first.")


def _blank(q: str) -> bool:
    return not q or not q.strip()


def _card_dict(c):
    """Thin card shape — metadata only, NO body/chunk text. Agents use this to
    decide which PRDs to call read_prd() on. Evidence comes from the vault,
    not from index chunks (Atlas pattern)."""
    return {"id": c.id, "title": c.title, "summary": c.summary, "tags": list(c.tags),
            "status": c.status, "source_url": c.source_url,
            "obsidian_link": c.obsidian_link, "score": c.score}


def search_prds_impl(cfg, store, llm, query: str, k: int) -> dict:
    if _blank(query):
        return {"count": 0, "verdict": "no_match", "results": [], "related": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    # We need the chunk text for wikilink extraction, so call retrieve() directly
    # and project to the thin card shape (no body/snippet in the response).
    rows, verdict, related = retrieve(query, store, llm.embed, k, cfg.score_threshold)
    cards = []
    for r in rows:
        cards.append(CardMetadata(
            id=r.doc_id, title=r.title, summary=r.summary, tags=list(r.tags),
            status=r.status, source_url=r.source_url,
            obsidian_link=f"[[{r.doc_stem}]]", score=r.score,
        ))
    return {"count": len(cards), "verdict": verdict,
            "results": [_card_dict(c) for c in cards], "related": related}


def ask_prds_impl(cfg, store, llm, question: str) -> dict:
    if _blank(question):
        return {"answer": "No PRD covers this.", "sources": [], "grounded": False}
    _ensure_index(store)
    results, verdict, _related = retrieve(question, store, llm.embed, cfg.top_k, cfg.score_threshold)
    return build_answer(question, results, verdict, llm.chat)


def keyword_search_impl(cfg, store, llm, query: str, k: int) -> dict:
    # Guard BEFORE _ensure_index: blank OR all-short-token queries (e.g. "a b" ->
    # zero usable tokens) must return empty without touching the store (Codex N2).
    if _blank(query) or not tokenize(query):
        return {"count": 0, "results": [], "related": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results, related = keyword_retrieve(query, store, k, cfg.prds_dir)
    # Thin card shape — same as search_prds: no snippet/body. read_prd() for
    # the canonical body when the agent needs to ground an answer.
    return {"count": len(results),
            "results": [{"id": r.doc_id, "title": r.title, "summary": r.summary,
                         "status": r.status, "tags": r.tags,
                         "source_url": r.source_url,
                         "obsidian_link": f"[[{r.doc_stem}]]", "score": 0.0}
                        for r in results],
            "related": related}


def read_prd_impl(cfg, prd_id: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict:
    return _read_prd(prd_id, cfg.prds_dir, read_doc_fn=read_doc_fn, list_docs_fn=list_docs_fn)


def build_server(cfg, store, llm) -> FastMCP:
    mcp = FastMCP("ringkas-prds")

    @mcp.tool(description="Search Ringkas PRDs by topic/concept (semantic). Returns relevant PRDs "
                          "with summary, link, snippet, score, plus a `verdict` (match/no_match) — "
                          "branch on the verdict, not the score.")
    def search_prds(query: str, k: int = 8) -> dict:
        return search_prds_impl(cfg, store, llm, query, k)

    @mcp.tool(description="Case-insensitive keyword search over PRD body, title, id, and tags — for "
                          "literal identifiers (EP-457, SP3K, KPR, LTV) that semantic search ranks "
                          "poorly. Multi-word matches PRDs containing ALL words. Pair with search_prds.")
    def keyword_search(query: str, k: int = 10) -> dict:
        return keyword_search_impl(cfg, store, llm, query, k)

    @mcp.tool(description="Read the full canonical body of ONE PRD by id (e.g. 'EP-437'). Use after "
                          "search_prds/keyword_search to read the evidence — search returns selection "
                          "signals; read_prd returns the body you answer from.")
    def read_prd(id: str) -> dict:
        return read_prd_impl(cfg, id)

    @mcp.tool(description="Ask a question about Ringkas PRDs and get a grounded answer with citations. "
                          "Uses ONLY PRD content; says so if the PRDs don't cover it.")
    def ask_prds(question: str) -> dict:
        return ask_prds_impl(cfg, store, llm, question)

    return mcp
