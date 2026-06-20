SYSTEM = (
    "You answer questions about Ringkas PRDs using ONLY the provided context. "
    "Cite the PRDs you used by their EP- id. If the context does not answer the question, "
    "say you don't have a PRD covering that — do not invent. Be concise and direct."
)


def build_messages(question: str, retrieved: list) -> list:
    ctx = "\n\n".join(f"[{r.doc_id} · {r.title}] {r.text}" for r in retrieved)
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Question: {question}\n\nContext:\n{ctx}"}]


def format_sources(retrieved: list) -> list:
    out, seen = [], set()
    for r in retrieved:
        if r.doc_stem in seen:
            continue
        seen.add(r.doc_stem)
        out.append({"id": r.doc_id, "title": r.title,
                    "source_url": r.source_url, "obsidian_link": f"[[{r.doc_stem}]]"})
    return out


def answer(question: str, retrieved: list, verdict: str, chat_fn) -> dict:
    if verdict == "no_match" or not retrieved:
        return {"answer": "No PRD covers this.", "sources": [], "grounded": False}
    prose = chat_fn(build_messages(question, retrieved))
    return {"answer": prose, "sources": format_sources(retrieved), "grounded": True}
