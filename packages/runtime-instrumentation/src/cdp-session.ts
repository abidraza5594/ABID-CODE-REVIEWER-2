import type { CDPSession, Page } from 'playwright';

/**
 * Helper that bundles the CDP domains we need (Performance, HeapProfiler,
 * Network) for one page session. Wraps the cross-domain bookkeeping so the
 * scenario runner only has to call high-level methods.
 */
export class AbidCdp {
  private session!: CDPSession;

  static async attach(page: Page): Promise<AbidCdp> {
    const cdp = page.context().newCDPSession ? await page.context().newCDPSession(page) : (await (page as unknown as { context(): { newCDPSession: (p: Page) => Promise<CDPSession> } }).context().newCDPSession(page));
    const inst = new AbidCdp();
    inst.session = cdp;
    await Promise.all([
      cdp.send('Performance.enable'),
      cdp.send('HeapProfiler.enable'),
      cdp.send('Network.enable'),
      cdp.send('Runtime.enable'),
    ]);
    return inst;
  }

  /** Capture a heap snapshot. Returns a stream of chunks the runner persists. */
  async takeHeapSnapshot(onChunk: (chunk: string) => void): Promise<void> {
    const handler = (params: { chunk: string }) => onChunk(params.chunk);
    this.session.on('HeapProfiler.addHeapSnapshotChunk', handler);
    try {
      await this.session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      this.session.off('HeapProfiler.addHeapSnapshotChunk', handler);
    }
  }

  /** Read perf counters. The runner subtracts a baseline to attribute work. */
  async getMetrics(): Promise<Array<{ name: string; value: number }>> {
    const res = (await this.session.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
    return res.metrics;
  }

  /** Subscribe to network events; the listener is fired for each request. */
  onRequest(handler: (e: { url: string; method: string }) => void): () => void {
    const wrapped = (params: { request: { url: string; method: string } }) => handler(params.request);
    this.session.on('Network.requestWillBeSent', wrapped);
    return () => this.session.off('Network.requestWillBeSent', wrapped);
  }

  /** Subscribe to long tasks (>50ms) via Performance domain. */
  onLongTask(handler: (e: { url: string; startMs: number; durationMs: number }) => void): () => void {
    // Chromium exposes long tasks via Performance.timeline; we use Runtime.evaluate
    // to subscribe within the page via PerformanceObserver, then bridge via
    // window.__abidPostMetric. The instrumentation bundle already collects
    // measures; this method routes the bridge.
    const wrapped = (params: { args: Array<{ value?: unknown }> }) => {
      const arg = params.args[0]?.value;
      if (typeof arg !== 'string') return;
      try {
        const parsed = JSON.parse(arg) as { kind: string; payload: { url?: string; startMs: number; durationMs: number } };
        if (parsed.kind !== 'longtask') return;
        handler({ url: parsed.payload.url ?? '', startMs: parsed.payload.startMs, durationMs: parsed.payload.durationMs });
      } catch {}
    };
    this.session.on('Runtime.consoleAPICalled', wrapped);
    return () => this.session.off('Runtime.consoleAPICalled', wrapped);
  }

  async detach(): Promise<void> {
    await this.session.detach();
  }
}
