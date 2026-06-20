from prd_mcp.retrieve import retrieve


class FakeStore:
    def __init__(self, rows): self.rows = rows
    def query(self, embedding, k): return self.rows[:k]


def row(stem, text, dist, summary="sum"):
    return {"text": text, "distance": dist, "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary_unused": "", "chunk_type": "body"}}


def test_dedupe_distinct_prds():
    store = FakeStore([row("EP-1-a", "a1", 0.1), row("EP-1-a", "a2", 0.2), row("EP-2-b", "b1", 0.3)])
    out = retrieve("q", store, lambda t: [[0.0, 1.0]], 8)
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
    assert out[0].text == "a1"
    assert out[0].source_url == "https://n/EP-1-a"
    assert out[0].tags == ["a", "b"]
    assert round(out[0].score, 3) == 0.9  # 1 - 0.1


def test_embeds_question():
    cap = {}
    def embed(texts): cap["t"] = texts; return [[1.0]]
    retrieve("my q", FakeStore([]), embed, 8)
    assert cap["t"] == ["my q"]
