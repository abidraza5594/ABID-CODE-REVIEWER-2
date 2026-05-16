import type { AstProject, ComponentDescriptor } from '@abid/ast-engine';
import type { DiffIndex } from '@abid/git-diff-engine';
import type { Finding } from '@abid/core';
import type { RepoContext } from '@abid/repo-context-engine';

/**
 * The shared context every rule receives. Rules are pure functions over this
 * context. They MUST NOT:
 *   - read from disk
 *   - call the network
 *   - mutate the context
 *   - sleep or use timers
 *
 * If a rule needs runtime data, it sets `runtimeNeeds` and the orchestrator
 * supplies it on a second pass.
 */
export interface RuleContext {
  jobId: string;
  tenantId: string;
  project: AstProject;
  repo: RepoContext;
  diff: DiffIndex;

  /** Only the components whose .ts or template file is in the diff. */
  changedComponents: ComponentDescriptor[];

  /** Optional runtime traces, joined by component className. */
  runtime?: RuntimeBundle;
}

export interface RuntimeBundle {
  byComponent: Map<string, ComponentRuntimeSlice>;
}

export interface ComponentRuntimeSlice {
  /** Render count averaged across scenario iterations. */
  avgRenderCount: number;
  /** Subscriptions opened in this component that never closed. */
  leakedSubscriptionCount: number;
  /** Long-task durations (>50ms) tied to this component's lifecycle hooks. */
  longTaskMs: number[];
  /** Heap-delta in bytes attributed to this component (heuristic). */
  heapDeltaBytes: number;
  /** Linked trace IDs for evidence attribution. */
  traceIds: string[];
}

export interface RawFinding extends Omit<Finding, 'id' | 'stage' | 'createdAt' | 'updatedAt' | 'jobId' | 'tenantId'> {
  // Rules emit RawFindings. The orchestrator stamps id/stage/timestamps.
}
