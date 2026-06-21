SYSTEM = (
    "You answer questions about Ringkas PRDs using ONLY the provided context. "
    "Cite the PRDs you used by their EP- id. If the context does not answer the question, "
    "say you don't have a PRD covering that — do not invent. Be concise and direct."
)

REWRITE_SYSTEM = (
    "Rewrite the user's latest message into a single standalone search query for a PRD "
    "knowledge base, using the conversation for context (resolve pronouns/references like "
    "'that one'). Output ONLY the query text, no quotes, no explanation."
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


NON_ANSWER = "No PRD covers this."


async def answer_stream(question: str, retrieved: list, verdict: str, chat_stream_fn):
    if verdict == "no_match" or not retrieved:
        yield NON_ANSWER
        return
    async for tok in chat_stream_fn(build_messages(question, retrieved)):
        yield tok


def rewrite_query(history: list, latest: str, chat_fn) -> str:
    # No prior turns OR a blank message -> nothing to rewrite; skip the LLM entirely.
    if not history or not latest or not latest.strip():
        return latest
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history)
    messages = [
        {"role": "system", "content": REWRITE_SYSTEM},
        {"role": "user", "content": f"Conversation so far:\n{convo}\n\nLatest message: {latest}\n\nStandalone query:"},
    ]
    return chat_fn(messages).strip()
