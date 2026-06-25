#!/bin/sh
set -eu

REPO="duypham9895/llm-wiki"
ENV_FILE="/app/.env"
STATE_FILE="/state/deployer.state"

LATEST_TAG=$(grep '^IMAGE_TAG=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "")

poll() {
  local img=$1
  local token
  token=$(curl -fsS "https://ghcr.io/token?scope=repo:${REPO}/${img}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || return 1
  [ -z "$token" ] && return 1
  curl -fsS -H "Authorization: Bearer $token" \
    "https://ghcr.io/v2/${REPO}/${img}/tags/list" \
    | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' \
    | sort | tail -1
}

new_app=$(poll app || echo "")
new_webui=$(poll webui || echo "")

if [ -z "$new_app" ] || [ "$new_app" = "$LATEST_TAG" ]; then
  echo "$(date -u +%FT%TZ) no_update app=${new_app:-none} current=${LATEST_TAG}" > "$STATE_FILE"
  exit 0
fi

# Both app and webui should be at the same SHA (built by the same GH Actions run).
# Use app as the source of truth; webui is optional.
cp "$ENV_FILE" "${ENV_FILE}.bak"

sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${new_app}/" "$ENV_FILE"

cd /app
if docker compose config >/dev/null 2>&1 \
   && docker compose pull prd-app prd-ui-build \
   && docker compose up -d prd-app prd-ui-build; then
  rm -f "${ENV_FILE}.bak"
  echo "$(date -u +%FT%TZ) deployed ${new_app}" > "$STATE_FILE"
else
  mv "${ENV_FILE}.bak" "$ENV_FILE"
  echo "$(date -u +%FT%TZ) deploy_failed; rolled back" > "$STATE_FILE"
  exit 1
fi
