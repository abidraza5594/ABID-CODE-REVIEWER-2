import type { SourceLocation } from '@abid/core';
import type { DiffIndex } from './line-map.js';

export type PostableReason =
  | 'ok'
  | 'ok-file-in-diff'
  | 'file-not-in-diff'
  | 'file-deleted'
  | 'file-binary'
  | 'line-not-in-changed-hunk'
  | 'line-out-of-range';

export interface PostableResult {
  postable: boolean;
  reason: PostableReason;
  /** Whether the line is in a changed hunk (vs. context inside a changed file). */
  inChangedHunk?: boolean;
  /** Closest changed-hunk line, useful if the caller wants to relocate the comment. */
  fallbackLine?: number;
}

export interface PostableOptions {
  /** True → only added/+ lines are postable. Used for "new-issues-only" mode. */
  requireAddedLine?: boolean;
  /**
   * True → require the exact line to live in a changed hunk.
   * False (default) → allow any line in a file that's in the diff. ADO permits
   * thread placement on any existing line; restricting to changed hunks silently
   * drops real findings that live in untouched lines of changed files.
   */
  requireChangedHunk?: boolean;
}

/**
 * Decide whether a finding can be posted inline at its declared location.
 *
 * Default policy:
 *   - File must be present in the diff (added or modified, non-binary).
 *   - Any line in such a file is postable. The result includes `inChangedHunk`
 *     so callers can still prefer/sort findings inside changed hunks.
 *
 * Strict policies for callers that want to limit comment scope:
 *   - `requireChangedHunk: true` → only lines that appear inside a hunk.
 *   - `requireAddedLine: true`   → only `+` lines (truly new code).
 */
export function isPostable(
  loc: SourceLocation,
  diff: DiffIndex,
  opts: PostableOptions = {},
): PostableResult {
  const file = diff.fileByNewPath(loc.file);
  if (!file) return { postable: false, reason: 'file-not-in-diff' };
  if (file.status === 'deleted') return { postable: false, reason: 'file-deleted' };
  if (file.binary) return { postable: false, reason: 'file-binary' };

  const map = diff.lineMap(loc.file)!;
  const target = loc.startLine;

  const inAdded = map.addedNewLines.has(target);
  const inChanged = map.changedNewLines.has(target);

  if (opts.requireAddedLine) {
    if (inAdded) return { postable: true, reason: 'ok', inChangedHunk: true };
    const fallback = nearestChangedLine(map.addedNewLines, target);
    return {
      postable: false,
      reason: 'line-not-in-changed-hunk',
      ...(fallback !== null ? { fallbackLine: fallback } : {}),
    };
  }

  if (opts.requireChangedHunk) {
    if (inChanged) return { postable: true, reason: 'ok', inChangedHunk: true };
    const fallback = nearestChangedLine(map.changedNewLines, target);
    return {
      postable: false,
      reason: 'line-not-in-changed-hunk',
      ...(fallback !== null ? { fallbackLine: fallback } : {}),
    };
  }

  // Default permissive mode: file in diff = postable. Surface whether the
  // line itself is in a changed hunk so callers can still sort by it.
  return {
    postable: true,
    reason: inChanged ? 'ok' : 'ok-file-in-diff',
    inChangedHunk: inChanged,
  };
}

function nearestChangedLine(set: ReadonlySet<number>, target: number): number | null {
  const MAX_DIST = 50;
  for (let d = 1; d <= MAX_DIST; d++) {
    if (set.has(target - d)) return target - d;
    if (set.has(target + d)) return target + d;
  }
  return null;
}
