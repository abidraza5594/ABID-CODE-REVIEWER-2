export type LineIntent = 'added' | 'removed' | 'context';

export interface DiffLine {
  intent: LineIntent;
  /** Old-file 1-indexed line number, or null if the line is added. */
  oldLine: number | null;
  /** New-file 1-indexed line number, or null if the line is removed. */
  newLine: number | null;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional "function context" suffix from unified diff header. */
  section?: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface FileDiff {
  /** Path in the head revision. Repo-relative, forward slashes. */
  newPath: string;
  /** Path in the base revision. Same as newPath unless renamed. */
  oldPath: string;
  status: FileStatus;
  /** True if git classified this as binary — we never post on binary files. */
  binary: boolean;
  hunks: Hunk[];
}

export interface ParsedDiff {
  files: FileDiff[];
}
