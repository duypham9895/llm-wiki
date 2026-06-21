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
    assert len(page1["results"]) == 2 and page1["next_cursor"] is not None
    page2 = store.list_cards(limit=2, cursor=page1["next_cursor"])
    assert page1["results"][0]["id"] != page2["results"][0]["id"]
