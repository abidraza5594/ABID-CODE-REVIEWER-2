import * as crypto from 'node:crypto';
import type { PullRequestRef } from '@abid/core';

/**
 * Azure DevOps webhook handling. Supports two auth schemes:
 *   - Basic auth in the `Authorization` header (most common ADO setup).
 *   - HMAC-SHA1 over the body in `x-hub-signature` (when configured).
 *
 * Both must use constant-time comparison. We reject events older than 5 minutes
 * and deduplicate by `subscriptionId + eventId`.
 */
export interface WebhookEnvelope {
  /** Azure DevOps subscription ID for this webhook integration. */
  subscriptionId: string;
  /** Per-event ID assigned by ADO. */
  eventId: string;
  /** Wall-clock UTC ISO timestamp ADO claims is when the event was created. */
  createdDate: string;
  /** Event type, e.g. "git.pullrequest.created" / "git.pullrequest.updated". */
  eventType: string;
  /** Raw resource payload — shape depends on eventType. */
  resource: PullRequestResource;
}

export interface PullRequestResource {
  pullRequestId: number;
  repository: { id: string; name: string; project: { id: string; name: string } };
  sourceRefName: string;
  targetRefName: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
}

export interface VerifyOptions {
  /** ADO Basic credentials (username:password). */
  basicAuth?: { user: string; pass: string };
  /** HMAC secret if you configured signed payloads. */
  hmacSecret?: string;
  /** Reject anything older than this. Defaults to 5 minutes. */
  maxAgeMs?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'bad-auth' | 'bad-hmac' | 'stale' | 'malformed' };

/** Verify the request authenticity. Body is the *exact bytes* received. */
export function verifyWebhook(
  body: Buffer,
  headers: Record<string, string | undefined>,
  opts: VerifyOptions,
): VerifyResult {
  // 1) Authentication: Basic auth if configured.
  if (opts.basicAuth) {
    const got = headers['authorization'] ?? '';
    const want = 'Basic ' + Buffer.from(`${opts.basicAuth.user}:${opts.basicAuth.pass}`).toString('base64');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      return { ok: false, reason: 'bad-auth' };
    }
  }

  // 2) HMAC if configured.
  if (opts.hmacSecret) {
    const sig = headers['x-hub-signature'] ?? '';
    if (!sig.startsWith('sha1=')) return { ok: false, reason: 'bad-hmac' };
    const got = sig.slice(5);
    const want = crypto.createHmac('sha1', opts.hmacSecret).update(body).digest('hex');
    const a = Buffer.from(got, 'hex');
    const b = Buffer.from(want, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-hmac' };
  }

  // 3) Replay / freshness window.
  let parsed: WebhookEnvelope;
  try {
    parsed = JSON.parse(body.toString('utf8')) as WebhookEnvelope;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const maxAge = opts.maxAgeMs ?? 5 * 60 * 1000;
  const t = Date.parse(parsed.createdDate);
  if (!Number.isFinite(t)) return { ok: false, reason: 'malformed' };
  if (Date.now() - t > maxAge) return { ok: false, reason: 'stale' };

  return { ok: true };
}

/** Lift a verified envelope to our internal PullRequestRef. */
export function toPullRequestRef(
  envelope: WebhookEnvelope,
  tenantId: string,
  organization: string,
): PullRequestRef | null {
  const r = envelope.resource;
  if (!r) return null;
  const sourceSha = r.lastMergeSourceCommit?.commitId;
  const baseSha = r.lastMergeTargetCommit?.commitId;
  if (!sourceSha || !baseSha) return null;
  return {
    tenantId,
    organization,
    project: r.repository.project.name,
    repositoryId: r.repository.id,
    repositoryName: r.repository.name,
    pullRequestId: r.pullRequestId,
    sourceRef: r.sourceRefName,
    targetRef: r.targetRefName,
    sourceSha,
    baseSha,
  };
}

/**
 * Replay protection — a small LRU of recently-seen `subscriptionId:eventId`s.
 * Backed by an in-memory Map; production wiring puts a Redis-backed
 * implementation behind this interface.
 */
export interface ReplayCache {
  seen(key: string): boolean;
  mark(key: string): void;
}

export class InMemoryReplayCache implements ReplayCache {
  private set = new Set<string>();
  private order: string[] = [];

  constructor(private readonly maxSize = 1024) {}

  seen(key: string): boolean {
    return this.set.has(key);
  }

  mark(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.order.push(key);
    while (this.order.length > this.maxSize) {
      const evict = this.order.shift()!;
      this.set.delete(evict);
    }
  }
}

export function envelopeReplayKey(env: WebhookEnvelope): string {
  return `${env.subscriptionId}:${env.eventId}`;
}
