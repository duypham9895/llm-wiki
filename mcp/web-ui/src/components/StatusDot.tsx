import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const dotVariants = cva('inline-block h-2 w-2 shrink-0 rounded-full', {
  variants: {
    status: {
      idle: 'bg-muted-foreground/40',
      running: 'bg-sky-500 animate-pulse',
      ok: 'bg-emerald-500',
      error: 'bg-red-500',
      warning: 'bg-amber-500',
    },
  },
  defaultVariants: { status: 'idle' },
});

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof dotVariants> {
  label?: string;
}

export function StatusDot({ status, label, className, ...props }: StatusDotProps) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', className)} {...props}>
      <span className={dotVariants({ status })} aria-hidden />
      {label && <span className="text-muted-foreground">{label}</span>}
    </span>
  );
}
