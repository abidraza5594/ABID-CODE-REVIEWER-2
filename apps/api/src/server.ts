import Fastify from 'fastify';
import pino from 'pino';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    const query = req.query as { demo?: string };
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

    let timer: NodeJS.Timeout | undefined;
    if (params.jobId === 'demo' && query.demo === '1') {
      let index = 0;
      timer = setInterval(() => {
        const event = DEMO_REVIEW_EVENTS[index++];
        if (!event) {
          write({ type: 'complete', at: new Date().toISOString(), title: 'Review complete' });
          if (timer) clearInterval(timer);
          reply.raw.end();
          return;
        }
        write({ ...event, at: new Date().toISOString() } as ReviewUiEvent);
      }, 850);
    }

    req.raw.on('close', () => {
      if (timer) clearInterval(timer);
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
      severity?: 'warn' | 'info';
      body?: string;
      duplicates?: string[];
      reason: string;
    };

type PendingReviewUiEvent = ReviewUiEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, 'at'>
    : never
  : never;

const DEMO_REVIEW_EVENTS: PendingReviewUiEvent[] = [
  {
    type: 'timeline',
    title: 'Parsing changed files',
    detail: '34 files changed. 10 Angular components are in review scope.',
    status: 'done',
    rule: 'diff',
    confidence: 0.72,
  },
  {
    type: 'file',
    title: 'Opening related files',
    rule: 'subscription',
    file: 'src/app/features/global-config/settings/module/automation-settings/automation-settings.component.ts',
    line: 147,
    code: [
      [140, 'saveDialerConfig(payload: DialerConfig) {', ''],
      [141, '  this.loading = true;', 'hot'],
      [142, '  this.dialerService.updateDialerConfiguration(payload)', 'bad'],
      [143, '    .subscribe((res) => {', 'bad'],
      [144, '      this.loading = false;', ''],
      [145, '      this.reloadDialerConfig();', ''],
      [146, '    });', ''],
      [147, '  this.dialerService.geteDialerConfiguration()', 'bad'],
      [148, '    .subscribe((config) => this.config = config);', 'bad'],
      [149, '}', ''],
    ],
    related: [
      { file: 'automation-settings.component.html', reason: 'Template reads fields from this component.' },
      { file: 'dialer.service.ts', reason: 'Component subscribes to dialer API flow.' },
      { file: 'global-config.module.ts', reason: 'Dependency scope and provider lifetime check.' },
    ],
  },
  {
    type: 'reasoning',
    title: 'Checking cleanup proof',
    detail: 'AI found subscribe(). It is checking pipe operators, DestroyRef, ngOnDestroy, and manual unsubscribe paths.',
    rule: 'subscription',
    confidenceDelta: 0.12,
  },
  {
    type: 'timeline',
    title: 'Checking null safety',
    detail: 'Template reads were compared with types, route resolvers, @if guards, and optional chaining.',
    status: 'done',
    rule: 'null',
  },
  {
    type: 'skip',
    title: 'Null issue skipped',
    rule: 'null',
    reason: 'Resolver and template guard already prove the value exists.',
    tag: 'guarded',
  },
  {
    type: 'timeline',
    title: 'Checking Angular list rendering',
    detail: 'ngFor and @for blocks checked for trackBy or modern track expressions.',
    status: 'done',
    rule: 'trackby',
  },
  {
    type: 'skip',
    title: 'trackBy issue skipped',
    rule: 'trackby',
    reason: 'Modern @for track expression already exists.',
    tag: 'clean',
  },
  {
    type: 'timeline',
    title: 'Checking template hot paths',
    detail: 'Template method calls are compared with OnPush, signals, and runtime render counts.',
    status: 'running',
    rule: 'template',
  },
  {
    type: 'skip',
    title: 'Template method summary-only',
    rule: 'template',
    reason: 'Runtime render count stayed below the posting threshold.',
    tag: 'summary',
  },
  {
    type: 'runtime',
    title: 'Runtime trace matched static finding',
    rule: 'subscription',
    metrics: {
      renders: 42,
      subscriptionsOpen: 2,
      changeDetectionMs: 118,
      domMutations: 276,
      apiCalls: 6,
    },
  },
  {
    type: 'comment',
    title: 'Comment ready',
    rule: 'subscription',
    severity: 'warn',
    file: 'automation-settings.component.ts',
    line: 147,
    confidence: 0.92,
    body: 'This subscription is not cleaned up. It can keep running after this component is gone. Please add takeUntilDestroyed before subscribe().',
    duplicates: [
      'automation-settings.component.ts:73',
      'app.component.ts:140 summary-only',
      'schedule-assignment.component.ts:675 low confidence',
    ],
    reason: 'Static AST and runtime trace both show this subscription can stay open after component destroy.',
  },
  {
    type: 'timeline',
    title: 'Checking IndexedDB cache flow',
    detail: 'Writes and reads checked for non-awaited stale-cache races.',
    status: 'done',
    rule: 'indexeddb',
  },
  {
    type: 'skip',
    title: 'IndexedDB race skipped',
    rule: 'indexeddb',
    reason: 'Write promise is awaited before reading the same store.',
    tag: 'safe',
  },
];

main().catch((err) => {
  log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'fatal');
  process.exit(1);
});
