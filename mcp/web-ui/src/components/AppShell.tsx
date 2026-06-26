import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, Moon, Search, Sun, KeyRound, BookOpen, Bell } from 'lucide-react';

import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { visibleSections } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { KbdHint } from '@/components/KbdHint';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';

export function AppShell() {
  const me = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { resolvedTheme, toggle } = useTheme();
  const sections = visibleSections(me.permissions);
  const [isSigningOut, setIsSigningOut] = React.useState(false);
  const [passwordOpen, setPasswordOpen] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  const queryClient = useQueryClient();
  async function signOut() {
    setIsSigningOut(true);
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      /* fall through */
    } finally {
      try {
        queryClient.setQueryData(['me'], null);
        await queryClient.invalidateQueries({ queryKey: ['me'] });
      } finally {
        setIsSigningOut(false);
      }
    }
  }

  const initials = (me.email ?? '?')
    .split('@')[0]
    .split(/[._-]/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  // Close mobile nav on route change.
  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Global "g X" navigation shortcuts.
  React.useEffect(() => {
    let buffer: string[] = [];
    let bufferTimer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const key = e.key.toLowerCase();
      buffer.push(key);
      if (bufferTimer) window.clearTimeout(bufferTimer);
      bufferTimer = window.setTimeout(() => (buffer = []), 800);
      const combo = buffer.join('');
      if (combo === 'gl' || combo === 'gs' || combo === 'ga' || combo === 'gt') {
        const map: Record<string, string> = {
          gl: '/library',
          gs: '/search',
          ga: '/ask',
          gt: '/status',
        };
        navigate(map[combo]);
        buffer = [];
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const NavList = (
    <nav aria-label="Primary" className="space-y-6 p-3">
      {sections.map((section) => (
        <section key={section.group} aria-labelledby={`nav-${section.group}`}>
          <h2
            id={`nav-${section.group}`}
            className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {section.group}
          </h2>
          <div className="space-y-0.5">
            {section.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                    isActive && 'bg-accent text-accent-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="border-b px-4 py-3">
              <SheetTitle className="flex items-center gap-2 text-base">
                <BookOpen className="h-4 w-4" /> LLM Wiki
              </SheetTitle>
            </SheetHeader>
            {NavList}
          </SheetContent>
        </Sheet>

        <Link to="/library" className="flex items-center gap-2 font-semibold tracking-tight">
          <BookOpen className="h-4 w-4" />
          <span className="hidden sm:inline">LLM Wiki</span>
        </Link>

        <div className="flex-1" />

        <Button
          variant="outline"
          size="sm"
          // The CommandPalette listens for ⌘K globally; this button is a hint affordance.
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }),
            )
          }
          className="hidden md:inline-flex text-muted-foreground"
        >
          <Search /> Search
          <KbdHint className="ml-2">⌘K</KbdHint>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          disabled
        >
          <Bell />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full p-0">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{initials || '?'}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate font-normal">
              <div className="text-xs text-muted-foreground">{me.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
              <KeyRound /> Change password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut} disabled={isSigningOut}>
              <LogOut /> {isSigningOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Body */}
      <div className="md:grid md:grid-cols-[14rem_1fr]">
        <aside className="hidden border-r bg-card/30 md:block">
          <div className="sticky top-14 max-h-[calc(100vh-3.5rem)] overflow-y-auto">{NavList}</div>
        </aside>
        <main id="main" className="min-h-[calc(100vh-3.5rem)] p-4 md:p-6">
          <Outlet />
        </main>
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
