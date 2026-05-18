import type { Evidence, Guarantee } from '@abid/core';
import type { RawFinding, RuleContext } from '../rule-context.js';
import { looksLikeFiniteApiObservable } from './typescript-engineering.js';

/**
 * angular/subscription-leak
 *
 * Flags `.subscribe(...)` call sites that have no plausible lifetime management.
 *
 * Things we treat as guarantees (no finding):
 *   - The pipe chain contains `takeUntilDestroyed`, `takeUntil(this.destroy$)`,
 *     `take(N)`, or `first()`.
 *   - The result is assigned to a class field AND the class has an `ngOnDestroy`
 *     that unsubscribes from that field (heuristic, see method-text scan).
 *   - The observable comes from `HttpClient` (cold, completes after one emission).
 *
 * Runtime corroboration: if the runtime trace reports a leaked subscription
 * whose source location matches this site, confidence is boosted.
 */
export const subscriptionLeakRule = {
  id: 'angular/subscription-leak',
  category: 'lifecycle' as const,
  severity: 'warn' as const,
  basePrecision: 0.85,
  needsRuntime: true,
  description: 'Subscriptions without takeUntilDestroyed or manual cleanup leak across component destroys.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const m of comp.methods) {
        for (const sub of m.subscribeCalls) {
          // Cheap acceptance paths first.
          if (sub.hasTakeUntil) continue;
          if (looksLikeHttpClient(sub.receiverText)) continue;
          if (looksLikeFiniteApiObservable(sub.receiverText)) continue;

          // Manual cleanup check: was the result assigned to a field that
          // ngOnDestroy unsubscribes from?
          if (sub.assignedToField && hasManualCleanup(comp, sub.assignedToField)) continue;

          // IMPORTANT: we do NOT add a guarantee just because the component has
          // ngOnDestroy or DestroyRef somewhere. Having those mechanisms exist
          // anywhere in the class doesn't prove THIS subscription is cleaned up.
          // The early-return paths above (`hasTakeUntil`, `assignedToField with
          // manual cleanup in ngOnDestroy`) already cover the cases where this
          // specific subscription is guaranteed to be cleaned up.
          const guarantees: Guarantee[] = [];

          const evidence: Evidence[] = [
            {
              kind: 'ast',
              nodeKind: 'CallExpression',
              description: 'subscribe() call with no takeUntilDestroyed / take / first / takeUntil in the pipe chain',
              snippet: sub.receiverText.slice(0, 120),
            },
          ];

          // Runtime corroboration.
          const slice = ctx.runtime?.byComponent.get(comp.className);
          if (slice && slice.leakedSubscriptionCount > 0) {
            evidence.push({
              kind: 'runtime',
              traceId: slice.traceIds[0] ?? 'unknown',
              metric: 'subscription-open-without-close',
              value: slice.leakedSubscriptionCount,
              description: `${slice.leakedSubscriptionCount} subscription(s) still open at scenario end`,
            });
          }

          out.push({
            ruleId: 'angular/subscription-leak',
            severity: 'warn',
            confidence: 0.85, // pre-scoring; confidence-engine refines this.
            location: sub.location,
            evidence,
            guarantees,
            ...(slice ? { runtimeRefs: slice.traceIds } : {}),
            message: {
              title: 'Subscription is not cleaned up',
              body: '', // filled in by voice rewrite
              suggestion: `${sub.receiverText}
  .pipe(takeUntilDestroyed(this.destroyRef))
  .subscribe(...);`,
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

function looksLikeHttpClient(receiverText: string): boolean {
  // Heuristic: HttpClient methods produce cold observables that complete after one emission.
  // Common forms: `this.http.get(...)`, `this.httpClient.post(...)`. Cheap regex is fine here.
  return /\b(http|httpClient)\.(get|post|put|patch|delete|request|head|options)\s*</.test(receiverText) ||
         /\b(http|httpClient)\.(get|post|put|patch|delete|request|head|options)\s*\(/.test(receiverText);
}

function hasManualCleanup(
  comp: import('@abid/ast-engine').ComponentDescriptor,
  fieldName: string,
): boolean {
  const onDestroy = comp.methods.find((m) => m.lifecycle === 'ngOnDestroy');
  if (!onDestroy) return false;
  // Look for `this.<fieldName>.unsubscribe()` or `?.unsubscribe()` in the body text.
  // A simple textual check is intentional — we don't want to AST-walk every body
  // when this rule fires on hundreds of methods in a large repo.
  const re = new RegExp(`this\\.${escapeRegex(fieldName)}\\??\\.unsubscribe\\s*\\(`);
  return re.test(onDestroy.text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
