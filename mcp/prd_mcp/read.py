from prd_mcp.vault import list_docs, read_doc


def _related_links(raw) -> list:
    """Normalize llm.related to a list of obsidian-link strings ("[[stem]]" or
    bare ids). The vault's `llm.related` is written by B as `[[EP-...-slug]]`
    strings (see src/enrich/relate.ts); coerce gracefully for raw ids too."""
    if not raw:
        return []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for r in raw:
        if not isinstance(r, str):
            continue
        r = r.strip()
        if not r:
            continue
        out.append(r)
    return out


def read_prd(prd_id: str, prds_dir: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict:
    target = (prd_id or "").strip()
    if target:
        for path in list_docs_fn(prds_dir):
            try:
                doc = read_doc_fn(path)
            except Exception:
                continue
            if doc.id == target:
                return {
                    "found": True,
                    "id": doc.id,
                    "title": doc.title,
                    "status": doc.status,
                    "tags": list(doc.tags),
                    "source_url": doc.source_url,
                    "obsidian_link": f"[[{doc.stem}]]",
                    "body": doc.body,
                    "related": _related_links(getattr(doc, "_llm_related", None)),
                }
    return {
        "found": False,
        "id": target,
        "title": "",
        "status": "",
        "tags": [],
        "source_url": "",
        "obsidian_link": "",
        "body": "",
        "related": [],
    }


def read_body_by_stem(stem: str, prds_dir: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> str:
    if not stem:
        return ""
    for path in list_docs_fn(prds_dir):
        try:
            doc = read_doc_fn(path)
        except Exception:
            continue
        if doc.stem == stem:
            return doc.body or ""
    return ""
