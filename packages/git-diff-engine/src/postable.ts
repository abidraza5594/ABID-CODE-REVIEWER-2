import type { SourceLocation } from '@abid/core';
import type { DiffIndex } from './line-map.js';

export type PostableReason =
  | 'ok'
  | 'file-not-in-diff'
  | 'file-deleted'
  | 'file-binary'
  | 'line-not-in-changed-hunk'
  | 'line-out-of-range';

export interface PostableResult {
  postable: boolean;
  reason: PostableReason;
  /** Optional fallback line within the same hunk if the exact line is unchanged context. */
  fallbackLine?: number;
}

/**
 * Decide whether a finding can be posted inline at its declared location.
 *
 * Rule: we post only on lines inside a changed hunk. Pure-context lines are
 * acceptable when the finding's *evidence* references a changed line nearby
 * (the caller may pass `requireAddedLine: true` to be stricter).
 */
export function isPostable(
  loc: SourceLocation,
  diff: DiffIndex,
  opts: { requireAddedLine?: boolean } = {},
): PostableResult {
  const file = diff.fileByNewPath(loc.file);
  if (!file) return { postable: false, reason: 'file-not-in-diff' };
  if (file.status === 'deleted') return { postable: false, reason: 'file-deleted' };
  if (file.binary) return { postable: false, reason: 'file-binary' };

  const map = diff.lineMap(loc.file)!;
  const target = loc.startLine;

  if (opts.requireAddedLine) {
    if (map.addedNewLines.has(target)) return { postable: true, reason: 'ok' };
  } else if (map.changedNewLines.has(target)) {
    return { postable: true, reason: 'ok' };
  }

  // Look for a nearby line within the same hunk we can fall back to.
  // We only consider the closest changed line within a small window — beyond
  // that, the comment isn't meaningfully tied to the change anyway.
  const WINDOW = 5;
  for (let dist = 1; dist <= WINDOW; dist++) {
    for (const candidate of [target - dist, target + dist]) {
      const isAcceptable = opts.requireAddedLine
        ? map.addedNewLines.has(candidate)
        : map.changedNewLines.has(candidate);
      if (isAcceptable) {
        return { postable: false, reason: 'line-not-in-changed-hunk', fallbackLine: candidate };
      }
    }
  }

  return { postable: false, reason: 'line-not-in-changed-hunk' };
}
