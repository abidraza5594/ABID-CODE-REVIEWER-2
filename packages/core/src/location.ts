/**
 * A point or range in a source file, in **head-revision coordinates**.
 * Always 1-indexed lines, 0-indexed columns (matches LSP convention except for the line base).
 *
 * Locations are normalized to forward slashes and repo-relative. Never absolute paths.
 */
export interface SourceLocation {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-indexed inclusive. */
  startLine: number;
  /** 1-indexed inclusive. If absent, single-line span = startLine. */
  endLine?: number;
  /** 0-indexed inclusive. */
  startColumn?: number;
  /** 0-indexed exclusive. */
  endColumn?: number;
}

export function singleLine(file: string, line: number): SourceLocation {
  return { file, startLine: line };
}

export function spans(loc: SourceLocation, line: number): boolean {
  if (loc.startLine > line) return false;
  const end = loc.endLine ?? loc.startLine;
  return line <= end;
}

export function locationKey(loc: SourceLocation): string {
  return `${loc.file}:${loc.startLine}:${loc.endLine ?? loc.startLine}`;
}
