import { ulid } from '@abid/core';
import type { Finding } from '@abid/core';
import type { RuleContext, RawFinding } from './rule-context.js';
import { ALL_RULES, type AnalyzerRule } from './registry.js';

/**
 * Run every enabled rule against the context, stamp Finding IDs/timestamps,
 * return the collected list.
 *
 * This is pure CPU work — rules don't await IO. We invoke them serially to
 * keep error attribution simple; the orchestrator can shard by file group
 * if needed.
 */
export interface RunOptions {
  enabledRules?: ReadonlySet<string>;
  /** When set, drop findings whose initial confidence is below this. Stored as
   *  rule's intrinsic precision — it's a cheap pre-filter only; the real
   *  confidence pass runs after. */
  preFilterFloor?: number;
}

export function runAnalyzer(ctx: RuleContext, opts: RunOptions = {}): Finding[] {
  const stamped: Finding[] = [];
  const now = new Date().toISOString();

  for (const rule of ALL_RULES) {
    if (opts.enabledRules && !opts.enabledRules.has(rule.id)) continue;
    let raw: RawFinding[] = [];
    try {
      const result = (rule as AnalyzerRule).run(ctx);
      raw = Array.isArray(result) ? result : [];
    } catch (err) {
      // A rule throwing must never crash the pipeline. Log and continue.
      // The orchestrator catches this log line and increments rule_error_total.
      console.error(`[abid-review] rule ${rule.id} threw`, err);
      continue;
    }
    for (const r of raw) {
      if (opts.preFilterFloor !== undefined && r.confidence < opts.preFilterFloor) continue;
      stamped.push({
        ...r,
        id: ulid(),
        stage: 'raw',
        jobId: ctx.jobId,
        tenantId: ctx.tenantId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return stamped;
}
