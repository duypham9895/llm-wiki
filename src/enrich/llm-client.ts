import { withDeadline } from '../timeout.js';

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface LlmClient {
  chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Extract the first JSON object from a model response (tolerates ```json fences / prose).
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in response');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function makeLlmClient(cfg: {
  apiKey: string; baseUrl: string; model: string; llmTimeoutMs: number; maxRetries: number;
  fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void>;
}): LlmClient {
  const fetchFn = cfg.fetchFn ?? fetch;
  const sleepFn = cfg.sleepFn ?? defaultSleep;

  async function callOnce(messages: ChatMessage[]): Promise<unknown> {
    const res = (await withDeadline(
      fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2 }),
      }),
      cfg.llmTimeoutMs,
      'llm chat',
    )) as Response;
    if (!res.ok) {
      const e: any = new Error(`llm http ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    return extractJson(content);
  }

  return {
    async chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T> {
      let attempt = 0;
      let msgs = messages;
      for (;;) {
        try {
          const parsed = await callOnce(msgs);
          if (opts.validate(parsed)) return parsed;
          throw new Error(`validation failed: ${opts.label}`);
        } catch (err: any) {
          const status = err?.status;
          const httpRetriable = status === 429 || (typeof status === 'number' && status >= 500);
          const contentRetriable = !status; // parse/validate failure
          if (attempt >= cfg.maxRetries || (!httpRetriable && !contentRetriable)) throw err;
          if (contentRetriable) {
            msgs = [...messages, { role: 'user', content: 'Your previous reply was not valid JSON matching the requested schema. Reply with ONLY the JSON object.' }];
          }
          await sleepFn(Math.min(2 ** attempt * 300, 5000));
          attempt++;
        }
      }
    },
  };
}
