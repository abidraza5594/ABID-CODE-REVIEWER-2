import kleur from 'kleur';
import type { Finding } from '@abid/core';

/**
 * Honest renderer. Groups findings by their FINAL stage so the user sees
 * exactly what will and won't be posted. No more "4 to post" headers when
 * nothing crosses the threshold.
 *
 * Stage → bucket:
 *   'rewritten' | 'posted'        → POST   (will be sent to ADO on confirm)
 *   'summarized'                  → SUMMARY-ONLY (in PR summary, not inline)
 *   'dropped'                     → DROPPED (with reason, for transparency)
 *   'clustered' (residual)        → ANOMALY (pipeline bug indicator)
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
    lines.push(kleur.bold().green(`━━━ ${toPost.length} comment(s) ready to post ━━━`));
    toPost.forEach((f, i) => lines.push(renderPost(f, i + 1)));
  } else {
    lines.push('');
    lines.push(kleur.bold().yellow('━━━ 0 comments crossed the post threshold ━━━'));
    lines.push(kleur.dim('   Nothing will be posted to ADO. See sections below for why.'));
  }

  if (summarized.length > 0) {
    lines.push('');
    lines.push(kleur.bold().yellow(`━━━ ${summarized.length} lower-confidence note(s) (PR summary only) ━━━`));
    summarized.forEach((f) => lines.push(renderShort(f, kleur.yellow)));
  }

  if (dropped.length > 0) {
    lines.push('');
    lines.push(kleur.bold().red(`━━━ ${dropped.length} finding(s) dropped ━━━`));
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
  parts.push('');
  parts.push(kleur.bold().green(`✓ #${n}  ${f.message.title}`));
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
  if (f.message.suggestion) {
    parts.push('');
    parts.push(kleur.dim('     ┌── suggestion ──'));
    for (const line of f.message.suggestion.split('\n')) {
      parts.push(kleur.green('     │ ') + line);
    }
    parts.push(kleur.dim('     └─────────────────'));
  }
  if (f.siblings && f.siblings.length > 0) {
    parts.push('');
    parts.push(kleur.dim('     Same issue also at:'));
    for (const s of f.siblings) parts.push(kleur.dim(`       · ${s.file}:${s.line}`));
  }
  if (f.notes) {
    parts.push('');
    parts.push(kleur.dim('     ') + kleur.dim(f.notes));
  }
  return parts.join('\n');
}

function renderShort(f: Finding, color: (s: string) => string): string {
  const lines: string[] = [];
  lines.push(
    '  ' + color('·') + ' ' + f.message.title +
    kleur.dim(`  (${f.location.file}:${f.location.startLine}, conf ${f.confidence.toFixed(2)})`),
  );
  if (f.notes) {
    lines.push(kleur.dim('      ↳ ') + kleur.dim(f.notes));
  } else if (f.dispositionReason) {
    lines.push(kleur.dim('      ↳ ') + kleur.dim(`reason: ${f.dispositionReason}`));
  }
  return lines.join('\n');
}
