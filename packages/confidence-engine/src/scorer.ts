import type { Evidence, Finding, Guarantee } from '@abid/core';

/**
 * Weighted-ensemble confidence scorer.
 *
 * Inputs:
 *   - the finding's intrinsic rule precision (passed in via `rulePrecision`)
 *   - structural signals from evidence/guarantees
 *   - LLM-agreement signal (when available)
 *
 * Output: a scalar in [0, 1]. We bound the final score to avoid overshooting
 * on a single signal pile-up — once you're at 0.95, you don't go higher just
 * because three weak signals lined up.
 *
 * Calibration: per-tenant overrides come from `applyCalibration(...)`. Without
 * calibration the default weights below are reasonable; they were chosen to
 * make the subscription-leak rule's "obviously real" examples hit 0.90, and
 * "could be intentional" examples land around 0.55.
 */
export interface ScoreInputs {
  rulePrecision: number;          // 0..1
  evidence: Evidence[];
  guarantees: Guarantee[];
  llmAgreement?: number;          // 0..1, set by the false-positive filter step
}

export interface ScoreResult {
  confidence: number;
  breakdown: Record<string, number>;
}

export interface ScoreWeights {
  /** Floor: even with zero LLM agreement, this fraction of rule precision survives. */
  rulePrecisionFloor: number;
  /** Multiplier on rule precision when LLM fully agrees. */
  rulePrecisionCeiling: number;
  /** Default LLM agreement when the filter step wasn't run. 0.5 = neutral. */
  llmDefault: number;
  /** Additive boosts. */
  typeCorroboration: number;
  templateCorroboration: number;
  runtimeCorroboration: number;
  crossFile: number;
  /** Multiplicative guarantee penalty (1 - strength). */
  guaranteePenalty: number;
}

/**
 * Default weights — rule precision is the primary signal; LLM modulates;
 * runtime/cross-file evidence is additive on top.
 *
 * Worked example (subscription-leak, basePrecision = 0.85):
 *   LLM agrees (0.8) →  0.85 * (0.35 + 0.55*0.8) = 0.85 * 0.79 ≈ 0.67  → POST
 *   LLM neutral (0.5) → 0.85 * (0.35 + 0.55*0.5) = 0.85 * 0.625 ≈ 0.53 → POST (barely)
 *   LLM 0.2          →  0.85 * (0.35 + 0.55*0.2) = 0.85 * 0.46 ≈ 0.39  → SUMMARIZE
 *   LLM rejects (0.0)→  0.85 * 0.35 ≈ 0.30                              → DROP
 *
 * Add runtime corroboration → +0.15 ; cross-file (5+ files) → +0.10.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  rulePrecisionFloor: 0.35,
  rulePrecisionCeiling: 0.90,
  llmDefault: 0.5,
  typeCorroboration: 0.05,
  templateCorroboration: 0.05,
  runtimeCorroboration: 0.15,
  crossFile: 0.10,
  guaranteePenalty: 1.0,
};

export function scoreFinding(inputs: ScoreInputs, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoreResult {
  const breakdown: Record<string, number> = {};

  const rule = clamp01(inputs.rulePrecision);
  const llm = inputs.llmAgreement ?? weights.llmDefault;

  // The rule's contribution is rule precision scaled by an LLM-modulated factor.
  // floor + (ceiling - floor) * llm so when llm=0 we get floor, when llm=1 we get ceiling.
  const llmFactor = weights.rulePrecisionFloor + (weights.rulePrecisionCeiling - weights.rulePrecisionFloor) * llm;
  const ruleContribution = rule * llmFactor;
  breakdown['rule'] = rule;
  breakdown['llm'] = llm;
  breakdown['rule-llm'] = ruleContribution;

  // Additive evidence bonuses on top.
  const hasTypeCorrob = inputs.evidence.some((e) => e.kind === 'type' && e.allowsNullish);
  const typeC = (hasTypeCorrob ? 1 : 0) * weights.typeCorroboration;
  breakdown['type'] = typeC;

  const hasRuntime = inputs.evidence.some((e) => {
    if (e.kind === 'runtime') return e.threshold === undefined || e.value >= (e.threshold ?? 0);
    return e.kind === 'heap' || e.kind === 'network';
  });
  const runtimeC = (hasRuntime ? 1 : 0) * weights.runtimeCorroboration;
  breakdown['runtime'] = runtimeC;

  const hasTemplate = inputs.evidence.some((e) => e.kind === 'template-binding');
  const hasTemplateContext = hasTemplate && inputs.evidence.some((e) => e.kind === 'callgraph' || e.kind === 'runtime' || e.kind === 'type');
  const templateC = (hasTemplateContext ? 1 : 0) * weights.templateCorroboration;
  breakdown['template'] = templateC;

  const cross = inputs.evidence.find((e) => e.kind === 'cross-file');
  const crossMatches = cross && cross.kind === 'cross-file' ? cross.matches.length : 0;
  const crossC = crossMatches >= 2 ? Math.min(1, crossMatches / 5) * weights.crossFile : 0;
  breakdown['cross-file'] = crossC;

  // Multiplicative guarantee penalty: each guarantee shrinks the score toward zero
  // proportional to its strength. A 0.85 resolver guarantee with weight 1.0 cuts
  // the score to ~15% of its raw value.
  const guarPenalty = guaranteeStrength(inputs.guarantees) * weights.guaranteePenalty;
  const beforeGuar = ruleContribution + typeC + templateC + runtimeC + crossC;
  const afterGuar = beforeGuar * (1 - guarPenalty);
  breakdown['guarantee-penalty'] = -(beforeGuar - afterGuar);

  // Soft cap above 0.95 so signal pile-ups don't max out unrealistically.
  const squashed = afterGuar <= 0.95 ? afterGuar : 0.95 + (1 - Math.exp(-(afterGuar - 0.95) * 4)) * 0.05;
  const final = clamp01(squashed);

  breakdown['final'] = final;
  return { confidence: final, breakdown };
}

function guaranteeStrength(guarantees: Guarantee[]): number {
  // Each guarantee kind has a heuristic strength; combined sub-linearly.
  // We deliberately cap at 1.0 so that a finding with a hundred trivial guarantees
  // doesn't outweigh a single, definitive resolver guarantee.
  const STRENGTH: Record<Guarantee['kind'], number> = {
    'resolver': 0.85,
    'guard': 0.70,
    'type-narrowing': 0.60,
    'template-ngIf': 0.75,
    'default-init': 0.45,
    'destroy-hook': 0.40,
    'take-until-destroyed': 0.95,
    'async-pipe': 0.85,
    'on-push': 0.30,
  };

  let total = 0;
  for (const g of guarantees) {
    const s = STRENGTH[g.kind] ?? 0.3;
    // Sub-linear combine: total = 1 - (1 - total) * (1 - s)
    total = 1 - (1 - total) * (1 - s);
  }
  return Math.min(1, total);
}

export function applyScore(finding: Finding, inputs: ScoreInputs, weights?: ScoreWeights): Finding {
  const { confidence } = scoreFinding(inputs, weights);
  return { ...finding, confidence, stage: 'scored', updatedAt: new Date().toISOString() };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
