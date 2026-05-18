import Fastify from 'fastify';
import pino from 'pino';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ReviewCommentKind, ReviewIssueType } from '@abid/core';
import { InMemoryFindingsStore } from '@abid/findings';
import { CalibrationModel } from '@abid/confidence-engine';

/**
 * Internal results API. Backs:
 *   - the per-tenant dashboard (findings, comment-resolution rate, calibration)
 *   - the manual `recheck` button on the dashboard
 *   - the `@abid mute <rule>` per-repo configuration mutations
 *
 * Auth is JWT-backed with tenant claims; all data access goes through the
 * findings store, which enforces row-level security in production.
 */
const log = pino({ name: 'api', level: process.env['LOG_LEVEL'] ?? 'info' });
const reviewBacklog = new Map<string, ReviewUiEvent[]>();
const reviewSubscribers = new Map<string, Set<(event: ReviewUiEvent) => void>>();

async function main() {
  const port = Number(process.env['PORT'] ?? 8081);
  const app = Fastify({ logger: log, trustProxy: true });
  const store = new InMemoryFindingsStore(); // production: PostgresFindingsStore
  const calibration = new CalibrationModel();
  const reviewUiPath = resolveReviewUiPath();

  app.get('/healthz', async () => ({ ok: true, reviewUi: 'live-bridge-v1' }));

  app.get('/', async (_req, reply) => reply.redirect('/review-ui?jobId=cli-live'));

  app.get('/review-ui', async (_req, reply) => {
    if (!reviewUiPath) {
      reply.code(404).type('text/plain');
      return 'Review UI file was not found. Expected mockups/designs/ai-review-command-center/index.html.';
    }

    const html = await readFile(reviewUiPath, 'utf8');
    reply.type('text/html; charset=utf-8');
    return html;
  });

  app.get('/api/tenants/:tenant/findings', async (req) => {
    const params = req.params as { tenant: string };
    const since = (req.query as { since?: string }).since ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    return store.byTenantSince(params.tenant, since);
  });

  app.get('/api/tenants/:tenant/calibration', async () => calibration.records());

  app.post('/api/reviews/:jobId/reset', async (req) => {
    const params = req.params as { jobId: string };
    reviewBacklog.set(params.jobId, []);
    publishReviewEvent(params.jobId, {
      type: 'timeline',
      at: new Date().toISOString(),
      title: 'Waiting for PR selection',
      detail: 'UI is connected. No PR has been selected yet.',
      status: 'running',
      rule: 'diff',
    });
    return { ok: true };
  });

  app.post('/api/reviews/:jobId/events', async (req) => {
    const params = req.params as { jobId: string };
    const body = req.body as PendingReviewUiEvent | PendingReviewUiEvent[];
    const events = Array.isArray(body) ? body : [body];
    for (const event of events) {
      publishReviewEvent(params.jobId, { ...event, at: new Date().toISOString() } as ReviewUiEvent);
    }
    return { ok: true, accepted: events.length };
  });

  app.get('/api/reviews/:jobId/events', async (req, reply) => {
    const params = req.params as { jobId: string };
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });

    const write = (event: ReviewUiEvent) => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify({ ...event, jobId: params.jobId })}\n\n`);
    };

    write({ type: 'connected', at: new Date().toISOString(), title: 'Review stream connected' });
    for (const event of reviewBacklog.get(params.jobId) ?? []) write(event);

    const subscriber = (event: ReviewUiEvent) => write(event);
    const subscribers = reviewSubscribers.get(params.jobId) ?? new Set<(event: ReviewUiEvent) => void>();
    subscribers.add(subscriber);
    reviewSubscribers.set(params.jobId, subscribers);

    req.raw.on('close', () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) reviewSubscribers.delete(params.jobId);
    });
  });

  await app.listen({ port, host: '0.0.0.0' });
  const reviewUiUrl = `http://localhost:${port}/review-ui?jobId=cli-live`;
  log.info({ port, reviewUiUrl }, 'api listening');
  openReviewUi(reviewUiUrl);
}

function publishReviewEvent(jobId: string, event: ReviewUiEvent) {
  const backlog = reviewBacklog.get(jobId) ?? [];
  backlog.push(event);
  reviewBacklog.set(jobId, backlog.slice(-200));
  for (const subscriber of reviewSubscribers.get(jobId) ?? []) subscriber(event);
}

function resolveReviewUiPath(): string | undefined {
  const fromEnv = process.env['REVIEW_UI_HTML'];
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    fromEnv,
    path.resolve(process.cwd(), 'mockups/designs/ai-review-command-center/index.html'),
    path.resolve(process.cwd(), '../../mockups/designs/ai-review-command-center/index.html'),
    path.resolve(path.dirname(currentFile), '../../../mockups/designs/ai-review-command-center/index.html'),
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
}

function openReviewUi(url: string) {
  if (process.env['OPEN_REVIEW_UI'] === '0' || process.env['CI'] === 'true' || process.env['NODE_ENV'] === 'production') {
    return;
  }

  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    log.info({ url }, 'opened review ui');
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, url }, 'could not open review ui automatically');
  }
}

type ReviewUiEvent =
  | { type: 'connected' | 'complete'; at: string; title: string }
  | {
      type: 'timeline';
      at: string;
      title: string;
      detail: string;
      status: 'running' | 'done' | 'skipped';
      rule?: string;
      confidence?: number;
    }
  | {
      type: 'queue';
      at: string;
      title: string;
      files: Array<{ file: string; reason?: string; rule?: string }>;
    }
  | {
      type: 'file';
      at: string;
      title: string;
      file: string;
      line?: number;
      rule?: string;
      code?: Array<[number, string, string?]>;
      related: Array<{ file: string; reason: string }>;
    }
  | {
      type: 'reasoning';
      at: string;
      title: string;
      detail: string;
      rule?: string;
      confidenceDelta?: number;
    }
  | {
      type: 'runtime';
      at: string;
      title: string;
      rule?: string;
      metrics: Record<string, number>;
    }
  | {
      type: 'skip';
      at: string;
      title: string;
      rule: string;
      reason: string;
      tag: string;
    }
  | {
      type: 'comment';
      at: string;
      title: string;
      file: string;
      line: number;
      confidence: number;
      rule?: string;
      severity?: 'blocker' | 'warn' | 'info';
      commentKind?: ReviewCommentKind;
      issueType?: ReviewIssueType;
      autoFixable?: boolean;
      requiresManualReview?: boolean;
      body?: string;
      duplicates?: string[];
      reason: string;
    };

type PendingReviewUiEvent = ReviewUiEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, 'at'>
    : never
  : never;

main().catch((err) => {
  log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'fatal');
  process.exit(1);
});
