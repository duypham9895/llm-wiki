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
