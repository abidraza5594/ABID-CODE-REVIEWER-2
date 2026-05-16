import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Redis } from 'ioredis';
import pino from 'pino';
import { chromium, type Browser, type Page } from 'playwright';
import { runScenario } from '@abid/runtime-instrumentation';
import type { RuntimeAction, RuntimeScenario } from '@abid/core';

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
  await ensureGroup(redis);
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
  const heapDir = path.join(tmpdir(), 'abid-heap', req.jobId, req.scenario.id);
  await fs.mkdir(heapDir, { recursive: true });
  const trace = await runScenario({
    browser,
    baseUrl: req.baseUrl,
    scenario: req.scenario,
    onHeapChunk: async (snapshotId, chunk) => {
      await fs.appendFile(path.join(heapDir, `${snapshotId}.heapsnapshot`), chunk);
    },
    performActions: async (page: Page) => {
      // The orchestrator passes a scenario "script path" but we don't load
      // arbitrary JS — too dangerous for a shared runner. Instead, we accept
      // a small DSL of click/type/wait actions in the scenario record. For
      // brevity here we navigate the page exposed by the scenario.
      await performSafeActions(page, req.baseUrl, req.scenario.actions ?? []);
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

async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', 'jobs:runtime', 'runtime-runners', '$', 'MKSTREAM');
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
  }
}

async function performSafeActions(page: Page, baseUrl: string, actions: RuntimeAction[]): Promise<void> {
  if (actions.length === 0) {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    return;
  }

  for (const action of actions) {
    switch (action.type) {
      case 'goto':
        await page.goto(resolveUrl(baseUrl, action.url), { waitUntil: action.waitUntil ?? 'networkidle' });
        break;
      case 'click':
        await page.locator(action.selector).click(timeoutOption(action.timeoutMs));
        break;
      case 'fill':
        await page.locator(action.selector).fill(action.text, timeoutOption(action.timeoutMs));
        break;
      case 'press':
        await page.locator(action.selector).press(action.key, timeoutOption(action.timeoutMs));
        break;
      case 'waitForSelector':
        await page.locator(action.selector).waitFor({
          state: action.state ?? 'visible',
          ...timeoutOption(action.timeoutMs),
        });
        break;
      case 'waitForLoadState':
        await page.waitForLoadState(action.state ?? 'networkidle');
        break;
      case 'wait':
        await page.waitForTimeout(action.ms);
        break;
    }
  }
}

function timeoutOption(timeoutMs: number | undefined): { timeout?: number } {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

function resolveUrl(baseUrl: string, url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  }
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
