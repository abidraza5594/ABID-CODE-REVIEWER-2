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
  rulePrecision: number;
  typeCorroboration: number;
  guaranteePenalty: number;
  runtimeCorroboration: number;
  crossFile: number;
  llmAgreement: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  rulePrecision: 0.25,
  typeCorroboration: 0.15,
  guaranteePenalty: 0.25, // applied as a SUBTRACTION when guarantees are present
  runtimeCorroboration: 0.20,
  crossFile: 0.10,
  llmAgreement: 0.20,
};

export function scoreFinding(inputs: ScoreInputs, weights: ScoreWeights = DEFAULT_WEIGHTS): ScoreResult {
  const breakdown: Record<string, number> = {};

  // Rule precision contributes baseline.
  const rule = clamp01(inputs.rulePrecision) * weights.rulePrecision;
  breakdown['rule'] = rule;

  // Type corroboration: a TypeEvidence that explicitly allows nullish (for null-check rules)
  // or has typeText present and informative.
  const hasTypeCorrob = inputs.evidence.some((e) => e.kind === 'type' && e.allowsNullish);
  const typeC = (hasTypeCorrob ? 1 : 0) * weights.typeCorroboration;
  breakdown['type'] = typeC;

  // Runtime: any RuntimeMetricEvidence or HeapDiffEvidence above its threshold.
  const hasRuntime = inputs.evidence.some((e) => {
    if (e.kind === 'runtime') return e.threshold === undefined || e.value >= (e.threshold ?? 0);
    return e.kind === 'heap' || e.kind === 'network';
  });
  const runtimeC = (hasRuntime ? 1 : 0) * weights.runtimeCorroboration;
  breakdown['runtime'] = runtimeC;

  // Cross-file: multiple matches increase confidence.
  const cross = inputs.evidence.find((e) => e.kind === 'cross-file');
  const crossC = cross && cross.kind === 'cross-file' && cross.matches.length >= 2
    ? Math.min(1, cross.matches.length / 5)
    : 0;
  breakdown['cross-file'] = crossC * weights.crossFile;

  // LLM agreement.
  const llmC = (inputs.llmAgreement ?? 0) * weights.llmAgreement;
  breakdown['llm'] = llmC;

  // Guarantee penalty: each present guarantee removes a portion of confidence.
  // We use a soft penalty that saturates so a single strong guarantee doesn't
  // *necessarily* drop a confidently corroborated finding below the floor.
  const guarPenalty = guaranteeStrength(inputs.guarantees) * weights.guaranteePenalty;
  breakdown['guarantee-penalty'] = -guarPenalty;

  const raw = rule + typeC + runtimeC + breakdown['cross-file']! + llmC - guarPenalty;
  // Squash through a soft cap; once we're above 0.95 we don't reward further.
  const squashed = raw <= 0.95 ? raw : 0.95 + (1 - Math.exp(-(raw - 0.95) * 4)) * 0.05;
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
