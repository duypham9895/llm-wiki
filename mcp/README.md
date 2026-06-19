# PRD MCP Server

Lets AI agents (Claude Code, Codex) search and ask over the Ringkas PRD vault.

## Tools
- `search_prds(query, k=8)` → ranked PRDs (id, title, summary, tags, status, links, snippet, score).
- `ask_prds(question)` → grounded answer + citations (Notion + Obsidian links).

## Setup
- Keys (already in keychain): `ringkas-prd-embed/openai-api-key` (embeddings),
  `ringkas-prd-enrich/llm-api-key` (answers). Read at runtime; never logged or returned to clients.
- `cd mcp && poetry install`
- Build the index: `VAULT_PATH="/path/to/Vault" poetry run prd-mcp index`
- It re-embeds only changed PRDs (by `body_hash`). Scheduled nightly at 12:20 after A+B+C
  (`launchd/com.ringkas.prd-mcp-index.plist` → its OWN Chroma store at `<vault>/.chroma-mcp`,
  never Open WebUI's collection).

## Run / register
- **stdio (Claude Code / Codex):** register an MCP server that runs `prd-mcp serve`
  (cwd = this `mcp/` dir, `VAULT_PATH` in env).
- **HTTP (shared):** `MCP_AUTH_TOKEN=... VAULT_PATH=... poetry run prd-mcp serve --http`
  (expose only over Tailscale; the bearer token gates access).

## Claude Code registration example
Add to `.mcp.json` (or Claude Code MCP settings). Use the venv console script by
absolute path — the MCP launcher does not always inherit the shell `PATH` that finds `poetry`:
```json
{ "mcpServers": { "ringkas-prds": {
  "command": "/Users/edwardpham/Documents/Workspace/Ringkas/Programming/Personal/llm-wiki/mcp/.venv/bin/prd-mcp",
  "args": ["serve"],
  "cwd": "/Users/edwardpham/Documents/Workspace/Ringkas/Programming/Personal/llm-wiki/mcp",
  "env": { "VAULT_PATH": "/Users/edwardpham/Documents/Backup/Obsidian/ringkas" } } } }
}
```
(Equivalent with poetry: `"command": "poetry", "args": ["run", "prd-mcp", "serve"]` — requires `poetry` on the launcher's PATH.)

Read-only over the vault. Embeddings: OpenAI text-embedding-3-small (1536-dim). Answers: MiniMax (`stream:false`).
