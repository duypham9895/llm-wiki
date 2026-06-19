# RAG Chat via Open WebUI — Setup Runbook (Sub-project C)

**Date:** 2026-06-19
**Status:** Decided after a live spike. C is a configured off-the-shelf app, not custom code.
**Supersedes:** the custom `chat/` build (`2026-06-19-rag-chat.md`), retained for history.

## Decision & Rationale

A 20-minute spike (Open WebUI in Docker, wired to the user's MiniMax router for chat + OpenAI for embeddings, 5 real PRDs uploaded) produced excellent grounded answers with inline `[1]` citations on the real corpus. For a personal daily tool, that clears the bar at ~zero build cost.

**Accepted tradeoffs** (vs. the custom build, verified in the spike):
- Citations are **filename-only** (e.g. `EP-468-bank-report-on-crm-for-bank-users.md`) — no dual Notion + Obsidian `[[link]]`. The filename contains the `EP-` id and slug, so the source is still identifiable; you search the title in Notion/Obsidian.
- Open WebUI does its **own chunking + embedding** on ingest — sub-project B's `summary`/`tags` do not influence retrieval. (B still has standalone value in the Obsidian vault.)
- Retrieval uses Open WebUI's **hybrid search (BM25 + vector)** + optional reranking — arguably better out-of-the-box recall than the custom v1's pure-vector plan.

**Stack confirmed working in the spike:**
- Chat: MiniMax router `https://9router-1.dat-nguyen.me/v1`, model `minimax/MiniMax-M3` (also exposes GPT-5.x and Claude models if preferred).
- Embeddings: OpenAI `text-embedding-3-small` direct (`https://api.openai.com/v1`, key `ringkas-prd-embed`/`openai-api-key`).
- The router has **no embedding model** (32 models, all chat) — embeddings MUST go to OpenAI directly.

---

## Prerequisites (verified)

- ✅ Docker Desktop installed (29.x) and daemon running.
- ✅ OpenAI key in keychain: `ringkas-prd-embed` / `openai-api-key` (probe returned 1536-dim).
- ✅ MiniMax key in keychain: `ringkas-prd-enrich` / `llm-api-key`.
- ✅ The vault: `<vault>/PRDs/*.md` (132 PRDs, A-synced + B-enriched). Spike used `/tmp/smoke-vault`; production uses the real iCloud vault path.
- Note: Open WebUI's pip install needs Python 3.11+; this host has 3.10, so **Docker is the supported path**.

---

## Part 1 — Run Open WebUI (one-time)

Port 3000 is taken on this host; use **3030**. The container reads keys via env at launch.

```bash
MINIMAX_KEY=$(security find-generic-password -s ringkas-prd-enrich -a llm-api-key -w)
OPENAI_KEY=$(security find-generic-password -s ringkas-prd-embed -a openai-api-key -w)

docker pull ghcr.io/open-webui/open-webui:main

docker rm -f open-webui 2>/dev/null
docker run -d --name open-webui --restart unless-stopped \
  -p 3030:8080 \
  -e WEBUI_AUTH=True \
  -e ENABLE_OLLAMA_API=False \
  -e ENABLE_OPENAI_API=True \
  -e OPENAI_API_BASE_URL="https://9router-1.dat-nguyen.me/v1" \
  -e OPENAI_API_KEY="$MINIMAX_KEY" \
  -e RAG_EMBEDDING_ENGINE=openai \
  -e RAG_EMBEDDING_MODEL=text-embedding-3-small \
  -e RAG_OPENAI_API_BASE_URL="https://api.openai.com/v1" \
  -e RAG_OPENAI_API_KEY="$OPENAI_KEY" \
  -e ENABLE_RAG_HYBRID_SEARCH=True \
  -v open-webui:/app/backend/data \
  ghcr.io/open-webui/open-webui:main
```

Notes:
- `WEBUI_AUTH=True` for production (the spike used `False`); the first account you create at `http://localhost:3030` becomes admin.
- `-v open-webui:/app/backend/data` persists the DB + vector index across restarts.
- `--restart unless-stopped` brings it back after a reboot.

**Verify:** wait ~40s, then `curl -s http://localhost:3030/health` → `{"status":true}`. Open `http://localhost:3030`, create your admin account.

---

## Part 2 — Create the PRD Knowledge Base + load all 132 PRDs

A small loader script uploads every PRD and adds it to a "PRDs" knowledge base. Save as `chat-owui/load_prds.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="http://localhost:3030"
VAULT_PRDS="${1:?usage: load_prds.sh <vault>/PRDs}"
EMAIL="${OWUI_EMAIL:?set OWUI_EMAIL}"
PASS="${OWUI_PASS:?set OWUI_PASS}"

TOKEN=$(curl -s -X POST "$BASE/api/v1/auths/signin" -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# reuse an existing 'PRDs' KB if present, else create
KBID=$(curl -s "$BASE/api/v1/knowledge/" -H "authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;ks=json.load(sys.stdin);print(next((k['id'] for k in ks if k['name']=='PRDs'),''))")
if [ -z "$KBID" ]; then
  KBID=$(curl -s -X POST "$BASE/api/v1/knowledge/create" -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" -d '{"name":"PRDs","description":"Ringkas PRD corpus"}' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
fi
echo "KB: $KBID"

n=0
for f in "$VAULT_PRDS"/*.md; do
  base=$(basename "$f"); case "$base" in _*) continue;; esac
  FID=$(curl -s -X POST "$BASE/api/v1/files/" -H "authorization: Bearer $TOKEN" -F "file=@${f}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  [ -z "$FID" ] && { echo "skip (upload failed): $base"; continue; }
  curl -s -X POST "$BASE/api/v1/knowledge/${KBID}/file/add" -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" -d "{\"file_id\":\"$FID\"}" >/dev/null
  n=$((n+1)); echo "[$n] $base"
done
echo "loaded $n PRDs into KB $KBID"
```

Run it:
```bash
chmod +x chat-owui/load_prds.sh
OWUI_EMAIL="you@local" OWUI_PASS="yourpass" ./chat-owui/load_prds.sh "/path/to/Vault/PRDs"
```
Expected: `loaded 132 PRDs into KB <id>`. (Each upload triggers an OpenAI embedding call — a few cents total for 132 docs.)

---

## Part 3 — Use it

In the Open WebUI chat (`http://localhost:3030`):
1. Pick model `minimax/MiniMax-M3` (top bar).
2. Attach the **PRDs** knowledge base to the chat (the `#` / collection picker), or set it as the default for a custom "PRD Assistant" model.
3. Ask: *"What is the bank report dashboard for?"* → grounded answer with inline `[1]` citations to the source PRD files.

Optional polish (in Admin → Settings → Documents/RAG):
- Tune **Top K** (default ~3-5; raise to 6-8 for broader questions).
- Enable a **reranker** if recall needs improving (`RAG_RERANKING_MODEL`).
- Set a **system prompt** for the PRD Assistant model: *"Answer using ONLY the attached PRDs. Cite the PRD ids. If they don't cover it, say so."*

---

## Part 4 — Keep it fresh (re-index after the nightly A+B pipeline)

The vault changes when A re-syncs (03:17) and B re-enriches (04:23). Open WebUI does not auto-watch the folder, so re-load changed PRDs after the pipeline. Two options:

**Option A — re-run the loader nightly (simple, full reload).** The loader re-uploads all PRDs; Open WebUI re-embeds them. At 132 docs this is a few cents + a few minutes. Schedule a launchd job at ~04:50:

`launchd/com.ringkas.prd-owui-load.plist` (StartCalendarInterval 04:50) running `load_prds.sh` against the real vault. (Caveat: a full reload duplicates files unless you first clear the KB; for v1 simplicity, periodically delete + recreate the PRDs KB, or use Option B.)

**Option B — Open WebUI's built-in Knowledge "Sync directory" (preferred if available in your version).** Admin → Knowledge → PRDs → **Sync** a mounted folder. Mount the vault read-only into the container (`-v "/path/to/Vault/PRDs":/data/prds:ro`) and point the KB sync at `/data/prds`. This re-ingests changed files without the loader script. Verify this feature exists in the installed Open WebUI version; if not, use Option A.

---

## Part 5 — Operational notes

- **Cost:** embeddings are OpenAI `text-embedding-3-small` (~$0.02 / 1M tokens). 132 PRDs ≈ well under $0.10 to fully index; chat answers run on the MiniMax router (your existing spend).
- **Privacy:** PRD text is sent to OpenAI (embeddings) and the MiniMax router (answers). Acceptable per the user's existing B usage; note it.
- **Backup:** the `-v open-webui:` named volume holds the index + chats. `docker volume inspect open-webui` for its path.
- **Teardown of the spike container:** `docker rm -f open-webui-spike && docker volume rm open-webui-spike-data` (the production container is named `open-webui`).
- **Logs:** `docker logs -f open-webui`.

---

## What was NOT built (and why that's fine)

The custom `chat/` Python app (spec `2026-06-19-rag-chat-design.md`, plan `2026-06-19-rag-chat.md`) is superseded. It would have added: dual Notion+Obsidian citation links, B-summary-aware retrieval, and `body_hash` incremental indexing. The spike showed Open WebUI's grounded answers + inline citations + hybrid search are good enough for a personal tool without that work. If dual-link traceability or B-aware retrieval later proves important, the custom plan is ready to execute (or an Open WebUI **Pipeline** can inject our retrieval while keeping the OWUI shell).
