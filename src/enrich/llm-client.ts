import { withDeadline } from '../timeout.js';

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface LlmClient {
  chatJSON<T>(messages: ChatMessage[], opts: { validate: (v: unknown) => v is T; label: string }): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Extract the first JSON object from a model response (tolerates ```json fences / prose).
// Throws an error tagged with contentInvalid=true when the content cannot be parsed,
// so the retry classifier can distinguish parse failures from infra/timeout errors.
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    const e: any = new Error('no JSON object in response');
    e.contentInvalid = true;
    throw e;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (parseErr: any) {
    const e: any = new Error('JSON parse error: ' + parseErr.message);
    e.contentInvalid = true;
    throw e;
  }
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
        body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, stream: false }),
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
          // Validation failure: tag it so the classifier treats it as a content failure.
          const ve: any = new Error(`validation failed: ${opts.label}`);
          ve.contentInvalid = true;
          throw ve;
        } catch (err: any) {
          const status = err?.status;
          const httpRetriable = status === 429 || (typeof status === 'number' && status >= 500);
          const contentRetriable = err?.contentInvalid === true; // ONLY explicitly tagged parse/validation failures
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
