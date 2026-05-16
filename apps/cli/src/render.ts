import kleur from 'kleur';
import type { Finding } from '@abid/core';

/**
 * Pretty-print findings to the terminal. We render in the same shape a PR
 * comment would have: title, body, optional suggestion block, siblings,
 * footer with rule id + confidence. Helps the user see exactly what would
 * be posted to ADO.
 */
export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return kleur.dim('No findings worth posting.');
  }

  const lines: string[] = [];
  const posted = findings.filter((f) => f.stage === 'posted' || f.stage === 'rewritten' || f.stage === 'clustered');
  const summarized = findings.filter((f) => f.stage === 'summarized');
  const dropped = findings.filter((f) => f.stage === 'dropped');

  lines.push('');
  lines.push(kleur.bold().cyan(`━━━ ${posted.length} comment(s) to post ━━━`));
  posted.forEach((f, i) => lines.push(renderOne(f, i + 1)));

  if (summarized.length > 0) {
    lines.push('');
    lines.push(kleur.bold().yellow(`━━━ ${summarized.length} lower-confidence note(s) (PR summary only) ━━━`));
    summarized.forEach((f) => {
      lines.push(`  ${kleur.yellow('·')} ${f.message.title} ${kleur.dim(`(${f.location.file}:${f.location.startLine}, conf ${f.confidence.toFixed(2)})`)}`);
    });
  }

  if (dropped.length > 0) {
    lines.push('');
    lines.push(kleur.dim(`${dropped.length} finding(s) dropped (${groupDropReasons(dropped)})`));
  }

  return lines.join('\n');
}

function renderOne(f: Finding, n: number): string {
  const parts: string[] = [];
  parts.push('');
  parts.push(kleur.bold(`#${n}  ${f.message.title}`));
  parts.push(
    kleur.dim('     ') +
    kleur.dim(`${f.location.file}:${f.location.startLine}`) +
    kleur.dim('   ') +
    kleur.dim(`[${f.ruleId}]`) +
    kleur.dim('   ') +
    kleur.dim(`confidence ${f.confidence.toFixed(2)}`),
  );
  parts.push('');
  for (const line of (f.message.body || '(no body — voice rewrite failed)').split('\n')) {
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
  return parts.join('\n');
}

function groupDropReasons(dropped: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of dropped) {
    const r = f.dispositionReason ?? 'unknown';
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts].map(([r, n]) => `${n}× ${r}`).join(', ');
}
