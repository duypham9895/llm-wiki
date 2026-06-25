import { formatDistanceToNow, format, type FormatDistanceOptions } from 'date-fns';

/**
 * Relative timestamp formatter. Returns "2 minutes ago"-style strings.
 * Use the <RelativeTime /> component instead — it handles live updates + tooltip.
 */
export function relativeTime(
  date: Date | string | number,
  options?: FormatDistanceOptions,
): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return formatDistanceToNow(d, { addSuffix: true, ...options });
}

/** Full timestamp for tooltips / detail views. */
export function fullTimestamp(date: Date | string | number): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return format(d, 'PPpp');
}

/** Deterministic color from a string (for role chips, avatar fallbacks). */
export function hashColor(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  const hue = Math.abs(h) % 360;
  return `oklch(0.85 0.08 ${hue})`;
}

/** Format a duration in seconds as "0:14" / "2:35" / "1:02:14". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `0:${s.toString().padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}:${rs.toString().padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}:${rm.toString().padStart(2, '0')}:${rs.toString().padStart(2, '0')}`;
}

/** Truncate text with ellipsis at the nearest word boundary. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}
