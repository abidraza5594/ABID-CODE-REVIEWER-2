import type {
  Finding,
  ReviewCommentKind,
  ReviewDecision,
  ReviewIssueType,
  SuggestionPresentation,
} from '@abid/core';
import type { Disposition } from './thresholds.js';

export interface ReviewDecisionInput {
  disposition: Disposition;
  exactAddedLine: boolean;
  hasExactAutoFix: boolean;
}

const AUTO_FIX_CONFIDENCE_FLOOR = 0.80;
const BLOCKER_CONFIDENCE_FLOOR = 0.80;

const SAFE_AUTO_FIX_RULES = new Set([
  'angular/ts-null-dereference',
  'angular/null-without-guard',
  'angular/unused-import',
]);

const ARCHITECTURE_RULES = new Set([
  'angular/large-component-complexity',
  'angular/large-method-complexity',
  'angular/service-responsibility-sprawl',
]);

const MANUAL_REVIEW_RULES = new Set([
  'angular/subscription-leak',
  'angular/event-listener-leak',
  'angular/nested-subscribe',
  'angular/duplicate-api-request',
  'angular/api-call-in-loop',
  'angular/async-missing-error-boundary',
  'angular/async-lifecycle-hook',
  'angular/template-method-call',
  'angular/template-complex-expression',
  'angular/default-cd-hot-template',
  'angular/direct-dom-mutation',
  'angular/xss-sanitizer-bypass',
  'angular/browser-global-ssr',
  'angular/manual-service-instantiation',
  'angular/circular-import',
  'angular/store-local-mirror',
  'angular/blocking-sync-operation',
]);

export function decideReviewAction(finding: Finding, input: ReviewDecisionInput): ReviewDecision {
  const issueType = classifyIssueType(finding);
  const autoFixable = isSafeAutoFix(finding, input);
  const architecture = isArchitectureReview(finding);
  const blocker = isBlocker(finding, issueType);
  const belowInlineFloor = input.disposition === 'drop';
  const summaryOnly = !input.exactAddedLine || belowInlineFloor;

  let kind: ReviewCommentKind;
  if (summaryOnly) {
    kind = 'informational';
  } else if (blocker) {
    kind = 'blocker';
  } else if (architecture) {
    kind = 'architecture';
  } else if (autoFixable) {
    kind = 'inline-suggestion';
  } else if (input.disposition === 'summarize' || finding.severity === 'info') {
    kind = 'informational';
  } else {
    kind = 'warning';
  }

  const postInline =
    kind !== 'informational' &&
    input.exactAddedLine &&
    (input.disposition === 'post' || autoFixable || blocker);
  const suggestionPresentation = suggestionPresentationFor(kind, autoFixable, finding);
  const requiresManualReview = !autoFixable && (kind === 'warning' || kind === 'architecture' || kind === 'blocker' || MANUAL_REVIEW_RULES.has(finding.ruleId));

  return {
    kind,
    issueType,
    postInline,
    autoFixable,
    suggestionPresentation,
    requiresManualReview,
    threadStatus: kind === 'informational' ? 'closed' : 'active',
    rationale: rationaleFor(finding, input, kind, autoFixable),
  };
}

function isSafeAutoFix(finding: Finding, input: ReviewDecisionInput): boolean {
  if (!SAFE_AUTO_FIX_RULES.has(finding.ruleId)) return false;
  if (!input.exactAddedLine || !input.hasExactAutoFix) return false;
  if (finding.confidence < AUTO_FIX_CONFIDENCE_FLOOR) return false;
  if (finding.guarantees.length > 0) return false;
  if (hasRuntimeOrCrossFileEvidence(finding)) return false;
  return true;
}

function isBlocker(finding: Finding, issueType: ReviewIssueType): boolean {
  if (finding.confidence < BLOCKER_CONFIDENCE_FLOOR) return false;
  if (issueType === 'security' || issueType === 'ssr') return true;
  if (finding.ruleId === 'angular/signal-write-in-computation') return true;
  if (finding.ruleId === 'angular/blocking-sync-operation' && hasRuntimeEvidence(finding)) return true;
  if (finding.ruleId === 'angular/subscription-leak' && hasLeakedSubscriptionEvidence(finding)) return true;
  if (finding.ruleId === 'angular/event-listener-leak' && hasRuntimeEvidence(finding)) return true;
  if (finding.ruleId === 'angular/ts-null-dereference' && finding.confidence >= 0.88) return true;
  return false;
}

function isArchitectureReview(finding: Finding): boolean {
  if (!ARCHITECTURE_RULES.has(finding.ruleId)) return false;
  if (finding.confidence < 0.90) return false;
  return finding.evidence.some((e) => {
    if (e.kind === 'cross-file') return e.matches.length >= 2;
    if (e.kind === 'runtime') return e.value >= (e.threshold ?? 1);
    return false;
  });
}

function suggestionPresentationFor(
  kind: ReviewCommentKind,
  autoFixable: boolean,
  finding: Finding,
): SuggestionPresentation {
  if (autoFixable && kind === 'inline-suggestion') return 'azure-suggestion';
  if (finding.message.suggestion && (kind === 'warning' || kind === 'architecture' || kind === 'blocker')) {
    return 'code-example';
  }
  return 'none';
}

function rationaleFor(
  finding: Finding,
  input: ReviewDecisionInput,
  kind: ReviewCommentKind,
  autoFixable: boolean,
): string {
  if (!input.exactAddedLine) {
    return 'Summary only because the finding is not on the exact added line.';
  }
  if (input.disposition === 'drop') {
    return 'Dropped from inline review because confidence is below the review floor.';
  }
  if (autoFixable) {
    return 'Auto-fix enabled because the patch is exact, isolated, and high-confidence.';
  }
  if (kind === 'blocker') {
    return 'Blocker because the evidence points to production-breaking risk.';
  }
  if (kind === 'architecture') {
    return 'Architecture comment because cross-file or runtime evidence proves real impact.';
  }
  if (kind === 'informational') {
    return 'Summary only because this is optional or lower-confidence.';
  }
  return 'Warning because the issue matters, but the fix needs human judgment.';
}

export function classifyIssueType(finding: Finding): ReviewIssueType {
  const rule = finding.ruleId;
  if (/xss|sanitizer|security/i.test(rule)) return 'security';
  if (/ssr|browser-global|hydration/i.test(rule)) return 'ssr';
  if (/null|optional|undefined/i.test(rule)) return 'null-safety';
  if (/error|boundary/i.test(rule)) return 'error-handling';
  if (/promise|async|lifecycle/i.test(rule)) return 'async-flow';
  if (/subscribe|rxjs|event-listener/i.test(rule)) return 'rxjs-lifecycle';
  if (/trackby|template|change-detection|api-call|duplicate-api|loop|dom|blocking/i.test(rule)) return 'performance';
  if (/architecture|component-complexity|method-complexity|service-responsibility|circular|instantiation/i.test(rule)) return 'architecture';
  if (/any|typing/i.test(rule)) return 'typing';
  if (/unused|dead|maintain/i.test(rule)) return 'maintainability';
  if (/signal|store|state|indexeddb/i.test(rule)) return 'state';
  if (/form/i.test(rule)) return 'forms';
  return 'unknown';
}

function hasRuntimeOrCrossFileEvidence(finding: Finding): boolean {
  return finding.evidence.some((e) => e.kind === 'runtime' || e.kind === 'heap' || e.kind === 'network' || e.kind === 'cross-file');
}

function hasRuntimeEvidence(finding: Finding): boolean {
  return finding.evidence.some((e) => e.kind === 'runtime' || e.kind === 'heap');
}

function hasLeakedSubscriptionEvidence(finding: Finding): boolean {
  return finding.evidence.some((e) => e.kind === 'runtime' && e.metric === 'subscription-open-without-close' && e.value >= (e.threshold ?? 1));
}
