import { type FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, Search } from 'lucide-react';

import { apiFetch } from '../lib/api';

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

function buildSearchPath(search: SubmittedSearch) {
  const params = new URLSearchParams({ q: search.q, mode: search.mode, k: String(search.k) });
  return `/prd/search?${params.toString()}`;
}

function formatScore(score: number) {
  return `${Math.min(100, Math.max(0, Math.round(score * 100)))}%`;
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('semantic');
  const [submittedSearch, setSubmittedSearch] = useState<SubmittedSearch | null>(null);

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
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    setSubmittedSearch({ q: trimmedQuery, mode, k: RESULT_LIMIT });
  }

  const activeMode = submittedSearch?.mode ?? mode;
  const isSemanticNoMatch =
    activeMode === 'semantic' &&
    searchQuery.data !== undefined &&
    (searchQuery.data.verdict === 'no_match' || searchQuery.data.count === 0);
  const results = isSemanticNoMatch ? [] : (searchQuery.data?.results ?? []);
  const canShowKeywordEmpty = activeMode === 'keyword' && searchQuery.data !== undefined && results.length === 0;
  const canShowSemanticEmpty = isSemanticNoMatch;

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
        </p>
      ) : null}

      {searchQuery.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Could not search PRDs.
        </p>
      ) : null}

      {canShowSemanticEmpty ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="text-lg font-semibold">No PRD covers this.</h2>
          <p className="mt-2 text-sm text-muted-foreground">Try keyword mode or revise the query.</p>
        </div>
      ) : null}

      {canShowKeywordEmpty ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <h2 className="text-lg font-semibold">No PRDs found.</h2>
          <p className="mt-2 text-sm text-muted-foreground">Try a broader keyword.</p>
        </div>
      ) : null}

      {results.length > 0 ? (
        <div className="grid gap-4">
          {results.map((result) => (
            <article key={result.id} className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{result.title}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{result.summary}</p>
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
                  {result.snippet}
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
          ))}
        </div>
      ) : null}
    </section>
  );
}
