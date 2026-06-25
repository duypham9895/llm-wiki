import { Badge } from '@/components/ui/badge';
import { hashColor } from '@/lib/format';

export interface RoleChipProps {
  role: string;
  className?: string;
}

/**
 * Role badge with a deterministic color derived from the role name.
 * Same role always renders the same color across reloads.
 */
export function RoleChip({ role, className }: RoleChipProps) {
  const bg = hashColor(role);
  return (
    <Badge
      variant="secondary"
      className={className}
      style={{
        backgroundColor: `color-mix(in oklch, ${bg} 70%, transparent)`,
        color: 'var(--foreground)',
        borderColor: 'transparent',
      }}
    >
      {role}
    </Badge>
  );
}
