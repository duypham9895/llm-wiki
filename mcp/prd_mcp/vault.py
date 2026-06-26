import os, glob
from dataclasses import dataclass, field
import yaml


@dataclass
class Doc:
    stem: str
    id: str
    title: str
    source_url: str
    status: str
    platform: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    summary: str | None = None
    body_hash: str | None = None
    body: str = ""
    # Raw `llm.related` frontmatter (list of `[[EP-...-slug]]` strings or bare
    # ids). read_prd projects this as the `related` field. Default empty for
    # unenriched docs (llm block absent or related missing).
    _llm_related: list = field(default_factory=list)


def _split_frontmatter(content: str) -> tuple[dict, str]:
    if not content.startswith("---\n"):
        return {}, content
    end = content.find("\n---", 4)
    if end == -1:
        return {}, content
    fm_text = content[4:end + 1]
    body = content[end + 4:]
    if body.startswith("\n"):
        body = body[1:]
    if body.startswith("\n"):
        body = body[1:]
    return (yaml.safe_load(fm_text) or {}), body


def read_doc(path: str) -> Doc:
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    data, body = _split_frontmatter(content)
    sync = data.get("sync", {}) or {}
    llm = data.get("llm", {}) or {}
    stem = os.path.splitext(os.path.basename(path))[0]
    return Doc(
        stem=stem,
        id=str(sync.get("id", stem)),
        title=str(sync.get("title", stem)),
        source_url=str(sync.get("source_url", "")),
        status=str(sync.get("status", "")),
        platform=list(sync.get("platform") or []),
        tags=list(llm.get("tags") or []),
        summary=(llm.get("summary") if llm.get("summary") not in ("", None) else None),
        body_hash=(llm.get("body_hash") if llm.get("body_hash") not in ("", None) else None),
        body=body,
        _llm_related=list(llm.get("related") or []),
    )


def list_docs(prds_dir: str) -> list[str]:
    paths = glob.glob(os.path.join(prds_dir, "*.md"))
    return sorted(p for p in paths if not os.path.basename(p).startswith("_"))
