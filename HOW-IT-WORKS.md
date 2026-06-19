# Chat with Your PRDs — How It Works

**What this is:** Ask questions about Ringkas PRDs in plain English and get answers with links back to the source. No more digging through Notion.

**Who this is for:** PMs. No technical background needed.

---

## The one-line version

Your PRDs live in Notion. Every day, a robot copies them out, summarizes them, and loads them into a chat app. You open the chat, ask a question, and it answers using your actual PRDs — with citations.

---

## The journey of a PRD (4 steps)

Think of it as an assembly line. A PRD starts as a messy Notion page and ends as something you can chat with.

```
   NOTION                OBSIDIAN VAULT            ENRICHED               CHAT
 (where PMs    ──A──▶   (clean copies of    ──B──▶ (+ AI summaries,  ──C──▶ (ask questions,
  write PRDs)            every PRD)                 tags, links)             get answers)
```

### Step A — Copy from Notion
A robot reads the **Product Backlog** database in Notion and saves a clean copy of every PRD as a file. It runs daily and only re-copies PRDs that changed. Each copy keeps a link back to the original Notion page.

### Step B — Add AI summaries
For each PRD, AI writes:
- **A summary** — what the PRD delivers, for whom, and its status.
- **Tags** — topics like `crm`, `referral`, `notifications`.
- **Related PRDs** — links to other PRDs about similar things.

This makes every PRD easier to find and understand at a glance.

### Step C — Make it searchable
The PRDs get loaded into the chat app's "memory" so it can find the right ones when you ask a question.

### Step — You chat
You open the chat, pick **"PRD Assistant"**, and ask. It finds the most relevant PRDs, reads them, and answers — citing which PRDs it used.

---

## How to use it

1. Open the chat in your browser (your team will share the link).
2. Log in with the account you were given.
3. Pick **PRD Assistant** from the model dropdown.
4. Ask anything, e.g.:
   - *"What is the SP3K notification and who gets notified?"*
   - *"Which PRDs involve referral features?"*
   - *"What did we decide about the bank report dashboard?"*

You'll get a direct answer plus a **Sources** list showing which PRDs it came from.

---

## What makes the answers trustworthy

- **It only uses your PRDs.** It's told to answer *only* from the PRD content — not from general knowledge. If your PRDs don't cover something, it says so instead of making things up.
- **Every answer cites its sources.** You can always check the original PRD.
- **It's always current.** The daily refresh means the chat reflects the latest Notion PRDs.

---

## What's running behind the scenes (the short version)

You don't need to know this to use it — but for the curious:

| Piece | What it does | Tool used |
|---|---|---|
| The copier (Step A) | Pulls PRDs out of Notion as clean files | Custom tool reading Notion's official API |
| The enricher (Step B) | Writes summaries, tags, related links | An AI model (MiniMax) |
| The chat app (Step C) | The interface you talk to | **Open WebUI** (an open-source chat app) |
| The "memory" | Lets it find relevant PRDs fast | Search powered by OpenAI embeddings |
| The schedule | Runs the daily refresh | macOS scheduler |

**Our approach in a sentence:** we used proven, off-the-shelf tools wherever possible (the chat app, the AI models) and built small custom pieces only for the parts unique to Ringkas (pulling from *our* Notion, formatting *our* PRDs).

---

## Honest limitations

- **The chat runs on one person's Mac.** It's available when that machine is on and connected. Fine for a small team; not yet a 24/7 service.
- **Answers are only as good as the PRDs.** A half-written PRD gives a half-useful answer. (The AI will tell you when a PRD is just a stub.)
- **It refreshes once a day**, around midday. A PRD edited in Notion this morning shows up in chat after the next refresh.
- **Citations point to the PRD's title/file**, which you can then find in Notion or the local notes.

---

## In short

Raw Notion PRDs → cleaned up → summarized by AI → searchable → **you chat with them, with citations.** All refreshed automatically every day. Ask it anything about a PRD instead of hunting through Notion.
