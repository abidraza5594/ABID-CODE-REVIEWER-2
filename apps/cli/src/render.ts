import kleur from 'kleur';
import type { Finding, ReviewCommentKind } from '@abid/core';

/**
 * Honest renderer. Groups findings by their final stage and shows the chosen
 * review interaction: suggestion, warning, architecture, blocker, or summary.
 */
export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return kleur.dim('No findings worth posting.');
  }

  const lines: string[] = [];
  const toPost = findings.filter((f) => f.stage === 'rewritten' || f.stage === 'posted');
  const summarized = findings.filter((f) => f.stage === 'summarized');
  const dropped = findings.filter((f) => f.stage === 'dropped');
  const leftover = findings.filter((f) => f.stage === 'clustered');

  if (toPost.length > 0) {
    lines.push('');
    lines.push(kleur.bold().green(`--- ${toPost.length} comment(s) ready to post ${renderKindCounts(toPost)} ---`));
    toPost.forEach((f, i) => lines.push(renderPost(f, i + 1)));
  } else {
    lines.push('');
    lines.push(kleur.bold().yellow('--- 0 comments crossed the post threshold ---'));
    lines.push(kleur.dim('   Nothing will be posted to ADO. See sections below for why.'));
  }

  if (summarized.length > 0) {
    lines.push('');
    lines.push(kleur.bold().yellow(`--- ${summarized.length} informational note(s) (summary only) ---`));
    summarized.forEach((f) => lines.push(renderShort(f, kleur.yellow)));
  }

  if (dropped.length > 0) {
    lines.push('');
    lines.push(kleur.bold().red(`--- ${dropped.length} finding(s) dropped ---`));
    dropped.forEach((f) => lines.push(renderShort(f, kleur.red)));
  }

  if (leftover.length > 0) {
    lines.push('');
    lines.push(kleur.bold().magenta(`! ${leftover.length} finding(s) in unexpected 'clustered' stage (bug)`));
    leftover.forEach((f) => lines.push(renderShort(f, kleur.magenta)));
  }

  return lines.join('\n');
}

function renderPost(f: Finding, n: number): string {
  const parts: string[] = [];
  const kind = f.review?.kind ?? 'warning';
  parts.push('');
  parts.push(kleur.bold().green(`#${n} ${labelFor(kind)}: ${f.message.title}`));
  parts.push(
    kleur.dim('     ') +
    kleur.dim(`${f.location.file}:${f.location.startLine}`) +
    kleur.dim('   ') +
    kleur.dim(`[${f.ruleId}]`) +
    kleur.dim('   ') +
    kleur.dim(`confidence ${f.confidence.toFixed(2)}`),
  );
  parts.push('');
  for (const line of (f.message.body || '(no body)').split('\n')) {
    parts.push('     ' + line);
  }

  if (f.message.suggestion !== undefined && f.review?.suggestionPresentation === 'azure-suggestion') {
    parts.push('');
    parts.push(kleur.dim('     suggestion (auto-apply)'));
    renderSuggestionLines(parts, f.message.suggestion);
  } else if (f.message.suggestion && f.review?.suggestionPresentation === 'code-example') {
    parts.push('');
    parts.push(kleur.dim('     suggested direction (manual review)'));
    renderSuggestionLines(parts, f.message.suggestion);
  }

  if (f.siblings && f.siblings.length > 0) {
    parts.push('');
    parts.push(kleur.dim('     Same issue also at:'));
    for (const s of f.siblings) parts.push(kleur.dim(`       - ${s.file}:${s.line}`));
  }
  if (f.notes || f.review?.rationale) {
    parts.push('');
    parts.push(kleur.dim('     ') + kleur.dim(f.review?.rationale ?? f.notes ?? ''));
  }
  return parts.join('\n');
}

function renderSuggestionLines(parts: string[], suggestion: string): void {
  const lines = suggestion.length > 0 ? suggestion.split('\n') : ['<delete selected line>'];
  for (const line of lines) {
    parts.push(kleur.green('       ') + line);
  }
}

function renderShort(f: Finding, color: (s: string) => string): string {
  const lines: string[] = [];
  lines.push(
    '  ' + color('-') + ' ' + f.message.title +
    kleur.dim(`  (${f.location.file}:${f.location.startLine}, ${f.review?.kind ?? f.stage}, conf ${f.confidence.toFixed(2)})`),
  );
  if (f.notes) {
    lines.push(kleur.dim('      -> ') + kleur.dim(f.notes));
  } else if (f.dispositionReason) {
    lines.push(kleur.dim('      -> ') + kleur.dim(`reason: ${f.dispositionReason}`));
  }
  return lines.join('\n');
}

function renderKindCounts(findings: Finding[]): string {
  const counts = new Map<ReviewCommentKind, number>();
  for (const finding of findings) {
    const kind = finding.review?.kind ?? 'warning';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const text = [...counts.entries()].map(([kind, count]) => `${count} ${labelFor(kind).toLowerCase()}`).join(', ');
  return text ? `(${text})` : '';
}

function labelFor(kind: ReviewCommentKind): string {
  switch (kind) {
    case 'inline-suggestion':
      return 'Suggestion';
    case 'warning':
      return 'Warning';
    case 'architecture':
      return 'Architecture';
    case 'blocker':
      return 'Blocker';
    case 'informational':
      return 'Information';
  }
}
