import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { apiFetch } from '../../lib/api';
import { copyForError } from '../../lib/error-copy';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

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

type ApprovalAction = {
  userId: string;
  action: 'approve' | 'reject';
  roleIds: string[];
};

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [selectedRoles, setSelectedRoles] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState<string | null>(null);

  const pendingUsers = useQuery({
    queryKey: ['admin', 'users', 'pending'],
    queryFn: ({ signal }) => apiFetch<AdminUsersResponse>('/admin/users?status=pending', { signal }),
  });
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => apiFetch<AdminRolesResponse>('/admin/roles', { signal }),
  });

  const users = pendingUsers.data?.users ?? [];
  const roleOptions = roles.data?.roles ?? [];

  const approvalMutation = useMutation({
    mutationFn: ({ userId, action, roleIds }: ApprovalAction) =>
      apiFetch(`/admin/users/${encodeURIComponent(userId)}/${action}`, {
        method: 'POST',
        body: action === 'approve' ? { role_ids: roleIds } : undefined,
      }),
    onSuccess: () => {
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users', 'pending'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  function toggleRole(userId: string, roleId: string, checked: boolean) {
    setSelectedRoles((current) => {
      const roleIds = current[userId] ?? [];
      return {
        ...current,
        [userId]: checked ? [...roleIds, roleId] : roleIds.filter((id) => id !== roleId),
      };
    });
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Admin</p>
        <h1 className="text-2xl font-semibold tracking-normal">Approvals</h1>
      </div>

      {message ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p> : null}

      {pendingUsers.isLoading || roles.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading approvals.
        </p>
      ) : null}

      {pendingUsers.isError || roles.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load approvals.
        </p>
      ) : null}

      {pendingUsers.isSuccess && users.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="text-lg font-semibold">No pending approvals</h2>
          <p className="mt-2 text-sm text-muted-foreground">New registration requests appear here.</p>
        </div>
      ) : null}

      <div className="grid gap-4">
        <TooltipProvider>
          {users.map((user) => {
            const roleIds = selectedRoles[user.id] ?? [];
            const rejectDisabled = approvalMutation.isPending || roleIds.length === 0;
            return (
              <article key={user.id} className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{user.email}</h2>
                    <p className="text-sm text-muted-foreground">Requested at {user.created_at ?? 'unknown'}</p>
                  </div>
                  <span className="w-fit rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                    {user.status}
                  </span>
                </div>

                <fieldset className="mt-4 grid gap-2">
                  <legend className="text-sm font-medium">Assign roles</legend>
                  <div className="flex flex-wrap gap-3">
                    {roleOptions.map((role) => (
                      <label key={role.id} className="inline-flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={roleIds.includes(role.id)}
                          onCheckedChange={(checked) =>
                            toggleRole(user.id, role.id, checked === true)
                          }
                          aria-label={role.name}
                        />
                        {role.name}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={approvalMutation.isPending}
                    onClick={() => approvalMutation.mutate({ userId: user.id, action: 'approve', roleIds })}
                  >
                    Approve {user.email}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={rejectDisabled}
                          onClick={() => approvalMutation.mutate({ userId: user.id, action: 'reject', roleIds: [] })}
                        >
                          Reject {user.email}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {roleIds.length === 0 ? (
                      <TooltipContent>Select roles first</TooltipContent>
                    ) : null}
                  </Tooltip>
                </div>
              </article>
            );
          })}
        </TooltipProvider>
      </div>
    </section>
  );
}