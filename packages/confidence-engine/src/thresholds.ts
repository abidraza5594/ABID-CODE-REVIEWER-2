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
  summarizeFloor: 0.50,
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
