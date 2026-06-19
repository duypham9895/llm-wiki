// The llm: block B owns (A preserves it value-for-value across re-syncs).
export interface LlmFields {
  summary: string | null;
  tags: string[];
  related: string[];      // ["[[EP-...-slug]]", ...]
  enriched_at?: string;   // ISO-8601, B bookkeeping
  body_hash?: string;     // sha256 of the body B enriched from
  extra?: Record<string, unknown>; // unknown llm keys preserved round-trip
}

// What summarize produces (validated LLM output, pre-normalization for tags).
export interface Summary {
  summary: string;
  tags: string[];
}

// What the LLM judge returns for a candidate pair.
export interface Verdict {
  related: boolean;
  reason: string;
}

// One PRD file loaded into memory for enrichment.
export interface DocRecord {
  path: string;           // absolute path to the .md
  stem: string;           // filename without .md, used to build the wikilink
  syncRaw: unknown;       // the parsed `sync` object (kept verbatim on write)
  llm: LlmFields;         // current llm block (may be empty)
  body: string;           // markdown body after frontmatter
  bodyHash: string;       // sha256(body)
  // frontmatter fields the distiller/overlap need, lifted from syncRaw:
  title: string;
  shortSummary: string | null;
  status: string | null;
  platform: string[];
  strategicGoal: string[];
}

export interface EnrichConfig {
  apiKey: string;
  baseUrl: string;        // e.g. https://api.minimax.io/v1
  model: string;          // e.g. MiniMax-M2 (confirm exact string)
  vaultPath: string;
  topK: number;           // related candidates per doc (default 5)
  distillThreshold: number; // bytes; bodies larger than this get distilled (default 8000)
  sectionHeadChars: number; // chars kept under each heading when distilling (default 200)
  llmTimeoutMs: number;   // per-call wall-clock (default 60000)
  maxRetries: number;     // default 3
}
