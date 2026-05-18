import type { Evidence } from './evidence.js';
import type { Guarantee } from './guarantee.js';
import type { SourceLocation } from './location.js';

export type Severity = 'info' | 'warn' | 'error';

/**
 * Stages of a finding's lifecycle. Used by both the pipeline and the audit log.
 */
export type FindingStage =
  | 'raw'           // emitted by a rule, not scored
  | 'scored'        // confidence-engine has run
  | 'filtered'      // LLM false-positive filter has run
  | 'rewritten'     // voice-rewrite has run
  | 'clustered'     // dedup-engine has run
  | 'posted'
  | 'summarized'
  | 'dropped';

export type DispositionReason =
  | 'below-confidence-floor'
  | 'guard-detected'
  | 'voice-lint-failed'
  | 'duplicate-of'
  | 'silent-mode'
  | 'not-on-added-line'
  | 'rule-disabled-for-repo'
  | 'rate-limited'
  | 'sibling'
  | 'informational'
  | 'manual-review-required';

export interface FindingMessage {
  /** Short summary, max ~80 chars. Used in PR summary and ADO thread title. */
  title: string;
  /** Plain-English body following docs/COMMENT_VOICE.md. Empty until LLM rewrite stage. */
  body: string;
  /** Optional concrete code suggestion. */
  suggestion?: string;
  /** Markdown language tag for the suggestion (`ts`, `html`, etc.). */
  suggestionLanguage?: 'ts' | 'html' | 'scss' | 'json';
}

export type ReviewCommentKind =
  | 'inline-suggestion'
  | 'warning'
  | 'architecture'
  | 'blocker'
  | 'informational';

export type ReviewIssueType =
  | 'null-safety'
  | 'error-handling'
  | 'async-flow'
  | 'rxjs-lifecycle'
  | 'performance'
  | 'architecture'
  | 'security'
  | 'ssr'
  | 'typing'
  | 'maintainability'
  | 'state'
  | 'forms'
  | 'unknown';

export type SuggestionPresentation =
  | 'azure-suggestion'
  | 'code-example'
  | 'none';

export interface ReviewDecision {
  /** How this should appear to the developer. */
  kind: ReviewCommentKind;
  /** The practical issue family behind the finding. */
  issueType: ReviewIssueType;
  /** False means summary panel only. No ADO inline thread should be posted. */
  postInline: boolean;
  /** True only when the patch is exact, deterministic, and low-risk. */
  autoFixable: boolean;
  /** Whether the suggestion should be an auto-apply ADO suggestion block. */
  suggestionPresentation: SuggestionPresentation;
  /** True when a person must understand behavior before changing code. */
  requiresManualReview: boolean;
  /** ADO thread status to use when posting inline. */
  threadStatus: 'active' | 'closed';
  /** Short audit reason for why this comment mode was chosen. */
  rationale: string;
}

export interface Finding {
  /** ULID. Stable across pipeline stages. */
  id: string;
  /** e.g. "angular/subscription-leak" */
  ruleId: string;
  severity: Severity;

  /** [0, 1]. Mutates as more signals come in (LLM filter, runtime trace, dedup). */
  confidence: number;

  /** Always head-revision coordinates. The poster maps to PR diff coordinates. */
  location: SourceLocation;

  /** Why we believe this is an issue. At least one required. */
  evidence: Evidence[];

  /** Why we might be wrong. Empty for high-confidence findings, often populated. */
  guarantees: Guarantee[];

  /** Sibling locations from dedup. Anchor's bullet list. */
  siblings?: Array<{ file: string; line: number }>;

  /** Linked runtime traces (object-store IDs). */
  runtimeRefs?: string[];

  message: FindingMessage;

  /** Final review interaction decision. Set after scoring, filtering, and exact patch checks. */
  review?: ReviewDecision;

  stage: FindingStage;

  /** Set when stage is 'dropped' or 'summarized'. */
  dispositionReason?: DispositionReason;
  /** If duplicated, the anchor finding ID. */
  duplicateOf?: string;

  /** Stable hash for dedup keying. Computed by dedup-engine. */
  fingerprint?: string;

  /** Free-form audit notes — used to record why the LLM filter / voice rewrite
   *  reached its conclusion. Surfaced in the renderer for transparency. */
  notes?: string;

  /** Created/updated UTC ISO timestamps. */
  createdAt: string;
  updatedAt: string;

  /** The PR review job this finding belongs to. */
  jobId: string;
  tenantId: string;
}
