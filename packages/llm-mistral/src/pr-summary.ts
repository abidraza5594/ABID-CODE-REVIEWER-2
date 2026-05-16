import type { Finding } from '@abid/core';
import type { MistralClient } from './client.js';
import { fillPrompt, type PromptLoader } from './prompt-loader.js';

/**
 * PR summary. Single thread posted at PR level that aggregates:
 *   - posted findings (titles only, with links to inline threads)
 *   - summarized findings (those between 0.50 and 0.75 confidence)
 *   - per-rule counts
 *   - runtime evidence collected (heap delta, render counts) when present
 *
 * The summary is deterministic structurally; the LLM only writes the opening
 * "what changed" paragraph.
 */
export interface SummaryInputs {
  prTitle: string;
  filesChangedCount: number;
  posted: Finding[];
  summarized: Finding[];
}

export interface SummaryDeps {
  mistral: MistralClient;
  prompts: PromptLoader;
}

export async function buildPrSummary(inputs: SummaryInputs, deps: SummaryDeps): Promise<string> {
  // Deterministic section.
  const lines: string[] = [];
  lines.push(`## Review summary`);
  lines.push('');

  if (inputs.posted.length === 0 && inputs.summarized.length === 0) {
    lines.push('No findings worth posting. Nice work.');
    return lines.join('\n');
  }

  // LLM-written intro (one short paragraph).
  const template = deps.prompts.load('pr-summary-intro');
  const prompt = fillPrompt(template, {
    pr_title: inputs.prTitle,
    files_changed: String(inputs.filesChangedCount),
    posted_count: String(inputs.posted.length),
    summarized_count: String(inputs.summarized.length),
    posted_titles_json: JSON.stringify(inputs.posted.map((f) => ({ rule: f.ruleId, title: f.message.title }))),
  });
  const res = await deps.mistral.chat({
    messages: [
      { role: 'system', content: 'You write a single short paragraph in plain English. No headings, no lists, no markdown.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    maxTokens: 200,
  });

  lines.push(res.content.trim());
  lines.push('');

  // Posted section.
  if (inputs.posted.length > 0) {
    lines.push('### Comments posted on lines');
    for (const f of inputs.posted) {
      lines.push(`- **${f.message.title}** — [${f.location.file}:${f.location.startLine}](${f.location.file}#L${f.location.startLine})`);
    }
    lines.push('');
  }

  // Summarized (kept here, not posted inline).
  if (inputs.summarized.length > 0) {
    lines.push('### Lower-confidence notes (not posted inline)');
    for (const f of inputs.summarized) {
      lines.push(`- ${f.message.title} — \`${f.location.file}:${f.location.startLine}\``);
    }
    lines.push('');
  }

  // Per-rule counts.
  const counts = new Map<string, number>();
  for (const f of [...inputs.posted, ...inputs.summarized]) {
    counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  }
  lines.push('### By rule');
  for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${rule}\`: ${n}`);
  }

  return lines.join('\n');
}
