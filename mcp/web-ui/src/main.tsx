import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RequirePermission } from './components/RequirePermission';
import './index.css';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { Toaster } from './components/ui/sonner';
import { LibraryPage } from './pages/LibraryPage';
import { Login } from './pages/Login';

// Heavy / non-first-paint pages are lazy-loaded so the initial bundle stays small.
// Login + Library are eager (first paint); everything else splits into its own chunk.
const AskPage = lazy(() => import('./pages/AskPage').then((m) => ({ default: m.AskPage })));
const SearchPage = lazy(() =>
  import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const StatusPage = lazy(() =>
  import('./pages/StatusPage').then((m) => ({ default: m.StatusPage })),
);
const PrdDetailPage = lazy(() =>
  import('./pages/PrdDetailPage').then((m) => ({ default: m.PrdDetailPage })),
);
const ApprovalsPage = lazy(() =>
  import('./pages/admin/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })),
);
const DirectoryPage = lazy(() =>
  import('./pages/admin/DirectoryPage').then((m) => ({ default: m.DirectoryPage })),
);
const RolesPage = lazy(() =>
  import('./pages/admin/RolesPage').then((m) => ({ default: m.RolesPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/admin/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const SourcesPage = lazy(() =>
  import('./pages/admin/SourcesPage').then((m) => ({ default: m.SourcesPage })),
);
const ThemePage = lazy(() =>
  import('./pages/admin/ThemePage').then((m) => ({ default: m.ThemePage })),
);
const CommandPaletteMount = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}

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
    <ThemeProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider fallback={<p>Loading</p>} onUnauthenticated={<Login />}>
              <Suspense fallback={null}>
                <CommandPaletteMount />
              </Suspense>
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
                    path="library/:id"
                    element={
                      <RequirePermission perm="prd.read">
                        <Suspense fallback={<RouteFallback />}>
                          <PrdDetailPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />

                  <Route
                    path="search"
                    element={
                      <RequirePermission perm="prd.read">
                        <Suspense fallback={<RouteFallback />}>
                          <SearchPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />

                  <Route
                    path="ask"
                    element={
                      <RequirePermission perm="prd.ask">
                        <Suspense fallback={<RouteFallback />}>
                          <AskPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />

                  <Route
                    path="status"
                    element={
                      <RequirePermission perm="status.view">
                        <Suspense fallback={<RouteFallback />}>
                          <StatusPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />

                  <Route
                    path="admin/approvals"
                    element={
                      <RequirePermission perm="users.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <ApprovalsPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="admin/directory"
                    element={
                      <RequirePermission perm="users.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <DirectoryPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route path="admin/users" element={<Navigate to="/admin/directory" replace />} />
                  <Route
                    path="admin/roles"
                    element={
                      <RequirePermission perm="roles.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <RolesPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="admin/sources"
                    element={
                      <RequirePermission perm="users.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <SourcesPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="admin/settings"
                    element={
                      <RequirePermission perm="roles.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <SettingsPage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="admin/theme"
                    element={
                      <RequirePermission perm="roles.manage">
                        <Suspense fallback={<RouteFallback />}>
                          <ThemePage />
                        </Suspense>
                      </RequirePermission>
                    }
                  />
                  <Route path="*" element={<Navigate to="/library" replace />} />
                </Route>
              </Routes>
              <Toaster />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
