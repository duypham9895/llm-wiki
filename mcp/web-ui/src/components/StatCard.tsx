import * as React from 'react';
import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Intent = 'success' | 'warning' | 'error' | 'neutral';

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: LucideIcon;
  delta?: { value: React.ReactNode; intent?: Intent; direction?: 'up' | 'down' };
  className?: string;
}

const intentTextClass: Record<Intent, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

export function StatCard({ label, value, hint, icon: Icon, delta, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-card p-4 shadow-sm transition-colors',
        className,
      )}
    >
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span className="uppercase tracking-wide">{label}</span>
        {Icon && <Icon className="h-3.5 w-3.5" />}
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {delta && (
          <span className={cn('inline-flex items-center gap-0.5 font-medium', intentTextClass[delta.intent ?? 'neutral'])}>
            {delta.direction === 'down' ? (
              <ArrowDown className="h-3 w-3" />
            ) : delta.direction === 'up' ? (
              <ArrowUp className="h-3 w-3" />
            ) : null}
            {delta.value}
          </span>
        )}
        {hint && <span>{hint}</span>}
      </div>
    </div>
  );
}
