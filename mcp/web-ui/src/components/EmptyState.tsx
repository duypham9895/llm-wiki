import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void } | React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={
        'flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card/50 p-10 text-center ' +
        (className ?? '')
      }
    >
      {Icon && (
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <div className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        {description && <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && (
        <div className="mt-2">
          {React.isValidElement(action) ? (
            action
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={(action as { onClick: () => void }).onClick}
            >
              {(action as { label: string }).label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
