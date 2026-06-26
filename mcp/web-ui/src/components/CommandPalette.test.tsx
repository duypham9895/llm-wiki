import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../test/util';
import { CommandPalette } from './CommandPalette';

const server = setupServer();
const STORAGE_KEY = 'prd:recent-views';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  window.localStorage.clear();
});
afterAll(() => server.close());

function installEmptyRecents() {
  server.use(
    http.get('/api/prd/recent', () => HttpResponse.json({ results: [] })),
    http.get('/api/prd/library', () =>
      HttpResponse.json({
        results: [
          { id: 'EP-SUGGEST-1', title: 'Suggested one', status: 'Active', tags: [], summary: '', source_url: '' },
          { id: 'EP-SUGGEST-2', title: 'Suggested two', status: 'Draft', tags: [], summary: '', source_url: '' },
        ],
        next_cursor: null,
      }),
    ),
  );
}

async function openPalette() {
  // CommandPalette binds its ⌘K listener on mount; simulating meta+k triggers it.
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  await waitFor(() => {
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
}

describe('CommandPalette — recent PRDs', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows "Recent PRDs" heading with localStorage entries when present', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 'EP-LOCAL-A', title: 'Local A' },
        { id: 'EP-LOCAL-B', title: 'Local B' },
      ]),
    );
    server.use(
      http.get('/api/prd/recent', () => HttpResponse.json({ results: [] })),
      http.get('/api/prd/library', () =>
        HttpResponse.json({ results: [], next_cursor: null }),
      ),
    );

    renderWithProviders(<CommandPalette />, {
      me: { permissions: ['prd.read'] },
    });

    await openPalette();

    // Header is "Recent PRDs" (not "Suggested") because localStorage has entries.
    expect(screen.getByText('Recent PRDs')).toBeInTheDocument();
    expect(screen.queryByText('Suggested')).not.toBeInTheDocument();

    // Local entries are rendered.
    expect(screen.getByText('Local A')).toBeInTheDocument();
    expect(screen.getByText('Local B')).toBeInTheDocument();
  });

  it('shows "Suggested" heading when localStorage is empty AND server recents are empty', async () => {
    installEmptyRecents();

    renderWithProviders(<CommandPalette />, {
      me: { permissions: ['prd.read'] },
    });

    await openPalette();

    // Honest label: no recents exist, so this is a suggestion, not history.
    expect(await screen.findByText('Suggested')).toBeInTheDocument();
    expect(screen.queryByText('Recent PRDs')).not.toBeInTheDocument();

    // Sourced from /api/prd/library.
    expect(await screen.findByText('Suggested one')).toBeInTheDocument();
    expect(screen.getByText('Suggested two')).toBeInTheDocument();
  });

  it('shows "Recent PRDs" with server-side recents when present', async () => {
    window.localStorage.clear();
    server.use(
      http.get('/api/prd/recent', () =>
        HttpResponse.json({
          results: [
            { id: 'EP-SERVER-1', title: 'Server one' },
            { id: 'EP-SERVER-2', title: 'Server two' },
          ],
        }),
      ),
      http.get('/api/prd/library', () =>
        HttpResponse.json({
          results: [
            { id: 'EP-SERVER-1', title: 'Server one', status: 'Active', tags: [], summary: '', source_url: '' },
            { id: 'EP-SERVER-2', title: 'Server two', status: 'Done', tags: [], summary: '', source_url: '' },
          ],
          next_cursor: null,
        }),
      ),
    );

    renderWithProviders(<CommandPalette />, {
      me: { permissions: ['prd.read'] },
    });

    await openPalette();

    expect(await screen.findByText('Recent PRDs')).toBeInTheDocument();
    expect(await screen.findByText('Server one')).toBeInTheDocument();
    expect(screen.getByText('Server two')).toBeInTheDocument();
  });

  it('records a PRD view in localStorage when one is selected from the palette', async () => {
    installEmptyRecents();

    renderWithProviders(<CommandPalette />, {
      me: { permissions: ['prd.read'] },
    });

    await openPalette();

    const item = await screen.findByText('Suggested one');
    fireEvent.click(item);

    // After click, the palette closes; re-open and confirm the recents entry exists.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(stored).toEqual([{ id: 'EP-SUGGEST-1', title: 'Suggested one' }]);
  });
});