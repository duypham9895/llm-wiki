import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock } from 'lucide-react';

import { apiFetch } from '../../lib/api';
import { copyForError } from '../../lib/error-copy';

type AdminRole = {
  id: string;
  name: string;
  is_system?: boolean;
  permissions: string[];
};

type AdminRolesResponse = {
  roles: AdminRole[];
};

type AdminPermission = {
  id: string;
  name: string;
  description: string;
};

type AdminPermissionsResponse = {
  permissions: AdminPermission[];
};

type RolePayload = {
  name: string;
  description: string;
  permission_ids: string[];
};

type UpdateRole = RolePayload & {
  roleId: string;
};

function roleTestId(name: string) {
  return `role-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function togglePermission(current: string[], permissionId: string, checked: boolean) {
  return checked ? [...current, permissionId] : current.filter((item) => item !== permissionId);
}

function permissionMappingForRole(role: AdminRole, permissions: AdminPermission[]) {
  const idsByName = new Map(permissions.map((permission) => [permission.name, permission.id]));
  const resolvedIds: string[] = [];
  const unresolvedNames: string[] = [];

  for (const permissionName of role.permissions) {
    const permissionId = idsByName.get(permissionName);
    if (permissionId === undefined) {
      unresolvedNames.push(permissionName);
    } else {
      resolvedIds.push(permissionId);
    }
  }

  return { resolvedIds, unresolvedNames };
}

export function RolesPage() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createPermissions, setCreatePermissions] = useState<string[]>([]);
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null);
  const [editName, setEditName] = useState('');
  const [editPermissions, setEditPermissions] = useState<string[]>([]);
  const [editUnresolvedPermissions, setEditUnresolvedPermissions] = useState<string[]>([]);

  const roles = useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: ({ signal }) => apiFetch<AdminRolesResponse>('/admin/roles', { signal }),
  });
  const permissions = useQuery({
    queryKey: ['admin', 'permissions'],
    queryFn: ({ signal }) => apiFetch<AdminPermissionsResponse>('/admin/permissions', { signal }),
  });

  const roleRows = roles.data?.roles ?? [];
  const permissionOptions = permissions.data?.permissions ?? [];
  const permissionsCatalogReady = permissions.isSuccess && permissionOptions.length > 0;
  const editBlockedByCatalog = editingRole !== null && (!permissionsCatalogReady || editUnresolvedPermissions.length > 0);

  const createMutation = useMutation({
    mutationFn: (payload: RolePayload) => apiFetch('/admin/roles', { method: 'POST', body: payload }),
    onSuccess: () => {
      setMessage(null);
      setCreateName('');
      setCreatePermissions([]);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ roleId, name, description, permission_ids }: UpdateRole) =>
      apiFetch(`/admin/roles/${encodeURIComponent(roleId)}`, {
        method: 'PUT',
        body: { name, description, permission_ids },
      }),
    onSuccess: () => {
      setMessage(null);
      setEditingRole(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (roleId: string) => apiFetch(`/admin/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    },
    onError: (err) => setMessage(copyForError(err)),
  });

  function beginEdit(role: AdminRole) {
    const mapping = permissionMappingForRole(role, permissionOptions);

    setEditingRole(role);
    setEditName(role.name);
    setEditPermissions(mapping.resolvedIds);
    setEditUnresolvedPermissions(mapping.unresolvedNames);
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Admin</p>
        <h1 className="text-2xl font-semibold tracking-normal">Roles</h1>
      </div>

      {message ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p> : null}

      <form
        className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          createMutation.mutate({ name: createName, description: '', permission_ids: createPermissions });
        }}
      >
        <h2 className="text-lg font-semibold">Create role</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-[18rem_1fr_auto] lg:items-end">
          <label className="grid gap-1 text-sm font-medium">
            Role name
            <input
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={createName}
              onChange={(event) => setCreateName(event.currentTarget.value)}
            />
          </label>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Permissions</legend>
            <div className="flex flex-wrap gap-3">
              {permissionOptions.map((permission) => (
                <label key={permission.id} className="inline-flex items-center gap-2 text-sm">
                  <input
                    checked={createPermissions.includes(permission.id)}
                    className="size-4 rounded border-input"
                    type="checkbox"
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setCreatePermissions((current) => togglePermission(current, permission.id, checked));
                    }}
                  />
                  {permission.name}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
            disabled={!createName || !permissionsCatalogReady || createMutation.isPending}
            type="submit"
          >
            Create role
          </button>
        </div>
      </form>

      {roles.isLoading || permissions.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading roles.
        </p>
      ) : null}

      {roles.isError || permissions.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load roles.
        </p>
      ) : null}

      <div className="grid gap-4">
        {roleRows.map((role) => (
          <article
            key={role.id}
            className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
            data-testid={roleTestId(role.name)}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{role.name}</h2>
                  {role.is_system === true ? (
                    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      <Lock className="size-3" /> Locked
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {role.permissions.length > 0 ? role.permissions.join(', ') : 'No permissions'}
                </p>
              </div>

              {role.is_system === false ? (
                <div className="flex gap-2">
                  <button
                    className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
                    type="button"
                    onClick={() => beginEdit(role)}
                  >
                    Edit {role.name}
                  </button>
                  <button
                    className="rounded-md border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
                    disabled={deleteMutation.isPending}
                    type="button"
                    onClick={() => deleteMutation.mutate(role.id)}
                  >
                    Delete {role.name}
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {editingRole ? (
        <form
          className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (editBlockedByCatalog) {
              return;
            }
            updateMutation.mutate({ roleId: editingRole.id, name: editName, description: '', permission_ids: editPermissions });
          }}
        >
          <h2 className="text-lg font-semibold">Edit {editingRole.name}</h2>
          {editBlockedByCatalog ? (
            <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              Can't safely edit this role: its permissions couldn't be matched (the permission list failed to load or is out of
              date). Reload and try again.
            </p>
          ) : null}
          <div className="mt-4 grid gap-4 lg:grid-cols-[18rem_1fr_auto_auto] lg:items-end">
            <label className="grid gap-1 text-sm font-medium">
              Role name
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={editName}
                onChange={(event) => setEditName(event.currentTarget.value)}
              />
            </label>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Permissions</legend>
              <div className="flex flex-wrap gap-3">
                {permissionOptions.map((permission) => (
                  <label key={permission.id} className="inline-flex items-center gap-2 text-sm">
                    <input
                      checked={editPermissions.includes(permission.id)}
                      className="size-4 rounded border-input"
                      type="checkbox"
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setEditPermissions((current) => togglePermission(current, permission.id, checked));
                      }}
                    />
                    {permission.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
              disabled={!editName || editBlockedByCatalog || updateMutation.isPending}
              type="submit"
            >
              Save role
            </button>
            <button
              className="h-10 rounded-md border px-4 text-sm font-medium hover:bg-accent"
              type="button"
              onClick={() => {
                setEditingRole(null);
                setEditUnresolvedPermissions([]);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
