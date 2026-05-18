import type { Evidence, Finding } from '@abid/core';

export type ExactSuggestionResult =
  | { ok: true; suggestion: string; reason: string }
  | { ok: false; reason: string };

/**
 * Convert a rule's small fix hint into the exact replacement text Azure DevOps
 * needs for a ```suggestion block. If we cannot prove the replacement maps to
 * the selected line range, we return false and the reviewer falls back to text.
 */
export function buildExactSuggestion(finding: Finding, targetText: string): ExactSuggestionResult {
  const target = normalizeNewlines(targetText).replace(/\n$/, '');

  if (finding.ruleId === 'angular/unused-import') {
    return buildUnusedImportSuggestion(finding, target);
  }

  const raw = finding.message.suggestion;
  if (raw === undefined) return { ok: false, reason: 'finding has no suggested code' };
  const suggestion = normalizeNewlines(raw).trim();
  if (!suggestion) return { ok: false, reason: 'suggested code is empty' };
  if (hasUnsafePlaceholder(suggestion)) return { ok: false, reason: 'suggested code contains placeholders or comments' };

  for (const candidate of oldCodeCandidates(finding)) {
    if (!candidate || !target.includes(candidate)) continue;
    if (suggestion.includes('\n') && !candidate.includes('\n')) {
      return { ok: false, reason: 'multi-line replacement for a sub-line target is not deterministic' };
    }
    return {
      ok: true,
      suggestion: target.replace(candidate, suggestion),
      reason: 'replacement was mapped to the exact changed line text',
    };
  }

  return { ok: false, reason: 'suggested code could not be mapped to the selected line' };
}

function buildUnusedImportSuggestion(finding: Finding, target: string): ExactSuggestionResult {
  const label = unusedImportLabel(finding);
  if (!label) return { ok: false, reason: 'unused import label was not found' };

  const namedImport = /^(\s*import\s*\{\s*)([^}]+)(\}\s*from\s*['"][^'"]+['"];?\s*)$/.exec(target);
  if (namedImport) {
    const before = namedImport[1]!;
    const members = namedImport[2]!.split(',').map((member) => member.trim()).filter(Boolean);
    const after = namedImport[3]!;
    const remaining = members.filter((member) => !importMemberMatches(member, label));
    if (remaining.length === members.length) {
      return { ok: false, reason: 'unused import was not found in the import list' };
    }
    return {
      ok: true,
      suggestion: remaining.length > 0 ? `${before}${remaining.join(', ')} ${after}`.replace(/\s+\}/, ' }') : '',
      reason: 'unused import can be removed from the exact import line',
    };
  }

  if (new RegExp(`^\\s*import\\s+(\\*\\s+as\\s+)?${escapeRegex(label)}\\b`).test(target)) {
    return {
      ok: true,
      suggestion: '',
      reason: 'unused default or namespace import can be removed from the exact import line',
    };
  }

  return { ok: false, reason: 'import statement shape is not safe to rewrite' };
}

function oldCodeCandidates(finding: Finding): string[] {
  const out: string[] = [];
  for (const evidence of finding.evidence) {
    if (evidence.kind === 'ast' && evidence.snippet) out.push(normalizeNewlines(evidence.snippet).trim());
    if (evidence.kind === 'template-binding') out.push(evidence.expression.trim());
  }

  return unique(out)
    .filter((candidate) => candidate.length > 0 && !hasUnsafePlaceholder(candidate))
    .sort((a, b) => b.length - a.length);
}

function unusedImportLabel(finding: Finding): string | undefined {
  const ast = finding.evidence.find((e): e is Extract<Evidence, { kind: 'ast' }> => e.kind === 'ast');
  const match = /^(.+?) is imported but not referenced\b/.exec(ast?.description ?? '');
  return match?.[1]?.trim();
}

function importMemberMatches(member: string, label: string): boolean {
  if (member === label) return true;
  const aliasMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(member);
  return aliasMatch?.[1] === label;
}

function hasUnsafePlaceholder(text: string): boolean {
  return /\.\.\./.test(text)
    || /(^|\n)\s*\/\//.test(text)
    || /\/\*/.test(text)
    || /\b(TODO|FIXME|example|placeholder|keep the|prefer)\b/i.test(text);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
