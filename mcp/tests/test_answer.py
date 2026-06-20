from prd_mcp.retrieve import Retrieved
from prd_mcp.answer import build_messages, format_sources, answer


def r(stem, title):
    return Retrieved(doc_stem=stem, doc_id=stem[:5], title=title, summary="sum",
                     tags=["t"], status="x", source_url=f"https://n/{stem}",
                     text=f"body of {stem}", score=0.9)


def test_build_messages_grounding_and_context():
    m = build_messages("What is X?", [r("EP-1-a", "PRD One")])
    assert m[0]["role"] == "system" and "ONLY" in m[0]["content"]
    assert "What is X?" in m[1]["content"]
    assert "PRD One" in m[1]["content"] and "body of EP-1-a" in m[1]["content"]


def test_format_sources():
    s = format_sources([r("EP-1-a", "PRD One"), r("EP-2-b", "PRD Two")])
    assert s[0] == {"id": "EP-1-", "title": "PRD One",
                    "source_url": "https://n/EP-1-a", "obsidian_link": "[[EP-1-a]]"}
    assert len(s) == 2


def test_answer_grounded():
    out = answer("q", [r("EP-1-a", "PRD One")], "match", chat_fn=lambda m: "Here is the answer.")
    assert out["answer"] == "Here is the answer."
    assert out["grounded"] is True
    assert out["sources"][0]["obsidian_link"] == "[[EP-1-a]]"


def test_answer_no_match_no_llm():
    called = {"n": 0}
    def chat_fn(m): called["n"] += 1; return "x"
    out = answer("q", [r("EP-1-a", "PRD One")], "no_match", chat_fn=chat_fn)
    assert called["n"] == 0 and out["grounded"] is False and out["sources"] == []
    assert "No PRD" in out["answer"]


def test_answer_empty_retrieved_no_llm():
    called = {"n": 0}
    def chat_fn(m): called["n"] += 1; return "x"
    out = answer("q", [], "match", chat_fn=chat_fn)  # defensive: empty list still no LLM
    assert called["n"] == 0 and out["grounded"] is False
