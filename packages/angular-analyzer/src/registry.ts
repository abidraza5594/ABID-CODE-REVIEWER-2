import {
  subscriptionLeakRule,
  nullWithoutGuardRule,
  templateMethodCallRule,
  trackByMissingRule,
  signalOverTriggerRule,
  indexedDbStaleReadRule,
  deprecatedToPromiseRule,
  subscribeMissingErrorHandlerRule,
  nestedSubscribeRule,
  formControlGetNullRule,
  eventListenerLeakRule,
} from './rules/index.js';
import type { RawFinding, RuleContext } from './rule-context.js';

export interface AnalyzerRule {
  id: string;
  category: string;
  severity: 'warn' | 'info';
  basePrecision: number;
  needsRuntime?: boolean;
  description: string;
  run(ctx: RuleContext): RawFinding[];
}

export const ALL_RULES: ReadonlyArray<AnalyzerRule> = [
  subscriptionLeakRule,
  nullWithoutGuardRule,
  templateMethodCallRule,
  trackByMissingRule,
  signalOverTriggerRule,
  indexedDbStaleReadRule,
  deprecatedToPromiseRule,
  subscribeMissingErrorHandlerRule,
  nestedSubscribeRule,
  formControlGetNullRule,
  eventListenerLeakRule,
];
