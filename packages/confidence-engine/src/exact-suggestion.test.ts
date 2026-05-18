import { describe, expect, it } from 'vitest';
import type { Finding } from '@abid/core';
import { buildExactSuggestion } from './exact-suggestion.js';

describe('buildExactSuggestion', () => {
  it('maps an optional-chain fix into the exact changed line', () => {
    const result = buildExactSuggestion(
      finding({
        ruleId: 'angular/ts-null-dereference',
        suggestion: 'user?.name',
        evidence: [{ kind: 'ast', nodeKind: 'PropertyAccessExpression', description: 'nullable access', snippet: 'user.name' }],
      }),
      'const label = user.name;',
    );

    expect(result).toEqual({
      ok: true,
      suggestion: 'const label = user?.name;',
      reason: 'replacement was mapped to the exact changed line text',
    });
  });

  it('removes one unused named import from the exact import line', () => {
    const result = buildExactSuggestion(
      finding({
        ruleId: 'angular/unused-import',
        evidence: [{ kind: 'ast', nodeKind: 'ImportSpecifier', description: 'UnusedThing is imported but not referenced in the file body' }],
      }),
      "import { UsedThing, UnusedThing } from './things';",
    );

    expect(result).toEqual({
      ok: true,
      suggestion: "import { UsedThing } from './things';",
      reason: 'unused import can be removed from the exact import line',
    });
  });

  it('rejects placeholder suggestions', () => {
    const result = buildExactSuggestion(
      finding({
        ruleId: 'angular/subscription-leak',
        suggestion: 'source$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(...);',
        evidence: [{ kind: 'ast', nodeKind: 'CallExpression', description: 'subscribe without cleanup', snippet: 'source$.subscribe(value => this.value = value)' }],
      }),
      'source$.subscribe(value => this.value = value);',
    );

    expect(result.ok).toBe(false);
  });
});

function finding(input: {
  ruleId: string;
  suggestion?: string;
  evidence: Finding['evidence'];
}): Finding {
  const now = new Date(0).toISOString();
  return {
    id: 'finding-1',
    ruleId: input.ruleId,
    severity: 'warn',
    confidence: 0.9,
    location: { file: 'src/app.ts', startLine: 1 },
    evidence: input.evidence,
    guarantees: [],
    message: {
      title: 'Test finding',
      body: '',
      ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
    },
    stage: 'scored',
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    tenantId: 'test',
  };
}
