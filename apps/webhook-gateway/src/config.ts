/**
 * Tenant configuration loader. Production reads from Postgres + Key Vault.
 * Local/dev reads from a JSON file pointed to by ABID_TENANTS_JSON.
 *
 * What lives here:
 *   - per-tenant ADO organization name
 *   - per-tenant webhook secret (Basic auth and/or HMAC)
 *   - PAT token reference (NOT the raw PAT — orchestrator fetches from KV)
 */
import * as fs from 'node:fs/promises';

export interface TenantConfig {
  tenantId: string;
  organization: string;
  basicAuth?: { user: string; pass: string };
  hmacSecret?: string;
  /** Key Vault secret name where the PAT is stored. */
  patSecretName: string;
}

let cached: Map<string, TenantConfig> | null = null;

export async function loadTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  if (!cached) cached = await loadAll();
  return cached.get(tenantId) ?? null;
}

async function loadAll(): Promise<Map<string, TenantConfig>> {
  const map = new Map<string, TenantConfig>();
  const jsonPath = process.env['ABID_TENANTS_JSON'];
  if (jsonPath) {
    const raw = await fs.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as TenantConfig[];
    for (const t of parsed) map.set(t.tenantId, t);
  }
  return map;
}
