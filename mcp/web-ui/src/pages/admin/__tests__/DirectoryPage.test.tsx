import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../../../test/util';
import { DirectoryPage } from '../DirectoryPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

type SeedUser = {
  id: string;
  email: string;
  status: 'active' | 'pending' | 'disabled';
  roles: Array<{ id: string; name: string }>;
  created_at: string;
  last_login_at?: string | null;
  last_password_change_at?: string | null;
};

function installUsersHandlers(users: SeedUser[]) {
  server.use(
    http.get('/api/admin/users', () =>
      HttpResponse.json({
        users,
        total: users.length,
        limit: 50,
        offset: 0,
      }),
    ),
    http.get('/api/admin/roles', () =>
      HttpResponse.json({
        roles: [
          { id: 'r-admin', name: 'admin', is_system: true, permissions: ['users.manage', 'roles.manage'] },
          { id: 'r-member', name: 'member', is_system: true, permissions: ['wiki.read'] },
        ],
      }),
    ),
  );
}

const baseUsers: SeedUser[] = [
  {
    id: 'u1',
    email: 'alice@example.com',
    status: 'active',
    roles: [{ id: 'r-admin', name: 'admin' }],
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: '2026-06-20T12:00:00Z',
  },
  {
    id: 'u2',
    email: 'bob@example.com',
    status: 'disabled',
    roles: [{ id: 'r-member', name: 'member' }],
    created_at: '2026-02-01T00:00:00Z',
    last_login_at: null,
  },
  {
    id: 'u3',
    email: 'carol@example.com',
    status: 'pending',
    roles: [],
    created_at: '2026-03-01T00:00:00Z',
  },
];

/**
 * Radix DropdownMenu opens on `pointerdown`; `fireEvent.click` alone is not
 * enough in jsdom. We dispatch pointerdown + click to keep the tests free of
 * `@testing-library/user-event` (not installed in this project).
 */
function openDropdown(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('DirectoryPage', () => {
  it('renders user rows returned by the API', async () => {
    installUsersHandlers(baseUsers);
    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    expect(await screen.findByTestId('row-u1')).toBeInTheDocument();
    expect(screen.getByTestId('row-u2')).toBeInTheDocument();
    expect(screen.getByTestId('row-u3')).toBeInTheDocument();
    expect(screen.getAllByText('alice@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('bob@example.com').length).toBeGreaterThan(0);
  });

  it('filters rows client-side by the search input', async () => {
    installUsersHandlers(baseUsers);
    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    await screen.findByTestId('row-u1');
    fireEvent.change(screen.getByTestId('users-search'), { target: { value: 'bob' } });

    await waitFor(() => {
      expect(screen.queryByTestId('row-u1')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('row-u2')).toBeInTheDocument();
    expect(screen.queryByTestId('row-u3')).not.toBeInTheDocument();
  });

  it('shows the correct action menu items for active vs disabled users', async () => {
    installUsersHandlers(baseUsers);
    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    openDropdown(within(await screen.findByTestId('row-u1')).getByTestId('actions-u1'));
    let menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /reset password/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^disable$/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^enable$/i })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /manage roles/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Escape' });

    openDropdown(within(screen.getByTestId('row-u2')).getByTestId('actions-u2'));
    menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /^enable$/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /^disable$/i })).not.toBeInTheDocument();
  });

  it('shows the temporary password after the reset mutation succeeds', async () => {
    installUsersHandlers(baseUsers);
    let resetCalls = 0;
    server.use(
      http.post('/api/admin/users/u1/reset-password', () => {
        resetCalls += 1;
        return HttpResponse.json({ temporary_password: 'Temp-1234-abcd' });
      }),
    );

    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    openDropdown(within(await screen.findByTestId('row-u1')).getByTestId('actions-u1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /reset password/i }));

    fireEvent.click(await screen.findByRole('button', { name: /generate new password/i }));

    expect(await screen.findByTestId('reset-temp-password')).toHaveTextContent('Temp-1234-abcd');
    expect(resetCalls).toBe(1);
  });

  it('optimistically flips the status badge when disabling a user and rolls back on error', async () => {
    installUsersHandlers(baseUsers);
    let disableCallCount = 0;
    server.use(
      http.post('/api/admin/users/u1/disable', async () => {
        // Add a small delay so we can observe the optimistic state before rollback.
        await new Promise((r) => setTimeout(r, 50));
        disableCallCount += 1;
        return HttpResponse.json(
          { error: { code: 'last_admin', message: 'no admins' } },
          { status: 409 },
        );
      }),
    );

    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    const row1 = await screen.findByTestId('row-u1');
    expect(within(row1).getByText(/^active$/i)).toBeInTheDocument();

    openDropdown(within(row1).getByTestId('actions-u1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^disable$/i }));

    // Optimistic update: the badge should flip to "disabled" before the request resolves.
    await waitFor(() => {
      expect(within(row1).getByText(/^disabled$/i)).toBeInTheDocument();
    });

    // Then the error fires and we roll back to "active".
    await waitFor(() => {
      expect(within(row1).getByText(/^active$/i)).toBeInTheDocument();
    });
    expect(disableCallCount).toBe(1);
  });

  it('removes a user after the typed-email delete confirm', async () => {
    installUsersHandlers(baseUsers);
    let deleteCalls = 0;
    server.use(
      http.delete('/api/admin/users/u3', () => {
        deleteCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    openDropdown(within(await screen.findByTestId('row-u3')).getByTestId('actions-u3'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^delete$/i }));

    // Dialog is up, submit should be disabled until the email matches.
    const confirmButton = await screen.findByTestId('delete-confirm-submit');
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('delete-confirm-input'), {
      target: { value: 'carol@example.com' },
    });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.queryByTestId('row-u3')).not.toBeInTheDocument();
    });
    expect(deleteCalls).toBe(1);
  });

  it('opens the user detail drawer on row click', async () => {
    installUsersHandlers(baseUsers);
    renderWithProviders(<DirectoryPage />, {
      me: { permissions: ['users.manage'] },
      route: '/admin/directory',
    });

    const row = await screen.findByTestId('row-u1');
    fireEvent.click(row);

    expect(await screen.findByRole('dialog', { name: /alice@example\.com/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /roles/i })).toBeInTheDocument();
  });
});
