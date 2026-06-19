#!/usr/bin/env bash
# Load all PRDs from a vault's PRDs/ folder into the Open WebUI "PRDs" knowledge base.
# Each upload triggers Open WebUI's chunking + OpenAI embedding. Re-uses an existing
# "PRDs" KB if present. Usage:
#   OWUI_EMAIL=you@host OWUI_PASS=pass ./load_prds.sh <vault>/PRDs [BASE_URL]
set -euo pipefail

BASE="${2:-http://localhost:3030}"
VAULT_PRDS="${1:?usage: load_prds.sh <vault>/PRDs [base_url]}"
EMAIL="${OWUI_EMAIL:?set OWUI_EMAIL}"
PASS="${OWUI_PASS:?set OWUI_PASS}"

TOKEN=$(curl -s -X POST "$BASE/api/v1/auths/signin" -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
[ -z "$TOKEN" ] && { echo "auth failed"; exit 1; }

# reuse an existing 'PRDs' KB if present, else create.
# GET /api/v1/knowledge/ returns {"items":[...], "total":N} (not a bare list).
KBID=$(curl -s "$BASE/api/v1/knowledge/" -H "authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);ks=d.get('items',d) if isinstance(d,dict) else d;print(next((k['id'] for k in ks if k.get('name')=='PRDs'),''))")
if [ -z "$KBID" ]; then
  KBID=$(curl -s -X POST "$BASE/api/v1/knowledge/create" -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" -d '{"name":"PRDs","description":"Ringkas PRD corpus"}' \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
fi
echo "KB: $KBID"

n=0; fail=0
for f in "$VAULT_PRDS"/*.md; do
  base=$(basename "$f"); case "$base" in _*) continue;; esac
  FID=$(curl -s -X POST "$BASE/api/v1/files/" -H "authorization: Bearer $TOKEN" -F "file=@${f}" \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)
  if [ -z "$FID" ]; then echo "skip (upload failed): $base"; fail=$((fail+1)); continue; fi
  curl -s -X POST "$BASE/api/v1/knowledge/${KBID}/file/add" -H "authorization: Bearer $TOKEN" \
    -H "content-type: application/json" -d "{\"file_id\":\"$FID\"}" >/dev/null 2>&1 || true
  n=$((n+1)); printf "\r[%d] loaded  " "$n"
done
echo ""
echo "loaded $n PRDs into KB $KBID (failures: $fail)"
