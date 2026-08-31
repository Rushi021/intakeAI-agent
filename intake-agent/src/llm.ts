/**
 * LLM access.
 *
 * Mistral is wired; Gemini and a local Ollama slot in as further entries in
 * PROVIDERS. Everything above this file talks to `chat()` and knows nothing
 * about who answers.
 *
 * ponytail: @llamaindex/mistral bundles to 7.1 MB for what is one POST. If the
 * tool-calling loop ever outgrows this, LlamaIndex.TS drops in behind `chat()`
 * without changing a caller.
 */
export type Provider = 'mistral';
export type Role = 'system' | 'user' | 'assistant';
export type Msg = { role: Role; content: string };
export type Config = { provider: Provider; model: string; apiKey: string };
export type Reply = { text: string; inputTokens: number; outputTokens: number };

type Spec = {
  label: string;
  endpoint: string;
  models: string[];
  /** Never interpolate the key into a URL — it lands in logs and history. */
  headers: (key: string) => Record<string, string>;
  body: (cfg: Config, msgs: Msg[], opts: ChatOptions) => object;
  parse: (json: any) => Reply;
};

export type ChatOptions = {
  /** Ask for a JSON object back. Set when the caller will parse the reply. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export const PROVIDERS: Record<Provider, Spec> = {
  mistral: {
    label: 'Mistral AI',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: (cfg, msgs, opts) => ({
      model: cfg.model,
      messages: msgs,
      // Deterministic by default: the same screen should produce the same
      // decision twice, and a build is not a place for creativity.
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    parse: (json) => ({
      text: json?.choices?.[0]?.message?.content ?? '',
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    }),
  },
};

/**
 * Configuration comes from `.env` at build time, and from nowhere else.
 *
 *   VITE_MISTRAL_API_KEY=...      required
 *   VITE_MISTRAL_MODEL=...        optional, defaults below
 *
 * Vite inlines these into dist/, so the built extension is self-contained and
 * the reviewer's only setup step is `cp .env.example .env`, paste, build.
 *
 * The trade-off is stated in the README: a build-time key is plaintext inside
 * the artefact. `.env` and `dist/` are both gitignored; use a revocable key.
 *
 * Undefined outside a Vite build, so the tests see empty values.
 */
const ENV = (import.meta as { env?: Record<string, string> }).env ?? {};

export const CONFIG: Config = {
  provider: 'mistral',
  model: ENV.VITE_MISTRAL_MODEL || 'mistral-large-latest',
  apiKey: ENV.VITE_MISTRAL_API_KEY || '',
};

/** Whether this build has a key, for the UI to report. Never the key itself. */
export const hasKey = (): boolean => CONFIG.apiKey !== '';

// ── The one call everything else uses ───────────────────────────────────────

export async function chat(msgs: Msg[], opts: ChatOptions = {}, cfg: Config = CONFIG): Promise<Reply> {
  const spec = PROVIDERS[cfg.provider];
  if (!cfg.apiKey) {
    throw new Error(
      `No ${spec.label} API key. Copy .env.example to .env, set VITE_MISTRAL_API_KEY, then re-run \`npm run build\`.`,
    );
  }

  const res = await fetch(spec.endpoint, {
    method: 'POST',
    headers: spec.headers(cfg.apiKey),
    body: JSON.stringify(spec.body(cfg, msgs, opts)),
    // A hung request must not stall a build. AbortSignal.timeout is stdlib.
    signal: opts.signal ?? AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(await describe(res, spec.label));
  return spec.parse(await res.json());
}

/** Readable failures, and never an echo of the key. */
async function describe(res: Response, label: string): Promise<string> {
  const detail = await res.text().catch(() => '');
  const msg = detail.slice(0, 300);
  if (res.status === 401 || res.status === 403) return `${label} rejected the API key (${res.status}).`;
  if (res.status === 429) return `${label} rate limit hit (429). Wait, or use a smaller model.`;
  return `${label} error ${res.status}${msg ? `: ${msg}` : ''}`;
}

/** Cheapest possible round trip, to prove the key works before a long run. */
export async function testConnection(cfg: Config = CONFIG): Promise<Reply> {
  return chat([{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 8 }, cfg);
}
