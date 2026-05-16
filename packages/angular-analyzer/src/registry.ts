import {
  subscriptionLeakRule,
  nullWithoutGuardRule,
  templateMethodCallRule,
  trackByMissingRule,
  signalOverTriggerRule,
  indexedDbStaleReadRule,
} from './rules/index.js';

type AnyRule = typeof subscriptionLeakRule
  | typeof nullWithoutGuardRule
  | typeof templateMethodCallRule
  | typeof trackByMissingRule
  | typeof signalOverTriggerRule
  | typeof indexedDbStaleReadRule;

export const ALL_RULES: ReadonlyArray<AnyRule> = [
  subscriptionLeakRule,
  nullWithoutGuardRule,
  templateMethodCallRule,
  trackByMissingRule,
  signalOverTriggerRule,
  indexedDbStaleReadRule,
];

export type AnalyzerRule = AnyRule;
