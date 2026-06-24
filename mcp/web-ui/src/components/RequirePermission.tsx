import type { ReactNode } from 'react';

import { useHasPermission } from '../lib/auth';

export function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const permitted = useHasPermission(perm);

  if (!permitted) {
    return <p>You don't have access to this page.</p>;
  }

  return children;
}
