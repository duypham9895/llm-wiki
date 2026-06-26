import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FileSearch, Loader2, Search, SearchX } from 'lucide-react';

import { apiFetch } from '../lib/api';
import { cn } from '@/lib/utils';
import { EmptyState } from '../components/EmptyState';

type SearchMode = 'semantic' | 'keyword';
type SearchVerdict = 'match' | 'no_match';

type SearchResult = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  status: string;
  source_url: string;
  obsidian_link: string;
  snippet: string;
  score?: number;
};

type SearchResponse = {
  count: number;
  verdict?: SearchVerdict;
  results: SearchResult[];
};

type SubmittedSearch = {
  q: string;
  mode: SearchMode;
  k: number;
};

const RESULT_LIMIT = 8;

const EXAMPLE_QUERIES = ['LTV cap', 'SP3K eligibility', 'KPR onboarding', 'referral revamp'];

const STATUS_FILTER_ALL = '__all__';

function buildSearchPath(search: SubmittedSearch) {
  const params = new URLSearchParams({ q: search.q, mode: search.mode, k: String(search.k) });
  return `/prd/search?${params.toString()}`;
}

function formatScore(score: number) {
  return `${Math.min(100, Math.max(0, Math.round(score * 100)))}%`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a raw query into distinct, non-empty terms for highlighting. */
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.trim().split(/\s+/)) {
    const term = raw.trim();
    if (term.length === 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
  }
  return [...seen];
}

/**
 * Wrap case-insensitive matches of any term in <mark>. User input is regex-escaped
 * so query chars like ( ) [ ] can't break the pattern. Returns a string untouched
 * when there are no terms (e.g. an all-whitespace query).
 */
function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0 || text.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded bg-primary/20 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('semantic');
  const [submittedSearch, setSubmittedSearch] = useState<SubmittedSearch | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(STATUS_FILTER_ALL);
  const [cursor, setCursor] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLElement | null>>([]);

  const searchQuery = useQuery({
    queryKey: ['prd-search', submittedSearch],
    queryFn: ({ signal }) => {
      if (submittedSearch === null) {
        throw new Error('Search has not been submitted.');
      }

      return apiFetch<SearchResponse>(buildSearchPath(submittedSearch), { signal });
    },
    enabled: submittedSearch !== null,
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runSearch(query);
  }

  function runSearch(rawQuery: string) {
    const trimmedQuery = rawQuery.trim();
    if (!trimmedQuery) return;
    setSubmittedSearch({ q: trimmedQuery, mode, k: RESULT_LIMIT });
  }

  function fillAndSearch(example: string) {
    setQuery(example);
    setSubmittedSearch({ q: example, mode, k: RESULT_LIMIT });
  }

  const activeMode = submittedSearch?.mode ?? mode;
  const isSemanticNoMatch =
    activeMode === 'semantic' &&
    searchQuery.data !== undefined &&
    (searchQuery.data.verdict === 'no_match' || searchQuery.data.count === 0);
  const allResults = isSemanticNoMatch ? [] : (searchQuery.data?.results ?? []);

  // Highlight terms come from the submitted query (not the live input box), so
  // marks stay stable while the user edits the box for a follow-up search.
  const terms = useMemo(() => queryTerms(submittedSearch?.q ?? ''), [submittedSearch?.q]);

  // Per-status counts over the full result set; drives the filter chips + labels.
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const result of allResults) {
      counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
    }
    return counts;
  }, [allResults]);

  const statuses = useMemo(() => [...statusCounts.keys()].sort(), [statusCounts]);

  // Reset the filter + cursor whenever a fresh result set arrives.
  useEffect(() => {
    setStatusFilter(STATUS_FILTER_ALL);
    setCursor(0);
  }, [searchQuery.data]);

  const results = useMemo(() => {
    if (statusFilter === STATUS_FILTER_ALL) return allResults;
    return allResults.filter((result) => result.status === statusFilter);
  }, [allResults, statusFilter]);

  // Clamp the cursor when the visible (filtered) result count shrinks.
  useEffect(() => {
    setCursor((prev) => {
      if (results.length === 0) return 0;
      return Math.min(prev, results.length - 1);
    });
  }, [results.length]);

  resultRefs.current.length = results.length;

  // j/k + arrow navigation over the visible results; Enter opens the active PRD.
  // Guarded so we never hijack keystrokes while the user is typing in the search box.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (results.length === 0) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((prev) => Math.min(prev + 1, results.length - 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        const active = results[cursor];
        if (active) {
          event.preventDefault();
          navigate(`/library/${active.id}`);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [results, cursor, navigate]);

  // Keep the active card in view as the cursor moves.
  useEffect(() => {
    resultRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const canShowKeywordEmpty =
    activeMode === 'keyword' && searchQuery.data !== undefined && allResults.length === 0;
  const canShowSemanticEmpty = isSemanticNoMatch;
  const showExamples = submittedSearch === null && !searchQuery.isFetching;

  if (import.meta.env.DEV && searchQuery.data?.verdict === 'no_match' && (searchQuery.data?.results?.length ?? 0) > 0) {
    const data = searchQuery.data;
    console.warn('[SearchPage] suppressed non-empty results on no_match', {
      count: data.count,
      ids: data.results.map((r) => r.id),
    });
  }

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">PRD search</p>
        <h1 className="text-2xl font-semibold tracking-normal">Search</h1>
      </div>

      <form className="rounded-lg border bg-card p-4 shadow-sm" role="search" onSubmit={handleSubmit}>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <label className="grid gap-1 text-sm font-medium">
            Query
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                aria-label="Search PRDs"
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
                placeholder="Search product requirements"
                role="searchbox"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <fieldset className="flex rounded-md border p-1">
              <legend className="sr-only">Search mode</legend>
              <label className="flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm has-[:checked]:bg-secondary">
                <input
                  checked={mode === 'semantic'}
                  className="sr-only"
                  name="search-mode"
                  type="radio"
                  value="semantic"
                  onChange={() => setMode('semantic')}
                />
                Semantic
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-sm has-[:checked]:bg-secondary">
                <input
                  checked={mode === 'keyword'}
                  className="sr-only"
                  name="search-mode"
                  type="radio"
                  value="keyword"
                  onChange={() => setMode('keyword')}
                />
                Keyword
              </label>
            </fieldset>
            <button
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60"
              disabled={searchQuery.isFetching || query.trim().length === 0}
              type="submit"
            >
              {searchQuery.isFetching ? 'Searching' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {searchQuery.isFetching ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching PRDs.
        </p>
      ) : null}

      {searchQuery.data && !searchQuery.isFetching ? (
        <p className="text-sm text-muted-foreground">
          Showing {results.length} of {searchQuery.data.count} {searchQuery.data.count === 1 ? 'result' : 'results'}
          {statusFilter !== STATUS_FILTER_ALL ? <span className="capitalize"> ({statusFilter})</span> : null}
        </p>
      ) : null}

      {!searchQuery.isFetching && allResults.length > 0 && statuses.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
          <button
            type="button"
            aria-pressed={statusFilter === STATUS_FILTER_ALL}
            onClick={() => setStatusFilter(STATUS_FILTER_ALL)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              statusFilter === STATUS_FILTER_ALL
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary',
            )}
          >
            All {allResults.length}
          </button>
          {statuses.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors',
                statusFilter === status
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
            >
              {status} {statusCounts.get(status)}
            </button>
          ))}
        </div>
      ) : null}

      {searchQuery.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not search PRDs.
        </p>
      ) : null}

      {showExamples ? (
        <EmptyState
          icon={FileSearch}
          title="Search the PRD library"
          description="Ask in plain language or jump in with one of these:"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_QUERIES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => fillAndSearch(example)}
                  className="rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          }
        />
      ) : null}

      {canShowSemanticEmpty ? (
        <EmptyState
          icon={SearchX}
          title={`No matches for "${submittedSearch?.q ?? ''}"`}
          description="No PRD covers this. Try keyword mode or broaden the query with fewer, more general terms."
        />
      ) : null}

      {canShowKeywordEmpty ? (
        <EmptyState
          icon={SearchX}
          title={`No matches for "${submittedSearch?.q ?? ''}"`}
          description="No PRDs found. Try a broader keyword or fewer terms."
        />
      ) : null}

      {results.length > 0 ? (
        <div className="grid gap-4">
          {results.map((result, index) => {
            const isActive = index === cursor;
            return (
              <article
                key={result.id}
                ref={(node) => {
                  resultRefs.current[index] = node;
                }}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition-shadow',
                  isActive ? 'ring-2 ring-ring ring-offset-2 ring-offset-background' : null,
                )}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{highlight(result.title, terms)}</h2>
                    <p className="mt-2 text-sm text-muted-foreground">{highlight(result.summary, terms)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                      {result.status}
                    </span>
                    {activeMode === 'semantic' && typeof result.score === 'number' ? (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                        Score {formatScore(result.score)}
                      </span>
                    ) : null}
                  </div>
                </div>

                {result.snippet ? (
                  <blockquote className="mt-4 rounded-md border-l-4 bg-muted p-3 text-sm text-muted-foreground">
                    {highlight(result.snippet, terms)}
                  </blockquote>
                ) : null}

                {result.tags.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {result.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-4 text-sm font-medium">
                  <button
                    type="button"
                    onClick={() => navigate(`/library/${result.id}`)}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    Open
                  </button>
                  {result.source_url ? (
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" href={result.source_url} rel="noreferrer" target="_blank">
                      Source <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                  {result.obsidian_link ? (
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" href={result.obsidian_link} rel="noreferrer" target="_blank">
                      Obsidian <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
