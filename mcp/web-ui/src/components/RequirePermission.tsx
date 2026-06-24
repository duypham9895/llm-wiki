import type { ReactNode } from 'react';

import { useHasPermission } from '../lib/auth';

export function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const permitted = useHasPermission(perm);

  if (!permitted) {
    return <p>Not authorized.</p>;
  }

  return children;
}
