import { Link } from 'react-router-dom';
import { ArrowRight, Circle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

interface SetupStep {
  label: string;
  to: string;
}

const STEPS: SetupStep[] = [
  { label: 'Connect Notion', to: '/admin/sources' },
  { label: 'Run your first sync', to: '/admin/sources' },
  { label: 'Invite your team', to: '/admin/directory' },
];

/**
 * First-run admin onboarding guide. Renders 3 link-out steps to seed the vault.
 * Stateless by design — it does not detect completion, it just points the way.
 * Gate rendering on `users.manage` + an empty vault at the call site.
 */
export function SetupChecklist() {
  return (
    <Card className="mx-auto w-full max-w-md text-left">
      <CardHeader>
        <CardTitle>Get started</CardTitle>
        <CardDescription>Three steps to fill your vault.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {STEPS.map((step) => (
          <Link
            key={step.label}
            to={step.to}
            className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Circle className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-sm font-medium">{step.label}</span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
