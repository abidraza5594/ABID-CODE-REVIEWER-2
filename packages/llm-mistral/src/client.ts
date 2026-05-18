/**
 * Mistral chat-completion client with the small set of features we need:
 *   - JSON-schema-constrained output (response_format: json_object + system instruction).
 *   - Streaming OFF (we always read complete responses for review).
 *   - Per-request `customer_id` tag for audit.
 *   - Retry with exponential backoff on 429 / 5xx.
 *   - Token-budget bookkeeping returned in metadata.
 *
 * We deliberately do not depend on a vendor SDK — the surface is tiny, and
 * not pulling a 5MB SDK keeps the orchestrator image lean. If Mistral ships
 * a thin official client we can swap.
 */
export interface MistralClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-tenant audit tag. */
  customerId?: string;
  /** Default chat model name, e.g. 'devstral-2512'. */
  model: string;
  /** Network fetch implementation; tests inject a mock. */
  fetch?: typeof globalThis.fetch;
  /** Max retries for transient failures. */
  maxRetries?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** Optional per-prompt model override. Defaults to the client model. */
  model?: string;
  messages: ChatMessage[];
  /** Optional JSON schema enforced server-side. */
  responseFormat?: 'json_object' | 'text';
  temperature?: number;
  maxTokens?: number;
  /** Used to make caching effective on idempotent prompts. */
  cacheKey?: string;
}

export interface ChatResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** Mistral request ID, recorded in audit log. */
  requestId: string;
}

export class MistralClient {
  private opts: Required<Pick<MistralClientOptions, 'baseUrl' | 'maxRetries' | 'fetch'>> & MistralClientOptions;

  /** Serializes ALL requests through this client.
   *
   * Why: Mistral's free tier limits to ~1 req/sec; even paid tiers throttle bursts.
   * Firing N requests in parallel (Promise.all) reliably triggers 429 storms that
   * exhaust retries. A single in-flight queue with a minimum spacing eliminates
   * this entire class of failure — at the cost of higher wall-clock for batches. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Minimum gap between consecutive completed requests, in milliseconds.
   *  Tuned for Mistral free tier (~1 req/sec). Override via env if your plan is fatter. */
  private readonly minSpacingMs: number;

  constructor(opts: MistralClientOptions) {
    this.opts = {
      baseUrl: 'https://api.mistral.ai',
      maxRetries: 5,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      ...opts,
    };
    const envSpacing = Number(process.env['MISTRAL_MIN_SPACING_MS']);
    this.minSpacingMs = Number.isFinite(envSpacing) && envSpacing > 0 ? envSpacing : 1100;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Build the request body. NOTE: we deliberately do NOT send `safe_prompt`
    // or `user` — those caused 422 "extra_forbidden" responses from the API.
    // The audit trail (customerId) is captured in our own logs, not the request.
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 1024,
    };
    if (req.responseFormat === 'json_object') {
      body['response_format'] = { type: 'json_object' };
    }
    if (req.cacheKey) {
      body['prompt_cache_key'] = req.cacheKey;
    }
    return this.enqueue(() => this.requestWithRetry('/v1/chat/completions', body));
  }

  async embed(texts: string[], model = 'codestral-embed'): Promise<number[][]> {
    const body = { model, input: texts };
    const res = await this.enqueue(() => this.requestWithRetry('/v1/embeddings', body));
    const parsed = JSON.parse(res.content) as { data: Array<{ embedding: number[] }> };
    return parsed.data.map((d) => d.embedding);
  }

  /** Chain a unit of work onto the serialization queue. Each call runs after
   *  the previous one settles, then waits `minSpacingMs` before releasing the
   *  next one. Failures don't poison the queue. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue
      .catch(() => undefined)
      .then(async () => {
        const result = await work();
        await sleep(this.minSpacingMs);
        return result;
      });
    this.queue = next;
    return next;
  }

  private async requestWithRetry(path: string, body: unknown): Promise<ChatResponse> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        return await this.requestOnce(path, body);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
        // For 429s, respect Retry-After header when present, otherwise use
        // exponential backoff with a higher base than 5xx (rate limits need
        // real time to reset).
        const wait = computeBackoff(err, attempt);
        await sleep(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('mistral: retries exhausted');
  }

  private async requestOnce(path: string, body: unknown): Promise<ChatResponse> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: RetriableError = new Error(`mistral ${res.status}: ${text.slice(0, 200)}`) as RetriableError;
      err.status = res.status;
      const ra = res.headers.get('retry-after');
      if (ra) {
        const secs = Number(ra);
        if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
      }
      throw err;
    }
    const json = (await res.json()) as MistralChatResponse;
    const requestId = res.headers.get('x-request-id') ?? 'unknown';
    if (path.includes('/embeddings')) {
      return { content: JSON.stringify(json), promptTokens: 0, completionTokens: 0, requestId };
    }
    const choice = json.choices?.[0]?.message?.content ?? '';
    return {
      content: choice,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      requestId,
    };
  }
}

interface MistralChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface RetriableError extends Error {
  status?: number;
  retryAfterMs?: number;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const s = (err as RetriableError).status;
  if (s === undefined) return true; // network errors
  return s === 429 || (s >= 500 && s < 600);
}

function computeBackoff(err: unknown, attempt: number): number {
  const e = err as RetriableError;
  if (e.retryAfterMs && e.retryAfterMs > 0) {
    // Server told us how long to wait — honor it with a tiny jitter.
    return e.retryAfterMs + Math.random() * 200;
  }
  // 429-aware exponential: start at 2s, double, cap at 30s. Plus jitter.
  if (e.status === 429) {
    const base = Math.min(30_000, 2000 * Math.pow(2, attempt));
    return jitter(base);
  }
  // 5xx: shorter backoff.
  const base = Math.min(8000, 250 * Math.pow(2, attempt));
  return jitter(base);
}

function jitter(base: number): number {
  return base * (0.5 + Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
