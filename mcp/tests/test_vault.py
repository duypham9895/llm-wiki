import os, tempfile
from prd_mcp.vault import read_doc, list_docs

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "EP-468-sample.md")


def test_read_doc_parses():
    d = read_doc(FIX)
    assert d.stem == "EP-468-sample"
    assert d.id == "EP-468"
    assert d.title == "Bank Report on CRM for Bank Users"
    assert d.source_url == "https://app.notion.com/p/Bank-Report-1b444805"
    assert d.status == "Not Started"
    assert d.platform == ["CRM"]
    assert d.tags == ["bank-report", "crm", "dashboard"]
    assert d.summary.startswith("A dashboard giving")
    assert d.body_hash == "abc123"
    assert "## Background" in d.body and "## Goal" in d.body
    assert "sync:" not in d.body


def test_read_doc_empty_llm():
    content = ("---\nsync:\n  id: EP-9\n  title: T\n  source_url: u\n  status: x\n"
               "  platform: []\nllm:\n  summary: null\n  tags: []\n  related: []\n---\n\n# Body\n")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(content); path = f.name
    d = read_doc(path)
    assert d.summary is None and d.tags == [] and d.body_hash is None
    assert "# Body" in d.body


def test_list_docs_excludes_underscore(tmp_path):
    prds = tmp_path / "PRDs"; prds.mkdir()
    (prds / "EP-1-a.md").write_text("x")
    (prds / "_index.md").write_text("x")
    (prds / "note.txt").write_text("x")
    out = list_docs(str(prds))
    assert len(out) == 1 and out[0].endswith("EP-1-a.md")
