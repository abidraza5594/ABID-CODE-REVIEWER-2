import type { Evidence, Guarantee } from '@abid/core';
import { parseTemplateRef, type TemplateAnalysis } from '@abid/ast-engine';
import type { RawFinding, RuleContext } from '../rule-context.js';

export const repeatedAsyncPipeRule = {
  id: 'angular/repeated-async-pipe',
  category: 'change-detection' as const,
  severity: 'warn' as const,
  basePrecision: 0.78,
  needsRuntime: true,
  description: 'The same observable is consumed by async pipe multiple times in one template.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const guarantees = onPushGuarantees(comp);
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        const byExpression = new Map<string, Array<{ line: number; kind: string }>>();
        for (const usage of analysis.asyncPipes) {
          const key = usage.expression;
          if (!key) continue;
          const list = byExpression.get(key) ?? [];
          list.push({ line: usage.line, kind: usage.kind });
          byExpression.set(key, list);
        }

        for (const [expression, usages] of byExpression) {
          if (usages.length < 2) continue;
          const anchor = usages.find((usage) => isChangedLine(ctx, tplRef.file, usage.line));
          if (!anchor) continue;

          const evidence: Evidence[] = [{
            kind: 'template-binding',
            expression,
            guardedByUpstream: hasTemplateGuard(analysis, anchor.line),
            asyncPipeWrapped: true,
            description: `${expression} is read through async pipe ${usages.length} times in this template`,
          }];
          const slice = ctx.runtime?.byComponent.get(comp.className);
          if (slice && slice.avgRenderCount > 50) {
            evidence.push(runtimeRenderEvidence(slice.avgRenderCount, slice.traceIds[0]));
          }

          out.push({
            ruleId: 'angular/repeated-async-pipe',
            severity: 'warn',
            confidence: slice && slice.avgRenderCount > 50 ? 0.84 : 0.78,
            location: { file: tplRef.file, startLine: anchor.line },
            evidence,
            guarantees,
            ...(slice ? { runtimeRefs: slice.traceIds } : {}),
            message: {
              title: 'Async value is read repeatedly in the template',
              body: '',
              suggestion: `@if (${expression} | async; as value) {
  <!-- bind value in this block -->
}`,
              suggestionLanguage: 'html',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const nestedTemplateLoopRule = {
  id: 'angular/nested-template-loop',
  category: 'performance' as const,
  severity: 'warn' as const,
  basePrecision: 0.76,
  needsRuntime: true,
  description: 'Nested template loops multiply DOM work and change-detection cost.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        const nested = analysis.forLoops.find((loop) => loop.depth >= 2 && isChangedLine(ctx, tplRef.file, loop.line));
        if (!nested) continue;

        const evidence: Evidence[] = [{
          kind: 'ast',
          nodeKind: 'TemplateForLoop',
          description: `loop over ${nested.iterableExpression || 'items'} is nested at depth ${nested.depth}`,
        }];
        const slice = ctx.runtime?.byComponent.get(comp.className);
        if (slice && slice.avgRenderCount > 50) {
          evidence.push(runtimeRenderEvidence(slice.avgRenderCount, slice.traceIds[0]));
        }

        out.push({
          ruleId: 'angular/nested-template-loop',
          severity: 'warn',
          confidence: slice && slice.avgRenderCount > 50 ? 0.84 : 0.76,
          location: { file: tplRef.file, startLine: nested.line },
          evidence,
          guarantees: [],
          ...(slice ? { runtimeRefs: slice.traceIds } : {}),
          message: {
            title: 'Nested loop can render too much DOM',
            body: '',
            suggestion: '<!-- Flatten the data, paginate, or virtualize this nested list before rendering. -->',
            suggestionLanguage: 'html',
          },
        });
      }
    }

    return out;
  },
} as const;

export const dynamicClassStyleBindingRule = {
  id: 'angular/dynamic-class-style-hot-binding',
  category: 'change-detection' as const,
  severity: 'info' as const,
  basePrecision: 0.72,
  needsRuntime: true,
  description: 'Complex class/style bindings are recalculated during rendering and can update DOM repeatedly.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const guarantees = onPushGuarantees(comp);
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        for (const binding of analysis.dynamicBindings) {
          if (!isChangedLine(ctx, tplRef.file, binding.line)) continue;
          const score = templateExpressionCost(binding.expression);
          if (score < 4 && analysis.rendering.dynamicClassStyleCount < 4) continue;

          const evidence: Evidence[] = [{
            kind: 'template-binding',
            expression: binding.expression,
            guardedByUpstream: hasTemplateGuard(analysis, binding.line),
            asyncPipeWrapped: /\|\s*async\b/.test(binding.expression),
            description: `${binding.kind} binding recalculates during rendering`,
          }];
          const slice = ctx.runtime?.byComponent.get(comp.className);
          if (slice && slice.avgRenderCount > 50) {
            evidence.push(runtimeRenderEvidence(slice.avgRenderCount, slice.traceIds[0]));
          }

          out.push({
            ruleId: 'angular/dynamic-class-style-hot-binding',
            severity: 'info',
            confidence: slice && slice.avgRenderCount > 50 ? 0.80 : 0.72,
            location: { file: tplRef.file, startLine: binding.line },
            evidence,
            guarantees,
            ...(slice ? { runtimeRefs: slice.traceIds } : {}),
            message: {
              title: 'Dynamic style binding does repeated render work',
              body: '',
              suggestion: '// Move this class/style calculation into a computed value or a field updated when inputs change.',
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const largeTemplateDomRule = {
  id: 'angular/large-template-dom',
  category: 'performance' as const,
  severity: 'info' as const,
  basePrecision: 0.70,
  needsRuntime: true,
  description: 'Large templates with many bindings can become rendering bottlenecks.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const tplRef of comp.templates) {
        const analysis = parseTemplateRef(tplRef);
        if (!isLargeTemplate(analysis)) continue;
        const line = firstChangedLine(ctx, tplRef.file);
        if (line === undefined) continue;

        const slice = ctx.runtime?.byComponent.get(comp.className);
        const evidence: Evidence[] = [{
          kind: 'ast',
          nodeKind: 'AngularTemplate',
          description: `template has ${analysis.rendering.elementCount} elements, ${analysis.rendering.hotBindingCount} hot bindings, ${analysis.rendering.loopCount} loop(s), and depth ${analysis.rendering.maxElementDepth}`,
        }];
        if (slice && slice.avgRenderCount > 50) {
          evidence.push(runtimeRenderEvidence(slice.avgRenderCount, slice.traceIds[0]));
        }

        out.push({
          ruleId: 'angular/large-template-dom',
          severity: 'info',
          confidence: slice && slice.avgRenderCount > 50 ? 0.82 : 0.70,
          location: { file: tplRef.file, startLine: line },
          evidence,
          guarantees: onPushGuarantees(comp),
          ...(slice ? { runtimeRefs: slice.traceIds } : {}),
          message: {
            title: 'Template renders a large DOM area',
            body: '',
            suggestion: '<!-- Split repeated sections, paginate, or virtualize large lists before rendering. -->',
            suggestionLanguage: 'html',
          },
        });
      }
    }

    return out;
  },
} as const;

function hasTemplateGuard(analysis: TemplateAnalysis, line: number): boolean {
  return analysis.guards.some((guard) => guard.range.startLine <= line && line <= guard.range.endLine);
}

function isLargeTemplate(analysis: TemplateAnalysis): boolean {
  return analysis.rendering.elementCount >= 120 ||
    analysis.rendering.hotBindingCount >= 60 ||
    analysis.rendering.maxElementDepth >= 14 ||
    (analysis.rendering.loopCount >= 3 && analysis.rendering.elementCount >= 60);
}

function templateExpressionCost(expression: string): number {
  let score = expression.length > 100 ? 2 : 0;
  score += (expression.match(/\b(map|filter|reduce|sort|find|some|every)\s*\(/g) ?? []).length * 2;
  score += (expression.match(/&&|\|\||\?|:/g) ?? []).length;
  score += (expression.match(/\|\s*[A-Za-z_$][\w$]*/g) ?? []).length;
  score += (expression.match(/\.[A-Za-z_$][\w$]*\s*\(/g) ?? []).length * 2;
  score += (expression.match(/\{|\[|=>/g) ?? []).length;
  return score;
}

function runtimeRenderEvidence(value: number, traceId: string | undefined): Evidence {
  return {
    kind: 'runtime',
    traceId: traceId ?? 'unknown',
    metric: 'render-count',
    value,
    threshold: 50,
    description: `${value} renders observed while this template work can repeat`,
  };
}

function onPushGuarantees(comp: import('@abid/ast-engine').ComponentDescriptor): Guarantee[] {
  return comp.changeDetection === 'OnPush'
    ? [{ kind: 'on-push', componentName: comp.className }]
    : [];
}

function isChangedLine(ctx: RuleContext, file: string, line: number): boolean {
  return ctx.diff.lineMap(file)?.addedNewLines.has(line) ?? false;
}

function firstChangedLine(ctx: RuleContext, file: string): number | undefined {
  return [...(ctx.diff.lineMap(file)?.addedNewLines ?? [])].sort((a, b) => a - b)[0];
}
