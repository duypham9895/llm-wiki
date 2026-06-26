import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'llm-wiki-theme';

// Design-token storage keys (consumed by both the ThemeProvider and the /admin/theme picker).
export const TOKEN_STORAGE = {
  accent: 'llm-wiki-accent',
  density: 'llm-wiki-density',
  radius: 'llm-wiki-radius',
} as const;

export type Density = 'compact' | 'comfortable';

export const DESIGN_DEFAULTS = {
  /** HSL hue (0–360) — 238 ≈ the indigo hue baked into the OKLCH tokens. */
  accentHue: 238,
  density: 'comfortable' as Density,
  /** Numeric px; mirrors the `--radius: 0.625rem` (≈10px) default in index.css. */
  radiusPx: 10,
} as const;

interface DesignTokens {
  accentHue: number;
  density: Density;
  radiusPx: number;
}

interface DesignTokensContextValue extends DesignTokens {
  setAccentHue: (hue: number) => void;
  setDensity: (density: Density) => void;
  setRadiusPx: (px: number) => void;
  resetTokens: () => void;
}

const DesignTokensContext = React.createContext<DesignTokensContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
}

function applyTheme(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

function clampHue(hue: number): number {
  if (Number.isNaN(hue)) return DESIGN_DEFAULTS.accentHue;
  return Math.min(360, Math.max(0, Math.round(hue)));
}

function clampRadius(px: number): number {
  if (Number.isNaN(px)) return DESIGN_DEFAULTS.radiusPx;
  return Math.min(12, Math.max(0, Math.round(px)));
}

function readStoredTokens(): DesignTokens {
  if (typeof window === 'undefined') {
    return {
      accentHue: DESIGN_DEFAULTS.accentHue,
      density: DESIGN_DEFAULTS.density,
      radiusPx: DESIGN_DEFAULTS.radiusPx,
    };
  }
  const rawHue = localStorage.getItem(TOKEN_STORAGE.accent);
  const rawDensity = localStorage.getItem(TOKEN_STORAGE.density);
  const rawRadius = localStorage.getItem(TOKEN_STORAGE.radius);

  const hue = rawHue === null ? DESIGN_DEFAULTS.accentHue : clampHue(Number(rawHue));
  const density: Density = rawDensity === 'compact' || rawDensity === 'comfortable' ? rawDensity : DESIGN_DEFAULTS.density;
  const radiusPx = rawRadius === null ? DESIGN_DEFAULTS.radiusPx : clampRadius(Number(rawRadius));

  return { accentHue: hue, density, radiusPx };
}

/**
 * Apply a design-token snapshot to the document root. Pure DOM write — safe to call
 * during render as well as inside effects. Reads the resolved theme so we keep the
 * accent visible against both light and dark backgrounds.
 */
function applyDesignTokens(tokens: DesignTokens): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--accent', `${tokens.accentHue} 90% 60%`);
  root.style.setProperty('--ring', `${tokens.accentHue} 90% 60%`);
  root.style.setProperty('--radius', `${tokens.radiusPx}px`);
  root.setAttribute('data-density', tokens.density);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<'light' | 'dark'>(
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );
  const [tokens, setTokens] = React.useState<DesignTokens>(readStoredTokens);

  // Sync DOM when theme changes.
  React.useEffect(() => {
    if (theme === 'system') {
      if (typeof window.matchMedia !== 'function') {
        setResolvedTheme('light');
        applyTheme('light');
        return;
      }
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => {
        const next = mq.matches ? 'dark' : 'light';
        setResolvedTheme(next);
        applyTheme(next);
      };
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    setResolvedTheme(theme);
    applyTheme(theme);
  }, [theme]);

  // Apply design tokens on first mount AND on every change. This is idempotent and
  // cheap, so we don't bother diffing.
  React.useEffect(() => {
    applyDesignTokens(tokens);
  }, [tokens]);

  const setTheme = React.useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const toggle = React.useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const setAccentHue = React.useCallback((hue: number) => {
    const next = clampHue(hue);
    setTokens((current) => {
      const merged = { ...current, accentHue: next };
      localStorage.setItem(TOKEN_STORAGE.accent, String(next));
      applyDesignTokens(merged);
      return merged;
    });
  }, []);

  const setDensity = React.useCallback((density: Density) => {
    setTokens((current) => {
      const merged = { ...current, density };
      localStorage.setItem(TOKEN_STORAGE.density, density);
      applyDesignTokens(merged);
      return merged;
    });
  }, []);

  const setRadiusPx = React.useCallback((px: number) => {
    const next = clampRadius(px);
    setTokens((current) => {
      const merged = { ...current, radiusPx: next };
      localStorage.setItem(TOKEN_STORAGE.radius, String(next));
      applyDesignTokens(merged);
      return merged;
    });
  }, []);

  const resetTokens = React.useCallback(() => {
    setTokens(() => {
      const merged: DesignTokens = {
        accentHue: DESIGN_DEFAULTS.accentHue,
        density: DESIGN_DEFAULTS.density,
        radiusPx: DESIGN_DEFAULTS.radiusPx,
      };
      localStorage.removeItem(TOKEN_STORAGE.accent);
      localStorage.removeItem(TOKEN_STORAGE.density);
      localStorage.removeItem(TOKEN_STORAGE.radius);
      applyDesignTokens(merged);
      return merged;
    });
  }, []);

  const themeValue = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggle }),
    [theme, resolvedTheme, setTheme, toggle],
  );

  const tokensValue = React.useMemo<DesignTokensContextValue>(
    () => ({
      accentHue: tokens.accentHue,
      density: tokens.density,
      radiusPx: tokens.radiusPx,
      setAccentHue,
      setDensity,
      setRadiusPx,
      resetTokens,
    }),
    [tokens, setAccentHue, setDensity, setRadiusPx, resetTokens],
  );

  return (
    <ThemeContext.Provider value={themeValue}>
      <DesignTokensContext.Provider value={tokensValue}>
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
      </DesignTokensContext.Provider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export function useDesignTokens(): DesignTokensContextValue {
  const ctx = React.useContext(DesignTokensContext);
  if (!ctx) throw new Error('useDesignTokens must be used within ThemeProvider');
  return ctx;
}
