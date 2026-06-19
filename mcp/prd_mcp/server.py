from mcp.server.fastmcp import FastMCP
from prd_mcp.retrieve import retrieve
from prd_mcp.answer import answer as build_answer


def _ensure_index(store):
    if not store.stored_hashes():
        raise RuntimeError("PRD index not built — run `prd-mcp index` first.")


def search_prds_impl(cfg, store, llm, query: str, k: int) -> dict:
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results = retrieve(query, store, llm.embed, k)
    return {
        "count": len(results),
        "results": [
            {"id": r.doc_id, "title": r.title, "summary": r.summary, "tags": r.tags,
             "status": r.status, "source_url": r.source_url,
             "obsidian_link": f"[[{r.doc_stem}]]", "snippet": r.text, "score": r.score}
            for r in results
        ],
    }


def ask_prds_impl(cfg, store, llm, question: str) -> dict:
    _ensure_index(store)
    results = retrieve(question, store, llm.embed, cfg.top_k)
    return build_answer(question, results, llm.chat)


def build_server(cfg, store, llm) -> FastMCP:
    mcp = FastMCP("ringkas-prds")

    @mcp.tool(description="Search Ringkas PRDs by topic or keyword. Returns the most relevant "
                          "PRDs with summary, link, and a snippet for you to read and reason over.")
    def search_prds(query: str, k: int = 8) -> dict:
        return search_prds_impl(cfg, store, llm, query, k)

    @mcp.tool(description="Ask a question about Ringkas PRDs and get a grounded answer with "
                          "citations. Uses ONLY PRD content; says so if the PRDs don't cover it.")
    def ask_prds(question: str) -> dict:
        return ask_prds_impl(cfg, store, llm, question)

    return mcp
