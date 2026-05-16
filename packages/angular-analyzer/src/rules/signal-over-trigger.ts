import type { Evidence } from '@abid/core';
import type { RawFinding, RuleContext } from '../rule-context.js';

/**
 * angular/signal-over-trigger
 *
 * Detects signals whose downstream computed/effect graph contains 8+ consumers
 * AND has at least one consumer reading every render. High fan-out signals
 * with frequent updates are an architectural smell — not necessarily a bug,
 * but worth surfacing as info-level on the changed declaration site.
 *
 * Confidence here is low without runtime. Runtime corroboration (high
 * signal-update-frequency) is required to escalate above the post threshold.
 */
export const signalOverTriggerRule = {
  id: 'angular/signal-over-trigger',
  category: 'change-detection' as const,
  severity: 'info' as const,
  basePrecision: 0.55,
  needsRuntime: true,
  description: 'High-fan-out signal that may cause excessive recomputation.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];
    const FANOUT_THRESHOLD = 8;

    for (const node of ctx.repo.signals.nodes.values()) {
      if (node.kind !== 'signal') continue;
      // Only fire on signals declared in changed files (avoids re-reporting old stuff).
      const file = node.file;
      if (!ctx.diff.fileByNewPath(file)) continue;

      const consumers = ctx.repo.signals.consumersOf(node.id);
      if (consumers.length < FANOUT_THRESHOLD) continue;

      const evidence: Evidence[] = [
        {
          kind: 'ast',
          nodeKind: 'SignalDecl',
          description: `signal ${node.name} has ${consumers.length} consumers`,
        },
      ];

      // Pull frequency from runtime when present.
      let confidence = 0.55;
      if (ctx.runtime) {
        // Aggregate update frequency across owners that read this signal.
        let updates = 0;
        for (const consumerId of consumers) {
          const consumer = ctx.repo.signals.nodes.get(consumerId);
          if (!consumer) continue;
          const owner = consumerId.split('#')[1]?.split('.')[0];
          if (!owner) continue;
          const slice = ctx.runtime.byComponent.get(owner);
          if (!slice) continue;
          updates += slice.avgRenderCount;
        }
        if (updates > 200) {
          confidence = 0.80;
          const ids = consumers
            .map((c) => ctx.runtime!.byComponent.get(c.split('#')[1]?.split('.')[0] ?? ''))
            .filter((x): x is NonNullable<typeof x> => !!x)
            .flatMap((s) => s.traceIds)
            .slice(0, 1);
          evidence.push({
            kind: 'runtime',
            traceId: ids[0] ?? 'unknown',
            metric: 'signal-update-frequency',
            value: updates,
            threshold: 200,
            description: `aggregated signal-update frequency`,
          });
        }
      }

      // We don't know the exact line cheaply here — declaring file + first match by name.
      out.push({
        ruleId: 'angular/signal-over-trigger',
        severity: 'info',
        confidence,
        location: { file, startLine: 1 },  // refined by orchestrator to declaration line
        evidence,
        guarantees: [],
        message: {
          title: `Signal '${node.name}' has many consumers (${consumers.length})`,
          body: '',
        },
      });
    }

    return out;
  },
} as const;
