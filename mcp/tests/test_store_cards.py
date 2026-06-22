from prd_mcp.store import Store


class _FakeCollection:
    def __init__(self, rows): self._rows = rows
    def get(self, include=None, where=None, limit=None):
        return {"metadatas": self._rows}


def _md(stem, status="active", tags="crm,referral"):
    return {"doc_stem": stem, "doc_id": stem, "title": f"Title {stem}", "status": status,
            "tags": tags, "summary": f"sum {stem}", "source_url": "u", "chunk_type": "summary", "body_hash": "h"}


def test_list_cards_dedupes_to_one_per_prd_and_filters():
    rows = [_md("EP-1"), _md("EP-1"), _md("EP-2", status="draft"), _md("EP-3", tags="kpr")]
    store = Store(_FakeCollection(rows))
    cards = store.list_cards()
    ids = sorted(c["id"] for c in cards["results"])
    assert ids == ["EP-1", "EP-2", "EP-3"]  # one card per PRD
    only_active = store.list_cards(status="active")
    assert all(c["status"] == "active" for c in only_active["results"])
    only_kpr = store.list_cards(tag="kpr")
    assert [c["id"] for c in only_kpr["results"]] == ["EP-3"]


def test_list_cards_paginates_by_cursor():
    rows = [_md(f"EP-{i}") for i in range(5)]
    store = Store(_FakeCollection(rows))
    page1 = store.list_cards(limit=2)
    assert [c["id"] for c in page1["results"]] == ["EP-0", "EP-1"]
    assert page1["next_cursor"] == "EP-1"
    page2 = store.list_cards(limit=2, cursor=page1["next_cursor"])
    assert [c["id"] for c in page2["results"]] == ["EP-2", "EP-3"]
    assert page2["next_cursor"] == "EP-3"
    page3 = store.list_cards(limit=2, cursor=page2["next_cursor"])
    assert [c["id"] for c in page3["results"]] == ["EP-4"]  # exact: no stray/repeated item
    assert page3["next_cursor"] is None


def test_list_cards_prefers_summary_chunk():
    # Body chunk first (title "BODY"), then summary chunk (title "SUMMARY")
    body_chunk = {"doc_stem": "EP-1", "doc_id": "EP-1", "title": "BODY", "status": "active",
                  "tags": "", "summary": "sum", "source_url": "u", "chunk_type": "body", "body_hash": "h"}
    summary_chunk = {"doc_stem": "EP-1", "doc_id": "EP-1", "title": "SUMMARY", "status": "active",
                     "tags": "", "summary": "sum", "source_url": "u", "chunk_type": "summary", "body_hash": "h"}
    store = Store(_FakeCollection([body_chunk, summary_chunk]))
    cards = store.list_cards()
    assert cards["results"][0]["title"] == "SUMMARY"

    # Reverse order: summary first, then body
    store2 = Store(_FakeCollection([summary_chunk, body_chunk]))
    cards2 = store2.list_cards()
    assert cards2["results"][0]["title"] == "SUMMARY"
