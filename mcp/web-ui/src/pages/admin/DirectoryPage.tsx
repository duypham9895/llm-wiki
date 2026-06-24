import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { apiFetch } from '../../lib/api';
import { copyForError } from '../../lib/error-copy';

type UserStatus = 'active' | 'disabled';

type AdminRole = {
  id: string;
  name: string;
  is_system?: boolean;
  permissions: string[];
};

type AdminRolesResponse = {
  roles: AdminRole[];
};

type AdminUser = {
  id: string;
  email: string;
  status: string;
  roles: Array<{ id: string; name: string }>;
  created_at?: string;
};

type AdminUsersResponse = {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
};

type UserAction = {
  userId: string;
  action: 'disable' | 'enable' | 'delete';
};

type RoleAction = {
  userId: string;
  roleIds: string[];
};

type PasswordAction = {
  userId: string;
  password: string;
};

export function DirectoryPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<UserStatus>('active');
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string[]>>({});
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [password, setPassword] = useState('');

  const users = useQuery({
    queryKey: ['admin', 'users', status],
    queryFn: ({ signal }) => apiFetch<AdminUsersResponse>(`/admin/users?status=${status}`, { signal }),
  });
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => apiFetch<AdminRolesResponse>('/admin/roles', { signal }),
  });

  const userRows = users.data?.users ?? [];
  const roleOptions = roles.data?.roles ?? [];

  const userMutation = useMutation({
    mutationFn: ({ userId, action }: UserAction) => {
      if (action === 'delete') {
        return apiFetch(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      }

      return apiFetch(`/admin/users/${encodeURIComponent(userId)}/${action}`, { method: 'POST' });
    },
    onSuccess: () => {
      setMessage(null);
      setSuccess(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, roleIds }: RoleAction) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}/roles`, {
        method: 'PUT',
        body: { role_ids: roleIds },
      }),
    onSuccess: () => {
      setMessage(null);
      setSuccess('Roles updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  const passwordMutation = useMutation({
    mutationFn: ({ userId, password: nextPassword }: PasswordAction) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}/reset-password`, {
        method: 'POST',
        body: { password: nextPassword },
      }),
    onSuccess: () => {
      setMessage(null);
      setSuccess('Password reset.');
      setResetUser(null);
      setPassword('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  function roleIdsFor(user: AdminUser) {
    return roleDrafts[user.id] ?? user.roles.map((role) => role.id);
  }

  function toggleRole(user: AdminUser, roleId: string, checked: boolean) {
    const currentIds = roleIdsFor(user);
    setRoleDrafts((current) => ({
      ...current,
      [user.id]: checked ? [...currentIds, roleId] : currentIds.filter((id) => id !== roleId),
    }));
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Admin</p>
          <h1 className="text-2xl font-semibold tracking-normal">Directory</h1>
        </div>
        <div className="inline-flex w-fit rounded-md border p-1">
          {(['active', 'disabled'] as const).map((nextStatus) => (
            <button
              key={nextStatus}
              className={`h-8 rounded px-3 text-sm font-medium capitalize ${status === nextStatus ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
              type="button"
              onClick={() => setStatus(nextStatus)}
            >
              {nextStatus}
            </button>
          ))}
        </div>
      </div>

      {message ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p> : null}
      {success ? <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700">{success}</p> : null}

      {users.isLoading || roles.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading users.
        </p>
      ) : null}

      {users.isError || roles.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load users.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Roles</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {userRows.map((user) => {
              const selectedRoleIds = roleIdsFor(user);
              return (
                <tr key={user.id} className="border-b last:border-0" data-testid={`user-${user.id}`}>
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium">{user.email}</div>
                    <div className="text-xs text-muted-foreground">Created {user.created_at ?? 'unknown'}</div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <fieldset className="grid gap-2">
                      <legend className="sr-only">Roles for {user.email}</legend>
                      <div className="flex flex-wrap gap-3">
                        {roleOptions.map((role) => (
                          <label key={role.id} className="inline-flex items-center gap-2 text-xs">
                            <input
                              checked={selectedRoleIds.includes(role.id)}
                              className="size-4 rounded border-input"
                              type="checkbox"
                              onChange={(event) => toggleRole(user, role.id, event.currentTarget.checked)}
                            />
                            {role.name}
                          </label>
                        ))}
                      </div>
                      <button
                        className="w-fit rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
                        disabled={roleMutation.isPending}
                        type="button"
                        onClick={() => roleMutation.mutate({ userId: user.id, roleIds: selectedRoleIds })}
                      >
                        Save roles for {user.email}
                      </button>
                    </fieldset>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-2">
                      {user.status === 'active' ? (
                        <button
                          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
                          disabled={userMutation.isPending}
                          type="button"
                          onClick={() => userMutation.mutate({ userId: user.id, action: 'disable' })}
                        >
                          Disable {user.email}
                        </button>
                      ) : (
                        <button
                          className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
                          disabled={userMutation.isPending}
                          type="button"
                          onClick={() => userMutation.mutate({ userId: user.id, action: 'enable' })}
                        >
                          Enable {user.email}
                        </button>
                      )}
                      <button
                        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent"
                        type="button"
                        onClick={() => {
                          setResetUser(user);
                          setPassword('');
                        }}
                      >
                        Reset password for {user.email}
                      </button>
                      <button
                        className="rounded-md border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                        disabled={userMutation.isPending}
                        type="button"
                        onClick={() => userMutation.mutate({ userId: user.id, action: 'delete' })}
                      >
                        Delete {user.email}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {users.isSuccess && userRows.length === 0 ? <p className="text-sm text-muted-foreground">No {status} users.</p> : null}

      {resetUser ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4" role="presentation">
          <form
            aria-labelledby="reset-password-title"
            aria-modal="true"
            className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              passwordMutation.mutate({ userId: resetUser.id, password });
            }}
          >
            <h2 id="reset-password-title" className="text-lg font-semibold">Reset password</h2>
            <p className="mt-1 text-sm text-muted-foreground">Set a new password for {resetUser.email}.</p>
            <label className="mt-4 grid gap-1 text-sm font-medium">
              New password
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
                type="button"
                onClick={() => setResetUser(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                disabled={!password || passwordMutation.isPending}
                type="submit"
              >
                Set password
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
