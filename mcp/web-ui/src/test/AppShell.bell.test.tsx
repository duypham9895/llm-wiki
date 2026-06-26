import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { renderWithProviders } from './util';
import { NotificationsBell } from '@/components/AppShell';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Radix DropdownMenu opens on `pointerdown`; `fireEvent.click` alone is not
 *  enough in jsdom. Mirror the DirectoryPage.test.tsx pattern. */
function openDropdown(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('NotificationsBell', () => {
  it('renders an unread badge and the row content when the API reports >0 unread', async () => {
    server.use(
      http.get('/api/notifications', () =>
        HttpResponse.json({
          notifications: [
            {
              id: 1,
              kind: 'sync_failed',
              title: 'Notion sync failed',
              body: 'HTTP 401 — wrong token',
              link: '/sources',
              read_at: null,
              created_at: new Date(Date.now() - 30_000).toISOString(),
            },
          ],
          unread_count: 3,
          next_before_id: null,
        }),
      ),
    );

    renderWithProviders(<NotificationsBell navigate={vi.fn()} />, {
      me: { permissions: ['prd.read'] },
    });

    // Badge reflects the unread_count from the server.
    const trigger = await screen.findByRole('button', { name: /Notifications \(3 unread\)/ });
    expect(trigger).toBeInTheDocument();

    openDropdown(trigger);

    // Row title + truncated body render.
    expect(await screen.findByText('Notion sync failed')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
  });

  it('posts to /notifications/read_all when the footer button is clicked', async () => {
    let markAllCalled = false;
    server.use(
      http.get('/api/notifications', () =>
        HttpResponse.json({
          notifications: [
            {
              id: 7,
              kind: 'system',
              title: 'Maintenance window',
              body: '',
              link: null,
              read_at: null,
              created_at: new Date().toISOString(),
            },
          ],
          unread_count: 2,
          next_before_id: null,
        }),
      ),
      http.post('/api/notifications/read_all', () => {
        markAllCalled = true;
        return HttpResponse.json({ status: 'ok', marked: 2 });
      }),
    );

    renderWithProviders(<NotificationsBell navigate={vi.fn()} />, {
      me: { permissions: ['prd.read'] },
    });

    const trigger = await screen.findByRole('button', { name: /Notifications/ });
    openDropdown(trigger);

    const btn = await screen.findByRole('button', { name: /Mark all as read/ });
    await fireEvent.click(btn);

    await waitFor(() => expect(markAllCalled).toBe(true));
  });

  it('renders the empty state when there are no notifications', async () => {
    server.use(
      http.get('/api/notifications', () =>
        HttpResponse.json({ notifications: [], unread_count: 0, next_before_id: null }),
      ),
    );

    renderWithProviders(<NotificationsBell navigate={vi.fn()} />, {
      me: { permissions: ['prd.read'] },
    });

    const trigger = await screen.findByRole('button', { name: /Notifications/ });
    openDropdown(trigger);

    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });
});