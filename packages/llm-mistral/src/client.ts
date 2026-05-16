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
  /** Default chat model name, e.g. 'mistral-large-latest'. */
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

  constructor(opts: MistralClientOptions) {
    this.opts = {
      baseUrl: 'https://api.mistral.ai',
      maxRetries: 3,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      ...opts,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 1024,
    };
    if (req.responseFormat === 'json_object') {
      body['response_format'] = { type: 'json_object' };
    }
    if (this.opts.customerId) {
      body['safe_prompt'] = false; // we manage our own safety
      body['user'] = this.opts.customerId;
    }
    return this.requestWithRetry('/v1/chat/completions', body);
  }

  async embed(texts: string[], model = 'mistral-embed'): Promise<number[][]> {
    const body = { model, input: texts };
    const res = await this.requestWithRetry('/v1/embeddings', body);
    // The response shape for embeddings differs — we re-parse the underlying JSON.
    const parsed = JSON.parse(res.content) as { data: Array<{ embedding: number[] }> };
    return parsed.data.map((d) => d.embedding);
  }

  private async requestWithRetry(path: string, body: unknown): Promise<ChatResponse> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        return await this.requestOnce(path, body);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
        const wait = jitter(Math.min(8000, 250 * Math.pow(2, attempt)));
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
      const err: RetriableError = new Error(`mistral ${res.status}: ${text}`) as RetriableError;
      err.status = res.status;
      throw err;
    }
    const json = (await res.json()) as MistralChatResponse;
    const requestId = res.headers.get('x-request-id') ?? 'unknown';
    if (path.includes('/embeddings')) {
      // Caller will re-parse; expose raw JSON in `content`.
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
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const s = (err as RetriableError).status;
  if (s === undefined) return true; // network errors
  return s === 429 || (s >= 500 && s < 600);
}

function jitter(base: number): number {
  return base * (0.5 + Math.random());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
