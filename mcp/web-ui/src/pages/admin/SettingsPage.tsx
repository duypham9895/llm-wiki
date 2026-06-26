import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';

import { apiFetch } from '../../lib/api';
import { copyForError } from '../../lib/error-copy';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type AdminSettings = {
  registration_enabled: boolean;
  allowed_domains: string[];
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [nextDomain, setNextDomain] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => apiFetch<AdminSettings>('/admin/settings', { signal }),
  });

  useEffect(() => {
    if (!settings.data) return;

    setRegistrationEnabled(settings.data.registration_enabled);
    setDomains(settings.data.allowed_domains);
  }, [settings.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: AdminSettings) => apiFetch('/admin/settings', { method: 'PUT', body: payload }),
    onSuccess: () => {
      setMessage(null);
      setSuccess('Settings saved.');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
    onError: (err) => {
      setSuccess(null);
      setMessage(copyForError(err));
    },
  });

  function addDomain() {
    const nextDomains = nextDomain
      .split(/[\s,]+/)
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    if (nextDomains.length === 0) return;

    setDomains((current) => [...new Set([...current, ...nextDomains])]);
    setNextDomain('');
  }

  const registrationGuardBlocked = registrationEnabled && domains.length === 0;
  const saveDisabled = saveMutation.isPending || registrationGuardBlocked;

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Admin</p>
        <h1 className="text-2xl font-semibold tracking-normal">Settings</h1>
      </div>

      {message ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{message}</p> : null}
      {success ? <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700">{success}</p> : null}

      {settings.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading settings.
        </p>
      ) : null}

      {settings.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load settings.
        </p>
      ) : null}

      <form
        className="space-y-6 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (saveDisabled) return;
          saveMutation.mutate({ registration_enabled: registrationEnabled, allowed_domains: domains });
        }}
      >
        <div className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm font-medium">
          <Label htmlFor="registration-enabled">Registration enabled</Label>
          <Checkbox
            id="registration-enabled"
            checked={registrationEnabled}
            onCheckedChange={(checked) => setRegistrationEnabled(checked === true)}
            aria-label="Registration enabled"
          />
        </div>

        <div className="grid gap-3">
          <h2 className="text-lg font-semibold">Allowed domains</h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Label className="sr-only" htmlFor="allowed-domain">Domain</Label>
            <Input
              id="allowed-domain"
              className="sm:w-80"
              placeholder="example.com"
              value={nextDomain}
              onChange={(event) => setNextDomain(event.currentTarget.value)}
            />
            <Button type="button" variant="outline" onClick={addDomain}>
              Add domain
            </Button>
          </div>

          {registrationGuardBlocked ? (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Registration is on but no domains are allowed</AlertTitle>
              <AlertDescription>
                Add at least one allowed email domain before enabling registration.
              </AlertDescription>
            </Alert>
          ) : null}

          {domains.length > 0 ? (
            <ul className="grid gap-2">
              {domains.map((domain) => (
                <li key={domain} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                  <span>{domain}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${domain}`}
                    onClick={() => setDomains((current) => current.filter((item) => item !== domain))}
                    type="button"
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No allowed domains added. With registration on, no email can match — add at least one domain to allow
              sign-ups.
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={saveDisabled}
          aria-disabled={saveDisabled}
          title={registrationGuardBlocked ? 'Add at least one allowed email domain before enabling registration' : undefined}
        >
          Save settings
        </Button>
      </form>
    </section>
  );
}