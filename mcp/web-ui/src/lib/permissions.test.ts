import { describe, expect, it } from 'vitest';

import { NAV, visibleSections } from './permissions';

function groupNames(perms: string[]): string[] {
  return visibleSections(perms).map((section) => section.group);
}

describe('visibleSections', () => {
  it('shows only Knowledge for read-only members', () => {
    expect(groupNames(['prd.read', 'prd.ask'])).toEqual(['Knowledge']);
  });

  it('shows all groups for full admins', () => {
    expect(groupNames(['prd.read', 'prd.ask', 'status.view', 'users.manage', 'roles.manage'])).toEqual([
      'Knowledge',
      'Operate',
      'Manage',
    ]);
  });

  it('shows the admin Manage entries for full admins', () => {
    const manage = visibleSections(['users.manage', 'roles.manage']).find((section) => section.group === 'Manage');

    expect(manage?.items.map((item) => item.label)).toEqual([
      'Approvals',
      'Directory',
      'Roles',
      'Sources',
      'Settings',
    ]);
    expect(manage?.items.map((item) => item.path)).toEqual([
      '/admin/approvals',
      '/admin/directory',
      '/admin/roles',
      '/admin/sources',
      '/admin/settings',
    ]);
  });

  it('hides every Manage entry from members', () => {
    const groups = visibleSections(['prd.read', 'prd.ask']);

    expect(groups.find((section) => section.group === 'Manage')).toBeUndefined();
    expect(groups.flatMap((section) => section.items.map((item) => item.label))).not.toEqual(
      expect.arrayContaining(['Approvals', 'Directory', 'Roles', 'Settings', 'Users']),
    );
  });

  it('drops empty groups', () => {
    expect(groupNames(['status.view'])).toEqual(['Operate']);
  });

  it('returns nothing when no permissions are present', () => {
    expect(visibleSections([])).toEqual([]);
  });

  it('ignores unknown permissions without crashing', () => {
    expect(visibleSections(['prd.read', 'bogus.perm'])).toEqual([
      {
        group: 'Knowledge',
        items: [
          { label: 'Library', path: '/library', perm: 'prd.read' },
          { label: 'Search', path: '/search', perm: 'prd.read' },
        ],
      },
    ]);
  });

  it('does not mutate NAV', () => {
    visibleSections(['prd.read']);

    expect(NAV).toHaveLength(3);
    expect(NAV[0].items).toHaveLength(3);
  });
});
