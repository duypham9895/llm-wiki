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

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
}

function applyTheme(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<'light' | 'dark'>(
    typeof window !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  );

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

  const setTheme = React.useCallback((t: Theme) => {
    localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const toggle = React.useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggle }),
    [theme, resolvedTheme, setTheme, toggle],
  );

  return (
    <ThemeContext.Provider value={value}>
      <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
