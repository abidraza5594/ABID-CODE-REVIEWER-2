import type { Finding } from '@abid/core';
import type { MistralClient } from './client.js';
import { fillPrompt, type PromptLoader } from './prompt-loader.js';
import { lintVoice } from './voice-linter.js';

/**
 * Voice rewrite. Takes a structured Finding and produces a plain-English body
 * following docs/COMMENT_VOICE.md. The output must:
 *   - pass the voice linter
 *   - fit a JSON schema (title, body, suggestion?)
 *
 * On linter rejection we re-prompt up to 2 times. On the third failure we
 * mark the finding as 'dropped' with reason 'voice-lint-failed'.
 */
export interface RewriteResult {
  ok: boolean;
  title?: string;
  body?: string;
  suggestion?: string;
  /** Reasons from linter when ok is false. */
  reasons?: string[];
}

export interface RewriteDeps {
  mistral: MistralClient;
  prompts: PromptLoader;
}

export async function rewriteFinding(finding: Finding, deps: RewriteDeps): Promise<RewriteResult> {
  const template = deps.prompts.load('voice-rewrite');

  let attempt = 0;
  let priorIssues: string[] = [];

  while (attempt < 3) {
    const prompt = fillPrompt(template, {
      rule_id: finding.ruleId,
      title_hint: finding.message.title,
      severity: finding.severity,
      evidence_json: JSON.stringify(finding.evidence, null, 2),
      suggestion_hint: finding.message.suggestion ?? '',
      suggestion_lang: finding.message.suggestionLanguage ?? 'ts',
      prior_lint_failures: priorIssues.join(', ') || 'none',
    });

    const res = await deps.mistral.chat({
      messages: [
        { role: 'system', content: 'You answer strictly in JSON. Output only the JSON object, no prose. Follow the project voice rules listed in the prompt.' },
        { role: 'user', content: prompt },
      ],
      responseFormat: 'json_object',
      temperature: 0.15,
      maxTokens: 512,
    });

    let parsed: { title?: string; body?: string; suggestion?: string };
    try {
      parsed = JSON.parse(res.content);
    } catch {
      priorIssues = ['previous response was not valid JSON'];
      attempt++;
      continue;
    }

    const body = String(parsed.body ?? '');
    const lint = lintVoice(body);
    if (!lint.ok) {
      priorIssues = lint.reasons;
      attempt++;
      continue;
    }

    return {
      ok: true,
      title: String(parsed.title ?? finding.message.title).slice(0, 80),
      body,
      ...(parsed.suggestion ? { suggestion: String(parsed.suggestion) } : {}),
    };
  }

  return { ok: false, reasons: priorIssues };
}
