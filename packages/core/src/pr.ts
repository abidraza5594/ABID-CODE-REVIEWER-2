/**
 * Identifying coordinates for an Azure DevOps PR review job.
 */
export interface PullRequestRef {
  /** Tenant / organization in our system, not ADO. */
  tenantId: string;
  /** ADO organization name. */
  organization: string;
  /** ADO project. */
  project: string;
  /** ADO repository ID (GUID) — stable across renames. */
  repositoryId: string;
  /** Human-readable repository name at the time of the event. */
  repositoryName: string;
  /** ADO PR number. */
  pullRequestId: number;
  /** Source branch full ref, e.g. "refs/heads/feature/x". */
  sourceRef: string;
  /** Target branch full ref. */
  targetRef: string;
  /** Source commit SHA at the time the webhook fired. */
  sourceSha: string;
  /** Merge-base SHA against target. */
  baseSha: string;
}

export interface ReviewJob {
  id: string;
  pr: PullRequestRef;
  triggeredBy: 'webhook' | 'manual' | 'recheck';
  /** Webhook event timestamp UTC ISO. */
  triggeredAt: string;
  /** Optional iteration tag — ADO PRs have multiple iterations. */
  iterationId?: number;
}
