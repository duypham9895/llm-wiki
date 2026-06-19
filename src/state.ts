import { readFile, writeFile, rename } from 'node:fs/promises';
import type { SyncState, StateEntry } from './types.js';

export function emptyState(): SyncState {
  return { pages: {}, users: {} };
}

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SyncState;
    return { pages: parsed.pages ?? {}, users: parsed.users ?? {} };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}

export function needsSync(entry: StateEntry | undefined, lastEdited: string): boolean {
  if (!entry) return true;
  return new Date(lastEdited).getTime() > new Date(entry.last_edited).getTime();
}

export function findRemoved(state: SyncState, presentUuids: Set<string>): string[] {
  return Object.keys(state.pages).filter((uuid) => !presentUuids.has(uuid));
}
