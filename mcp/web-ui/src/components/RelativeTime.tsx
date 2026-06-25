import * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { relativeTime, fullTimestamp } from '@/lib/format';

export interface RelativeTimeProps {
  date: Date | string | number;
  className?: string;
  withTooltip?: boolean;
  /** Tick interval in ms to refresh the relative string. Default 60s. */
  refreshMs?: number;
}

export function RelativeTime({
  date,
  className,
  withTooltip = true,
  refreshMs = 60_000,
}: RelativeTimeProps) {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const id = window.setInterval(force, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);

  const rel = relativeTime(date);
  const content = <time className={className}>{rel}</time>;

  if (!withTooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{fullTimestamp(date)}</TooltipContent>
    </Tooltip>
  );
}
