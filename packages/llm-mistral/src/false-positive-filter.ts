import type { Finding } from '@abid/core';
import type { MistralClient } from './client.js';
import { fillPrompt, type PromptLoader } from './prompt-loader.js';

/**
 * False-positive filter. For each scored finding, we give the model:
 *   - the finding's structured details (rule, location, evidence, guarantees)
 *   - the surrounding code snippet (head revision)
 *   - the rule-specific guidance on what would invalidate the finding
 *
 * The model returns a JSON object: `{ agreement: 0..1, reason: string }`.
 *
 * We don't ask "is this a bug?" open-endedly. We ask whether the *specific*
 * pre-identified bug pattern applies *given the surrounding context*. This
 * narrowing is what makes the model's answer reliable — it's a yes/no with
 * justification rather than open-ended code review.
 */
export interface CodeContext {
  /** Repo-relative head-revision path. */
  file: string;
  /** ~30 lines around the finding location. */
  snippet: string;
  /** Optional template snippet for cross-binding rules. */
  templateSnippet?: string;
}

export interface FilterResult {
  /** 0..1 — how much the model agrees that the finding is real here. */
  agreement: number;
  /** Short justification (<200 chars). Stored in audit log. */
  reason: string;
  /** True when the response failed JSON parsing — caller treats as 0.0 agreement. */
  parseError?: boolean;
}

export interface FilterDeps {
  mistral: MistralClient;
  prompts: PromptLoader;
}

export async function filterFinding(
  finding: Finding,
  ctx: CodeContext,
  deps: FilterDeps,
): Promise<FilterResult> {
  const template = deps.prompts.load('false-positive-filter');
  const prompt = fillPrompt(template, {
    rule_id: finding.ruleId,
    title: finding.message.title,
    evidence_json: JSON.stringify(finding.evidence, null, 2),
    guarantees_json: JSON.stringify(finding.guarantees, null, 2),
    file: ctx.file,
    code: ctx.snippet,
    template: ctx.templateSnippet ?? '',
  });

  const res = await deps.mistral.chat({
    messages: [
      { role: 'system', content: 'You answer strictly in JSON. Output only the JSON object, no prose.' },
      { role: 'user', content: prompt },
    ],
    responseFormat: 'json_object',
    temperature: 0.0,
    maxTokens: template.meta.maxTokens ?? 256,
  });

  try {
    const parsed = JSON.parse(res.content) as { agreement: number; reason: string };
    return {
      agreement: clamp01(parsed.agreement),
      reason: String(parsed.reason ?? '').slice(0, 200),
    };
  } catch {
    return { agreement: 0, reason: 'parse-error', parseError: true };
  }
}

function clamp01(x: number): number {
  if (typeof x !== 'number' || Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
