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
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';

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

interface MiniPrd {
  id: string;
  title: string;
}

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

  // Recent PRDs (top 8 from library)
  const recentPrds = useQuery<MiniPrd[]>({
    queryKey: ['recent-prds'],
    queryFn: async () => {
      const data = await apiFetch<{ results: MiniPrd[] }>('/prd/library?limit=8');
      return data.results ?? [];
    },
    enabled: open,
    staleTime: 60_000,
  });

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

        {(recentPrds.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Recent PRDs">
            {recentPrds.data!.map((p) => (
              <CommandItem
                key={p.id}
                value={`prd ${p.title} ${p.id}`}
                onSelect={() => handleSelect({ kind: 'prd', label: p.title, id: p.id, icon: Library })}
              >
                <Library className="text-muted-foreground" />
                <span className="truncate">{p.title}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{p.id}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
