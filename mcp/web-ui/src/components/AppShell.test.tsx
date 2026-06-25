import '@testing-library/jest-dom/vitest';

import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../test/util';
import { AppShell } from './AppShell';
import { RequirePermission } from './RequirePermission';

describe('AppShell nav', () => {
  it('renders only permitted sections', async () => {
    renderWithProviders(<AppShell />, {
      me: { permissions: ['prd.read', 'prd.ask'] },
      route: '/library',
    });

    const libraryLink = await screen.findByRole('link', { name: 'Library' });

    expect(libraryLink).toBeInTheDocument();
    expect(libraryLink).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Approvals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Directory' })).not.toBeInTheDocument();
  });

  it('shows admin sections for an admin', async () => {
    renderWithProviders(<AppShell />, {
      me: {
        permissions: ['prd.read', 'prd.ask', 'status.view', 'users.manage', 'roles.manage'],
      },
    });

    expect(await screen.findByRole('link', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Directory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roles' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders not authorized for a direct guarded route without permission', async () => {
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="/admin/directory"
            element={
              <RequirePermission perm="users.manage">
                <h1>Directory</h1>
              </RequirePermission>
            }
          />
        </Route>
      </Routes>,
      { me: { permissions: ['prd.read'] }, route: '/admin/directory' },
    );

    expect(await screen.findByText(/access to this page/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Directory' })).not.toBeInTheDocument();
  });
});
