# llm-wiki v2 — Roadmap

**Date:** 2026-06-20
**Status:** Roadmap approved; Phase 1 designed (own spec); Phases 2–3 to be designed when reached.
**Origin:** After shipping the PRD MCP (v1), we reviewed the AI team's **Atlas** KB platform
(`risa-nxt/atlas`) and decided to adopt its best ideas into our own Notion-sourced system
rather than pivot onto Atlas. v2 turns the single MCP into a team-facing product.

---

## Why v2

v1 gave Claude Code / Codex two MCP tools (`search_prds`, `ask_prds`) over the PRD vault.
Three gaps emerged:

1. **Retrieval quality** — pure vector search misses literal identifiers (EP-numbers, `SP3K`,
   `KPR`), and a raw `score` can't tell an agent "genuinely relevant" from "closest of a bad
   bunch." (Our SP3K smoke proved both.)
2. **No human surface of our own** — PMs use Open WebUI (off-the-shelf) for chat, but there's no
   way to browse/search PRDs or see system health. The pipeline is a black box: on 2026-06-19,
   enrichment (B) failed 287/287 and the chain still reported success, silently serving
   un-enriched PRDs — and nobody could see it.
3. **Access is network-level, not person-level** — sharing is via Tailscale. The owner wants real
   user management: authentication, per-account permissions, an email-domain allowlist, and a
   registration on/off switch — because the tool is scoped to Ringkas PMs.

## The three sub-projects

Each is independently shippable and gets its own spec → plan → build cycle.

| Phase | Subsystem | Delivers | Depends on |
|---|---|---|---|
| **1** | **Retrieval upgrades** | `keyword_search` (literal ids), relevance **verdict** (match/no_match/degraded), `read_prd` (full body on demand). Pure backend in the shared `mcp/prd_mcp` core — improves Claude Code/Codex **today**; every later surface inherits it. | — |
| **2** | **Auth / user-management** | Postgres user store; email+password login; sessions; RBAC (roles→permissions); **email-domain allowlist**; **registration on/off switch**. Deployed on the `openclaw` VPS behind the existing Caddy (automatic HTTPS). Replaces Tailscale as the gate. | — |
| **3** | **Web dashboard** | React + Vite SPA with **Library · Search · Ask · Status** tabs, served by a FastAPI web-API over the **same** shared core (one brain, two doors: MCP + HTTP). Gated by Phase 2 auth. Pipeline gains **run-manifests** for the Status tab + a chain guard (a failed B must not silently pass to C). Replaces Open WebUI eventually. | 1 + 2 |

**Build order: 1 → 2 → 3.** Foundation-first: retrieval helps Claude Code immediately and carries
no deploy risk; auth is the load-bearing security layer the dashboard sits on; the dashboard lands
last, on solid auth.

## Decisions locked (apply across phases)

- **Deployment target:** the `openclaw` VPS (Hostinger, Ubuntu 24.04, 2 vCPU / 7.8 GB, Docker +
  Caddy on :80/:443 with automatic HTTPS, existing Dockerized Postgres pattern). Always-on — no
  more MacBook-sleep limitation. The nightly pipeline (A/B/C/index) either moves to the box or the
  Mac syncs the vault+index up; decided in Phase 3's spec.
- **Frontend stack:** React + Vite + Tailwind + react-query (mirrors Atlas, so the AI team can help
  and components can be borrowed). Builds to static files Caddy serves — the server needs no Node.
- **Backend:** FastAPI inside the existing `mcp/` package, importing the **same** core
  (`retrieve`/`answer`/`store`/`read`/`index`). `server.py` = MCP adapter; `webapi.py` (Phase 3) =
  HTTP/JSON adapter. DRY: the dashboard's Ask tab and Claude Code's `ask_prds` run identical code.
- **Auth model (Phase 2 detail):** drop Tailscale-as-gate; build real user management — hashed
  passwords (argon2/bcrypt), sessions, RBAC, domain allowlist, register on/off. Security bar rises
  because the login screen becomes the only moat; Caddy HTTPS + Postgres on `openclaw` provide the
  primitives.

## Out of scope for v2 (explicitly deferred)

- Multi-tenancy (Atlas-style tenant/project/user scoping) — we have one corpus, one team.
- Writing to the vault/Notion from any surface — Notion stays the editor; every surface is
  read-only over content.
- Reconciling with or feeding Atlas — we keep our own index. (The "feed Atlas" pivot remains
  documented in `2026-06-20-atlas-lessons-backlog.md` if priorities change.)
