/**
 * Voice linter — regex rejection list of phrases that violate the project's
 * comment voice (see docs/COMMENT_VOICE.md). The voice-rewrite step re-prompts
 * if the linter rejects; after 2 retries the finding is dropped.
 */
const BANNED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bconsider\b/i, reason: 'banned: "consider"' },
  { pattern: /\bpotential(ly)?\b/i, reason: 'banned: "potential(ly)"' },
  { pattern: /\bmight want to\b/i, reason: 'banned: "might want to"' },
  { pattern: /\b(it is|its) generally\b/i, reason: 'banned: "it is generally"' },
  { pattern: /\bbest practice\b/i, reason: 'banned: "best practice"' },
  { pattern: /\bI (think|believe|suggest)\b/i, reason: 'banned: first-person hedging' },
  { pattern: /\bI'm not sure\b/i, reason: 'banned: "I\'m not sure"' },
  { pattern: /\brefactor for maintainability\b/i, reason: 'banned: vague "refactor for maintainability"' },
  { pattern: /\bcould be improved\b/i, reason: 'banned: vague "could be improved"' },
  { pattern: /\b(may|might) be (a |an )?potential\b/i, reason: 'banned: "may be a potential"' },
  // URLs except markdown-fenced code blocks indicate possible prompt-injection escapes.
  { pattern: /https?:\/\//, reason: 'banned: URL in output' },
];

export interface LintResult {
  ok: boolean;
  reasons: string[];
}

export function lintVoice(body: string): LintResult {
  const reasons: string[] = [];
  for (const b of BANNED_PATTERNS) {
    if (b.pattern.test(body)) reasons.push(b.reason);
  }
  // Length: bodies should be short. >2400 chars is almost certainly the model
  // wandering off into explanation. We reject and re-prompt.
  if (body.length > 2400) reasons.push('banned: body > 2400 chars');

  return { ok: reasons.length === 0, reasons };
}
