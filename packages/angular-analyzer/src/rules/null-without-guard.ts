import type { Evidence, Guarantee } from '@abid/core';
import { parseTemplateRef, resolveBindings } from '@abid/ast-engine';
import type { RawFinding, RuleContext } from '../rule-context.js';

/**
 * angular/null-without-guard
 *
 * Flags property accesses in templates that read from a possibly-nullish value
 * without an upstream guard. Heavy false-positive risk if we don't check:
 *   - resolver guarantees (the value is fetched before activation)
 *   - upstream *ngIf / @if guards
 *   - async pipe wrap (which short-circuits on null)
 *   - type narrowing in the parent expression
 *
 * Because of those risks, the rule is *conservative*: it only fires when ALL
 * of the following are true:
 *   - The root symbol resolves through cross-binding.
 *   - The root symbol's declared type permits null/undefined.
 *   - No matching resolver guarantees the field non-null.
 *   - No upstream *ngIf/@if expression names the root symbol.
 *   - The expression is NOT inside `async` pipe wrap.
 */
export const nullWithoutGuardRule = {
  id: 'angular/null-without-guard',
  category: 'state-sync' as const,
  severity: 'warn' as const,
  basePrecision: 0.70,
  description: 'Template reads a property of a value that may be null at runtime.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        const resolved = resolveBindings(ctx.project, comp, analysis);

        for (const b of resolved) {
          if (b.kind !== 'resolved') continue;        // unknown root → don't false-positive
          if (!b.allowsNullish) continue;             // type forbids null/undefined
          if (b.expression === b.rootSymbol) continue; // bare reference, no member access

          // Async pipe?
          if (/^\s*\(?\s*[A-Za-z_$][\w$]*\$\s*\|\s*async/.test(b.expression)) continue;
          if (/\|\s*async\b/.test(b.expression)) continue;
          if (hasLocalNullSafety(b.expression, b.rootSymbol)) continue;

          // Upstream *ngIf / @if guards covering this binding's line?
          const bindingLine = locateBindingLineInTemplate(analysis, b.expression);
          const guarded = bindingLine !== null && analysis.guards.some(
            (g) => coversLine(g.range, bindingLine) && namesRoot(g.expression, b.rootSymbol),
          );
          if (guarded) continue;

          // Resolver guarantee for the field?
          if (b.rootSymbol) {
            const resolvers = ctx.repo.resolvers.lookup(b.rootSymbol);
            if (resolvers.length > 0 && resolvers.every((r) => !r.allowsNullish)) {
              // Fully guaranteed non-null by every matching resolver.
              continue;
            }
          }

          const guarantees: Guarantee[] = [];
          if (b.rootSymbol && ctx.repo.resolvers.lookup(b.rootSymbol).length > 0) {
            // Partial: some routes guarantee, others don't. We still report but list as guarantee.
            for (const r of ctx.repo.resolvers.lookup(b.rootSymbol)) {
              if (!r.allowsNullish) {
                guarantees.push({
                  kind: 'resolver',
                  route: r.routePath,
                  field: r.field,
                  declaringFile: r.declaringFile,
                  resolvedTypeText: r.resolvedTypeText,
                });
              }
            }
          }

          const evidence: Evidence[] = [
            {
              kind: 'template-binding',
              expression: b.expression,
              guardedByUpstream: false,
              asyncPipeWrapped: false,
              description: 'binding reads a member of a possibly-null value',
            },
            {
              kind: 'type',
              typeText: b.typeText ?? 'unknown',
              allowsNullish: b.allowsNullish ?? true,
              description: 'declared type allows null/undefined',
            },
          ];

          out.push({
            ruleId: 'angular/null-without-guard',
            severity: 'warn',
            confidence: 0.70,
            location: {
              file: tplRef.file,
              startLine: locateBindingLineInTemplate(analysis, b.expression) ?? comp.location.startLine,
            },
            evidence,
            guarantees,
            message: {
              title: 'Value can be null without a check',
              body: '',
              suggestion: buildSuggestion(b.expression, b.rootSymbol),
              suggestionLanguage: 'html',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

function locateBindingLineInTemplate(
  analysis: ReturnType<typeof parseTemplateRef>,
  expression: string,
): number | null {
  const b = analysis.bindings.find((x) => x.expression === expression);
  return b ? b.line : null;
}

function coversLine(range: { startLine: number; endLine: number }, line: number): boolean {
  return range.startLine <= line && line <= range.endLine;
}

function namesRoot(expression: string, rootSymbol?: string): boolean {
  if (!rootSymbol) return false;
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(rootSymbol)}([^A-Za-z0-9_$]|$)`).test(expression);
}

function hasLocalNullSafety(expression: string, rootSymbol?: string): boolean {
  if (!rootSymbol) return true;
  if (new RegExp(`\\b${escapeRegex(rootSymbol)}\\?\\.`).test(expression)) return true;
  if (new RegExp(`\\b${escapeRegex(rootSymbol)}!\\.`).test(expression)) return true;
  if (new RegExp(`\\b${escapeRegex(rootSymbol)}\\s*&&`).test(expression)) return true;
  return false;
}

function buildSuggestion(expression: string, rootSymbol?: string): string {
  if (!rootSymbol) return '';
  const safe = expression.replace(new RegExp(`\\b${escapeRegex(rootSymbol)}\\.`), `${rootSymbol}?.`);
  if (safe !== expression) return safe;
  return `@if (${rootSymbol}) {\n  ${expression}\n}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
