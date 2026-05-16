/**
 * Per-tenant calibration model. The orchestrator periodically (weekly cron)
 * recomputes weights and per-rule precision from feedback data:
 *
 *   - posted comments that the author resolved without "not useful" → positive
 *   - posted comments the author refuted (reply contains a known phrase or
 *     the bot's reaction was thumbs-down) → negative
 *
 * The model fitted is a simple logistic regression over (rule_id × signal
 * features) → P(useful). The fitted coefficients are translated into:
 *
 *   - per-rule precision adjustment
 *   - per-rule post-floor override (if precision is consistently low, raise the bar)
 *
 * We deliberately *do not* learn a fully end-to-end neural classifier. The
 * confidence engine must be auditable — for every comment we post, we want a
 * one-page explanation of "why we said this".
 */

import type { Rule } from '@abid/core';

export interface CalibrationRecord {
  ruleId: string;
  /** Latest fitted precision, replaces the rule's intrinsic basePrecision. */
  precision: number;
  /** Optional override of the post threshold for this rule. */
  postFloor?: number;
  /** Number of samples this fit is based on — used to weight against the prior. */
  sampleCount: number;
  /** Wall-clock timestamp of the last fit. */
  fittedAt: string;
}

export class CalibrationModel {
  private byRule = new Map<string, CalibrationRecord>();

  upsert(record: CalibrationRecord): void {
    this.byRule.set(record.ruleId, record);
  }

  /** Returns the calibrated rule precision; falls back to base precision. */
  precisionFor(rule: Rule | { id: string; basePrecision: number }): number {
    const r = this.byRule.get(rule.id);
    if (!r) return rule.basePrecision;
    return blendPrecision(rule.basePrecision, r);
  }

  postFloorOverride(ruleId: string): number | undefined {
    return this.byRule.get(ruleId)?.postFloor;
  }

  /** All currently-fitted records — for dashboards / audits. */
  records(): CalibrationRecord[] {
    return [...this.byRule.values()];
  }
}

/**
 * Bayesian-style blend of base precision (the prior) with the fitted precision,
 * weighted by sample count. Low-sample fits barely move the prior. High-sample
 * fits dominate it. Avoids the "new rule with 3 false positives gets nuked"
 * failure mode.
 */
function blendPrecision(base: number, r: CalibrationRecord): number {
  const PRIOR_WEIGHT = 30; // equivalent samples for the base precision
  const num = base * PRIOR_WEIGHT + r.precision * r.sampleCount;
  const den = PRIOR_WEIGHT + r.sampleCount;
  return Math.min(1, Math.max(0, num / den));
}
