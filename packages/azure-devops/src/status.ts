import type { PullRequestRef } from '@abid/core';
import type { AdoClient } from './client.js';

/**
 * The PR-level status check Abid Review reports. We use this to surface
 * pipeline progress and link to the dashboard. We do NOT block merge — the
 * point of the bot is to inform reviewers, not gatekeep them.
 */
export type ReviewStatusState = 'pending' | 'succeeded' | 'failed';

export interface ReviewStatusUpdate {
  state: ReviewStatusState;
  description: string;
  targetUrl?: string;
}

export async function publishStatus(
  ado: AdoClient,
  pr: PullRequestRef,
  update: ReviewStatusUpdate,
): Promise<void> {
  await ado.setStatus(pr, {
    state: update.state === 'pending' ? 'pending' : update.state,
    description: update.description.slice(0, 140),
    context: { name: 'abid-review', genre: 'continuous-integration' },
    ...(update.targetUrl ? { targetUrl: update.targetUrl } : {}),
  });
}
