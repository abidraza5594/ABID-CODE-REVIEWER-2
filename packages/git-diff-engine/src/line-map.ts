import type { FileDiff, ParsedDiff } from './types.js';

/**
 * Bidirectional line map between base and head revisions.
 *
 * Why we need this:
 *   - Findings come back from the AST with head-revision line numbers.
 *   - ADO PR comments are posted with head-revision coordinates, but we still
 *     need to verify the line is in a changed hunk (we never comment on
 *     unmodified lines — that's noise).
 *   - When a rule needs to ask "was this method already broken on main?",
 *     it walks head→base to read the original code.
 */
export interface LineMap {
  /** newLine → oldLine, or null if the line is added (no base counterpart). */
  newToOld: Map<number, number | null>;
  /** oldLine → newLine, or null if the line was removed. */
  oldToNew: Map<number, number | null>;
  /** Set of `newLine` values that are inside a changed hunk (added or context-of-changed). */
  changedNewLines: Set<number>;
  /** Set of newLines that are *added* (not just context inside a changed hunk). */
  addedNewLines: Set<number>;
  /** Section labels per hunk (function context from `@@ ... @@`), keyed by start newLine. */
  sectionByHunkStart: Map<number, string>;
}

export function buildLineMap(file: FileDiff): LineMap {
  const newToOld = new Map<number, number | null>();
  const oldToNew = new Map<number, number | null>();
  const changedNewLines = new Set<number>();
  const addedNewLines = new Set<number>();
  const sectionByHunkStart = new Map<number, string>();

  for (const hunk of file.hunks) {
    if (hunk.section) sectionByHunkStart.set(hunk.newStart, hunk.section);

    for (const ln of hunk.lines) {
      if (ln.newLine !== null) {
        newToOld.set(ln.newLine, ln.oldLine);
        changedNewLines.add(ln.newLine);
        if (ln.intent === 'added') addedNewLines.add(ln.newLine);
      }
      if (ln.oldLine !== null) {
        oldToNew.set(ln.oldLine, ln.newLine);
      }
    }
  }

  return { newToOld, oldToNew, changedNewLines, addedNewLines, sectionByHunkStart };
}

/**
 * A diff index keyed by `newPath`. Renames are also indexed under `oldPath`
 * so callers can look up either coordinate.
 */
export class DiffIndex {
  private byNewPath = new Map<string, FileDiff>();
  private byOldPath = new Map<string, FileDiff>();
  private lineMaps = new Map<string, LineMap>();

  constructor(diff: ParsedDiff) {
    for (const f of diff.files) {
      this.byNewPath.set(f.newPath, f);
      this.byOldPath.set(f.oldPath, f);
      this.lineMaps.set(f.newPath, buildLineMap(f));
    }
  }

  fileByNewPath(path: string): FileDiff | undefined {
    return this.byNewPath.get(path);
  }

  fileByOldPath(path: string): FileDiff | undefined {
    return this.byOldPath.get(path);
  }

  lineMap(newPath: string): LineMap | undefined {
    return this.lineMaps.get(newPath);
  }

  /** All `newPath` values that are non-binary and non-deleted (i.e. postable files). */
  postableFiles(): string[] {
    const out: string[] = [];
    for (const f of this.byNewPath.values()) {
      if (f.binary) continue;
      if (f.status === 'deleted') continue;
      out.push(f.newPath);
    }
    return out;
  }

  /** Iterate over all changed (added or modified) files. */
  *files(): IterableIterator<FileDiff> {
    yield* this.byNewPath.values();
  }
}
