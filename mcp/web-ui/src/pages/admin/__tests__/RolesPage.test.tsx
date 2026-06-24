import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { renderWithProviders } from '../../../test/util';
import { RolesPage } from '../RolesPage';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function installRolesHandlers() {
  server.use(
    http.get('/api/admin/roles', () =>
      HttpResponse.json({
        roles: [
          { id: 'r1', name: 'admin', is_system: true, permissions: ['users.manage', 'roles.manage'] },
          { id: 'r2', name: 'editor', is_system: false, permissions: ['wiki.write'] },
        ],
      }),
    ),
    http.get('/api/admin/permissions', () =>
      HttpResponse.json({
        permissions: [
          { id: 'p1', name: 'wiki.read', description: 'Read wiki' },
          { id: 'p2', name: 'wiki.write', description: 'Write wiki' },
          { id: 'p3', name: 'users.manage', description: 'Manage users' },
          { id: 'p4', name: 'roles.manage', description: 'Manage roles' },
        ],
      }),
    ),
  );
}

describe('RolesPage', () => {
  it('renders system roles as locked without edit or delete actions', async () => {
    installRolesHandlers();

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    const adminRole = within(await screen.findByTestId('role-admin'));
    const editorRole = within(screen.getByTestId('role-editor'));

    expect(adminRole.getByText(/locked/i)).toBeInTheDocument();
    expect(adminRole.queryByRole('button', { name: /edit admin/i })).not.toBeInTheDocument();
    expect(adminRole.queryByRole('button', { name: /delete admin/i })).not.toBeInTheDocument();
    expect(editorRole.getByRole('button', { name: /edit editor/i })).toBeInTheDocument();
    expect(editorRole.getByRole('button', { name: /delete editor/i })).toBeInTheDocument();
  });

  it('shows friendly copy when deleting an in-use role', async () => {
    installRolesHandlers();
    server.use(
      http.delete('/api/admin/roles/r2', () =>
        HttpResponse.json({ error: { code: 'role_in_use', message: 'role is assigned' } }, { status: 409 }),
      ),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    fireEvent.click(within(await screen.findByTestId('role-editor')).getByRole('button', { name: /delete editor/i }));

    expect(await screen.findByText(/still assigned to users/i)).toBeInTheDocument();
    expect(screen.queryByText('role_in_use')).not.toBeInTheDocument();
  });

  it('shows friendly copy when the API rejects role edits for immutable system roles', async () => {
    installRolesHandlers();
    server.use(
      http.put('/api/admin/roles/r2', () =>
        HttpResponse.json(
          { error: { code: 'system_role_immutable', message: 'system role cannot change' } },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    fireEvent.click(within(await screen.findByTestId('role-editor')).getByRole('button', { name: /edit editor/i }));
    fireEvent.click(screen.getByRole('button', { name: /save role/i }));

    expect(await screen.findByText(/built-in roles/i)).toBeInTheDocument();
    expect(screen.queryByText('system_role_immutable')).not.toBeInTheDocument();
  });

  it('creates roles with permission_ids instead of permission names', async () => {
    installRolesHandlers();
    const createBodies: Array<{ permission_ids?: unknown; permissions?: unknown }> = [];
    server.use(
      http.post('/api/admin/roles', async ({ request }) => {
        createBodies.push((await request.json()) as { permission_ids?: unknown; permissions?: unknown });
        return HttpResponse.json({ id: 'r3', name: 'author', is_system: false, permissions: ['wiki.read'] }, { status: 201 });
      }),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    await screen.findByText('wiki.read');
    fireEvent.change(screen.getByLabelText(/role name/i), { target: { value: 'author' } });
    fireEvent.click(screen.getByLabelText('wiki.read'));
    fireEvent.click(screen.getByRole('button', { name: /create role/i }));

    await waitFor(() => expect(createBodies[0]).toEqual({ name: 'author', description: '', permission_ids: ['p1'] }));
    expect(createBodies[0]?.permissions).toBeUndefined();
  });

  it('prefills role edits by permission id and submits permission_ids', async () => {
    installRolesHandlers();
    const updateBodies: Array<{ permission_ids?: unknown; permissions?: unknown }> = [];
    server.use(
      http.put('/api/admin/roles/r2', async ({ request }) => {
        updateBodies.push((await request.json()) as { permission_ids?: unknown; permissions?: unknown });
        return HttpResponse.json({ id: 'r2', name: 'editor', is_system: false, permissions: ['wiki.write', 'wiki.read'] });
      }),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    fireEvent.click(within(await screen.findByTestId('role-editor')).getByRole('button', { name: /edit editor/i }));
    expect(screen.getAllByLabelText('wiki.write')[1]).toBeChecked();
    fireEvent.click(screen.getAllByLabelText('wiki.read')[1]);
    fireEvent.click(screen.getByRole('button', { name: /save role/i }));

    await waitFor(() => expect(updateBodies[0]).toEqual({ name: 'editor', description: '', permission_ids: ['p2', 'p1'] }));
    expect(updateBodies[0]?.permissions).toBeUndefined();
  });

  it('blocks stale-catalog role edits before permissions can be dropped', async () => {
    installRolesHandlers();
    const updateBodies: Array<{ permission_ids?: unknown; permissions?: unknown }> = [];
    server.use(
      http.get('/api/admin/roles', () =>
        HttpResponse.json({
          roles: [{ id: 'r2', name: 'editor', is_system: false, permissions: ['wiki.write', 'wiki.publish'] }],
        }),
      ),
      http.get('/api/admin/permissions', () =>
        HttpResponse.json({
          permissions: [
            { id: 'p1', name: 'wiki.read', description: 'Read wiki' },
            { id: 'p2', name: 'wiki.write', description: 'Write wiki' },
          ],
        }),
      ),
      http.put('/api/admin/roles/r2', async ({ request }) => {
        updateBodies.push((await request.json()) as { permission_ids?: unknown; permissions?: unknown });
        return HttpResponse.json({ id: 'r2', name: 'editor', is_system: false, permissions: ['wiki.write'] });
      }),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    fireEvent.click(within(await screen.findByTestId('role-editor')).getByRole('button', { name: /edit editor/i }));

    const saveButton = screen.getByRole('button', { name: /save role/i });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText(/can't safely edit this role/i)).toBeInTheDocument();

    fireEvent.click(saveButton);
    expect(updateBodies).toHaveLength(0);
  });

  it('blocks role edits when the permissions catalog fails to load', async () => {
    installRolesHandlers();
    server.use(http.get('/api/admin/permissions', () => HttpResponse.json({ error: 'unavailable' }, { status: 500 })));

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    fireEvent.click(within(await screen.findByTestId('role-editor')).getByRole('button', { name: /edit editor/i }));

    expect(screen.getByRole('button', { name: /save role/i })).toBeDisabled();
    expect(screen.getByText(/can't safely edit this role/i)).toBeInTheDocument();
  });

  it('does not show edit or delete actions when is_system is omitted', async () => {
    installRolesHandlers();
    server.use(
      http.get('/api/admin/roles', () =>
        HttpResponse.json({ roles: [{ id: 'r3', name: 'unknown', permissions: ['wiki.read'] }] }),
      ),
    );

    renderWithProviders(<RolesPage />, { me: { permissions: ['roles.manage'] }, route: '/admin/roles' });

    const unknownRole = within(await screen.findByTestId('role-unknown'));
    expect(unknownRole.queryByRole('button', { name: /edit unknown/i })).not.toBeInTheDocument();
    expect(unknownRole.queryByRole('button', { name: /delete unknown/i })).not.toBeInTheDocument();
  });
});
