import type { RuntimeScenario, RuntimeTrace, SubscriptionEvent } from '@abid/core';
import { ulid } from '@abid/core';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AbidCdp } from './cdp-session.js';
import { INSTRUMENTATION_BUNDLE } from './instrumentation-bundle.js';

/**
 * Run one scenario end-to-end. The caller is responsible for:
 *   - launching the browser (we don't manage browser lifecycle here so we can
 *     reuse warm browser instances)
 *   - persisting heap snapshots / large trace artifacts to object storage
 *
 * The function returns the structured RuntimeTrace. Subscription metrics
 * are reconstructed from `__abidPostMetric` events buffered on `window.__abidEvents`.
 */
export interface RunScenarioOptions {
  browser: Browser;
  baseUrl: string;
  scenario: RuntimeScenario;
  /** Sink for heap-snapshot chunks. Called per snapshot, per chunk. */
  onHeapChunk: (snapshotId: string, chunk: string) => Promise<void> | void;
  /** Hook to run the scenario's actual user actions. The runtime-runner app
   *  loads the scenario's script module and passes the function here. */
  performActions: (page: Page) => Promise<void>;
}

export async function runScenario(opts: RunScenarioOptions): Promise<RuntimeTrace> {
  const traceId = ulid();
  const startedAt = new Date().toISOString();
  const ctx: BrowserContext = await opts.browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  await ctx.addInitScript({
    content: `
      window.__abidEvents = [];
      window.__abidPostMetric = function(kind, payload) {
        window.__abidEvents.push({ kind: kind, payload: payload, t: performance.now() });
      };
      ${INSTRUMENTATION_BUNDLE}
    `,
  });

  const consoleErrors: string[] = [];
  const heapSnapshotIds: string[] = [];
  const networkCounts = new Map<string, { method: string; count: number }>();
  const longTasks: RuntimeTrace['longTasks'] = [];

  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const cdp = await AbidCdp.attach(page);
  const unsubNet = cdp.onRequest((e) => {
    const k = `${e.method} ${e.url}`;
    const cur = networkCounts.get(k);
    if (cur) cur.count += 1;
    else networkCounts.set(k, { method: e.method, count: 1 });
  });

  try {
    // Baseline heap.
    const baseSnap = ulid();
    await cdp.takeHeapSnapshot((chunk) => opts.onHeapChunk(baseSnap, chunk));
    heapSnapshotIds.push(baseSnap);

    await page.goto(opts.baseUrl, { waitUntil: 'networkidle' });

    for (let iter = 0; iter < opts.scenario.iterations; iter++) {
      await opts.performActions(page);
    }

    // Final heap.
    const endSnap = ulid();
    await cdp.takeHeapSnapshot((chunk) => opts.onHeapChunk(endSnap, chunk));
    heapSnapshotIds.push(endSnap);

    await page.evaluate(() => {
      const w = window as unknown as { __abidFlushSummary?: () => void };
      w.__abidFlushSummary?.();
    }).catch(() => undefined);

    // Drain instrumentation buffer.
    const events = (await page.evaluate(() => (window as unknown as { __abidEvents: RuntimePageEvent[] }).__abidEvents)) ?? [];

    // Build runtime event slices.
    const subs: SubscriptionEvent[] = [];
    const openMap = new Map<number, { openedAtMs: number; stack: string }>();
    const renderCounts: Record<string, number> = {};
    const changeDetection: RuntimeTrace['changeDetection'] = {};
    const signalUpdates: Record<string, number> = {};
    for (const e of events) {
      if (e.kind === 'subscription.open') {
        const p = e.payload as { id: number; openedAt: number; stack: string };
        openMap.set(p.id, { openedAtMs: p.openedAt, stack: p.stack });
      } else if (e.kind === 'subscription.close') {
        const p = e.payload as { id: number; closedAt: number };
        const o = openMap.get(p.id);
        if (o) {
          const sub: SubscriptionEvent = {
            id: String(p.id),
            openedAtMs: o.openedAtMs,
            closedAtMs: p.closedAt,
            leaked: false,
          };
          const sourceLocation = extractSourceLocation(o.stack);
          if (sourceLocation) sub.sourceLocation = sourceLocation;
          subs.push(sub);
          openMap.delete(p.id);
        }
      } else if (e.kind === 'cd.tick') {
        const p = e.payload as { durationMs?: number; duration?: number };
        const duration = finiteNumber(p.durationMs ?? p.duration) ?? 0;
        const cur = changeDetection['__app__'] ?? { cycles: 0, totalMs: 0 };
        cur.cycles += 1;
        cur.totalMs += duration;
        changeDetection['__app__'] = cur;
      } else if (e.kind === 'longtask') {
        const p = e.payload as { url?: string; startMs?: number; durationMs?: number };
        const duration = finiteNumber(p.durationMs);
        const startMs = finiteNumber(p.startMs);
        if (duration !== undefined && duration >= 50 && startMs !== undefined) {
          longTasks.push({ url: p.url ?? page.url(), startMs, durationMs: duration });
        }
      } else if (e.kind === 'render.mutation') {
        const p = e.payload as { count?: number };
        renderCounts['__dom__'] = Math.max(renderCounts['__dom__'] ?? 0, finiteNumber(p.count) ?? 0);
      } else if (e.kind === 'signal.update') {
        const p = e.payload as { name?: string; count?: number };
        const key = p.name || '__unknown__';
        signalUpdates[key] = (signalUpdates[key] ?? 0) + (finiteNumber(p.count) ?? 1);
      }
    }
    for (const [id, o] of openMap) {
      const sub: SubscriptionEvent = {
        id: String(id),
        openedAtMs: o.openedAtMs,
        leaked: true,
      };
      const sourceLocation = extractSourceLocation(o.stack);
      if (sourceLocation) sub.sourceLocation = sourceLocation;
      subs.push(sub);
    }

    unsubNet();
    await cdp.detach();
    await ctx.close();

    return {
      id: traceId,
      scenarioId: opts.scenario.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      heapSnapshots: heapSnapshotIds,
      renderCounts,
      changeDetection,
      subscriptions: subs,
      signalUpdates,
      longTasks,
      networkRequests: [...networkCounts.entries()].map(([k, v]) => ({
        url: k.slice(v.method.length + 1),
        method: v.method,
        count: v.count,
      })),
      ok: true,
      consoleErrors,
    };
  } catch (err) {
    unsubNet();
    await cdp.detach().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    return {
      id: traceId,
      scenarioId: opts.scenario.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      heapSnapshots: heapSnapshotIds,
      renderCounts: {},
      changeDetection: {},
      subscriptions: [],
      signalUpdates: {},
      longTasks: [],
      networkRequests: [],
      ok: false,
      consoleErrors: consoleErrors.concat(String((err as Error).message ?? err)),
    };
  }
}

interface RuntimePageEvent {
  kind: string;
  payload: unknown;
  t: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractSourceLocation(stack: string): SubscriptionEvent['sourceLocation'] | undefined {
  for (const line of stack.split('\n')) {
    const match = /\(?((?:webpack:\/\/\/|ng:\/\/\/|file:\/\/\/)?[^():]+\.ts):(\d+):(\d+)\)?/.exec(line.trim());
    if (!match) continue;
    const file = match[1]!.replace(/^webpack:\/\/\//, '').replace(/^ng:\/\/\//, '').replace(/^file:\/\/\//, '');
    const lineNo = Number(match[2]);
    if (!Number.isFinite(lineNo)) continue;
    return { file: file.replace(/\\/g, '/'), line: lineNo };
  }
  return undefined;
}
