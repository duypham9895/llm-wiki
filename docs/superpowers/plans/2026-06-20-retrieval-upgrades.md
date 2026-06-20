# Retrieval Upgrades (v2 Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three agent-facing retrieval improvements to the shared `mcp/prd_mcp` core — `keyword_search` (case-insensitive literal-identifier search), a relevance `verdict` on `search_prds`/`ask_prds`, and `read_prd` (full body on demand) — all backward-compatible.

**Architecture:** Extends the existing MCP-agnostic core (`chunk`/`store`/`retrieve`/`answer`/`read`/`index`), wrapped by `server.py` as MCP tools. Keyword search uses a synthetic per-PRD "keyword chunk" whose *document text* is `lower(body + title + id + tags)`, matched via Chroma `where_document {$and:[{$contains:w}]}`; every semantic query excludes that chunk. The verdict is a score-threshold over the best semantic hit. `read_prd` reads the canonical body from the vault by exact `sync.id`.

**Tech Stack:** Python 3.10, Poetry, pytest, chromadb 0.5.x (`$contains` full-text on `where_document` only), the existing OpenAI-embeddings + MiniMax-chat clients.

## Global Constraints

- **Stack:** Python 3.10, Poetry. All code under `mcp/`; package `prd_mcp`; tests under `mcp/tests/`. Run tests with `cd mcp && poetry run pytest`.
- **Read-only over the vault.** Reads `<vault>/PRDs/*.md` (names starting with `_` excluded); never writes the vault or Notion.
- **Backward-compatible / additive.** `search_prds` keeps every existing field and *adds* `verdict`; existing tool callers must not break.
- **`$contains` constraint (verified):** Chroma `$contains` works ONLY on document text via `where_document`; it is rejected in a `where` metadata clause. The lowercased search field must therefore BE a chunk's document, never metadata.
- **Keyword-chunk isolation (invariant):** the synthetic keyword chunk carries a placeholder vector; EVERY semantic vector query (`Store.query`) MUST filter `where={"chunk_type": {"$ne": "keyword"}}` so it never appears in semantic results.
- **Keyword chunk is NEVER embedded (invariant):** its text exceeds OpenAI's 8191-token embed limit (up to ~106k tokens; 48/287 docs over). The indexer assigns it a zero vector `[0.0] * EMBED_DIM` directly; `embed_fn` is called ONLY on `chunk_type != "keyword"` chunks. `EMBED_DIM = 1536` (text-embedding-3-small).
- **Score threshold default = `-0.15`** (env `PRD_SCORE_THRESHOLD`), tuned from measured separation (in-domain `login` −0.06 / `API` −0.20 stay `match`; junk weather/pizza ≤ −0.5 → `no_match`).
- **Snippets are original-case** — never sourced from the lowercased keyword chunk.
- **Degenerate-query guards:** empty/whitespace query → `no_match` (search) / empty (keyword) BEFORE any embed or store call. Keyword tokens shorter than 2 chars are dropped; if none remain → empty.
- **read_prd id resolution = exact `sync.id`**, returns `{found: false, ...}` on miss; never raises.
- **Discipline (unchanged from v1):** one bad doc never aborts indexing; a tool error never crashes the server; code-built citations from metadata; keys never exposed to clients.
- **A one-time forced full reindex is part of this phase** (Task 9): the keyword chunks must be populated for all existing docs.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `mcp/prd_mcp/config.py` | config dataclass + loader | Modify: add `score_threshold` field |
| `mcp/prd_mcp/chunk.py` | Doc → chunks | Modify: add `build_keyword_chunk(doc)`; `chunk_doc` appends it |
| `mcp/prd_mcp/store.py` | Chroma wrapper | Modify (Task 3): `query` excludes keyword chunk; add `keyword_query(terms, k)` |
| `mcp/prd_mcp/read.py` | id → full body | **Create (Task 4)**: `read_prd(...)` + `read_body_by_stem(...)` for snippets |
| `mcp/prd_mcp/retrieve.py` | query → results | Modify (Task 5): `retrieve` returns `(results, verdict)` + empty guard; add `keyword_retrieve` (uses read for snippets) |
| `mcp/prd_mcp/answer.py` | answer builder | Modify (Task 6): accept `verdict`; `no_match` short-circuits |
| `mcp/prd_mcp/server.py` | MCP tool adapters | Modify (Task 7): verdict + empty-query guard BEFORE `_ensure_index`; add `keyword_search`, `read_prd` tools |
| `mcp/prd_mcp/index.py` | incremental indexer | Modify (Task 8): embed only non-keyword chunks; keyword chunk gets zero vector; `--force` |
| `mcp/prd_mcp/cli.py` | CLI | Modify (Task 8): `index` gains `--force` (forced reindex) |
| `mcp/tests/test_*.py` | unit tests | Create/modify per task |

Task order respects dependencies: config(1) → chunk(2) → store(3) → **read(4)** → retrieve(5, uses read for keyword snippets) → answer(6) → server(7) → cli/force(8) → live reindex+smoke(9). NOTE: `read.py` is built BEFORE `retrieve.py` so `keyword_retrieve` can read original-case bodies for snippets.

### Critical design note — keyword chunk is NEVER embedded

The synthetic keyword chunk's text is up to ~425 KB / ~106k tokens (verified: 48/287 docs exceed OpenAI's 8191-token embed limit). It MUST receive a **zero placeholder vector** assigned directly — never passed to `embed_fn`, which would crash the embedding call. Verified: Chroma accepts a 1536-dim zero vector, the `where chunk_type != keyword` filter excludes it from semantic results, and `keyword_query` still finds it. The indexer (Task 8) embeds only `chunk_type != "keyword"` chunks and assigns the keyword chunk `[0.0] * EMBED_DIM`.

---

### Task 1: Add `score_threshold` to config

**Files:**
- Modify: `mcp/prd_mcp/config.py`
- Test: `mcp/tests/test_config.py`

**Interfaces:**
- Produces: `Config.score_threshold: float` (default `-0.15`, env `PRD_SCORE_THRESHOLD`).

- [ ] **Step 1: Write the failing test**

Add to `mcp/tests/test_config.py`:

```python
def test_score_threshold_default_and_override():
    from prd_mcp.config import load_config
    def fake_secret(s, a): return "k"
    base = {"VAULT_PATH": "/tmp/v"}
    cfg = load_config(base, fake_secret)
    assert cfg.score_threshold == -0.15
    cfg2 = load_config({**base, "PRD_SCORE_THRESHOLD": "-0.30"}, fake_secret)
    assert cfg2.score_threshold == -0.30
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_config.py::test_score_threshold_default_and_override -v`
Expected: FAIL — `AttributeError: 'Config' object has no attribute 'score_threshold'`.

- [ ] **Step 3: Add the field + loader line**

In `mcp/prd_mcp/config.py`, add to the `Config` dataclass (after `http_token: str`):

```python
    http_token: str
    score_threshold: float
```

And in `load_config`, add (after the `http_token=...` line, before the closing `)`):

```python
        http_token=env.get("MCP_AUTH_TOKEN", ""),
        score_threshold=float(env.get("PRD_SCORE_THRESHOLD", "-0.15")),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_config.py -v`
Expected: PASS (all config tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/config.py mcp/tests/test_config.py
git commit -m "feat(mcp): add score_threshold config for relevance verdict"
```

---

### Task 2: Keyword chunk in the chunker

**Files:**
- Modify: `mcp/prd_mcp/chunk.py`
- Test: `mcp/tests/test_chunk.py`

**Interfaces:**
- Consumes: `Doc` (fields `stem, id, title, status, source_url, platform, tags, summary, body_hash, body`) from `vault.py`; existing `Chunk` dataclass and `chunk_doc(doc, size, overlap)`.
- Produces: `build_keyword_chunk(doc) -> Chunk` with `chunk_type="keyword"`, `index=0`, and `text = lower(body + " " + title + " " + id + " " + (" ".join(tags)))`. `chunk_doc` appends exactly one keyword chunk (last) per doc.

- [ ] **Step 1: Write the failing test**

Add to `mcp/tests/test_chunk.py`:

```python
def test_build_keyword_chunk_lowercased_and_includes_metadata():
    from prd_mcp.chunk import build_keyword_chunk
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-7-x", id="EP-7", title="Referral CODE", source_url="u",
            status="Released", platform=["CRM"], tags=["KPR", "Affiliate"],
            summary="S", body_hash="h", body="The SP3K Notification flow")
    ch = build_keyword_chunk(d)
    assert ch.chunk_type == "keyword"
    assert ch.index == 0
    # everything lowercased; body + title + id + tags all present
    assert "sp3k notification" in ch.text
    assert "referral code" in ch.text
    assert "ep-7" in ch.text
    assert "kpr" in ch.text and "affiliate" in ch.text
    assert ch.text == ch.text.lower()


def test_chunk_doc_appends_one_keyword_chunk():
    from prd_mcp.chunk import chunk_doc
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-7-x", id="EP-7", title="T", source_url="u", status="x",
            platform=[], tags=["a"], summary="Sum", body_hash="h", body="hello world")
    chunks = chunk_doc(d, 1000, 150)
    kw = [c for c in chunks if c.chunk_type == "keyword"]
    assert len(kw) == 1
    assert chunks[-1].chunk_type == "keyword"  # appended last


def test_chunk_doc_keyword_chunk_for_unenriched_doc():
    # No summary -> still emits a keyword chunk built from the body.
    from prd_mcp.chunk import chunk_doc
    from prd_mcp.vault import Doc
    d = Doc(stem="EP-9-y", id="EP-9", title="Title", source_url="u", status="x",
            platform=[], tags=[], summary=None, body_hash=None, body="some body text")
    chunks = chunk_doc(d, 1000, 150)
    kw = [c for c in chunks if c.chunk_type == "keyword"]
    assert len(kw) == 1
    assert "some body text" in kw[0].text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_chunk.py -k keyword -v`
Expected: FAIL — `ImportError: cannot import name 'build_keyword_chunk'`.

- [ ] **Step 3: Implement in `mcp/prd_mcp/chunk.py`**

Add after the `chunk_doc` function (the existing `base(...)` helper inside `chunk_doc` shows the field order):

```python
def build_keyword_chunk(doc: Doc) -> Chunk:
    parts = [doc.body or "", doc.title or "", doc.id or "", " ".join(doc.tags or [])]
    text = " ".join(p for p in parts if p).lower()
    return Chunk(doc.stem, doc.id, doc.title, doc.source_url, doc.status,
                 list(doc.platform), list(doc.tags), "keyword", 0, text, doc.summary or "")
```

Then, inside `chunk_doc`, append the keyword chunk before `return chunks`:

```python
    for i, part in enumerate(_split(doc.body, size, overlap)):
        chunks.append(base("body", i, part))
    chunks.append(build_keyword_chunk(doc))
    return chunks
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_chunk.py -v`
Expected: PASS (all chunk tests, including the pre-existing ones — they don't assert chunk counts that the extra keyword chunk would break; if any pre-existing test asserts an exact total chunk count, update it to account for the +1 keyword chunk).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/chunk.py mcp/tests/test_chunk.py
git commit -m "feat(mcp): per-PRD keyword chunk (lowercased body+title+id+tags)"
```

---

### Task 3: Store — exclude keyword chunk from semantic; add `keyword_query`

**Files:**
- Modify: `mcp/prd_mcp/store.py`
- Test: `mcp/tests/test_store.py`

**Interfaces:**
- Consumes: `Chunk` objects (with `chunk_type`), existing `Store.open(path)`, `Store.upsert(chunks, embeddings, body_hash)`.
- Produces:
  - `Store.query(embedding, k)` — UNCHANGED signature, now passes `where={"chunk_type": {"$ne": "keyword"}}` so keyword chunks never appear in semantic results.
  - `Store.keyword_query(terms: list[str], k: int) -> list[dict]` — returns rows `[{"text", "metadata"}]` for keyword chunks whose document contains ALL `terms` (already-lowercased substrings). Caller dedupes. Uses `where={"chunk_type": "keyword"}` + `where_document={"$and": [{"$contains": t} for t in terms]}` (single `{"$contains": t}` when one term). Respects `k` via `limit`.

- [ ] **Step 1: Write the failing test**

Add to `mcp/tests/test_store.py`:

```python
def test_query_excludes_keyword_chunk(tmp_path):
    # A keyword chunk with a vector identical to the query must NOT be returned by semantic query.
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    d = Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
            platform=[], tags=["t"], summary="S", body_hash="h", body="alpha beta")
    chunks = chunk_doc(d, 1000, 150)
    # give EVERY chunk the same embedding so the keyword chunk would rank top if not excluded
    s.upsert(chunks, [[1.0, 0.0]] * len(chunks), "h1")
    res = s.query([1.0, 0.0], 10)
    assert res, "semantic query returned nothing"
    assert all(r["metadata"]["chunk_type"] != "keyword" for r in res)


def test_keyword_query_case_insensitive_and_and_of_words(tmp_path):
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    d1 = Doc(stem="EP-1-a", id="EP-1", title="Bank Report Dashboard", source_url="u",
             status="x", platform=[], tags=["KPR"], summary="S", body_hash="h",
             body="The SP3K notification and KPR flow")
    d2 = Doc(stem="EP-2-b", id="EP-2", title="Other", source_url="u", status="x",
             platform=[], tags=[], summary="S", body_hash="h", body="unrelated content")
    for d in (d1, d2):
        ch = chunk_doc(d, 1000, 150)
        s.upsert(ch, [[0.0, 1.0]] * len(ch), "h")
    # case-insensitive single term (query already lowercased by caller)
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["sp3k"], 10)} == {"EP-1-a"}
    # id (lives in keyword-chunk text) still matched
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["ep-1"], 10)} == {"EP-1-a"}
    # AND-of-words: both present, any order
    assert {r["metadata"]["doc_stem"] for r in s.keyword_query(["bank", "dashboard"], 10)} == {"EP-1-a"}
    assert s.keyword_query(["bank", "nonexistentword"], 10) == []


def test_keyword_query_respects_k_limit(tmp_path):
    from prd_mcp.vault import Doc
    from prd_mcp.chunk import chunk_doc
    s = Store.open(str(tmp_path / "c"))
    # 3 docs all containing "shared" in their keyword chunk
    for i in range(3):
        d = Doc(stem=f"EP-{i}-x", id=f"EP-{i}", title="T", source_url="u", status="x",
                platform=[], tags=[], summary="S", body_hash="h", body="shared term here")
        ch = chunk_doc(d, 1000, 150)
        s.upsert(ch, [[0.0, 1.0]] * len(ch), "h")
    rows = s.keyword_query(["shared"], 2)
    assert len(rows) == 2  # capped at k even though 3 match
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_store.py -k "keyword or exclude" -v`
Expected: FAIL — `AttributeError: 'Store' object has no attribute 'keyword_query'`, and `test_query_excludes_keyword_chunk` fails because `query` returns the keyword chunk.

- [ ] **Step 3: Implement in `mcp/prd_mcp/store.py`**

Change `Store.query` to exclude keyword chunks:

```python
    def query(self, embedding, k: int) -> list:
        res = self.collection.query(query_embeddings=[list(embedding)], n_results=k,
                                    where={"chunk_type": {"$ne": "keyword"}},
                                    include=["documents", "metadatas", "distances"])
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        return [{"text": t, "metadata": m, "distance": d} for t, m, d in zip(docs, metas, dists)]
```

Add `keyword_query` to the `Store` class:

```python
    def keyword_query(self, terms: list, k: int) -> list:
        if not terms:
            return []
        where_doc = ({"$contains": terms[0]} if len(terms) == 1
                     else {"$and": [{"$contains": t} for t in terms]})
        res = self.collection.get(where={"chunk_type": "keyword"},
                                  where_document=where_doc,
                                  include=["documents", "metadatas"], limit=k)
        docs = res.get("documents") or []
        metas = res.get("metadatas") or []
        return [{"text": t, "metadata": m} for t, m in zip(docs, metas)]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_store.py -v`
Expected: PASS (all store tests; pre-existing `test_upsert_query_hashes` still passes — its body chunk is what `query` returns).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/store.py mcp/tests/test_store.py
git commit -m "feat(mcp): keyword_query + exclude keyword chunk from semantic query"
```

---

### Task 4: `read.py` — full body by id + body-by-stem for snippets

**Files:**
- Create: `mcp/prd_mcp/read.py`
- Test: `mcp/tests/test_read.py`

**Interfaces:**
- Consumes: `vault.read_doc(path) -> Doc`, `vault.list_docs(prds_dir) -> list[str]`.
- Produces:
  - `read_prd(prd_id, prds_dir, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict` = `{found, id, title, status, tags, source_url, obsidian_link, body}`. Resolves by exact `Doc.id == prd_id`. `found: False` (empty body) on miss; never raises.
  - `read_body_by_stem(stem, prds_dir, read_doc_fn=read_doc, list_docs_fn=list_docs) -> str` — returns the original-case body for a doc whose filename stem == `stem`, or `""` if not found. Used by `keyword_retrieve` (Task 5) to build original-case snippets. Never raises.

NOTE: `read.py` is built BEFORE `retrieve.py` because `keyword_retrieve` depends on `read_body_by_stem`.

- [ ] **Step 1: Write the failing test**

Create `mcp/tests/test_read.py`:

```python
from prd_mcp.read import read_prd, read_body_by_stem
from prd_mcp.vault import Doc


def make_docs():
    docs = {
        "/v/EP-43-short.md": Doc(stem="EP-43-short", id="EP-43", title="Short", source_url="u43",
                                 status="x", platform=[], tags=["a"], summary="s",
                                 body_hash="h", body="short body"),
        "/v/EP-437-long.md": Doc(stem="EP-437-long", id="EP-437", title="Long", source_url="u437",
                                 status="Released", platform=[], tags=["b", "c"], summary="s",
                                 body_hash="h", body="full long body text"),
        "/v/EP-9-noenrich.md": Doc(stem="EP-9-noenrich", id="EP-9", title="NoEnrich", source_url="u9",
                                   status="x", platform=[], tags=[], summary=None,
                                   body_hash=None, body="body of unenriched doc"),
    }
    list_fn = lambda prds_dir: list(docs.keys())
    read_fn = lambda path: docs[path]
    return list_fn, read_fn


def test_read_prd_returns_full_body_by_exact_id():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-437", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True
    assert out["id"] == "EP-437" and out["title"] == "Long"
    assert out["body"] == "full long body text"
    assert out["obsidian_link"] == "[[EP-437-long]]"
    assert out["tags"] == ["b", "c"] and out["source_url"] == "u437"


def test_read_prd_exact_id_no_prefix_collision():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-43", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True and out["title"] == "Short"


def test_read_prd_unknown_id_found_false():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-999", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is False and out["body"] == ""


def test_read_prd_unenriched_doc_still_returns_body():
    list_fn, read_fn = make_docs()
    out = read_prd("EP-9", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn)
    assert out["found"] is True and out["body"] == "body of unenriched doc"


def test_read_body_by_stem():
    list_fn, read_fn = make_docs()
    assert read_body_by_stem("EP-437-long", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn) == "full long body text"
    assert read_body_by_stem("nope", "/v", read_doc_fn=read_fn, list_docs_fn=list_fn) == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_read.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'prd_mcp.read'`.

- [ ] **Step 3: Implement `mcp/prd_mcp/read.py`**

```python
from prd_mcp.vault import read_doc, list_docs


def read_prd(prd_id: str, prds_dir: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict:
    target = (prd_id or "").strip()
    if target:
        for path in list_docs_fn(prds_dir):
            try:
                d = read_doc_fn(path)
            except Exception:
                continue
            if d.id == target:
                return {
                    "found": True, "id": d.id, "title": d.title, "status": d.status,
                    "tags": list(d.tags), "source_url": d.source_url,
                    "obsidian_link": f"[[{d.stem}]]", "body": d.body,
                }
    return {"found": False, "id": target, "title": "", "status": "",
            "tags": [], "source_url": "", "obsidian_link": "", "body": ""}


def read_body_by_stem(stem: str, prds_dir: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> str:
    for path in list_docs_fn(prds_dir):
        try:
            d = read_doc_fn(path)
        except Exception:
            continue
        if d.stem == stem:
            return d.body or ""
    return ""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_read.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/read.py mcp/tests/test_read.py
git commit -m "feat(mcp): read_prd (full body by exact id) + read_body_by_stem"
```

---

### Task 5: Retrieve — verdict + empty guard + keyword_retrieve (with original-case snippet)

**Files:**
- Modify: `mcp/prd_mcp/retrieve.py`
- Test: `mcp/tests/test_retrieve.py`

**Interfaces:**
- Consumes: `Store.query(...)`, `Store.keyword_query(terms, k)`, `embed_fn`, `Config.score_threshold`, `read.read_body_by_stem(stem, prds_dir, ...)`.
- Produces:
  - `retrieve(query, store, embed_fn, k, threshold) -> tuple[list[Retrieved], str]`, verdict ∈ `{"match","no_match"}`. Empty/whitespace query → `([], "no_match")` WITHOUT calling `embed_fn`.
  - `keyword_retrieve(query, store, k, prds_dir, read_body_fn=read_body_by_stem) -> list[Retrieved]` — lowercases + splits the query, drops tokens shorter than 2 chars, returns `[]` if none remain (never calls `keyword_query`); dedupes to distinct PRDs; `Retrieved.text` is an **original-case snippet**: a ±120-char window around the first matched word in the original body (via `read_body_fn`), falling back to the metadata `summary`, then the title.
  - `Retrieved` dataclass UNCHANGED.

NOTE: `retrieve`'s signature changes (adds `threshold`, returns a tuple). Both call sites (`search_prds_impl`, `ask_prds_impl`, Task 7) are updated in this phase.

- [ ] **Step 1: Write the failing test**

Replace the contents of `mcp/tests/test_retrieve.py` with:

```python
from prd_mcp.retrieve import retrieve, keyword_retrieve


class FakeStore:
    def __init__(self, rows=None, kw_rows=None):
        self.rows = rows or []
        self.kw_rows = kw_rows or []
        self.kw_calls = []
    def query(self, embedding, k): return self.rows[:k]
    def keyword_query(self, terms, k):
        self.kw_calls.append(terms)
        return self.kw_rows[:k]


def row(stem, text, dist, summary="sum"):
    return {"text": text, "distance": dist, "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": summary, "chunk_type": "body"}}


def test_dedupe_distinct_prds_and_verdict_match():
    store = FakeStore([row("EP-1-a", "a1", 0.1), row("EP-1-a", "a2", 0.2), row("EP-2-b", "b1", 0.3)])
    out, verdict = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "match"
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
    assert out[0].text == "a1" and out[0].summary == "sum"
    assert round(out[0].score, 3) == 0.9


def test_verdict_no_match_when_all_below_threshold():
    store = FakeStore([row("EP-9-z", "x", 1.2)])  # score -0.2 < -0.15
    out, verdict = retrieve("q", store, lambda t: [[0.0, 1.0]], 8, -0.15)
    assert verdict == "no_match" and out == []


def test_empty_query_no_embed_call():
    called = {"n": 0}
    def embed(texts): called["n"] += 1; return [[1.0]]
    out, verdict = retrieve("   ", FakeStore([row("EP-1-a", "x", 0.1)]), embed, 8, -0.15)
    assert verdict == "no_match" and out == [] and called["n"] == 0


def kwrow(stem, summary="sum"):
    return {"text": "the lowercased keyword chunk text", "metadata": {
        "doc_stem": stem, "doc_id": stem[:5], "title": f"Title {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": summary, "chunk_type": "keyword"}}


def test_keyword_retrieve_lowercases_splits_drops_short_tokens():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "Real Summary")])
    # original-case body contains "SP3K" -> snippet drawn from it
    bodies = {"EP-1-a": "Intro about the SP3K Notification flow and more"}
    out = keyword_retrieve("SP3K  A of", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: bodies.get(stem, ""))
    # "a"(1) dropped, "of"(2) kept, "sp3k"(4) kept
    assert store.kw_calls[-1] == ["sp3k", "of"]
    assert [r.doc_stem for r in out] == ["EP-1-a"]
    # snippet is ORIGINAL case (from body), not the lowercased keyword text
    assert "SP3K Notification" in out[0].text


def test_keyword_retrieve_snippet_falls_back_to_summary_when_body_missing():
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out = keyword_retrieve("sp3k", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: "")  # no body
    assert out[0].text == "The Summary Text"  # fell back to summary


def test_keyword_retrieve_snippet_falls_back_when_term_absent_from_body():
    # body EXISTS but does not contain the matched term (it matched via title/id/tags)
    # -> must fall back to summary, NOT return an arbitrary body[:200] (Codex F3)
    store = FakeStore(kw_rows=[kwrow("EP-1-a", "The Summary Text")])
    out = keyword_retrieve("sp3k", store, 10, "/v",
                           read_body_fn=lambda stem, prds, **kw: "body without the term at all")
    assert out[0].text == "The Summary Text"  # summary, not "body without..."


def test_keyword_retrieve_all_short_tokens_returns_empty():
    store = FakeStore(kw_rows=[kwrow("EP-1-a")])
    out = keyword_retrieve("a", store, 10, "/v", read_body_fn=lambda *a, **k: "")
    assert out == [] and store.kw_calls == []  # never queried


def test_keyword_retrieve_dedupes_distinct_prds():
    store = FakeStore(kw_rows=[kwrow("EP-1-a"), kwrow("EP-2-b")])
    out = keyword_retrieve("bank dashboard", store, 10, "/v",
                           read_body_fn=lambda *a, **k: "")
    assert [r.doc_stem for r in out] == ["EP-1-a", "EP-2-b"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_retrieve.py -v`
Expected: FAIL — `ImportError: cannot import name 'keyword_retrieve'`.

- [ ] **Step 3: Implement in `mcp/prd_mcp/retrieve.py`**

Replace the whole file with:

```python
from dataclasses import dataclass
from prd_mcp.read import read_body_by_stem


@dataclass
class Retrieved:
    doc_stem: str
    doc_id: str
    title: str
    summary: str
    tags: list
    status: str
    source_url: str
    text: str
    score: float


def _mk(md, text, score):
    tags = md.get("tags", "")
    return Retrieved(
        doc_stem=md["doc_stem"], doc_id=md["doc_id"], title=md["title"],
        summary=md.get("summary", "") or "",
        tags=[t for t in tags.split(",") if t] if tags else [],
        status=md.get("status", ""), source_url=md.get("source_url", ""),
        text=text, score=score,
    )


def retrieve(query: str, store, embed_fn, k: int, threshold: float):
    if not query or not query.strip():
        return [], "no_match"
    vec = embed_fn([query])[0]
    rows = store.query(vec, k)
    seen, out, best = set(), [], None
    for r in rows:
        score = round(1.0 - r.get("distance", 0.0), 4)
        if best is None or score > best:
            best = score
        stem = r["metadata"]["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        out.append(_mk(r["metadata"], r["text"], score))
    if best is None or best < threshold:
        return [], "no_match"
    return out, "match"


def _snippet(body: str, first_term: str, summary: str, title: str) -> str:
    # Prefer a body window around the first matched term. If the term is NOT in
    # the body (it matched via title/id/tags in the keyword chunk), fall back to
    # the summary, then the title — never an arbitrary body[:200] that doesn't
    # contain the match (Codex F3).
    if body and first_term:
        idx = body.lower().find(first_term)
        if idx >= 0:
            start = max(0, idx - 100)
            return body[start:idx + 120]
    if summary:
        return summary
    if title:
        return title
    return body[:200] if body else ""


def tokenize(query: str) -> list:
    # Lowercase, split, drop tokens shorter than 2 chars (1-char tokens like "a"
    # match almost everything). Shared by the server's pre-store guard (Codex N2).
    return [t for t in (query or "").lower().split() if len(t) >= 2]


def keyword_retrieve(query: str, store, k: int, prds_dir: str,
                     read_body_fn=read_body_by_stem) -> list:
    terms = tokenize(query)
    if not terms:
        return []
    rows = store.keyword_query(terms, k)
    seen, out = set(), []
    for r in rows:
        md = r["metadata"]
        stem = md["doc_stem"]
        if stem in seen:
            continue
        seen.add(stem)
        body = read_body_fn(stem, prds_dir)
        snippet = _snippet(body, terms[0], md.get("summary", "") or "", md.get("title", ""))
        out.append(_mk(md, snippet, 0.0))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_retrieve.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/retrieve.py mcp/tests/test_retrieve.py
git commit -m "feat(mcp): retrieve verdict + empty guard; keyword_retrieve w/ original-case snippet"
```

---

### Task 6: Answer — accept verdict, short-circuit on no_match

**Files:**
- Modify: `mcp/prd_mcp/answer.py`
- Test: `mcp/tests/test_answer.py`

**Interfaces:**
- Consumes: `Retrieved` list + a `verdict` string, `chat_fn(messages) -> str`.
- Produces: `answer(question, retrieved, verdict, chat_fn) -> {answer, sources, grounded}`. On `verdict == "no_match"` (or empty `retrieved`): honest non-answer WITHOUT calling `chat_fn`. NOTE: signature gains a `verdict` parameter (3rd positional); `server.py` (Task 7) passes it. `build_messages`/`format_sources` are UNCHANGED.

- [ ] **Step 1: Update the failing test**

Edit `mcp/tests/test_answer.py`. KEEP `test_build_messages_grounding_and_context` and `test_format_sources` unchanged (they cover the unchanged helpers). Replace ONLY the two `answer()` tests (`test_answer_grounded`, `test_answer_empty_no_llm`) with:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_answer.py -v`
Expected: FAIL — `answer()` got an unexpected/positional mismatch (the new `verdict` arg).

- [ ] **Step 3: Implement in `mcp/prd_mcp/answer.py`**

Replace ONLY the `answer` function (keep `SYSTEM`, `build_messages`, `format_sources`):

```python
def answer(question: str, retrieved: list, verdict: str, chat_fn) -> dict:
    if verdict == "no_match" or not retrieved:
        return {"answer": "No PRD covers this.", "sources": [], "grounded": False}
    prose = chat_fn(build_messages(question, retrieved))
    return {"answer": prose, "sources": format_sources(retrieved), "grounded": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_answer.py -v`
Expected: PASS (4 tests: 2 unchanged helpers + 3 answer... wait, 2 helpers + 3 answer = 5). Expected: PASS (all answer tests).

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/answer.py mcp/tests/test_answer.py
git commit -m "feat(mcp): answer short-circuits on no_match verdict (no LLM call)"
```

---

### Task 7: Server — verdict + empty-query guard; add keyword_search + read_prd tools

**Files:**
- Modify: `mcp/prd_mcp/server.py`
- Test: `mcp/tests/test_server.py`

**Interfaces:**
- Consumes: `retrieve(query, store, embed_fn, k, threshold) -> (results, verdict)`, `keyword_retrieve(query, store, k, prds_dir) -> results`, `answer(question, retrieved, verdict, chat_fn)`, `read_prd(prd_id, prds_dir, ...)`, `Config.score_threshold`, `Config.prds_dir`.
- Produces: `search_prds_impl` (adds `verdict`; empty-query guard BEFORE `_ensure_index`), `ask_prds_impl` (verdict to answer; empty guard), `keyword_search_impl` (empty/short-token guard BEFORE `_ensure_index`), `read_prd_impl`; `build_server` registers `keyword_search` + `read_prd` tools.

**Empty-query ordering (Codex fix):** the empty/whitespace guard MUST run BEFORE `_ensure_index(store)` so an empty query returns the documented early response without touching the store — even when the index is missing.

- [ ] **Step 1: Write the failing test**

Replace `mcp/tests/test_server.py` contents with:

```python
import pytest
from prd_mcp.server import (search_prds_impl, ask_prds_impl,
                            keyword_search_impl, read_prd_impl)


class Cfg:
    top_k = 8
    score_threshold = -0.15
    prds_dir = "/v"


class FakeStore:
    def __init__(self, has_index=True, sem=None, kw=None):
        self._has = has_index
        self._sem = sem or []
        self._kw = kw or []
        self.touched = False
    def stored_hashes(self):
        self.touched = True
        return {"x": "h"} if self._has else {}
    def query(self, vec, k): self.touched = True; return self._sem[:k]
    def keyword_query(self, terms, k): self.touched = True; return self._kw[:k]


class BoomStore:
    # fails loudly if touched at all — proves empty-query guard runs first
    def stored_hashes(self): raise AssertionError("store touched on empty query")
    def query(self, vec, k): raise AssertionError("store touched on empty query")
    def keyword_query(self, terms, k): raise AssertionError("store touched on empty query")


class FakeLlm:
    def __init__(self): self.embed_calls = 0
    def embed(self, texts): self.embed_calls += 1; return [[0.0, 1.0]]
    def chat(self, msgs): return "answer prose"


def _doc_id(stem):
    # "EP-1-a" -> "EP-1" (the real id is the first two dash-segments, not stem[:5]
    # which would wrongly yield "EP-1-" with a trailing hyphen)
    return "-".join(stem.split("-")[:2])


def srow(stem, dist):
    return {"text": "body", "distance": dist, "metadata": {
        "doc_stem": stem, "doc_id": _doc_id(stem), "title": f"T {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": "sum", "chunk_type": "body"}}


def krow(stem):
    return {"text": "kw text lowercased", "metadata": {
        "doc_stem": stem, "doc_id": _doc_id(stem), "title": f"T {stem}",
        "source_url": f"https://n/{stem}", "status": "x", "tags": "a,b",
        "summary": "Original Summary", "chunk_type": "keyword"}}


def _no_body(stem, prds_dir, **kw): return ""  # snippet falls back to summary in these tests


def test_search_prds_includes_verdict_match():
    store = FakeStore(sem=[srow("EP-1-a", 0.1)])
    out = search_prds_impl(Cfg(), store, FakeLlm(), "q", 8)
    assert out["verdict"] == "match" and out["count"] == 1
    assert out["results"][0]["id"] == "EP-1" and "score" in out["results"][0]
    # backward-compat: all v1 fields still present
    for f in ("id", "title", "summary", "tags", "status", "source_url", "obsidian_link", "snippet", "score"):
        assert f in out["results"][0]


def test_search_prds_verdict_no_match():
    out = search_prds_impl(Cfg(), FakeStore(sem=[srow("EP-9-z", 1.3)]), FakeLlm(), "q", 8)
    assert out["verdict"] == "no_match" and out["results"] == [] and out["count"] == 0


def test_search_prds_empty_query_does_not_touch_store():
    out = search_prds_impl(Cfg(), BoomStore(), FakeLlm(), "   ", 8)
    assert out["verdict"] == "no_match" and out["count"] == 0


def test_search_prds_empty_index_raises():
    with pytest.raises(RuntimeError, match="index"):
        search_prds_impl(Cfg(), FakeStore(has_index=False), FakeLlm(), "q", 8)


def test_ask_prds_no_match_no_llm():
    llm = FakeLlm()
    out = ask_prds_impl(Cfg(), FakeStore(sem=[srow("EP-9-z", 1.3)]), llm, "q")
    assert out["grounded"] is False and out["sources"] == []


def test_ask_prds_match_returns_answer():
    out = ask_prds_impl(Cfg(), FakeStore(sem=[srow("EP-1-a", 0.1)]), FakeLlm(), "q")
    assert out["grounded"] is True and out["answer"] == "answer prose"
    assert out["sources"][0]["id"] == "EP-1"


def test_keyword_search_returns_distinct_with_snippet(monkeypatch):
    # Patch the binding keyword_retrieve actually uses (retrieve module), so the
    # body read returns "" and the snippet falls back to the summary — by the
    # patch, not by accident (Codex/Claude minor).
    import prd_mcp.retrieve as ret
    monkeypatch.setattr(ret, "read_body_by_stem", _no_body)
    store = FakeStore(kw=[krow("EP-1-a"), krow("EP-2-b")])
    out = keyword_search_impl(Cfg(), store, FakeLlm(), "bank dashboard", 10)
    assert out["count"] == 2
    assert [r["id"] for r in out["results"]] == ["EP-1", "EP-2"]
    assert out["results"][0]["snippet"] == "Original Summary"  # snippet populated (not empty)
    assert out["results"][0]["obsidian_link"] == "[[EP-1-a]]"


def test_keyword_search_empty_query_does_not_touch_store():
    out = keyword_search_impl(Cfg(), BoomStore(), FakeLlm(), "  ", 10)
    assert out["count"] == 0 and out["results"] == []


def test_keyword_search_all_short_tokens_does_not_touch_store():
    # "a b" is non-blank but every token is <2 chars -> zero usable tokens.
    # Must return empty WITHOUT touching the store (Codex N2).
    out = keyword_search_impl(Cfg(), BoomStore(), FakeLlm(), "a b", 10)
    assert out["count"] == 0 and out["results"] == []


def test_keyword_search_empty_index_raises():
    with pytest.raises(RuntimeError, match="index"):
        keyword_search_impl(Cfg(), FakeStore(has_index=False), FakeLlm(), "kpr", 10)


def test_read_prd_impl_found_and_missing():
    from prd_mcp.vault import Doc
    docs = {"/v/EP-1-a.md": Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u",
                                status="x", platform=[], tags=["a"], summary="s",
                                body_hash="h", body="the body")}
    import prd_mcp.server as srv
    out = srv.read_prd_impl(Cfg(), "EP-1",
                            list_docs_fn=lambda p: list(docs.keys()), read_doc_fn=lambda p: docs[p])
    assert out["found"] is True and out["body"] == "the body"
    miss = srv.read_prd_impl(Cfg(), "EP-404",
                             list_docs_fn=lambda p: list(docs.keys()), read_doc_fn=lambda p: docs[p])
    assert miss["found"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_server.py -v`
Expected: FAIL — `ImportError: cannot import name 'keyword_search_impl'`.

- [ ] **Step 3: Implement in `mcp/prd_mcp/server.py`**

Replace the whole file with:

```python
from mcp.server.fastmcp import FastMCP
from prd_mcp.retrieve import retrieve, keyword_retrieve, tokenize
from prd_mcp.answer import answer as build_answer
from prd_mcp.read import read_prd as _read_prd
from prd_mcp.vault import read_doc, list_docs


def _ensure_index(store):
    if not store.stored_hashes():
        raise RuntimeError("PRD index not built — run `prd-mcp index` first.")


def _blank(q: str) -> bool:
    return not q or not q.strip()


def _result(r):
    return {"id": r.doc_id, "title": r.title, "summary": r.summary, "tags": r.tags,
            "status": r.status, "source_url": r.source_url,
            "obsidian_link": f"[[{r.doc_stem}]]", "snippet": r.text, "score": r.score}


def search_prds_impl(cfg, store, llm, query: str, k: int) -> dict:
    if _blank(query):
        return {"count": 0, "verdict": "no_match", "results": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results, verdict = retrieve(query, store, llm.embed, k, cfg.score_threshold)
    return {"count": len(results), "verdict": verdict, "results": [_result(r) for r in results]}


def ask_prds_impl(cfg, store, llm, question: str) -> dict:
    if _blank(question):
        return {"answer": "No PRD covers this.", "sources": [], "grounded": False}
    _ensure_index(store)
    results, verdict = retrieve(question, store, llm.embed, cfg.top_k, cfg.score_threshold)
    return build_answer(question, results, verdict, llm.chat)


def keyword_search_impl(cfg, store, llm, query: str, k: int) -> dict:
    # Guard BEFORE _ensure_index: blank OR all-short-token queries (e.g. "a b" ->
    # zero usable tokens) must return empty without touching the store (Codex N2).
    if _blank(query) or not tokenize(query):
        return {"count": 0, "results": []}
    _ensure_index(store)
    k = min(max(1, int(k)), 20)
    results = keyword_retrieve(query, store, k, cfg.prds_dir)
    return {"count": len(results),
            "results": [{"id": r.doc_id, "title": r.title, "status": r.status,
                         "tags": r.tags, "source_url": r.source_url,
                         "obsidian_link": f"[[{r.doc_stem}]]", "snippet": r.text}
                        for r in results]}


def read_prd_impl(cfg, prd_id: str, read_doc_fn=read_doc, list_docs_fn=list_docs) -> dict:
    return _read_prd(prd_id, cfg.prds_dir, read_doc_fn=read_doc_fn, list_docs_fn=list_docs_fn)


def build_server(cfg, store, llm) -> FastMCP:
    mcp = FastMCP("ringkas-prds")

    @mcp.tool(description="Search Ringkas PRDs by topic/concept (semantic). Returns relevant PRDs "
                          "with summary, link, snippet, score, plus a `verdict` (match/no_match) — "
                          "branch on the verdict, not the score.")
    def search_prds(query: str, k: int = 8) -> dict:
        return search_prds_impl(cfg, store, llm, query, k)

    @mcp.tool(description="Case-insensitive keyword search over PRD body, title, id, and tags — for "
                          "literal identifiers (EP-457, SP3K, KPR, LTV) that semantic search ranks "
                          "poorly. Multi-word matches PRDs containing ALL words. Pair with search_prds.")
    def keyword_search(query: str, k: int = 10) -> dict:
        return keyword_search_impl(cfg, store, llm, query, k)

    @mcp.tool(description="Read the full canonical body of ONE PRD by id (e.g. 'EP-437'). Use after "
                          "search_prds/keyword_search to read the evidence — search returns selection "
                          "signals; read_prd returns the body you answer from.")
    def read_prd(id: str) -> dict:
        return read_prd_impl(cfg, id)

    @mcp.tool(description="Ask a question about Ringkas PRDs and get a grounded answer with citations. "
                          "Uses ONLY PRD content; says so if the PRDs don't cover it.")
    def ask_prds(question: str) -> dict:
        return ask_prds_impl(cfg, store, llm, question)

    return mcp
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && poetry run pytest tests/test_server.py -v`
Expected: PASS (13 tests).

- [ ] **Step 5: Run the FULL suite (cross-task integration check)**

Run: `cd mcp && poetry run pytest -q`
Expected: PASS — all tests across config/chunk/store/read/retrieve/answer/server/index/llm/vault.

- [ ] **Step 6: Commit**

```bash
git add mcp/prd_mcp/server.py mcp/tests/test_server.py
git commit -m "feat(mcp): verdict + empty-query guard; keyword_search + read_prd tools"
```

---

### Task 8: Index — placeholder vector for keyword chunk + `--force`

**Files:**
- Modify: `mcp/prd_mcp/index.py`, `mcp/prd_mcp/cli.py`
- Test: `mcp/tests/test_index.py`

**Interfaces:**
- Consumes: existing `run_index(cfg, store, embed_fn, read_doc_fn, list_docs_fn)`, `Chunk.chunk_type`.
- Produces: `run_index(..., force: bool = False)` that (a) embeds ONLY `chunk_type != "keyword"` chunks, (b) assigns the keyword chunk a zero vector `[0.0] * EMBED_DIM` with `EMBED_DIM = 1536`, (c) when `force=True`, ignores the `body_hash` skip-guard. `cli` `index` gains `--force`.

**Critical (Codex fix):** the keyword chunk text (up to ~106k tokens) must NEVER be passed to `embed_fn` — it exceeds OpenAI's 8191-token limit and would crash. Embed the non-keyword chunks, then splice a zero vector in the keyword chunk's position.

- [ ] **Step 1: Write the failing tests**

Add to `mcp/tests/test_index.py`:

```python
def test_keyword_chunk_not_embedded_and_gets_zero_vector():
    # The keyword chunk must NOT be passed to embed_fn; it gets a zero vector instead.
    from prd_mcp.index import run_index, EMBED_DIM
    from prd_mcp.vault import Doc

    class Cfg:
        prds_dir = "/v"; chunk_size = 1000; chunk_overlap = 150

    embedded_texts = []
    def embed(texts):
        embedded_texts.extend(texts)
        return [[0.1] * EMBED_DIM for _ in texts]

    upserted = {}
    class FakeStore:
        def stored_hashes(self): return {}
        def delete_by_doc(self, stem): pass
        def upsert(self, chunks, embs, body_hash):
            upserted["chunks"] = chunks; upserted["embs"] = embs

    doc = Doc(stem="EP-1-a", id="EP-1", title="Title", source_url="u", status="x",
              platform=[], tags=["kpr"], summary="s", body_hash="h1", body="real body text")
    res = run_index(Cfg(), FakeStore(), embed,
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"])
    assert res["indexed"] == 1
    # the lowercased keyword text must NOT appear in what was embedded
    kw_texts = [c.text for c in upserted["chunks"] if c.chunk_type == "keyword"]
    assert kw_texts, "expected a keyword chunk"
    assert kw_texts[0] not in embedded_texts
    # the keyword chunk's embedding is the zero placeholder of correct dim
    kw_idx = [i for i, c in enumerate(upserted["chunks"]) if c.chunk_type == "keyword"][0]
    assert upserted["embs"][kw_idx] == [0.0] * EMBED_DIM
    # body chunks DID get real (non-zero) embeddings
    body_idx = [i for i, c in enumerate(upserted["chunks"]) if c.chunk_type == "body"][0]
    assert upserted["embs"][body_idx] != [0.0] * EMBED_DIM


def test_force_reindexes_unchanged_docs():
    from prd_mcp.index import run_index, EMBED_DIM
    from prd_mcp.vault import Doc

    class Cfg:
        prds_dir = "/v"; chunk_size = 1000; chunk_overlap = 150

    class FakeStore:
        def __init__(self): self.upserts = []
        def stored_hashes(self): return {"EP-1-a": "h1"}  # already indexed, same hash
        def delete_by_doc(self, stem): pass
        def upsert(self, chunks, embs, body_hash): self.upserts.append(body_hash)

    doc = Doc(stem="EP-1-a", id="EP-1", title="T", source_url="u", status="x",
              platform=[], tags=["t"], summary="s", body_hash="h1", body="b")
    store = FakeStore()
    res = run_index(Cfg(), store, lambda t: [[0.0] * EMBED_DIM for _ in t],
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"])
    assert res["skipped"] == 1 and store.upserts == []
    res = run_index(Cfg(), store, lambda t: [[0.0] * EMBED_DIM for _ in t],
                    read_doc_fn=lambda p: doc, list_docs_fn=lambda d: ["/v/EP-1-a.md"], force=True)
    assert res["indexed"] == 1 and store.upserts == ["h1"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && poetry run pytest tests/test_index.py -k "keyword_chunk or force" -v`
Expected: FAIL — `ImportError: cannot import name 'EMBED_DIM'` and `run_index() got an unexpected keyword argument 'force'`.

- [ ] **Step 3: Implement in `mcp/prd_mcp/index.py`**

Replace the whole file with:

```python
import sys
from prd_mcp.vault import read_doc, list_docs
from prd_mcp.chunk import chunk_doc

EMBED_DIM = 1536  # text-embedding-3-small


def _embed_with_keyword_placeholder(chunks, embed_fn):
    # Embed only non-keyword chunks (keyword chunk text can exceed the embed token
    # limit). Keyword chunks get a zero placeholder vector spliced back in order.
    # The placeholder dim MUST match the real embeddings' dim (a Chroma collection
    # is single-dimension) — derive it from the returned vectors, not a constant,
    # so tests with small fake embedders and the live 1536-dim embedder both work.
    to_embed = [c.text for c in chunks if c.chunk_type != "keyword"]
    vecs = list(embed_fn(to_embed)) if to_embed else []
    dim = len(vecs[0]) if vecs else EMBED_DIM
    out, it = [], iter(vecs)
    for c in chunks:
        out.append([0.0] * dim if c.chunk_type == "keyword" else next(it))
    return out


def run_index(cfg, store, embed_fn, read_doc_fn=read_doc, list_docs_fn=list_docs,
              force: bool = False) -> dict:
    stored = store.stored_hashes()
    indexed = skipped = removed = errors = 0
    seen = set()
    for path in list_docs_fn(cfg.prds_dir):
        try:
            d = read_doc_fn(path)
            seen.add(d.stem)
            if not force and stored.get(d.stem) == d.body_hash and d.body_hash is not None:
                skipped += 1
                continue
            chunks = chunk_doc(d, cfg.chunk_size, cfg.chunk_overlap)
            if not chunks:
                skipped += 1
                continue
            embeddings = _embed_with_keyword_placeholder(chunks, embed_fn)
            store.delete_by_doc(d.stem)
            store.upsert(chunks, embeddings, body_hash=d.body_hash or "")
            indexed += 1
        except Exception as err:
            errors += 1
            print(f"error indexing {path}: {err}", file=sys.stderr)
    for stem in list(stored.keys()):
        if stem not in seen:
            store.delete_by_doc(stem)
            removed += 1
    return {"indexed": indexed, "skipped": skipped, "removed": removed, "errors": errors}
```

In `mcp/prd_mcp/cli.py`, replace the `sub.add_parser("index", ...)` line with:

```python
    idx = sub.add_parser("index", help="build/refresh the PRD index")
    idx.add_argument("--force", action="store_true",
                     help="re-embed every doc (ignore body_hash skip-guard)")
```

And in the `index` branch, pass `force`:

```python
    if args.cmd == "index":
        llm = make_client(cfg)
        res = run_index(cfg, store, llm.embed, force=args.force)
        print(f"indexed {res['indexed']} · skipped {res['skipped']} · "
              f"removed {res['removed']} · errors {res['errors']}")
        return 1 if res["errors"] else 0
```

- [ ] **Step 4: Run tests + full suite**

Run: `cd mcp && poetry run pytest -q`
Expected: PASS (all tests). Verify the CLI parses: `cd mcp && poetry run prd-mcp index --help` shows `--force`.

- [ ] **Step 5: Commit**

```bash
git add mcp/prd_mcp/index.py mcp/prd_mcp/cli.py mcp/tests/test_index.py
git commit -m "fix(mcp): never embed the keyword chunk (zero placeholder vector) + index --force"
```

---

### Task 9: Live forced reindex + smoke (manual, against the real index)

**Files:** none (ops verification).

**Interfaces:** none.

This task rebuilds the real index so existing docs gain keyword chunks, then verifies all three features against live data. Not automated (touches real OpenAI embeddings + the real vault).

- [ ] **Step 1: Forced reindex**

Run:
```bash
cd mcp
VAULT_PATH="/Users/edwardpham/Documents/Backup/Obsidian/ringkas" poetry run prd-mcp index --force
```
Expected: `indexed 287 · skipped 0 · removed 0 · errors 0` (every doc re-embedded with its keyword chunk; `skipped 0` confirms `--force` worked).

- [ ] **Step 2: Smoke — keyword_search case-insensitivity + identifiers**

Run:
```bash
cd mcp
VAULT_PATH="/Users/edwardpham/Documents/Backup/Obsidian/ringkas" poetry run python -c "
import os, warnings; warnings.filterwarnings('ignore')
from prd_mcp.config import load_config
from prd_mcp.keychain import read_secret
from prd_mcp.store import Store
from prd_mcp.llm import make_client
from prd_mcp.server import keyword_search_impl, search_prds_impl, read_prd_impl
cfg=load_config(os.environ, read_secret); s=Store.open(cfg.chroma_path); llm=make_client(cfg)
print('kw lower sp3k:', [r['id'] for r in keyword_search_impl(cfg,s,llm,'sp3k',5)['results']])
print('kw upper SP3K:', [r['id'] for r in keyword_search_impl(cfg,s,llm,'SP3K',5)['results']])
print('kw multiword :', [r['id'] for r in keyword_search_impl(cfg,s,llm,'bank report dashboard',5)['results']])
sp=search_prds_impl(cfg,s,llm,'pizza recipe',5); print('search junk verdict:', sp['verdict'])
sp2=search_prds_impl(cfg,s,llm,'referral code',5); print('search good verdict:', sp2['verdict'])
rd=read_prd_impl(cfg,'EP-437'); print('read EP-437 found:', rd['found'], 'body chars:', len(rd['body']))
" 2>&1 | grep -vE "telemetry|capture|HTTP Request"
```
Expected: `sp3k` and `SP3K` return the SAME ids (case-insensitive); `bank report dashboard` returns ≥1 id; junk verdict `no_match`; good verdict `match`; `read EP-437 found: True` with a non-zero body length.

- [ ] **Step 3: Verify the keyword chunk does NOT pollute semantic search**

Run:
```bash
cd mcp
VAULT_PATH="/Users/edwardpham/Documents/Backup/Obsidian/ringkas" poetry run python -c "
import os, warnings; warnings.filterwarnings('ignore')
from prd_mcp.config import load_config
from prd_mcp.keychain import read_secret
from prd_mcp.store import Store
from prd_mcp.llm import make_client
from prd_mcp.retrieve import retrieve
cfg=load_config(os.environ, read_secret); s=Store.open(cfg.chroma_path); llm=make_client(cfg)
res, verdict = retrieve('referral', s, llm.embed, 8, cfg.score_threshold)
# none of the returned rows should be keyword chunks (they are excluded at the store layer)
print('semantic results all non-keyword:', verdict, len(res), 'distinct PRDs')
" 2>&1 | grep -vE "telemetry|capture|HTTP Request"
```
Expected: `match`, several distinct PRDs (the store-level `$ne keyword` filter guarantees no keyword chunk leaks).

- [ ] **Step 4: Document the outcome in the report** (no commit — verification only). If any smoke check fails, STOP and report; do not proceed to merge.

---

## Self-Review (completed by plan author)

**Task order (post-Codex-review):** config(1) → chunk(2) → store(3) → **read(4)** → retrieve(5) → answer(6) → server(7) → index/force(8) → live smoke(9). `read.py` moved before `retrieve.py` so `keyword_retrieve` builds original-case snippets via `read_body_by_stem`.

**Spec coverage** (§ of `2026-06-20-retrieval-upgrades-design.md` → task):
- §2 keyword_search via keyword-chunk + `$contains` → Tasks 2, 3, 7. ✓
- §2 case handling (lowercased keyword chunk) → Task 2. ✓
- §2 keyword chunk excluded from semantic → Task 3 (`query` `$ne`), tested Task 3 + smoke Task 9 §3. ✓
- §2 keyword chunk NEVER embedded (placeholder vector) → Task 8 (`_embed_with_keyword_placeholder`), tested Task 8. ✓ **(Codex Critical fix)**
- §2 multi-word AND-of-words + drop <2-char tokens → Tasks 3, 5. ✓
- §2 verdict match/no_match, threshold −0.15 → Tasks 1, 5, 7. ✓
- §2 read_prd full body from vault by exact id → Task 4. ✓
- §2 original-case keyword snippet (summary/body/title fallback) → Task 5 (`_snippet` + `read_body_by_stem`), tested Task 5. ✓ **(Codex Important fix)**
- §2 degenerate-query guards at the TOOL layer (before `_ensure_index`) → Task 7 (`_blank` guard), tested with `BoomStore`. ✓ **(Codex Important fix)**
- §4 tool contracts (keyword_search, read_prd, search_prds+verdict, ask_prds no-LLM-on-no_match) → Tasks 6, 7. ✓
- §6 error handling (empty results not errors; found:false; un-enriched ok; empty index raises) → Tasks 4, 7. ✓
- §7 testing (chunk/store/read/retrieve/answer/server layers) → each task's tests. ✓
- §8 edges 1–13 → covered: E1/E2/E9 keyword chunk (T2/T3), E10 semantic exclusion (T3), E3/E11 AND-of-words+short-token drop (T3/T5), E4 threshold (T1/T5), E5 un-enriched (T2/T4), E6 empty guard (T7 tool layer), E7 exact-id (T4), E8 removed docs (read-only, no code), E12 size→placeholder vector (T8), E13 literal-not-regex (no code). ✓
- §6 one-time forced reindex → Tasks 8, 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion.

**Type consistency:** `retrieve(...) -> (list, str)` consumed as a tuple in `search_prds_impl`/`ask_prds_impl` (T7) and `answer(question, retrieved, verdict, chat_fn)` (T6) — matched. `keyword_retrieve(query, store, k, prds_dir, read_body_fn) -> list[Retrieved]` consumed by `keyword_search_impl` (T7). `Retrieved` fields unchanged across T5/T6/T7. `read_prd(prd_id, prds_dir, ...)` + `read_body_by_stem(stem, prds_dir, ...)` (T4) consumed by `read_prd_impl` (T7) and `keyword_retrieve` (T5). `run_index(..., force=False)` (T8) with `EMBED_DIM=1536` called with `force=args.force` (T8 cli). Consistent.

**Codex review fixes applied (3 Critical/Important + 1 Minor):** (1) Critical — keyword chunk is no longer embedded; it gets a zero placeholder vector (verified: 48/287 keyword chunks exceed the 8191-token embed limit, largest ~106k tokens — would have crashed the live reindex). (2) Important — empty-query guards moved to the tool layer BEFORE `_ensure_index`, tested with a `BoomStore` that raises if touched. (3) Important — `keyword_retrieve` now builds original-case snippets (summary/body/title fallback) via `read_body_by_stem`; tests assert the `snippet` field, not just `summary`; this is why `read.py` moved to Task 4. (4) Minor — added a `keyword_query` `k`-limit test (Task 3). Kept `build_messages`/`format_sources` direct tests (did not wholesale-replace `test_answer.py`).

**Known follow-up (not a gap):** the nightly index cron (`com.ringkas.prd-mcp-index`) runs `prd-mcp index` WITHOUT `--force`; after Task 9's one-time `--force` rebuild, incremental-by-body_hash correctly maintains keyword chunks (a changed doc re-emits all its chunks including the keyword chunk, which the indexer gives a placeholder vector). No cron change needed.
