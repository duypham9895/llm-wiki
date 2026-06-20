from mcp.server.fastmcp import FastMCP
from prd_mcp.retrieve import retrieve, keyword_retrieve, tokenize
from prd_mcp.answer import answer as build_answer
from prd_mcp.read import read_prd as _read_prd
from prd_mcp.vault import read_doc, list_docs


def _ensure_index(store):
    if not store.stored_hashes():
        raise RuntimeError("PRD index not built — run `prd-mcp index` first.")


def _blank(q: str) -> bool:
    return not q or not q.strip()


def _result(r):
    return {"id": r.doc_id, "title": r.title, "summary": r.summary, "tags": r.tags,
            "status": r.status, "source_url": r.source_url,
            "obsidian_link": f"[[{r.doc_stem}]]", "snippet": r.text, "score": r.score}


def search_prds_impl(cfg, store, llm, query: str, k: int) -> dict:
    if _blank(query):
        return {"count": 0, "verdict": "no_match", "results": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results, verdict = retrieve(query, store, llm.embed, k, cfg.score_threshold)
    return {"count": len(results), "verdict": verdict, "results": [_result(r) for r in results]}


def ask_prds_impl(cfg, store, llm, question: str) -> dict:
    if _blank(question):
        return {"answer": "No PRD covers this.", "sources": [], "grounded": False}
    _ensure_index(store)
    results, verdict = retrieve(question, store, llm.embed, cfg.top_k, cfg.score_threshold)
    return build_answer(question, results, verdict, llm.chat)


def keyword_search_impl(cfg, store, llm, query: str, k: int) -> dict:
    # Guard BEFORE _ensure_index: blank OR all-short-token queries (e.g. "a b" ->
    # zero usable tokens) must return empty without touching the store (Codex N2).
    if _blank(query) or not tokenize(query):
        return {"count": 0, "results": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results = keyword_retrieve(query, store, k, cfg.prds_dir)
    return {"count": len(results),
            "results": [{"id": r.doc_id, "title": r.title, "status": r.status,
                         "tags": r.tags, "source_url": r.source_url,
                         "obsidian_link": f"[[{r.doc_stem}]]", "snippet": r.text}
                        for r in results]}


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
