export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly perm: string;
}

export interface NavGroup {
  readonly group: string;
  readonly items: readonly NavItem[];
}

export const NAV: NavGroup[] = [
  {
    group: 'Knowledge',
    items: [
      { label: 'Library', path: '/library', perm: 'prd.read' },
      { label: 'Search', path: '/search', perm: 'prd.read' },
      { label: 'Ask', path: '/ask', perm: 'prd.ask' },
    ],
  },
  {
    group: 'Operate',
    items: [{ label: 'Status', path: '/status', perm: 'status.view' }],
  },
  {
    group: 'Manage',
    items: [
      { label: 'Approvals', path: '/admin/approvals', perm: 'users.manage' },
      { label: 'Directory', path: '/admin/directory', perm: 'users.manage' },
      { label: 'Roles', path: '/admin/roles', perm: 'roles.manage' },
      { label: 'Sources', path: '/admin/sources', perm: 'users.manage' },
      { label: 'Settings', path: '/admin/settings', perm: 'roles.manage' },
    ],
  },
];

export function visibleSections(perms: string[]): NavGroup[] {
  const allowed = new Set(perms);

  return NAV.flatMap((section) => {
    const items = section.items.filter((item) => allowed.has(item.perm));

    if (items.length === 0) {
      return [];
    }

    return [{ group: section.group, items }];
  });
}
