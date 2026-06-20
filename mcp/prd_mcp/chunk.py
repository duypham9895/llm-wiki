from dataclasses import dataclass, field
from prd_mcp.vault import Doc


@dataclass
class Chunk:
    doc_stem: str
    doc_id: str
    title: str
    source_url: str
    status: str
    platform: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    chunk_type: str = "body"
    index: int = 0
    text: str = ""
    summary: str = ""


def _split(text: str, size: int, overlap: int) -> list[str]:
    if not text:
        return []
    if len(text) <= size:
        return [text]
    out, step, i = [], max(1, size - overlap), 0
    while i < len(text):
        out.append(text[i:i + size])
        if i + size >= len(text):
            break
        i += step
    return out


def chunk_doc(doc: Doc, size: int, overlap: int) -> list[Chunk]:
    def base(ct, idx, text):
        return Chunk(doc.stem, doc.id, doc.title, doc.source_url, doc.status,
                     list(doc.platform), list(doc.tags), ct, idx, text, doc.summary or "")
    chunks = []
    if doc.summary:
        chunks.append(base("summary", 0, doc.summary))
    for i, part in enumerate(_split(doc.body, size, overlap)):
        chunks.append(base("body", i, part))
    return chunks
