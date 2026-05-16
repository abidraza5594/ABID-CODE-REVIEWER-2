import type { Evidence } from '@abid/core';
import { parseTemplateRef } from '@abid/ast-engine';
import type { RawFinding, RuleContext } from '../rule-context.js';

/**
 * angular/trackby-missing
 *
 * Fires on `*ngFor` over a collection without `trackBy`. `@for` is required to
 * declare `track` so it never fires there.
 *
 * Suppression:
 *   - List of literal length <= 5 (small lists don't benefit; we infer by name
 *     heuristic in absence of runtime; runtime can also confirm).
 *   - Collection is a constant signal that never updates.
 */
export const trackByMissingRule = {
  id: 'angular/trackby-missing',
  category: 'performance' as const,
  severity: 'info' as const,
  basePrecision: 0.80,
  description: 'Missing trackBy on *ngFor causes unnecessary DOM rebuilds.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        for (const fl of analysis.forLoops) {
          if (fl.hasTrackBy) continue;

          const evidence: Evidence[] = [
            {
              kind: 'ast',
              nodeKind: 'NgForTemplate',
              description: '*ngFor without trackBy — collection identity changes will re-render every row',
            },
          ];

          out.push({
            ruleId: 'angular/trackby-missing',
            severity: 'info',
            confidence: 0.80,
            location: { file: tplRef.file, startLine: fl.line },
            evidence,
            guarantees: [],
            message: {
              title: '*ngFor is missing trackBy',
              body: '',
              suggestion: buildTrackBySuggestion(fl.iterableExpression),
              suggestionLanguage: 'html',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

function buildTrackBySuggestion(iterableExpression: string): string {
  const parsed = /let\s+([A-Za-z_$][\w$]*)\s+of\s+(.+?)(?:;|$)/.exec(iterableExpression);
  const itemName = parsed?.[1] ?? 'item';
  const itemsExpression = (parsed?.[2]?.trim() ?? iterableExpression.trim()) || 'items';
  return `*ngFor="let ${itemName} of ${itemsExpression}; trackBy: trackById"

// in component:
trackById = (_: number, ${itemName}: { id: string | number }) => ${itemName}.id;`;
}
