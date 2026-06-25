# Phase 4 — shadcn/ui + Tailwind Research

**Date:** 2026-06-25
**Scope:** `mcp/web-ui/` (Vite + React 19 + react-router 7, dark mode first-class)
**Related spec:** `docs/superpowers/specs/2026-06-25-phase4-ui-redesign-design.md`

---

## 1. Current Tailwind version in `mcp/web-ui/`

From `mcp/web-ui/package.json` (read 2026-06-25):

```json
"@tailwindcss/vite": "4.3.1",
"tailwindcss":        "4.3.1",
"tw-animate-css":     "^1.3.0"
```

- **Tailwind major: v4 (4.3.1, matches latest published 4.3.1)**
- Vite plugin: `@tailwindcss/vite@4.3.1`
- Animate plugin: `tw-animate-css@^1.3.0` (replaces `tailwindcss-animate` for v4)
- **No `tailwind.config.js`** — config is CSS-first via `@theme inline` in `src/index.css`
- `vite.config.ts` already wires `tailwindcss()` plugin: `import tailwindcss from '@tailwindcss/vite'; ... plugins: [react(), tailwindcss()]`
- `components.json` already exists at repo root (`mcp/web-ui/components.json`), currently `style: "default"`, `baseColor: "slate"`, `cssVariables: true`, `iconLibrary: "lucide"`, paths: `components: @/components`, `utils: @/lib/utils`, `ui: @/components/ui`

## 2. Compatibility — shadcn CLI on Tailwind v4

**Status: fully supported, this is the official target.** Per shadcn docs (`https://ui.shadcn.com/docs/installation/vite` and `https://ui.shadcn.com/docs/cli`):

- `shadcn@latest` (currently `4.11.0`, `npm view shadcn version` confirmed 2026-06-25) is the only CLI in active use. The old `shadcn-ui` package is deprecated; do NOT use it.
- The CLI auto-detects framework + Tailwind v4 and configures accordingly. It adds `@import "shadcn/tailwind.css"` to the global CSS for shared v4 utilities, and writes to `components.json`.
- shadcn docs site itself runs on Next 15.3 + Tailwind v4 (May 2025 changelog), so the path is the recommended one.

**Do NOT downgrade to Tailwind v3.** The spec's own "Risks" section flags v4 as a concern with mitigation "pin to v3.4 if v4 integration breaks" — but as of 2026-06 the integration is stable, and downgrading would force rewriting `src/index.css` (OKLCH → HSL, `@theme inline` → JS config) and swapping `tw-animate-css` → `tailwindcss-animate`. Not worth it.

**Migration path needed: zero.** Stay on v4.

## 3. Install command + init step

**Command (pnpm, matches project):**

```bash
pnpm dlx shadcn@latest init --yes --base radix
```

- `--base radix` is the default; explicit so future readers don't wonder. (Other option: `--base base` = shadcn's reimplementation without Radix. We want Radix for the a11y/focus-trap story the spec calls out.)
- `--yes` skips confirmation; existing `components.json` will be overwritten unless we use `--force` (intentionally NOT passing `--force` so a confirmation prompt appears — protects against clobbering manual edits).
- The old `npx shadcn-ui@latest add …` is dead; the package was renamed to `shadcn` in 2024. Only use `shadcn@latest`.
- `pnpm dlx` (not `pnpx`) is the pnpm-native equivalent and avoids an interactive "OK to install?" prompt.

**`init` walkthrough for an existing Vite + Tailwind v4 + components.json project:**

The CLI auto-detects most fields. The only prompts that will actually ask for input when `components.json` already exists are:

```
✔ The path /mcp/web-ui/components.json already exists. Would you like to: [update/update & overwrite/ignore/exit]
```

→ Choose **update & overwrite** (or use `--force` to skip the prompt).

The CLI will then:
1. Verify Tailwind v4 in `package.json` and the `@tailwindcss/vite` plugin in `vite.config.ts` (both present, no action).
2. Add `@import "shadcn/tailwind.css"` to top of `src/index.css` (idempotent — safe to add; co-exists with the existing `@import "tailwindcss"` and `@import "tw-animate-css"`).
3. Ensure `cn` util at `src/lib/utils.ts` (check for existing — create if missing).
4. Re-write `components.json` (we'll hand-edit it post-init, see §5).
5. Install deps: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` (most already present in `package.json`).

**Verify after init:**

```bash
pnpm dlx shadcn@latest info      # echoes resolved config
pnpm dlx shadcn@latest add button # smoke test
```

## 4. The 16 primitives — install status

All 16 are first-class in the shadcn registry (`https://ui.shadcn.com/docs/components`, confirmed 2026-06-25). Install all in one shot:

```bash
pnpm dlx shadcn@latest add \
  button card input textarea label badge avatar separator \
  dialog sheet dropdown-menu tooltip tabs skeleton command sonner
```

Per-component notes:

| # | Component | Registry name | Out-of-the-box? | Manual paste needed? | Notes |
|---|-----------|---------------|-----------------|----------------------|-------|
| 1 | Button | `button` | yes | no | variants in spec: default, secondary, ghost, outline, destructive; sizes sm/default/lg/icon — all in registry defaults |
| 2 | Card | `card` | yes | no | ships `CardHeader`/`CardContent`/`CardFooter` exports |
| 3 | Input | `input` | yes | no | |
| 4 | Textarea | `textarea` | yes | no | |
| 5 | Label | `label` | yes | no | Radix Label wrapper |
| 6 | Badge | `badge` | yes | no | we'll add custom variants for status (Not Started/In Progress/Done/Archived) |
| 7 | Avatar | `avatar` | yes | no | uses Radix Avatar; supports fallback initials — matches "PIC avatars" use case |
| 8 | Separator | `separator` | yes | no | |
| 9 | Dialog | `dialog` | yes | no | for confirm + sync trigger |
| 10 | Sheet | `sheet` | yes | no | mobile nav (<1024px collapsed), and possible user detail drawer (spec says "Vaul drawer" — see gotcha below) |
| 11 | DropdownMenu | `dropdown-menu` | yes | no | user menu, row actions; note registry name is `dropdown-menu` (hyphen) not `dropdown_menu` |
| 12 | Tooltip | `tooltip` | yes | no | |
| 13 | Tabs | `tabs` | yes | no | Status page (Pipeline/Coverage), PRD detail (Body/Metadata/Conversations/History) |
| 14 | Skeleton | `skeleton` | yes | no | |
| 15 | Command | `command` | yes | no | depends on `cmdk` (auto-installed by add) — the ⌘K palette |
| 16 | Sonner | `sonner` | yes | no | toast; **must** render `<Toaster />` in root after install |

**Manual paste required for one related primitive (not in the 16):** if we want a real right-side drawer with drag-to-close (spec says "Vaul drawer" for user detail), we need `vaul`. It's not a shadcn primitive — install as a dep: `pnpm add vaul`. shadcn has a separate `drawer` primitive built on vaul; the spec already calls it out in Tech Foundation. Treat vaul as a runtime dep, not a shadcn registry add.

**All 16 ship out-of-the-box via the registry; no manual paste needed.**

## 5. Recommended `components.json` shape

Hand-write the file (overwrite what `init` produces) to match our actual setup. Key decision: **`style: "new-york"`**, not `default`.

Why: shadcn docs state "new-york" is the recommended option as the "default" style is deprecated, and it cannot be changed after initialization without re-installing all components. Switching later is destructive — pick `new-york` now. The current repo file says `"default"`, so this IS a breaking change for any already-added components (none exist yet — `src/components/ui/` is empty), so it's safe to do.

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

Per-field rationale:

- `style: "new-york"` — recommended; slightly more opinionated spacing/borders, matches Linear-vibe aesthetic in the spec
- `rsc: false` — this is a Vite SPA, no RSC
- `tsx: true` — matches `tsconfig.app.json` + `.tsx` files in `src/`
- `tailwind.config: ""` — v4 has no JS config; CSS-first only. Leaving the string empty signals to the CLI "do not try to read a JS config"
- `tailwind.css: "src/index.css"` — matches current file
- `baseColor: "slate"` — current value; closest neutral to the spec's "Neutral greys" direction. Spec also mentions `#5E6AD2`-ish indigo accent — this gets hand-painted into the `--primary` CSS var, not via `baseColor` (baseColor only sets the neutrals and a few defaults; the accent stays custom).
- `cssVariables: true` — required for dark mode + theme switching; spec mandates it
- `prefix: ""` — no class prefix
- `aliases` — match `vite.config.ts` (`@` → `./src`) exactly. The current components.json has `lib` and `hooks` aliases declared but the project doesn't have those folders yet — create empty `src/lib/`, `src/hooks/` as part of the install (CLI expects them).
- `iconLibrary: "lucide"` — `lucide-react@0.523.0` already installed

**Reconciliation with the spec:** the design spec §Design DNA writes CSS vars in HSL (`--background: 0 0% 100%`) but the current `src/index.css` uses OKLCH (e.g. `--background: oklch(1 0 0)`). OKLCH is the v4-native format and renders fine in all modern browsers; HSL is the historical shadcn default. Keep OKLCH — it is the correct v4 pattern. The values in the spec need a follow-up translate to OKLCH in the design tokens doc, not in this install. Flag, do not silently fix.

## 6. Gotchas — shadcn + Vite + react-router 7

No blocking issues. The known sharp edges:

1. **CSS variable resolution order in v4**
   - **Symptom:** dark mode tokens render, but `bg-background` and `text-foreground` show as `undefined` or transparent in production builds.
   - **Cause:** `@import "shadcn/tailwind.css"` must come BEFORE the `@import "tailwindcss"` / `@import "tw-animate-css"` lines in `src/index.css` so the shadcn `--color-*` tokens override the defaults.
   - **Fix:** in `src/index.css`, the order is currently `@import "tailwindcss"; @import "tw-animate-css"; ...`. After `init` runs, it becomes `@import "shadcn/tailwind.css"; @import "tailwindcss"; @import "tw-animate-css"; ...` — confirm shadcn's import is line 1.

2. **Vite plugin order in `vite.config.ts`**
   - **Symptom:** Tailwind classes not picked up during HMR; only on full reload.
   - **Fix:** keep `plugins: [react(), tailwindcss()]` (current order is correct — react first, tailwind last). Don't insert anything between them.

3. **react-router-dom v7 + shadcn "Sheet" / "Dialog"**
   - **Symptom:** when navigating between routes while a Dialog/Sheet is open, the overlay doesn't close and focus is lost.
   - **Cause:** not a peer-dep conflict — it's a portal-mounting issue. shadcn portals render to `document.body`, but react-router v7's transitions can unmount the parent before Radix's focus trap cleans up.
   - **Fix:** wrap `useNavigate()` calls in a `setTimeout(..., 0)` or close the dialog first, then navigate. Standard pattern; documented in shadcn Discord. Not a blocker.

4. **Peer dep warning: `react@19.2.7` + shadcn `Tooltip`**
   - **Symptom:** npm warns about peer range "react: ^16.8 || ^17.0 || ^18.0" from `@radix-ui/react-tooltip`.
   - **Fix:** add `pnpm.overrides` in `package.json` if strict — but `--legacy-peer-deps` install is fine for now since shadcn tests against React 19 (changelog Oct 2024).

5. **`components.json` `tailwind.config: ""` must be the empty string, not `null` or omitted**
   - **Symptom:** CLI tries to read `null.config` and errors.
   - **Fix:** explicitly set to `""` (already correct in our recommendation above).

6. **`@tailwindcss/vite` requires Vite 5+**
   - Project is on `vite@8.1.0` — fine.

7. **OKLCH colors in older browsers**
   - Not a concern: spec is Ringkas internal; baseline 2024+ browsers assumed.

## 7. Dark mode — "no flash on reload" inline script

The spec calls this out explicitly: "dark mode toggle in top bar; respects system preference on first visit; persisted to localStorage; no flash on reload (inline script in `index.html`)".

shadcn's recommended pattern is an inline `<script>` placed at the TOP of `<head>`, before any CSS or JS imports, that reads localStorage + `prefers-color-scheme` synchronously and sets `.dark` on `<html>`. The existing `index.html` has no script — we add one.

The current `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLM Wiki</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Add the inline script as the FIRST child of `<head>` (must be before any `<link rel="stylesheet">` or `<script type="module">`):

```html
<script>
  (function() {
    const storageKey = 'vite-ui-theme';
    const theme = (() => {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored === 'dark' || stored === 'light') return stored;
      } catch (_) {}
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    })();
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  })();
</script>
```

**Why this exact form (not the full shadcn sample):**
- The full shadcn `vite-ui-theme` example manages the toggle, system listener, and `body.classList` writes. We only need the "no flash" slice; React takes over after mount.
- Sets `class` on `documentElement` (`<html>`), not `<body>` — because `<body>` is the root mount target and shadcn's v4 dark variant selector is `.dark *` (already declared in `src/index.css` as `@custom-variant dark (&:is(.dark *))`).
- `documentElement.style.colorScheme` ensures browser native form/scrollbar colors also flip.

**Storage key:** `vite-ui-theme` (matches shadcn convention). Don't pick `theme` — collides with the Tailwind docs `theme` example.

**The React-side toggle** (separate, not part of this script) reads/writes the same `vite-ui-theme` key and flips the class on `documentElement`. Trivial hook in `src/hooks/use-theme.ts`.

---

## DECISION

**Use Tailwind v4.3.1 (already installed), shadcn@latest (4.11.0), components.json as follows:**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

**Install sequence (in order):**

```bash
# 1. Init — accepts existing components.json prompt for "update & overwrite"
pnpm dlx shadcn@latest init --yes --base radix

# 2. Hand-rewrite components.json with the block above (switch style: default → new-york)

# 3. Add all 16 primitives in one shot
pnpm dlx shadcn@latest add \
  button card input textarea label badge avatar separator \
  dialog sheet dropdown-menu tooltip tabs skeleton command sonner

# 4. Add Vaul for the user-detail drawer (not in the 16; runtime dep)
pnpm add vaul

# 5. Render <Toaster /> in src/main.tsx (sonner requires it)

# 6. Add the dark-mode inline script to index.html (§7) before any module script

# 7. Verify
pnpm dlx shadcn@latest info
```

**Do NOT downgrade to Tailwind v3.** Do NOT use the old `shadcn-ui` package. Do NOT change `style` after install — pick `new-york` once.
