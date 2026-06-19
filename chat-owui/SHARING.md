# Sharing the PRD Assistant (Open WebUI) with a teammate

The PRD chat runs on **your Mac** in a Docker container (`open-webui`) and is shared
privately over **Tailscale** (a private device mesh — never internet-public).

## What's already set up

- **Open WebUI** container `open-webui`, bound `0.0.0.0:3030`, auto-restarts, persistent volume.
- **PRD Assistant** model: base `minimax/MiniMax-M3` + the 132-doc **PRDs** knowledge base + a grounding system prompt. Picking it auto-attaches the PRD knowledge; answers are grounded with citations.
- **Member account:** `member@ringkas.local` / `prd-member-2026` (role `user`). They should change the password in Settings → Account.
- **Tailscale:** running on this Mac (`edwards-macbook-pro`, tailnet IP `100.119.190.72`), account `duypham9895@`.

## One-time admin step you still do (in the browser)

The model should already be public (`access_control: null`). If the member doesn't see
"PRD Assistant" in their model dropdown, confirm it via the UI (the API schema for this
is version-specific; the UI toggle is reliable):

1. Log in at `http://localhost:3030` as `duy@ringkas.local` / `ringkas-prd`.
2. **Workspace → Models → PRD Assistant → ✏️ edit → Visibility → Public → Save.**

## Get the member's device onto your tailnet (interactive)

Tailscale only lets *authorized devices* reach the instance — that's the security.
Two ways to add the member:

**Option A — invite the member to your tailnet (they get their own device):**
1. Open the Tailscale admin console: https://login.tailscale.com/admin/machines
2. **Invite external** / **Share** → share the machine `edwards-macbook-pro` with the
   member's email, OR send a tailnet invite link.
3. The member installs Tailscale, accepts the invite, signs in.
4. They browse **`http://100.119.190.72:3030`** and log in with the member account above.

**Option B — share just this machine (Tailscale "Share" / Funnel-free):**
- In the admin console, use **Share node** on `edwards-macbook-pro` to generate a
  share link for the member; they accept and reach `100.119.190.72:3030`.

(Tailscale device-sharing specifics vary by plan; the admin console at
login.tailscale.com/admin walks you through "Share" / "Invite external users".)

## The member's daily use

1. Be connected to Tailscale (the shared device must be reachable).
2. Open **`http://100.119.190.72:3030`**, log in (`member@ringkas.local`).
3. Pick **PRD Assistant** in the model dropdown. Ask PRD questions — grounded answers
   with source citations. No need to attach anything; the KB is bundled.

## Security notes (important)

- Chatting spends **your** MiniMax credits; re-indexing spends **your** OpenAI embedding
  credits. The member's usage is on your keys.
- The PRD corpus is internal Ringkas strategy — Tailscale keeps it to authorized
  devices only (never a public URL). Don't switch to a public ngrok/cloudflare URL
  unless you add auth in front and accept the exposure.
- Keys live in the container's environment (from your keychain at launch), not in the
  Tailscale share — the member can use the app but can't read the raw keys.

## Keeping content fresh

After the nightly A-sync + B-enrich pipeline updates the vault, re-load changed PRDs:
```bash
OWUI_EMAIL="duy@ringkas.local" OWUI_PASS="ringkas-prd" \
  ./chat-owui/load_prds.sh "/path/to/Vault/PRDs"
```
(See `docs/superpowers/plans/2026-06-19-rag-chat-openwebui-setup.md` Part 4 for scheduling.)
