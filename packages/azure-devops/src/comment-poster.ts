import type { Finding, PullRequestRef } from '@abid/core';
import type { DiffIndex } from '@abid/git-diff-engine';
import { isPostable } from '@abid/git-diff-engine';
import type { AdoClient, AdoThreadRequest } from './client.js';

/**
 * Translate a stage-'clustered' Finding into an ADO thread and post it.
 * Returns the posted thread id.
 *
 * Rules:
 *   - We never post on lines outside a changed hunk.
 *   - We never post the same comment twice in one PR iteration. The caller
 *     is responsible for passing a fingerprint set; if a fingerprint is
 *     already present, we skip silently.
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
}

export async function postFinding(
  ado: AdoClient,
  pr: PullRequestRef,
  finding: Finding,
  diff: DiffIndex,
  opts: PostOptions,
): Promise<{ posted: boolean; reason?: string; threadId?: number }> {
  if (opts.alreadyPosted && finding.fingerprint && opts.alreadyPosted.has(finding.fingerprint)) {
    return { posted: false, reason: 'already-posted-this-iteration' };
  }

  const checks = isPostable(finding.location, diff, { requireAddedLine: false });
  if (!checks.postable) return { posted: false, reason: checks.reason };

  const body = formatComment(finding, opts.includeSuggestionBlock !== false);
  const start = finding.location.startLine;
  const end = finding.location.endLine ?? start;

  const thread: AdoThreadRequest = {
    status: opts.closeThreadOnLowSeverity && finding.severity === 'info' ? 'closed' : 'active',
    comments: [{ commentType: 'text', content: body }],
    threadContext: {
      filePath: `/${finding.location.file}`,
      rightFileStart: { line: start, offset: 1 },
      rightFileEnd: { line: end, offset: 1 },
    },
    pullRequestThreadContext: {
      iterationContext: {
        firstComparingIteration: opts.iterationId,
        secondComparingIteration: opts.iterationId,
      },
    },
  };

  const t = await ado.postThread(pr, thread);
  return { posted: true, threadId: t.id };
}

export function formatComment(finding: Finding, includeSuggestion: boolean): string {
  const lines: string[] = [];

  // The title is *not* echoed — ADO threads don't have a title separate from
  // the first comment, and the body opens with the same point. Echoing makes
  // comments feel wordy.

  lines.push(finding.message.body.trim());

  if (includeSuggestion && finding.message.suggestion) {
    lines.push('');
    const lang = finding.message.suggestionLanguage ?? 'ts';
    lines.push('```' + lang);
    lines.push(finding.message.suggestion.trim());
    lines.push('```');
  }

  if (finding.siblings && finding.siblings.length > 0) {
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
