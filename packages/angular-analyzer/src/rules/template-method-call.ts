import type { Evidence, Guarantee } from '@abid/core';
import { parseTemplateRef } from '@abid/ast-engine';
import type { RawFinding, RuleContext } from '../rule-context.js';

/**
 * angular/template-method-call
 *
 * Flags hot-path method calls inside template interpolations or attribute
 * bindings when the component is on the *default* change detection strategy.
 *
 * Guarantees that suppress the finding:
 *   - The component is OnPush AND consumes signals (signals make the cost negligible).
 *   - The method is a pure pipe call (`| someUpper`) — but those aren't method
 *     calls on `this`, so they don't appear here anyway.
 *
 * Runtime corroboration: very high render counts boost confidence.
 */
export const templateMethodCallRule = {
  id: 'angular/template-method-call',
  category: 'change-detection' as const,
  severity: 'warn' as const,
  basePrecision: 0.65,
  needsRuntime: true,
  description: 'Method calls inside templates re-run on every change detection cycle under default CD.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const guarantees: Guarantee[] = [];
      if (comp.changeDetection === 'OnPush') {
        guarantees.push({ kind: 'on-push', componentName: comp.className });
      }

      // OnPush + signals is the modern path — don't fire there.
      const hasSignalFields = comp.fields.some((f) => f.initializerKind === 'signal' || f.initializerKind === 'computed');
      if (comp.changeDetection === 'OnPush' && hasSignalFields) continue;

      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        for (const call of analysis.methodCalls) {
          if (!call.inHotPath) continue;
          if (!isAddedLine(ctx, tplRef.file, call.line)) continue;
          const method = comp.methods.find((candidate) => candidate.name === call.name);
          const methodCost = method ? renderCostOfMethod(method.text) : 0;
          // Filter known-cheap calls unless the TypeScript body proves work.
          if (isPureLookup(call.name) && methodCost < 2) continue;

          const evidence: Evidence[] = [
            {
              kind: 'ast',
              nodeKind: 'CallExpression',
              description: methodCost >= 2
                ? `template calls ${call.name}() on every change detection cycle; the method body does repeated work`
                : `template calls ${call.name}() on every change detection cycle`,
            },
          ];
          if (method) {
            evidence.push({
              kind: 'callgraph',
              path: [`template:${call.name}()`, `${comp.className}.${method.name}()`],
              description: `template binding resolves to ${method.name} in ${comp.className}`,
            });
          }

          const slice = ctx.runtime?.byComponent.get(comp.className);
          if (slice && slice.avgRenderCount > 50) {
            evidence.push({
              kind: 'runtime',
              traceId: slice.traceIds[0] ?? 'unknown',
              metric: 'render-count',
              value: slice.avgRenderCount,
              threshold: 50,
              description: `${slice.avgRenderCount} renders observed in scenario`,
            });
          }

          out.push({
            ruleId: 'angular/template-method-call',
            severity: 'warn',
            confidence: methodCost >= 2 ? 0.78 : 0.65,
            location: { file: tplRef.file, startLine: call.line },
            evidence,
            guarantees,
            ...(slice ? { runtimeRefs: slice.traceIds } : {}),
            message: {
              title: `${call.name}() runs on every change detection cycle`,
              body: '',
              suggestion: `// Compute once when inputs change, then bind the value in the template.
readonly ${toCachedName(call.name)} = computed(() => this.${call.name}());`,
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

function isPureLookup(name: string): boolean {
  // Methods that are nearly always just object lookups — keep noise low.
  return /^(get|is|has)[A-Z]/.test(name) && name.length < 12;
}

function toCachedName(methodName: string): string {
  return `${methodName.replace(/^[A-Z]/, (c) => c.toLowerCase())}Value`;
}

function renderCostOfMethod(text: string): number {
  let score = 0;
  score += (text.match(/\.(map|filter|reduce|sort|find|some|every)\s*\(/g) ?? []).length * 2;
  score += (text.match(/\b(for|while|switch|if)\b/g) ?? []).length;
  score += (text.match(/\b(http|httpClient|Service|Api|Client)\b/g) ?? []).length;
  return score;
}

function isAddedLine(ctx: RuleContext, file: string, line: number): boolean {
  return ctx.diff.lineMap(file)?.addedNewLines.has(line) ?? false;
}
