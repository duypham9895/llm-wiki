import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Library,
  Search as SearchIcon,
  MessageSquare,
  Activity,
  Users,
  ShieldCheck,
  Settings,
  Database,
  Plus,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { KbdHint } from '@/components/KbdHint';
import { useAuth } from '@/lib/auth';
import {
  fetchServerRecents,
  fetchSuggested,
  getLocalRecents,
  hydrateLocalRecents,
  recordLocalRecent,
  type RecentPrd,
} from '@/lib/recent';

interface PageItem {
  kind: 'page';
  label: string;
  path: string;
  icon: LucideIcon;
  shortcut?: string;
  permission?: string;
}

interface ActionItem {
  kind: 'action';
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

interface PrdItem {
  kind: 'prd';
  label: string;
  id: string;
  icon: LucideIcon;
}

type PaletteItem = PageItem | ActionItem | PrdItem;

const PAGES: PageItem[] = [
  { kind: 'page', label: 'Library', path: '/library', icon: Library, shortcut: 'G L' },
  { kind: 'page', label: 'Search', path: '/search', icon: SearchIcon, shortcut: 'G S' },
  { kind: 'page', label: 'Ask', path: '/ask', icon: MessageSquare, shortcut: 'G A' },
  { kind: 'page', label: 'Status', path: '/status', icon: Activity, shortcut: 'G T' },
  { kind: 'page', label: 'Approvals', path: '/admin/approvals', icon: ShieldCheck, permission: 'users.manage' },
  { kind: 'page', label: 'Users', path: '/admin/directory', icon: Users, permission: 'users.manage' },
  { kind: 'page', label: 'Roles', path: '/admin/roles', icon: ShieldCheck, permission: 'roles.manage' },
  { kind: 'page', label: 'Sources', path: '/admin/sources', icon: Database, permission: 'users.manage' },
  { kind: 'page', label: 'Settings', path: '/admin/settings', icon: Settings, permission: 'roles.manage' },
];

const RECENT_LIMIT = 8;

export function CommandPalette() {
  const navigate = useNavigate();
  const me = useAuth();
  const [open, setOpen] = React.useState(false);

  // Toggle on ⌘K / Ctrl+K
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Recents: show localStorage FIRST so the palette paints instantly, then
  // reconcile with the server's cross-device list. If both are empty, fall
  // back to a "Suggested" group from the library endpoint.
  const [localRecents, setLocalRecents] = React.useState<RecentPrd[]>([]);
  React.useEffect(() => {
    if (!open) return;
    setLocalRecents(getLocalRecents());
  }, [open]);

  const serverRecentsQuery = useQuery<RecentPrd[]>({
    queryKey: ['recent-prds'],
    queryFn: async () => fetchServerRecents(RECENT_LIMIT),
    enabled: open,
    staleTime: 60_000,
  });

  const suggestedQuery = useQuery<RecentPrd[]>({
    queryKey: ['suggested-prds'],
    queryFn: async () => fetchSuggested(RECENT_LIMIT),
    enabled: open,
    staleTime: 60_000,
  });

  // Merge: server recents are the source of truth for cross-device history;
  // when the server returns 0 entries (new user / never opened a PRD), the
  // palette renders "Suggested" from /library. Local entries are merged on
  // top so the just-opened PRD shows up immediately, before the server
  // round-trip resolves. When the SAME id appears in both, prefer whichever
  // row carries a title — localStorage writes (from PrdDetailPage) include
  // the title, server ids don't.
  const mergedRecents: RecentPrd[] = React.useMemo(() => {
    const server = serverRecentsQuery.data ?? [];
    const local = localRecents;
    const byId = new Map<string, RecentPrd>();
    for (const e of server) byId.set(e.id, e);
    for (const e of local) {
      const existing = byId.get(e.id);
      if (!existing) {
        byId.set(e.id, e);
      } else if (!existing.title && e.title) {
        byId.set(e.id, e);
      }
      // else: existing has title, or both have it — keep existing.
    }
    return Array.from(byId.values()).slice(0, RECENT_LIMIT);
  }, [serverRecentsQuery.data, localRecents]);

  // Hydrate missing titles from the library endpoint (server recents don't
  // carry titles — just ids — so the first paint would be "EP-101" alone).
  React.useEffect(() => {
    if (!open) return;
    if (mergedRecents.some((e) => !e.title)) {
      hydrateLocalRecents(mergedRecents).then((resolved) => {
        if (resolved.some((e) => e.title)) setLocalRecents(resolved);
      });
    }
  }, [open, mergedRecents]);

  const showSuggested = mergedRecents.length === 0;
  const suggestedItems: RecentPrd[] = suggestedQuery.data ?? [];
  const heading = showSuggested ? 'Suggested' : 'Recent PRDs';

  const pages = React.useMemo<PageItem[]>(
    () => PAGES.filter((p) => !p.permission || me.permissions.includes(p.permission)),
    [me.permissions],
  );

  const handleSelect = (item: PaletteItem) => {
    setOpen(false);
    if (item.kind === 'page') navigate(item.path);
    else if (item.kind === 'prd') navigate(`/library/${item.id}`);
    else item.onSelect();
  };

  const newChat: ActionItem = {
    kind: 'action',
    label: 'New chat',
    icon: Plus,
    onSelect: () => navigate('/ask'),
  };

  const prdItems: RecentPrd[] = showSuggested ? suggestedItems : mergedRecents;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages, PRDs, or run a command…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Pages">
          {pages.map((p) => (
            <CommandItem key={p.path} value={`page ${p.label}`} onSelect={() => handleSelect(p)}>
              <p.icon className="text-muted-foreground" />
              <span>{p.label}</span>
              <ArrowRight className="ml-auto text-muted-foreground" />
              {p.shortcut && <CommandShortcut>{p.shortcut}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem value="action new chat" onSelect={() => handleSelect(newChat)}>
            <newChat.icon className="text-muted-foreground" />
            <span>{newChat.label}</span>
            <CommandShortcut>
              <KbdHint>G</KbdHint> <KbdHint>A</KbdHint>
            </CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {prdItems.length > 0 && (
          <CommandGroup heading={heading}>
            {prdItems.map((p) => (
              <CommandItem
                key={p.id}
                value={`prd ${p.title} ${p.id}`}
                onSelect={() => {
                  // Make sure the click re-records (in case the user opened the
                  // palette before the detail page's useEffect ran — e.g. via
                  // a stale localStorage entry).
                  recordLocalRecent(p.id, p.title);
                  handleSelect({ kind: 'prd', label: p.title, id: p.id, icon: Library });
                }}
              >
                <Library className="text-muted-foreground" />
                <span className="truncate">{p.title || p.id}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{p.id}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}