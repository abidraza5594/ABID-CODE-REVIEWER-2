import type { Finding } from '@abid/core';

/**
 * Persistence interface for findings + feedback. Production wiring uses
 * Postgres with row-level security per tenant (see docs/SECURITY.md). The
 * interface stays narrow so unit tests can swap an in-memory implementation.
 */
export interface FindingsStore {
  saveBatch(findings: Finding[]): Promise<void>;
  byJob(jobId: string): Promise<Finding[]>;
  byTenantSince(tenantId: string, sinceIso: string): Promise<Finding[]>;
  /** Mark a finding as posted with the ADO thread id. */
  markPosted(findingId: string, adoThreadId: number): Promise<void>;
  /** Mark with a disposition reason (drop, summarize, sibling, etc.). */
  updateStage(findingId: string, stage: Finding['stage'], reason?: Finding['dispositionReason']): Promise<void>;
}

/** In-memory implementation for tests and local development. */
export class InMemoryFindingsStore implements FindingsStore {
  private rows = new Map<string, Finding & { adoThreadId?: number }>();

  async saveBatch(findings: Finding[]): Promise<void> {
    for (const f of findings) this.rows.set(f.id, { ...f });
  }
  async byJob(jobId: string): Promise<Finding[]> {
    return [...this.rows.values()].filter((r) => r.jobId === jobId);
  }
  async byTenantSince(tenantId: string, sinceIso: string): Promise<Finding[]> {
    const since = Date.parse(sinceIso);
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && Date.parse(r.updatedAt) >= since);
  }
  async markPosted(findingId: string, adoThreadId: number): Promise<void> {
    const r = this.rows.get(findingId);
    if (!r) return;
    r.adoThreadId = adoThreadId;
    r.stage = 'posted';
    r.updatedAt = new Date().toISOString();
  }
  async updateStage(findingId: string, stage: Finding['stage'], reason?: Finding['dispositionReason']): Promise<void> {
    const r = this.rows.get(findingId);
    if (!r) return;
    r.stage = stage;
    if (reason !== undefined) r.dispositionReason = reason;
    r.updatedAt = new Date().toISOString();
  }
}
