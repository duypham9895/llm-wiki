import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, type ColumnDef } from '@tanstack/react-table';
import {
  ArrowUpDown,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';

import { DataTable } from '@/components/DataTable';
import { ResetPasswordDialog, type ResetPasswordDialogUser } from '@/components/ResetPasswordDialog';
import { UserDetailDrawer, type UserDetailUser } from '@/components/UserDetailDrawer';
import { ApiError, apiFetch } from '@/lib/api';
import { copyForError } from '@/lib/error-copy';
import { RelativeTime } from '@/components/RelativeTime';
import { RoleChip } from '@/components/RoleChip';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageHeader';

interface AdminUser {
  id: string;
  email: string;
  status: string;
  roles: Array<{ id: string; name: string }>;
  created_at: string;
  last_login_at?: string | null;
  last_password_change_at?: string | null;
}

interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

interface AdminRole {
  id: string;
  name: string;
  is_system?: boolean;
  permissions: string[];
}
interface AdminRolesResponse {
  roles: AdminRole[];
}

function statusToBadgeVariant(status: string): 'success' | 'warning' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active':
      return 'success';
    case 'pending':
      return 'warning';
    case 'disabled':
      return 'secondary';
    case 'deleted':
      return 'destructive';
    default:
      return 'outline';
  }
}

function initialsFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  return (
    local
      .split(/[._-]/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

export function DirectoryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [detailUser, setDetailUser] = React.useState<UserDetailUser | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [resetUser, setResetUser] = React.useState<ResetPasswordDialogUser | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [deleteUser, setDeleteUser] = React.useState<AdminUser | null>(null);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = React.useState('');

  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => apiFetch<AdminUsersResponse>('/admin/users', { signal }),
  });

  const rolesQuery = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => apiFetch<AdminRolesResponse>('/admin/roles', { signal }),
  });

  const users = usersQuery.data?.users ?? [];
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.email.toLowerCase().includes(q));
  }, [users, search]);

  const setStatusMutation = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: 'disable' | 'enable' }) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}/${status}`, { method: 'POST' }),
    // Optimistic: update the status badge in the cached list before the request resolves.
    onMutate: async ({ userId, status }) => {
      await queryClient.cancelQueries({ queryKey: ['admin', 'users'] });
      const previous = queryClient.getQueryData<AdminUsersResponse>(['admin', 'users']);
      if (previous) {
        const nextUserStatus = status === 'disable' ? 'disabled' : 'active';
        const optimistic = {
          ...previous,
          users: previous.users.map((u) => (u.id === userId ? { ...u, status: nextUserStatus } : u)),
        };
        queryClient.setQueryData(['admin', 'users'], optimistic);
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['admin', 'users'], context.previous);
      }
      if (err instanceof ApiError) {
        toast.error(copyForError(err));
      } else {
        toast.error('Could not update user status');
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.status === 'disable' ? 'User disabled' : 'User enabled');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onMutate: async (userId) => {
      await queryClient.cancelQueries({ queryKey: ['admin', 'users'] });
      const previous = queryClient.getQueryData<AdminUsersResponse>(['admin', 'users']);
      if (previous) {
        queryClient.setQueryData(['admin', 'users'], {
          ...previous,
          users: previous.users.filter((u) => u.id !== userId),
          total: Math.max(0, previous.total - 1),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['admin', 'users'], context.previous);
      }
      if (err instanceof ApiError) {
        toast.error(copyForError(err));
      } else {
        toast.error('Could not delete user');
      }
      // Only refetch on error so the server-truth matches the cache again.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onSuccess: () => {
      toast.success('User deleted');
      setDeleteUser(null);
      setDeleteConfirmEmail('');
      // Trust the optimistic state; skip refetch so a stale mock handler
      // can't accidentally re-introduce a row we just removed.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function openDetail(user: AdminUser) {
    setDetailUser(user);
    setDetailOpen(true);
  }

  function openReset(user: AdminUser) {
    setResetUser({ id: user.id, email: user.email });
    setResetOpen(true);
  }

  function startDelete(user: AdminUser) {
    setDeleteUser(user);
    setDeleteConfirmEmail('');
  }

  function confirmDelete() {
    if (!deleteUser) return;
    if (deleteConfirmEmail.trim().toLowerCase() !== deleteUser.email.toLowerCase()) {
      toast.error('Type the user email exactly to confirm');
      return;
    }
    deleteMutation.mutate(deleteUser.id);
  }

  const columnHelper = createColumnHelper<AdminUser>();
  const columns = React.useMemo<ColumnDef<AdminUser, unknown>[]>(
    () => [
      columnHelper.accessor('email', {
        id: 'name',
        header: () => (
          <span className="inline-flex items-center gap-1">
            Name <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />
          </span>
        ),
        cell: (info) => {
          const email = info.getValue();
          const display = email.split('@')[0];
          return (
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{initialsFromEmail(email)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate font-medium" title={display}>
                  {display}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={email}>
                  {email}
                </div>
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor((row) => row.roles.map((r) => r.name).join(','), {
        id: 'roles',
        header: 'Roles',
        enableSorting: false,
        cell: (info) => {
          const user = info.row.original;
          if (user.roles.length === 0) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div className="flex max-w-[220px] flex-wrap gap-1">
              {user.roles.map((role) => (
                <RoleChip key={role.id} role={role.name} />
              ))}
            </div>
          );
        },
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: (info) => {
          const status = info.getValue();
          return (
            <Badge variant={statusToBadgeVariant(status)} className="capitalize">
              {status}
            </Badge>
          );
        },
      }),
      columnHelper.accessor((row) => row.last_login_at ?? '', {
        id: 'last_login',
        header: 'Last login',
        cell: (info) => {
          const v = info.getValue();
          if (!v) return <span className="text-xs text-muted-foreground">Never</span>;
          return <RelativeTime date={v} />;
        },
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: (info) => {
          const user = info.row.original;
          const isActive = user.status === 'active';
          return (
            <div
              className="flex justify-end"
              // Stop row click bubbling to the row's onRowClick handler.
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Open actions for ${user.email}`}
                    data-testid={`actions-${user.id}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => openReset(user)}>
                    <KeyRound /> Reset password
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      setStatusMutation.mutate({ userId: user.id, status: isActive ? 'disable' : 'enable' })
                    }
                    disabled={setStatusMutation.isPending}
                  >
                    {isActive ? (
                      <>
                        <Lock /> Disable
                      </>
                    ) : (
                      <>
                        <UserCheck /> Enable
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openDetail(user)}>
                    <Shield /> Manage roles
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => startDelete(user)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ],
    // Recompute when status mutation goes pending so disabled state stays in sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnHelper, setStatusMutation.isPending, deleteMutation.isPending],
  );

  const isLoading = usersQuery.isLoading || rolesQuery.isLoading;
  const isError = usersQuery.isError || rolesQuery.isError;
  const hasUsers = !isLoading && !isError && users.length > 0;

  return (
    <section className="space-y-6">
      <PageHeader
        title="Users"
        description="Manage team members, roles, and access."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search name or email…"
                className="w-56 pl-8"
                aria-label="Search users"
                data-testid="users-search"
              />
            </div>
            <Button
              type="button"
              variant="default"
              onClick={() => toast.info('Invite flow coming soon')}
              data-testid="invite-button"
            >
              <UserPlus className="h-4 w-4" /> Invite
            </Button>
          </>
        }
      />

      {isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load users.
        </div>
      ) : null}

      {hasUsers || isLoading ? (
        <DataTable
          columns={columns}
          data={filtered}
          isLoading={isLoading}
          onRowClick={openDetail}
          ariaLabel="Users directory"
          emptyState={
            users.length > 0 && filtered.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No users match "{search}".</div>
            ) : (
              <EmptyState title="No users yet" description="Invite a teammate to get started." />
            )
          }
        />
      ) : !isError ? (
        <EmptyState title="No users yet" description="Invite a teammate to get started." />
      ) : null}

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading users…
        </p>
      ) : null}

      <UserDetailDrawer user={detailUser} open={detailOpen} onOpenChange={setDetailOpen} />
      <ResetPasswordDialog user={resetUser} open={resetOpen} onOpenChange={setResetOpen} />

      <Dialog
        open={!!deleteUser}
        onOpenChange={(next) => {
          if (!next) {
            setDeleteUser(null);
            setDeleteConfirmEmail('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleteUser?.email}?</DialogTitle>
            <DialogDescription>
              This permanently removes the user and revokes all active sessions. To confirm, type the user's email
              address below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">Email address</Label>
            <Input
              id="delete-confirm"
              autoComplete="off"
              value={deleteConfirmEmail}
              onChange={(e) => setDeleteConfirmEmail(e.currentTarget.value)}
              placeholder={deleteUser?.email}
              data-testid="delete-confirm-input"
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteUser(null);
                setDeleteConfirmEmail('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={
                deleteMutation.isPending ||
                !deleteUser ||
                deleteConfirmEmail.trim().toLowerCase() !== deleteUser.email.toLowerCase()
              }
              data-testid="delete-confirm-submit"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete user'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
