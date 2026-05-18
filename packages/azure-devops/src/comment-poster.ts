import type { Finding, PullRequestRef } from '@abid/core';
import type { DiffIndex } from '@abid/git-diff-engine';
import { isPostable } from '@abid/git-diff-engine';
import type { AdoClient, AdoThreadRequest } from './client.js';

/**
 * Translate a post-ready Finding into an ADO thread and post it.
 * Returns the posted thread id.
 *
 * Rules:
 *   - We never post on deleted/binary/files-outside-the-PR-diff.
 *   - We never post the same comment twice in one PR iteration. The caller
 *     is responsible for passing a fingerprint set; if a fingerprint is
 *     already present, we skip silently.
 *   - When the caller passes ADO change tracking IDs, every inline comment must
 *     carry the matching ID so Azure pins the thread to the right file diff.
 *   - We always include rule_id in the body footer for auditability and
 *     so users can reply `@abid mute angular/subscription-leak` to suppress.
 */
export interface PostOptions {
  /** When true, sets thread status to 'fixed' or 'closed' to reduce visual noise. */
  closeThreadOnLowSeverity?: boolean;
  /** When true, formats the comment as a suggestion block. */
  includeSuggestionBlock?: boolean;
  /** Already-posted fingerprints (across iterations) to skip. */
  alreadyPosted?: Set<string>;
  /** Iteration ID returned by ADO; ensures thread context binds to current source SHA. */
  iterationId: number;
  /** Map of repo-relative path -> ADO changeTrackingId for the current PR iteration. */
  changeTrackingIds?: ReadonlyMap<string, number>;
}

export async function postFinding(
  ado: AdoClient,
  pr: PullRequestRef,
  finding: Finding,
  diff: DiffIndex,
  opts: PostOptions,
): Promise<{ posted: boolean; reason?: string; threadId?: number; fallbackLine?: number }> {
  if (opts.alreadyPosted && finding.fingerprint && opts.alreadyPosted.has(finding.fingerprint)) {
    return { posted: false, reason: 'already-posted-this-iteration' };
  }

  const checks = isPostable(finding.location, diff, { requireAddedLine: true });
  if (!checks.postable) {
    return {
      posted: false,
      reason: checks.reason,
      ...(checks.fallbackLine !== undefined ? { fallbackLine: checks.fallbackLine } : {}),
    };
  }

  const changeTrackingId = opts.changeTrackingIds
    ? lookupChangeTrackingId(opts.changeTrackingIds, finding.location.file)
    : undefined;
  if (opts.changeTrackingIds && changeTrackingId === undefined) {
    return { posted: false, reason: 'change-tracking-id-missing' };
  }

  const body = formatComment(finding, opts.includeSuggestionBlock !== false);
  const start = finding.location.startLine;
  const end = Math.max(start, finding.location.endLine ?? start);
  const prContext: NonNullable<AdoThreadRequest['pullRequestThreadContext']> = {
    iterationContext: {
      firstComparingIteration: opts.iterationId,
      secondComparingIteration: opts.iterationId,
    },
  };
  if (changeTrackingId !== undefined) {
    prContext.changeTrackingId = changeTrackingId;
  }

  const thread: AdoThreadRequest = {
    status: opts.closeThreadOnLowSeverity && finding.severity === 'info' ? 'closed' : 'active',
    comments: [{ parentCommentId: 0, commentType: 'text', content: body }],
    threadContext: {
      filePath: toAdoFilePath(finding.location.file),
      rightFileStart: { line: start, offset: toAdoOffset(finding.location.startColumn) },
      rightFileEnd: { line: end, offset: toAdoOffset(finding.location.endColumn) },
    },
    pullRequestThreadContext: prContext,
  };

  const t = await ado.postThread(pr, thread);
  return { posted: true, threadId: t.id };
}

export function formatComment(finding: Finding, includeSuggestion: boolean): string {
  const lines: string[] = [];

  // The title is *not* echoed — ADO threads don't have a title separate from
  // the first comment, and the body opens with the same point. Echoing makes
  // comments feel wordy.

  lines.push(finding.message.body.trim() || finding.message.title.trim());

  if (includeSuggestion && finding.message.suggestion) {
    lines.push('');
    const lang = finding.message.suggestionLanguage ?? 'ts';
    lines.push('```' + lang);
    lines.push(finding.message.suggestion.trim());
    lines.push('```');
  }

  if (finding.siblings && finding.siblings.length > 0 && !finding.message.body.includes('This same issue also exists here:')) {
    lines.push('');
    lines.push('This same issue also exists here:');
    for (const s of finding.siblings) {
      lines.push(`- ${s.file}:${s.line}`);
    }
  }

  lines.push('');
  lines.push(`<sub>rule: \`${finding.ruleId}\` · confidence ${finding.confidence.toFixed(2)}</sub>`);

  return lines.join('\n');
}

function lookupChangeTrackingId(ids: ReadonlyMap<string, number>, file: string): number | undefined {
  const path = normalizeRepoPath(file);
  return ids.get(path) ?? ids.get(`/${path}`);
}

function toAdoFilePath(file: string): string {
  return `/${normalizeRepoPath(file)}`;
}

function normalizeRepoPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '');
}

function toAdoOffset(column: number | undefined): number {
  return Math.max(1, (column ?? 0) + 1);
}
