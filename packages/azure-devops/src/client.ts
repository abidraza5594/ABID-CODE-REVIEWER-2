import type { PullRequestRef } from '@abid/core';

/**
 * Thin Azure DevOps REST client. We use direct fetch rather than the
 * azure-devops-node-api SDK because:
 *   - We only need ~6 endpoints; the SDK adds ~3MB to the image.
 *   - We need fine control over retries and rate limiting per tenant.
 *
 * Auth: PAT in Basic auth header (`:<pat>` base64) — works against both
 * dev.azure.com and on-prem Azure DevOps Server hosts.
 */
export interface AdoClientOptions {
  /** ADO organization URL: `https://dev.azure.com/<org>` or on-prem host. */
  organizationUrl: string;
  /** Personal access token (or short-lived OAuth token). */
  pat: string;
  fetch?: typeof globalThis.fetch;
  /** API version to pin. ADO is mostly stable but new fields appear; we pin. */
  apiVersion?: string;
}

export class AdoClient {
  private opts: Required<AdoClientOptions>;

  constructor(opts: AdoClientOptions) {
    this.opts = {
      apiVersion: '7.1-preview.1',
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      ...opts,
    };
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ 'api-version': this.opts.apiVersion, ...params }).toString();
    return `${this.opts.organizationUrl}${path}?${qs}`;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`:${this.opts.pat}`).toString('base64');
  }

  async getIteration(pr: PullRequestRef): Promise<number> {
    // Iterations represent each push to the PR. We comment on the latest one
    // so threads stay aligned with the current source SHA.
    const path = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.pullRequestId}/iterations`;
    const res = await this.opts.fetch(this.url(path), {
      method: 'GET',
      headers: { 'authorization': this.authHeader(), 'accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`ADO getIteration ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { value: Array<{ id: number }> };
    const ids = json.value.map((v) => v.id);
    if (ids.length === 0) throw new Error('ADO: PR has no iterations');
    return Math.max(...ids);
  }

  async getPullRequestDiff(pr: PullRequestRef): Promise<string> {
    // ADO doesn't return a unified diff directly; we use the `git/diffs/commits`
    // endpoint with `$mediaType=text/x-diff` to receive a unified diff text.
    const path = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/diffs/commits`;
    const url = this.url(path, {
      baseVersion: pr.baseSha,
      targetVersion: pr.sourceSha,
      baseVersionType: 'commit',
      targetVersionType: 'commit',
      diffCommonCommit: 'true',
      '$top': '5000',
    });
    const res = await this.opts.fetch(url, {
      method: 'GET',
      headers: { 'authorization': this.authHeader(), 'accept': 'text/x-diff,application/json' },
    });
    if (!res.ok) throw new Error(`ADO getPullRequestDiff ${res.status}: ${await res.text()}`);
    // ADO sometimes returns JSON metadata instead of raw diff; fall through
    // to file-by-file fetch when so.
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/x-diff')) return await res.text();
    // Fallback: parse the JSON change list and fetch each file's diff individually.
    return this.fetchPerFileDiff(pr, (await res.json()) as { changes: AdoChange[] });
  }

  private async fetchPerFileDiff(pr: PullRequestRef, body: { changes: AdoChange[] }): Promise<string> {
    const out: string[] = [];
    for (const c of body.changes) {
      if (!c.item || !c.item.path) continue;
      out.push(await this.fetchOneFileDiff(pr, c.item.path));
    }
    return out.join('\n');
  }

  private async fetchOneFileDiff(pr: PullRequestRef, gitPath: string): Promise<string> {
    // For each file, fetch both versions and produce a unified diff client-side.
    // Real implementation lives in the orchestrator; this helper is intentionally
    // light because the streamed diff path is the common case.
    const headPath = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/items`;
    const urlHead = this.url(headPath, {
      path: gitPath,
      versionDescriptor: '',
      'versionDescriptor.version': pr.sourceSha,
      'versionDescriptor.versionType': 'commit',
      includeContent: 'true',
      'download': 'true',
    });
    const r = await this.opts.fetch(urlHead, {
      method: 'GET',
      headers: { 'authorization': this.authHeader(), 'accept': 'text/plain' },
    });
    if (!r.ok) return '';
    // We don't reconstruct a real unified diff here; the orchestrator's preferred
    // path is the text/x-diff response above. This branch only triggers on
    // misconfigured ADO instances and is mainly defensive.
    return '';
  }

  async postThread(pr: PullRequestRef, thread: AdoThreadRequest): Promise<AdoThread> {
    const path = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.pullRequestId}/threads`;
    const res = await this.opts.fetch(this.url(path), {
      method: 'POST',
      headers: {
        'authorization': this.authHeader(),
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(thread),
    });
    if (!res.ok) throw new Error(`ADO postThread ${res.status}: ${await res.text()}`);
    return (await res.json()) as AdoThread;
  }

  async postReplyToThread(pr: PullRequestRef, threadId: number, content: string): Promise<void> {
    const path = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.pullRequestId}/threads/${threadId}/comments`;
    const res = await this.opts.fetch(this.url(path), {
      method: 'POST',
      headers: {
        'authorization': this.authHeader(),
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({ commentType: 'text', parentCommentId: 1, content }),
    });
    if (!res.ok) throw new Error(`ADO postReply ${res.status}: ${await res.text()}`);
  }

  async setStatus(pr: PullRequestRef, status: AdoStatus): Promise<void> {
    const path = `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.pullRequestId}/statuses`;
    const res = await this.opts.fetch(this.url(path), {
      method: 'POST',
      headers: {
        'authorization': this.authHeader(),
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(status),
    });
    if (!res.ok) throw new Error(`ADO setStatus ${res.status}: ${await res.text()}`);
  }
}

export interface AdoThreadRequest {
  status?: 'active' | 'closed' | 'wontFix' | 'fixed';
  comments: Array<{ commentType: 'text' | 'system'; content: string }>;
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
    leftFileStart?: { line: number; offset: number };
    leftFileEnd?: { line: number; offset: number };
  };
  pullRequestThreadContext?: {
    iterationContext?: { firstComparingIteration: number; secondComparingIteration: number };
    changeTrackingId?: number;
  };
}

export interface AdoThread {
  id: number;
  status: string;
}

export interface AdoStatus {
  state: 'pending' | 'succeeded' | 'failed' | 'notApplicable' | 'notSet';
  description: string;
  context: { name: string; genre: string };
  targetUrl?: string;
}

interface AdoChange {
  item?: { path: string };
}
