import type { DiffLine, FileDiff, FileStatus, Hunk, ParsedDiff } from './types.js';

/**
 * Unified-diff parser. We don't use a generic NPM diff parser because:
 *   1. We need exact intent per line (`added | removed | context`).
 *   2. We need to handle git-specific markers: `rename from`, `copy from`, `Binary files`.
 *   3. We need bidirectional line mapping, which means we have to walk the hunk
 *      ourselves anyway.
 *
 * Input is the output of `git diff --no-color --no-prefix --unified=3 <base> <head>`
 * (or what ADO's PR API returns as a unified diff per file).
 */
const HEADER_DIFF = /^diff --git (?<a>\S+) (?<b>\S+)$/;
const HEADER_FROM = /^---\s+(?<p>\S.*?)\s*$/;
const HEADER_TO = /^\+\+\+\s+(?<p>\S.*?)\s*$/;
const HEADER_RENAME_FROM = /^rename from (?<p>.+)$/;
const HEADER_RENAME_TO = /^rename to (?<p>.+)$/;
const HEADER_COPY_FROM = /^copy from (?<p>.+)$/;
const HEADER_COPY_TO = /^copy to (?<p>.+)$/;
const HEADER_NEW_FILE = /^new file mode /;
const HEADER_DELETED_FILE = /^deleted file mode /;
const HEADER_BINARY = /^Binary files/;
const HUNK_HEADER = /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@(?<section>.*)$/;

function stripPrefix(p: string): string {
  // Git's --no-prefix omits a/ b/, but ADO often returns with a/ b/. Be safe.
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function normalize(p: string): string {
  return stripPrefix(p).replace(/\\/g, '/');
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split(/\r?\n/);
  const files: FileDiff[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const headerMatch = line.match(HEADER_DIFF);
    if (!headerMatch) {
      i++;
      continue;
    }

    // We've found a `diff --git` header. Parse the file metadata block.
    let oldPath = normalize(headerMatch.groups!['a']!);
    let newPath = normalize(headerMatch.groups!['b']!);
    let status: FileStatus = 'modified';
    let binary = false;
    i++;

    while (i < lines.length && !lines[i]!.startsWith('@@') && !HEADER_DIFF.test(lines[i]!)) {
      const meta = lines[i]!;
      if (HEADER_NEW_FILE.test(meta)) status = 'added';
      else if (HEADER_DELETED_FILE.test(meta)) status = 'deleted';
      else if (HEADER_RENAME_FROM.test(meta)) {
        status = 'renamed';
        oldPath = normalize(meta.match(HEADER_RENAME_FROM)!.groups!['p']!);
      } else if (HEADER_RENAME_TO.test(meta)) {
        newPath = normalize(meta.match(HEADER_RENAME_TO)!.groups!['p']!);
      } else if (HEADER_COPY_FROM.test(meta)) {
        status = 'copied';
        oldPath = normalize(meta.match(HEADER_COPY_FROM)!.groups!['p']!);
      } else if (HEADER_COPY_TO.test(meta)) {
        newPath = normalize(meta.match(HEADER_COPY_TO)!.groups!['p']!);
      } else if (HEADER_BINARY.test(meta)) {
        binary = true;
      } else {
        const fm = meta.match(HEADER_FROM);
        const tm = meta.match(HEADER_TO);
        if (fm) {
          const p = fm.groups!['p']!;
          if (p !== '/dev/null') oldPath = normalize(p);
        } else if (tm) {
          const p = tm.groups!['p']!;
          if (p !== '/dev/null') newPath = normalize(p);
        }
      }
      i++;
    }

    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const { hunk, advance } = parseHunk(lines, i);
      hunks.push(hunk);
      i += advance;
    }

    files.push({ newPath, oldPath, status, binary, hunks });
  }

  return { files };
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; advance: number } {
  const header = lines[start]!;
  const m = header.match(HUNK_HEADER);
  if (!m) throw new Error(`malformed hunk header at line ${start}: ${header}`);
  const oldStart = parseInt(m.groups!['oldStart']!, 10);
  const oldLines = m.groups!['oldLines'] ? parseInt(m.groups!['oldLines']!, 10) : 1;
  const newStart = parseInt(m.groups!['newStart']!, 10);
  const newLines = m.groups!['newLines'] ? parseInt(m.groups!['newLines']!, 10) : 1;
  const section = m.groups!['section']?.trim() || undefined;

  const out: DiffLine[] = [];
  let i = start + 1;
  let oldCursor = oldStart;
  let newCursor = newStart;

  while (i < lines.length) {
    const raw = lines[i]!;
    if (raw.startsWith('@@') || HEADER_DIFF.test(raw)) break;
    if (raw === '\\ No newline at end of file') {
      // No-op for our purposes; we don't currently surface this to rules.
      i++;
      continue;
    }
    if (raw === '') {
      // Some patches include a trailing empty line before the next file header.
      i++;
      // Peek; if next is another diff header or hunk, we're done.
      if (i >= lines.length || HEADER_DIFF.test(lines[i]!) || lines[i]!.startsWith('@@')) {
        break;
      }
      // Otherwise treat as a context line representing an actual blank line.
      out.push({ intent: 'context', oldLine: oldCursor, newLine: newCursor, text: '' });
      oldCursor++;
      newCursor++;
      continue;
    }
    const sigil = raw[0];
    const text = raw.slice(1);
    if (sigil === '+') {
      out.push({ intent: 'added', oldLine: null, newLine: newCursor, text });
      newCursor++;
    } else if (sigil === '-') {
      out.push({ intent: 'removed', oldLine: oldCursor, newLine: null, text });
      oldCursor++;
    } else if (sigil === ' ') {
      out.push({ intent: 'context', oldLine: oldCursor, newLine: newCursor, text });
      oldCursor++;
      newCursor++;
    } else {
      // Unknown sigil — stop. Should not happen on well-formed diffs.
      break;
    }
    i++;
  }

  return {
    hunk: { oldStart, oldLines, newStart, newLines, section, lines: out },
    advance: i - start,
  };
}
