import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { useHasPermission } from '../lib/auth';
import { EmptyState } from './EmptyState';
import { Button } from './ui/button';

export function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const permitted = useHasPermission(perm);

  if (!permitted) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Access restricted"
        description="You don't have permission to view this page. Ask an admin if you think this is wrong."
        action={
          <Button asChild variant="outline">
            <Link to="/library">Back to Library</Link>
          </Button>
        }
      />
    );
  }

  return children;
}