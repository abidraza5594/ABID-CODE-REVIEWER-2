import { Redis } from 'ioredis';
import pino from 'pino';
import { runReview } from './pipeline.js';
import type { ReviewJob } from '@abid/core';

const log = pino({ name: 'orchestrator', level: process.env['LOG_LEVEL'] ?? 'info' });

/**
 * Orchestrator entrypoint. Reads jobs from the Redis Stream produced by the
 * webhook gateway, runs the full review pipeline per job, and acks.
 *
 * Concurrency: we read with a consumer group; each pod processes up to
 * `CONCURRENCY` jobs in flight. Long-running CPU-heavy stages are kept under
 * a worker_threads pool inside pipeline.ts (not shown here for brevity).
 */
async function main() {
  const redis = new Redis(requiredEnv('REDIS_URL'));
  const stream = 'jobs:review';
  const group = process.env['CONSUMER_GROUP'] ?? 'orchestrators';
  const consumer = `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`;
  const concurrency = Number(process.env['CONCURRENCY'] ?? 2);

  // Ensure the consumer group exists. BUSYGROUP means it already does.
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (e) {
    const msg = String((e as Error).message);
    if (!msg.includes('BUSYGROUP')) throw e;
  }

  const inflight = new Set<Promise<void>>();
  log.info({ group, consumer, concurrency }, 'orchestrator started');

  while (true) {
    if (inflight.size >= concurrency) {
      // Park until any current job finishes.
      await Promise.race(inflight);
      continue;
    }

    const res = await redis.xreadgroup(
      'GROUP', group, consumer,
      'COUNT', 1,
      'BLOCK', 30_000,
      'STREAMS', stream, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, kv] of entries) {
        const jobJson = kv[kv.indexOf('job') + 1]!;
        let job: ReviewJob;
        try {
          job = JSON.parse(jobJson) as ReviewJob;
        } catch (err) {
          log.warn({ id, err: (err as Error).message }, 'malformed job, acking');
          await redis.xack(stream, group, id);
          continue;
        }

        const p = handleJob(job)
          .then(async () => { await redis.xack(stream, group, id); })
          .catch(async (err) => {
            log.error({ jobId: job.id, err: { message: (err as Error).message, stack: (err as Error).stack } }, 'job failed');
            // We ack on failure so the same broken job doesn't loop forever.
            // The job's failure is captured in Postgres + the PR status check.
            await redis.xack(stream, group, id);
          })
          .finally(() => { inflight.delete(p); });

        inflight.add(p);
      }
    }
  }
}

async function handleJob(job: ReviewJob): Promise<void> {
  const startedAt = Date.now();
  log.info({ jobId: job.id, prId: job.pr.pullRequestId }, 'starting review');
  await runReview(job, log);
  log.info({ jobId: job.id, durationMs: Date.now() - startedAt }, 'review complete');
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
