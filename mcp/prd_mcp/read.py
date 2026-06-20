from prd_mcp.vault import list_docs, read_doc


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
