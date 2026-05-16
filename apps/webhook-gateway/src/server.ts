import Fastify from 'fastify';
import { Redis } from 'ioredis';
import pino from 'pino';
import {
  envelopeReplayKey,
  InMemoryReplayCache,
  toPullRequestRef,
  verifyWebhook,
  type WebhookEnvelope,
} from '@abid/azure-devops';
import { ulid } from '@abid/core';
import { loadTenantConfig } from './config.js';

/**
 * Webhook gateway — receives ADO PR events and enqueues review jobs.
 *
 * Responsibilities:
 *   - Verify authenticity (Basic auth and/or HMAC).
 *   - Replay protection.
 *   - Per-tenant rate limit (sliding window).
 *   - Enqueue ReviewJob onto a Redis Stream.
 *
 * Non-responsibilities:
 *   - Cloning repos, parsing diffs, running rules, calling Mistral. All that
 *     lives in the orchestrator.
 *
 * Stateless across requests; replay cache is keyed by tenant in Redis so we
 * survive pod restarts and don't have one-cache-per-pod gotchas.
 */
const log = pino({ name: 'webhook-gateway', level: process.env['LOG_LEVEL'] ?? 'info' });

async function main() {
  const port = Number(process.env['PORT'] ?? 8080);
  const redisUrl = requiredEnv('REDIS_URL');
  const redis = new Redis(redisUrl);

  // Local replay cache as a fast-path; Redis is authoritative.
  const local = new InMemoryReplayCache(2048);

  const app = Fastify({
    logger: log,
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024, // 4 MB — ADO payloads are typically <100 KB
  });

  // ADO sends with content-type 'application/json'. We use the raw buffer for HMAC.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await redis.ping();
      return { ok: true };
    } catch (err) {
      reply.code(503);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/webhook/:tenant', async (req, reply) => {
    const tenantId = (req.params as { tenant: string }).tenant;
    const cfg = await loadTenantConfig(tenantId);
    if (!cfg) return reply.code(404).send({ error: 'unknown-tenant' });

    const raw = req.body as Buffer;
    const verify = verifyWebhook(raw, headersToRecord(req.headers), {
      ...(cfg.basicAuth ? { basicAuth: cfg.basicAuth } : {}),
      ...(cfg.hmacSecret ? { hmacSecret: cfg.hmacSecret } : {}),
    });
    if (!verify.ok) {
      log.warn({ tenant: tenantId, reason: verify.reason }, 'rejected webhook');
      return reply.code(401).send({ error: verify.reason });
    }

    const env = JSON.parse(raw.toString('utf8')) as WebhookEnvelope;
    if (!isPrUpdate(env)) {
      return reply.code(204).send();
    }

    const key = `replay:${tenantId}:${envelopeReplayKey(env)}`;
    if (local.seen(key)) return reply.code(204).send();
    const setRes = await redis.set(key, '1', 'EX', 600, 'NX');
    if (setRes !== 'OK') return reply.code(204).send();
    local.mark(key);

    // Rate limit per tenant: sliding 1s window via INCR + EXPIRE.
    const rlKey = `rl:${tenantId}:${Math.floor(Date.now() / 1000)}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, 2);
    if (count > 10) {
      log.warn({ tenant: tenantId, count }, 'tenant rate limited');
      return reply.code(429).send({ error: 'rate-limited' });
    }

    const pr = toPullRequestRef(env, tenantId, cfg.organization);
    if (!pr) {
      log.warn({ tenant: tenantId }, 'envelope missing required fields');
      return reply.code(400).send({ error: 'malformed-pr' });
    }

    const jobId = ulid();
    const payload = JSON.stringify({ id: jobId, pr, triggeredBy: 'webhook', triggeredAt: env.createdDate });
    await redis.xadd('jobs:review', '*', 'job', payload);
    log.info({ tenant: tenantId, jobId, pr: { id: pr.pullRequestId, sha: pr.sourceSha } }, 'enqueued job');
    return reply.code(202).send({ jobId });
  });

  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'webhook gateway listening');
}

function isPrUpdate(env: WebhookEnvelope): boolean {
  return env.eventType === 'git.pullrequest.created' || env.eventType === 'git.pullrequest.updated';
}

function headersToRecord(h: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v[0];
    else out[k.toLowerCase()] = v;
  }
  return out;
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
