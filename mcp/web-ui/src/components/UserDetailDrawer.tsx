import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Mail, Save } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ApiError, apiFetch } from '@/lib/api';
import { copyForError } from '@/lib/error-copy';
import { RelativeTime } from '@/components/RelativeTime';

export interface UserDetailUser {
  id: string;
  email: string;
  status: string;
  roles: Array<{ id: string; name: string }>;
  created_at: string;
  last_login_at?: string | null;
  last_password_change_at?: string | null;
}

export interface UserDetailDrawerProps {
  user: UserDetailUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

/**
 * Side drawer for inspecting a user + editing their role assignment. Roles
 * are toggled locally and saved as a single PUT; the save button is disabled
 * until the selection is dirty.
 */
export function UserDetailDrawer({ user, open, onOpenChange }: UserDetailDrawerProps) {
  const queryClient = useQueryClient();
  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => apiFetch<AdminRolesResponse>('/admin/roles', { signal }),
    enabled: open,
  });

  const [draft, setDraft] = React.useState<string[]>([]);
  const [seededFor, setSeededFor] = React.useState<string | null>(null);

  // Seed/reseed the draft when the active user changes.
  React.useEffect(() => {
    if (!user) return;
    if (user.id !== seededFor) {
      setDraft(user.roles.map((r) => r.id));
      setSeededFor(user.id);
    }
  }, [user, seededFor]);

  const dirty = !!user && JSON.stringify([...draft].sort()) !== JSON.stringify([...user.roles.map((r) => r.id)].sort());

  const saveRoles = useMutation({
    mutationFn: () =>
      apiFetch(`/admin/users/${encodeURIComponent(user!.id)}/roles`, {
        method: 'PUT',
        body: { role_ids: draft },
      }),
    onSuccess: () => {
      toast.success('Roles updated');
      setSeededFor(user!.id);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        toast.error(copyForError(err));
      } else {
        toast.error('Could not update roles');
      }
    },
  });

  const availableRoles = roles.data?.roles ?? [];
  const statusVariant = statusToBadgeVariant(user?.status);

  function toggleRole(roleId: string, checked: boolean) {
    setDraft((current) => (checked ? [...current, roleId] : current.filter((id) => id !== roleId)));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-6 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{user?.email ?? ''}</span>
          </SheetTitle>
          <SheetDescription asChild>
            {user ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={statusVariant}>{user.status}</Badge>
                <span className="text-xs text-muted-foreground">ID {user.id}</span>
              </div>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Roles</h3>
          {roles.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading roles…
            </p>
          ) : availableRoles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No roles available.</p>
          ) : (
            <fieldset className="space-y-2" disabled={saveRoles.isPending}>
              <legend className="sr-only">Roles for {user?.email}</legend>
              {availableRoles.map((role) => {
                const checked = draft.includes(role.id);
                return (
                  <label
                    key={role.id}
                    className="flex items-start gap-3 rounded-md border bg-card/50 p-2 text-sm transition-colors hover:bg-muted/30"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-input"
                      checked={checked}
                      onChange={(e) => toggleRole(role.id, e.currentTarget.checked)}
                    />
                    <span className="flex-1 leading-tight">
                      <span className="block font-medium">{role.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {role.permissions.length > 0 ? role.permissions.join(', ') : 'no permissions'}
                        {role.is_system ? ' · system' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => saveRoles.mutate()}
              disabled={!dirty || saveRoles.isPending}
              size="sm"
            >
              {saveRoles.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save roles
            </Button>
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Audit</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Created</dt>
              <dd>
                {user?.created_at ? <RelativeTime date={user.created_at} /> : <span className="text-muted-foreground">—</span>}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Last login</dt>
              <dd>
                {user?.last_login_at ? (
                  <RelativeTime date={user.last_login_at} />
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </dd>
            </div>
            {user?.last_password_change_at ? (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Password last changed</dt>
                <dd>
                  <RelativeTime date={user.last_password_change_at} />
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      </SheetContent>
    </Sheet>
  );
}

function statusToBadgeVariant(status?: string): 'success' | 'warning' | 'secondary' | 'destructive' | 'outline' {
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
