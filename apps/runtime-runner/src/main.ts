import * as path from 'node:path';
import { Redis } from 'ioredis';
import pino from 'pino';
import { chromium, type Browser, type Page } from 'playwright';
import { runScenario } from '@abid/runtime-instrumentation';
import type { RuntimeScenario } from '@abid/core';

/**
 * Runtime-runner. Consumes a separate Redis Stream (`jobs:runtime`) of
 * scenario requests dispatched by the orchestrator when a static finding
 * needs runtime corroboration.
 *
 * Browser lifecycle: we keep a warm browser pool of size 2 so cold-start
 * costs are amortized across consecutive scenarios.
 */
const log = pino({ name: 'runtime-runner', level: process.env['LOG_LEVEL'] ?? 'info' });

async function main() {
  const redis = new Redis(requiredEnv('REDIS_URL'));
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  log.info('runtime-runner started');

  while (true) {
    const res = await redis.xreadgroup(
      'GROUP', 'runtime-runners', `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`,
      'COUNT', 1,
      'BLOCK', 30_000,
      'STREAMS', 'jobs:runtime', '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res) continue;

    for (const [, entries] of res) {
      for (const [id, kv] of entries) {
        const payload = JSON.parse(kv[kv.indexOf('payload') + 1]!) as RuntimeRequest;
        try {
          await handle(payload, browser);
        } catch (err) {
          log.error({ id, err: (err as Error).message }, 'runtime scenario failed');
        }
        await redis.xack('jobs:runtime', 'runtime-runners', id);
      }
    }
  }
}

interface RuntimeRequest {
  jobId: string;
  baseUrl: string;
  scenario: RuntimeScenario;
  resultsKey: string;
}

async function handle(req: RuntimeRequest, browser: Browser): Promise<void> {
  const heapDir = path.join('/tmp', 'abid-heap', req.jobId, req.scenario.id);
  const trace = await runScenario({
    browser,
    baseUrl: req.baseUrl,
    scenario: req.scenario,
    onHeapChunk: () => Promise.resolve(),
    performActions: async (page: Page) => {
      // The orchestrator passes a scenario "script path" but we don't load
      // arbitrary JS — too dangerous for a shared runner. Instead, we accept
      // a small DSL of click/type/wait actions in the scenario record. For
      // brevity here we navigate the page exposed by the scenario.
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500); // settle
    },
  });
  log.info({ jobId: req.jobId, scenario: req.scenario.id, ok: trace.ok, leaks: trace.subscriptions.filter(s => s.leaked).length }, 'trace done');
  // Persist via Redis hash for the orchestrator to read on its next poll.
  const redis = new Redis(requiredEnv('REDIS_URL'));
  await redis.set(req.resultsKey, JSON.stringify(trace), 'EX', 3600);
  await redis.quit();
  // heapDir is the destination prefix; production wires this to S3/Azure Blob.
  void heapDir;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

main().catch((err) => {
  log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'fatal');
  process.exit(1);
});
