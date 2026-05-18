/**
 * Thresholds decide what happens to a scored finding:
 *
 *   confidence >= postFloor       → post as inline comment
 *   summarizeFloor <= confidence < postFloor  → include in PR summary only
 *   confidence < summarizeFloor   → drop (kept in internal log)
 *
 * Defaults are conservative. Per-tenant overrides arrive through the
 * orchestrator's config loader and replace these values.
 */
export interface Thresholds {
  postFloor: number;
  summarizeFloor: number;
  /** Per-rule overrides. When present, this overrides the global postFloor for that rule only. */
  perRulePostFloor?: Record<string, number>;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  postFloor: 0.75,
  summarizeFloor: 0.45,
  perRulePostFloor: {
    // Subjective or architecture-only findings need human-level proof before
    // becoming active inline comments. Keep them summary-only by default.
    'angular/large-component-complexity': 0.95,
    'angular/large-method-complexity': 0.95,
    'angular/service-responsibility-sprawl': 0.95,
    'angular/unused-import': 0.95,
    'angular/explicit-any': 0.95,
    'angular/dead-private-member': 0.95,
    'angular/signal-over-trigger': 0.90,
    'angular/trackby-missing': 0.90,
    'angular/template-method-call': 0.85,
    'angular/template-complex-expression': 0.90,
    'angular/default-cd-hot-template': 0.95,
  },
};

export type Disposition = 'post' | 'summarize' | 'drop';

export function classify(
  ruleId: string,
  confidence: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Disposition {
  const postFloor = thresholds.perRulePostFloor?.[ruleId] ?? thresholds.postFloor;
  if (confidence >= postFloor) return 'post';
  if (confidence >= thresholds.summarizeFloor) return 'summarize';
  return 'drop';
}
