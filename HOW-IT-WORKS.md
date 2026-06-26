# LLM Wiki — How it works

> An always-on PRD search + chat platform for the Ringkas PM team. Notion is
> the editor, a synced markdown vault is canonical, a Chroma index powers search,
> and a React dashboard (gated by login) is the human surface.

---

## TL;DR

Notion (Product Backlog DB) is the editor PMs write in. Every night, a Node pipeline
copies PRDs to a local markdown vault, asks an LLM to enrich them with summaries /
tags / links, then embeds everything into a Chroma vector store. A FastAPI app
serves **two doors** over the same Python core — a JSON HTTP door (the React
dashboard, `prd-app`) and a stdio MCP door (Claude Code / Codex). The dashboard
exposes a Library browser, a Search box (semantic + keyword lanes), a multi-turn
streaming Ask chat, and a Status panel for pipeline health. Auth is real (Postgres
users, Argon2 passwords, cookie sessions, RBAC, domain allowlist, registration
toggle). One workspace; one team; one chat with your PRDs, with citations.

---

## The data flow

```
  ┌─────────┐    sync     ┌─────────────┐   enrich    ┌─────────────┐  index   ┌─────────────┐
  │ NOTION  │  ──────────▶│   VAULT     │ ───────────▶│  ENRICHED   │─────────▶│   CHROMA    │
  │ (source)│  npm run    │ <vault>/    │ npm run     │ <vault>/    │ Python   │ <vault>/    │
  │         │   sync      │  PRDs/*.md  │  enrich     │  PRDs/*.md  │ index    │ .chroma-mcp/│
  └─────────┘             └─────────────┘             │  (+llm:     │          └─────────────┘
                                                     │   block)    │                │
                                                     └─────────────┘                │
                                                                                     │
                                                                              ┌──────┴──────┐
                                                                              │  FastAPI    │
                                                                              │  (one core, │
                                                                              │   two doors)│
                                                                              └──────┬──────┘
                                                                                     │
                                                              ┌──────────────────────┼──────────────────────┐
                                                              ▼                      ▼                      ▼
                                                       ┌────────────┐         ┌────────────┐         ┌────────────┐
                                                       │ HTTP door  │         │ MCP door   │         │ CRON       │
                                                       │ (React UI) │         │ (stdio,    │         │ (nightly)  │
                                                       │            │         │  Claude    │         │            │
                                                       └────────────┘         │  Code/Codex│         └────────────┘
                                                                           └────────────┘
```

Every stage writes a **run-manifest** JSON to `<vault>/.runs/<run_id>/<stage>.json`.
The orchestrator reads each stage's manifest, evaluates a **chain guard** (a failed
enrich stage halts the index stage instead of silently passing — the bug that
shipped un-enriched PRDs once before), and pings a dead-man Healthchecks.io URL
on success. The Status tab reads these manifests directly — no sync-up gap.

---

## The four surfaces

1. **Notion** — Product Backlog DB. PMs edit here. Source of truth for content.
2. **Vault** — `<vault>/PRDs/*.md` (canonical markdown copies with YAML frontmatter
   and an `llm:` enrichment block). Survives Notion outages; the only thing the
   rest of the system actually reads.
3. **Chroma** — `<vault>/.chroma-mcp/` (vector + keyword index, OpenAI
   `text-embedding-3-small`, 1536-dim). Rebuilt after every sync.
4. **Postgres `prd_app`** — users, sessions, roles, permissions, conversations,
   messages, recent_views. Single DB; the HTTP and MCP doors share it.

---

## The three doors

| Door | What | Who uses it | How |
|---|---|---|---|
| **FastAPI HTTP** | `prd-mcp web` (uvicorn, single worker) | React dashboard, internal curl | Cookie session + `X-Requested-With: prd-app` CSRF header on mutations |
| **MCP stdio** | `prd-mcp serve` | Claude Code, Codex | stdio JSON-RPC over the same Python core |
| **Cron pipeline** | `npm run orchestrate` / `npm run sync` | nightly + on-demand | `busybox crond` inside the `prd-cron` container |

**One brain, two doors.** Both the HTTP door and the MCP door call the same pure
core functions (`retrieve`, `keyword_retrieve`, `answer`, `answer_stream`,
`read_prd`). The dashboard's Ask tab and Claude Code's `ask_prds` are behaviorally
identical — there is no second implementation of retrieval or answering.

---

## The pipeline stages

| Stage | What | When | Where |
|---|---|---|---|
| **Sync** | Notion → vault `.md` files (incremental) | nightly + on demand | `npm run sync` (UI: Sources → Run now) |
| **Enrich** | LLM fills `llm:` block (summary, tags, related links) | nightly only | `npm run enrich` |
| **Index** | Rebuild Chroma embeddings from vault | nightly + after every sync | `python -m prd_mcp.cli index` |
| **Orchestrate** | sync → enrich → index in sequence, with chain guard | nightly at 02:00 UTC | `npm run orchestrate` (in `prd-cron`) |
| **Force re-index** | Drift catch in case the morning run errored | nightly at 03:00 UTC | `prd-mcp index --force` |

A nightly run with no Notion changes is legitimate: `processed=0, skipped=N`
counts and still passes the chain guard (no division-by-zero, no false halt).

---

## The auth model

- **Passwords** — Argon2id (tunable cost via env); hashed, never logged.
- **Sessions** — opaque 256-bit random tokens, stored as SHA-256 hashes (no
  signed cookies, no JWT). Idle timeout slides on activity; absolute timeout
  never moves. Default: 24h idle, 30d absolute.
- **RBAC** — `roles` → `permissions` (many-to-many). 5 fixed permissions:
  `prd.read`, `prd.ask`, `status.view`, `users.manage`, `roles.manage`. The
  admin pair (`users.manage` + `roles.manage`) is enforced as an invariant —
  no role or user may hold exactly one of them, and at least one active user
  must hold both. A Postgres advisory lock serializes the check-then-mutate.
- **System roles seeded** — `admin` (all 5 permissions) and `member`
  (`prd.read` + `prd.ask`). Admins can create additional custom roles in the UI.
- **Email-domain allowlist** — admins configure a list; non-matching sign-ups are
  rejected with a generic error (no enumeration).
- **Registration toggle** — admins can disable self-sign-up entirely; existing
  users still log in.
- **Break-glass admin** — `.env` `ADMIN_EMAIL` / `ADMIN_PASSWORD` are re-asserted
  only when no active admin exists; on a healthy instance they are never touched.
- **CSRF** — state-changing HTTP requests must send `X-Requested-With: prd-app`.

---

## The UI

- **Stack** — React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui (Radix under
  the hood) + TanStack Query + react-router. Builds to static files; Caddy serves
  them and reverse-proxies `/api/*` to the loopback FastAPI app.
- **Design system** — clean Linear/Notion-grade SaaS, single indigo accent
  (`#5E6AD2`-ish), Inter + JetBrains Mono, 13–14px base, 8px grid, subtle
  150–200ms motion, framer-motion transitions.
- **Dark mode** — first-class, CSS variables (OKLCH), persisted to localStorage,
  no flash on reload (inline script reads localStorage before React mounts).
- **9 pages** (under `/library`, `/search`, `/ask`, `/status`, `/admin/{approvals,
  directory, roles, sources, settings}`, plus `/login`):
  - **Library** — paginated PRD grid, filters by status/tag, click → full reader.
  - **Search** — semantic vs. keyword toggle; surfaces the honest `no_match`
    verdict instead of dressing weak hits as matches.
  - **Ask** — multi-turn streaming chat (SSE), conversation rail with delete,
    Sources panel per answer. New chat via the rail's `+ New`. Server enforces
    one-at-a-time generation per conversation (`409 conversation_busy` otherwise).
  - **Status** — pipeline health (latest per-stage run, chain-halt banner),
    coverage (enriched vs. un-enriched, index freshness).
  - **Admin › Approvals** — pending registration queue, Approve/Reject with role
    assignment; surfaces `admin_pair` / `last_admin` invariants inline.
  - **Admin › Directory** — active/disabled/pending user table (DataTable):
    reset password, disable/enable, manage roles, delete with typed-confirm.
  - **Admin › Roles** — list/create/edit/delete custom roles; system roles locked.
  - **Admin › Sources** — list configured sources (Notion today), last run, recent
    runs, **Run now** button that spawns `npm run sync` and auto-chains re-index.
    Polls every 5–30s while running.
  - **Admin › Settings** — registration toggle + email-domain allowlist editor.
  - **Login** — email + password; generic error on failure (no enumeration).
- **⌘K palette** — global, opens via `Cmd+K` / `Ctrl+K`. Fuzzy-search navigation,
  recent PRDs (from the `recent_views` table), and quick actions.
- **Keyboard shortcuts** — `g l` → Library, `g s` → Search, `g a` → Ask, `g s` →
  Status, `?` → shortcut help.

---

## What's NOT here (out of scope)

- **Multi-tenancy / multiple workspaces** — one Ringkas workspace, one team.
- **Writing PRDs from the UI** — Notion stays the editor; every surface is
  read-only over content.
- **Atlas / multi-source feed** — only Notion is wired as a source today;
  Confluence and others are placeholder cards on the Sources page.
- **Email-based password reset** — no email provider; admins reset via the
  Directory, users change their own password from the user menu.
- **Realtime presence, comments, mentions, drag-and-drop board views** —
  PRDs are documents, not cards-on-kanban.
- **Mobile-first layout** — IA is desktop-primary; the dashboard degrades
  gracefully to 360px via the `Sheet` primitive.

---

## How to run locally

```bash
# 1. Copy and fill environment
cp mcp/deploy/.env.example mcp/deploy/.env
chmod 600 mcp/deploy/.env

# 2. Build + start everything (postgres, app, web-ui build, caddy, cron, backup)
cd mcp/deploy && docker compose build && docker compose up -d

# 3. Open
open https://localhost          # Caddy serves the SPA + /api/*
# or, while developing the frontend:
cd mcp/web-ui && npm install && npm run dev
```

The dashboard at `/library` redirects from `/`. Smoke test:
`curl https://localhost/healthz` should return `{"db":"ok"}`.

## How to deploy

See [`mcp/deploy/README.md`](./mcp/deploy/README.md) for the full openclaw
deployment runbook — service catalog, one-shot setup, common operations,
debugging recipes, cron schedule, failure handling, and rollback. In short:
push to `master`, the `prd-deployer` sidecar rebuilds + restarts on its own.

---

## What's running where (openclaw production)

| Service | Image | Role |
|---|---|---|
| `prd-postgres` | `postgres:16-alpine` | Users, sessions, roles, conversations, recent_views |
| `prd-app` | `ghcr.io/.../llm-wiki/app` | FastAPI web + sync CLI in one container |
| `prd-ui-build` | `ghcr.io/.../llm-wiki/webui` | One-shot Vite build → static bundle |
| `prd-caddy` | `caddy:2-alpine` | HTTPS + SPA routing + `/api/*` proxy |
| `prd-backup` | `alpine:3.20` | Nightly `pg_dump` + healthchecks.io ping |
| `prd-deployer` | custom | Watches master → rebuilds + restarts on push |
| `prd-cron` | `node:22-alpine` | Nightly sync + re-index + enrich |

---

## In short

Raw Notion PRDs → cleaned vault → LLM-enriched → Chroma-indexed → served
through one brain over two doors (HTTP + MCP), gated by real auth, observed
via run-manifests. PMs log in, search, chat, and watch the pipeline. Ask it
anything about a PRD instead of hunting through Notion.