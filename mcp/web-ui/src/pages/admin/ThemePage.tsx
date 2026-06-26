import { RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { DESIGN_DEFAULTS, useDesignTokens } from '@/lib/theme';

const RADIUS_MIN = 0;
const RADIUS_MAX = 12;

export function ThemePage() {
  const { accentHue, density, radiusPx, setAccentHue, setDensity, setRadiusPx, resetTokens } =
    useDesignTokens();

  const accentSwatch = `hsl(${accentHue} 90% 60%)`;

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Admin</p>
        <h1 className="text-2xl font-semibold tracking-normal">Theme</h1>
        <p className="text-sm text-muted-foreground">
          Tweak the design tokens live. Changes apply across the app and persist in your browser.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accent color</CardTitle>
          <CardDescription>Pick a hue; saturation and lightness stay fixed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <input
              type="color"
              aria-label="Accent color picker"
              value={hslToHex(accentHue)}
              onChange={(event) => {
                const hue = hexToHue(event.currentTarget.value);
                if (hue !== null) setAccentHue(hue);
              }}
              className="h-10 w-14 cursor-pointer rounded-md border bg-transparent"
            />
            <div className="flex-1">
              <Label htmlFor="accent-hue">Hue</Label>
              <div className="flex items-center gap-3">
                <input
                  id="accent-hue"
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={accentHue}
                  onChange={(event) => setAccentHue(Number(event.currentTarget.value))}
                  aria-label="Accent hue"
                  className="flex-1 accent-primary"
                />
                <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                  {accentHue}°
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Density</CardTitle>
          <CardDescription>Tighter or roomier spacing for cards, lists, and forms.</CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label="Density"
            className="inline-flex rounded-md border bg-muted p-1 text-sm"
          >
            <button
              type="button"
              role="radio"
              aria-checked={density === 'compact'}
              onClick={() => setDensity('compact')}
              className={
                density === 'compact'
                  ? 'rounded-sm bg-background px-3 py-1 font-medium text-foreground shadow-sm'
                  : 'rounded-sm px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              Compact
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={density === 'comfortable'}
              onClick={() => setDensity('comfortable')}
              className={
                density === 'comfortable'
                  ? 'rounded-sm bg-background px-3 py-1 font-medium text-foreground shadow-sm'
                  : 'rounded-sm px-3 py-1 text-muted-foreground hover:text-foreground'
              }
            >
              Comfortable
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Border radius</CardTitle>
          <CardDescription>Roundness of cards, buttons, and inputs.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={1}
              value={radiusPx}
              onChange={(event) => setRadiusPx(Number(event.currentTarget.value))}
              aria-label="Border radius"
              className="flex-1 accent-primary"
            />
            <span className="w-16 text-right text-sm tabular-nums text-muted-foreground">
              {radiusPx}px
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>Live sample using the values above.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div
            className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
            style={{ backgroundColor: 'var(--card)', borderRadius: 'var(--radius)' }}
          >
            <p className="font-semibold">Card title</p>
            <p className="text-sm text-muted-foreground">A sample card with the current tokens.</p>
          </div>
          <Button type="button">Primary button</Button>
          <Badge style={{ backgroundColor: accentSwatch, color: 'white', borderColor: 'transparent' }}>
            Accent badge
          </Badge>
          <Separator orientation="vertical" className="h-8" />
          <code className="text-xs text-muted-foreground">hue {accentHue}° · radius {radiusPx}px · {density}</code>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
        <p className="text-sm text-muted-foreground">
          Defaults: hue {DESIGN_DEFAULTS.accentHue}°, radius {DESIGN_DEFAULTS.radiusPx}px, {DESIGN_DEFAULTS.density}.
        </p>
        <Button type="button" variant="outline" onClick={resetTokens}>
          <RotateCcw />
          Reset to defaults
        </Button>
      </div>
    </section>
  );
}

/** Convert an HSL hue (0–360) at fixed S/L to a hex color usable by <input type="color">. */
function hslToHex(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = 0.9;
  const l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

function hexToHue(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const raw = match[1];
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  return h;
}
