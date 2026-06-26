# chat-owui — RETIRED 2026-06-26

This directory contains the original Open WebUI setup for chatting with PRDs over Tailscale.
It ran on Duy's MacBook as a private sharing setup for one teammate (`member@ringkas.local`).

## Why retired

The llm-wiki web dashboard (this repo, `mcp/web-ui/`) ships its own Ask page backed by the
same shared `mcp/prd_mcp` core that powers the MCP server. As of Phase 5 the dashboard has:

- Real auth + per-user sessions (replacing Tailscale-as-gate)
- Multi-device access via the openclaw VPS (no more "only on Duy's laptop")
- Streaming chat with sources + token-by-token UI
- Conversation history per user (with URL hash persistence)
- No need for a separate Open WebUI knowledge base upload — Chroma index is the single source of truth

So the OWUI side-stack (Open WebUI + a Mac-laptop knowledge base + Tailscale tunnel) is now
strictly redundant. **This directory's `load_prds.sh` is preserved as a historical reference for
the migration**, but you should NOT run it again. If someone wants to keep a personal Open
WebUI for experimental work, that's fine — but the team's PRD chat is the dashboard's Ask page.

## Files retained (do not delete, but do not use)

- `load_prds.sh` — bash script that POSTed each PRD to Open WebUI's `/api/v1/knowledge/`. Useful
  if you want to seed a personal OWUI instance for offline experiments.
- `SHARING.md` — the old sharing-via-Tailscale instructions. The current sharing model is
  "create an account in `/admin/directory` and send the user the link".

## Replacement

- **PRD chat:** `https://prd.duyopenclaw.tech/ask` (production)
- **PRD browse + search:** `https://prd.duyopenclaw.tech/library` + `/search`
- **User management:** `https://prd.duyopenclaw.tech/admin/directory` (admin only)

See `mcp/deploy/README.md` for the full operational picture.