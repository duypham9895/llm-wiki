# Notion → Obsidian PRD Sync (sub-project A)

One-way sync of Ringkas PRDs from the Notion "Product Backlog (EPIC)" database
into an Obsidian vault as clean Markdown. See `docs/superpowers/specs/` for design.

## Setup (once)
1. Create a Notion internal integration; share it on the "Product Management" page.
2. Store the token: `security add-generic-password -s ringkas-prd-sync -a notion-token -w '<TOKEN>'`

## Run
```bash
VAULT_PATH="/path/to/Obsidian/Vault" npm run sync
```

## Schedule (macOS launchd)
Edit `launchd/com.ringkas.prd-sync.plist` (set `<USER>`, `<VAULT_PATH>`), then:
```bash
cp launchd/com.ringkas.prd-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ringkas.prd-sync.plist
```
Logs: `/tmp/prd-sync.log`, `/tmp/prd-sync.err.log`.

## Output
`PRDs/*.md` (one file per PRD), `PRDs/_attachments/<id>/`, `PRDs/_Archive/`.
`sync.*` frontmatter is owned by this tool; `llm.*` is reserved for enrichment and never overwritten.

## Enrichment (sub-project B)

After A syncs, B fills each PRD's `llm:` frontmatter block with an LLM summary,
tags, and related-PRD backlinks.

### Setup (once)
Store the LLM API key: `security add-generic-password -s ringkas-prd-enrich -a llm-api-key -w '<KEY>'`

### Run
```bash
VAULT_PATH="/path/to/Vault" LLM_BASE_URL="https://your-endpoint/v1" LLM_MODEL="MiniMax-M2" npm run enrich
```

### Schedule
`launchd/com.ringkas.prd-enrich.plist` runs at 04:23 (after A's 03:17 sync). Edit the placeholders, then:
```bash
cp launchd/com.ringkas.prd-enrich.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ringkas.prd-enrich.plist
```

B only writes the `llm:` block; A's `sync:` block and body are never touched.
