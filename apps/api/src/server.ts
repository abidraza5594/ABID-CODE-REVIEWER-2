import Fastify from 'fastify';
import pino from 'pino';
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

async function main() {
  const port = Number(process.env['PORT'] ?? 8081);
  const app = Fastify({ logger: log, trustProxy: true });
  const store = new InMemoryFindingsStore(); // production: PostgresFindingsStore
  const calibration = new CalibrationModel();

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/tenants/:tenant/findings', async (req) => {
    const params = req.params as { tenant: string };
    const since = (req.query as { since?: string }).since ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    return store.byTenantSince(params.tenant, since);
  });

  app.get('/api/tenants/:tenant/calibration', async () => calibration.records());

  await app.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'api listening');
}

main().catch((err) => {
  log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'fatal');
  process.exit(1);
});
