import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { RequirePermission } from './components/RequirePermission';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { AskPage } from './pages/AskPage';
import { LibraryPage } from './pages/LibraryPage';
import { SearchPage } from './pages/SearchPage';
import { StatusPage } from './pages/StatusPage';
import { ApprovalsPage } from './pages/admin/ApprovalsPage';
import { DirectoryPage } from './pages/admin/DirectoryPage';
import { RolesPage } from './pages/admin/RolesPage';
import { SettingsPage } from './pages/admin/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, err) => {
        if (err instanceof ApiError && err.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider fallback={<p>Loading</p>} onUnauthenticated={<p>Please sign in</p>}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/library" replace />} />
              <Route
                path="library"
                element={
                  <RequirePermission perm="prd.read">
                    <LibraryPage />
                  </RequirePermission>
                }
              />
              <Route
                path="search"
                element={
                  <RequirePermission perm="prd.read">
                    <SearchPage />
                  </RequirePermission>
                }
              />
              <Route
                path="ask"
                element={
                  <RequirePermission perm="prd.ask">
                    <AskPage />
                  </RequirePermission>
                }
              />
              <Route
                path="status"
                element={
                  <RequirePermission perm="status.view">
                    <StatusPage />
                  </RequirePermission>
                }
              />
              <Route
                path="admin/approvals"
                element={
                  <RequirePermission perm="users.manage">
                    <ApprovalsPage />
                  </RequirePermission>
                }
              />
              <Route
                path="admin/directory"
                element={
                  <RequirePermission perm="users.manage">
                    <DirectoryPage />
                  </RequirePermission>
                }
              />
              <Route path="admin/users" element={<Navigate to="/admin/directory" replace />} />
              <Route
                path="admin/roles"
                element={
                  <RequirePermission perm="roles.manage">
                    <RolesPage />
                  </RequirePermission>
                }
              />
              <Route
                path="admin/settings"
                element={
                  <RequirePermission perm="roles.manage">
                    <SettingsPage />
                  </RequirePermission>
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
