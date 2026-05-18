import { describe, expect, it } from 'vitest';
import type { Finding } from '@abid/core';
import { decideReviewAction } from './review-decision.js';

describe('decideReviewAction', () => {
  it('turns exact high-confidence small fixes into inline suggestions', () => {
    const decision = decideReviewAction(finding({ ruleId: 'angular/ts-null-dereference', confidence: 0.84 }), {
      disposition: 'summarize',
      exactAddedLine: true,
      hasExactAutoFix: true,
    });

    expect(decision.kind).toBe('inline-suggestion');
    expect(decision.postInline).toBe(true);
    expect(decision.autoFixable).toBe(true);
    expect(decision.suggestionPresentation).toBe('azure-suggestion');
  });

  it('uses warnings when a fix needs behavior review', () => {
    const decision = decideReviewAction(finding({ ruleId: 'angular/duplicate-api-request', confidence: 0.86 }), {
      disposition: 'post',
      exactAddedLine: true,
      hasExactAutoFix: false,
    });

    expect(decision.kind).toBe('warning');
    expect(decision.postInline).toBe(true);
    expect(decision.autoFixable).toBe(false);
    expect(decision.requiresManualReview).toBe(true);
  });

  it('makes security findings active blockers', () => {
    const decision = decideReviewAction(finding({ ruleId: 'angular/xss-sanitizer-bypass', confidence: 0.86 }), {
      disposition: 'post',
      exactAddedLine: true,
      hasExactAutoFix: false,
    });

    expect(decision.kind).toBe('blocker');
    expect(decision.threadStatus).toBe('active');
    expect(decision.postInline).toBe(true);
  });

  it('keeps non-exact findings summary only', () => {
    const decision = decideReviewAction(finding({ ruleId: 'angular/ts-null-dereference', confidence: 0.9 }), {
      disposition: 'post',
      exactAddedLine: false,
      hasExactAutoFix: true,
    });

    expect(decision.kind).toBe('informational');
    expect(decision.postInline).toBe(false);
  });
});

function finding(input: { ruleId: string; confidence: number }): Finding {
  const now = new Date(0).toISOString();
  return {
    id: 'finding-1',
    ruleId: input.ruleId,
    severity: 'warn',
    confidence: input.confidence,
    location: { file: 'src/app.ts', startLine: 1 },
    evidence: [{ kind: 'ast', nodeKind: 'Node', description: 'evidence' }],
    guarantees: [],
    message: { title: 'Test finding', body: '', suggestion: 'fixed code' },
    stage: 'scored',
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    tenantId: 'test',
  };
}
