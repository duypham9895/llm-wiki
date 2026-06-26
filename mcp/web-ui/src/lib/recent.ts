/** localStorage-backed recent-PRD cache.

Why this exists:
- The CommandPalette opens on ⌘K and needs to show results INSTANTLY. The
  server's `GET /api/prd/recent` is the source of truth across devices, but
  the round-trip is too slow to be the first paint.
- PrdDetailPage records the view both here (localStorage, instant) and via
  the server's `GET /api/prd/{id}` (cross-device, eventual). The two layers
  converge: a hot-cache hit here is also a recent row server-side.
- When localStorage is empty (first-time user, cleared cookies), the palette
  falls back to a "Suggested" section from `/api/prd/library?limit=8`.

Storage shape: JSON array of { id, title } newest-first, capped at 16 entries.
Title is stored so the palette can render the row synchronously without a
second network fetch. Missing title is fine — CommandPalette will resolve it.
*/

import { apiFetch } from './api';

export interface RecentPrd {
  id: string;
  title: string;
}

const STORAGE_KEY = 'prd:recent-views';
const MAX_ENTRIES = 16;

function readRaw(): RecentPrd[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown): e is RecentPrd =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RecentPrd).id === 'string',
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: RecentPrd[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded / private mode — silently drop. Recents are a UX nicety.
  }
}

/** Get the cached recents synchronously. Newest-first, deduped by id. */
export function getLocalRecents(): RecentPrd[] {
  return readRaw();
}

/** Record a PRD as just-viewed. Pushes to the front, dedupes, caps at MAX_ENTRIES.
 *  Pass `title` if known; empty string is OK and will be filled in by the server
 *  response on next visit. */
export function recordLocalRecent(id: string, title: string): void {
  const trimmedId = id.trim();
  if (!trimmedId) return;
  const existing = readRaw().filter((e) => e.id !== trimmedId);
  const next = [{ id: trimmedId, title }, ...existing].slice(0, MAX_ENTRIES);
  writeRaw(next);
}

/** Resolve titles for any cached recents missing them, using the library endpoint
 *  as a title source. Returns the resolved list AND persists the resolved titles
 *  back to localStorage so subsequent palette opens can paint synchronously. */
export async function hydrateLocalRecents(entries: RecentPrd[]): Promise<RecentPrd[]> {
  const missing = entries.filter((e) => !e.title);
  if (missing.length === 0) return entries;
  try {
    const data = await apiFetch<{ results: RecentPrd[] }>('/prd/library?limit=50');
    const byId = new Map((data.results ?? []).map((p) => [p.id, p.title]));
    const resolved = entries.map((e) =>
      e.title ? e : { id: e.id, title: byId.get(e.id) ?? '' },
    );
    // Persist resolved titles back so the next ⌘K paints instantly without a
    // network round-trip.
    writeRaw(resolved);
    return resolved;
  } catch {
    return entries;
  }
}

/** Fetch the server-side recents. Empty list means the user has never opened a
 *  PRD — the palette should then fall back to "Suggested". */
export async function fetchServerRecents(limit = 8): Promise<RecentPrd[]> {
  const data = await apiFetch<{ results: RecentPrd[] }>(`/prd/recent?limit=${limit}`);
  return (data.results ?? []).map((r) => ({ id: r.id, title: '' }));
}

/** Fetch the fallback "Suggested" list (top of library). */
export async function fetchSuggested(limit = 8): Promise<RecentPrd[]> {
  const data = await apiFetch<{ results: RecentPrd[] }>(`/prd/library?limit=${limit}`);
  return data.results ?? [];
}