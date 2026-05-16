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

    // Drain instrumentation buffer.
    const events = (await page.evaluate(() => (window as unknown as { __abidEvents: Array<{ kind: string; payload: unknown; t: number }> }).__abidEvents)) ?? [];

    // Build subscription event list.
    const subs: SubscriptionEvent[] = [];
    const openMap = new Map<number, { openedAtMs: number; stack: string }>();
    for (const e of events) {
      if (e.kind === 'subscription.open') {
        const p = e.payload as { id: number; openedAt: number; stack: string };
        openMap.set(p.id, { openedAtMs: p.openedAt, stack: p.stack });
      } else if (e.kind === 'subscription.close') {
        const p = e.payload as { id: number; closedAt: number };
        const o = openMap.get(p.id);
        if (o) {
          subs.push({
            id: String(p.id),
            openedAtMs: o.openedAtMs,
            closedAtMs: p.closedAt,
            leaked: false,
          });
          openMap.delete(p.id);
        }
      }
    }
    for (const [id, o] of openMap) {
      subs.push({ id: String(id), openedAtMs: o.openedAtMs, leaked: true });
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
      renderCounts: {},          // populated by Angular profiler bridge — empty if unavailable
      changeDetection: {},       // populated by Angular profiler bridge
      subscriptions: subs,
      signalUpdates: {},         // optional bridge
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
