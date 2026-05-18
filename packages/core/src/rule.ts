import type { Finding, Severity } from './finding.js';

/**
 * The contract every rule implements. Rules are pure functions over the
 * typed AST + context. They do not perform IO, they do not call the LLM,
 * they do not post comments. They produce structured findings with evidence.
 */
export interface Rule<Ctx = unknown> {
  id: string;                         // "angular/subscription-leak"
  category: RuleCategory;
  severity: Severity;
  /** Intrinsic calibrated precision — feeds the confidence engine. */
  basePrecision: number;
  /** If true, the orchestrator may invoke runtime-runner to corroborate. */
  needsRuntime?: boolean;
  /** Human-readable description for dashboards / docs. */
  description: string;

  run(ctx: Ctx): Promise<Finding[]> | Finding[];
}

export type RuleCategory =
  | 'lifecycle'
  | 'change-detection'
  | 'state-sync'
  | 'rxjs'
  | 'memory'
  | 'indexeddb-cache'
  | 'runtime'
  | 'performance'
  | 'architecture'
  | 'maintainability'
  | 'typing'
  | 'async-handling'
  | 'error-handling'
  | 'forms'
  | 'di'
  | 'ssr-hydration'
  | 'security';

export interface RuleConfig {
  /** Enable/disable per repo. */
  enabled: boolean;
  /** Per-rule confidence floor override. */
  confidenceFloor?: number;
  /** Severity override (a repo can dial subscription-leak to error). */
  severity?: Severity;
}

export type RuleRegistry = Map<string, Rule<unknown>>;
