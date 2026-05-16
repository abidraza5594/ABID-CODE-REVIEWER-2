/**
 * A scenario the runtime-runner can execute against a deployed/staged Angular app.
 * Declared per-repo in `abid-review.config.ts`. We never invent scenarios.
 */
export interface RuntimeScenario {
  id: string;
  description: string;
  /** Playwright script in TS that boots the app and performs actions. */
  scriptPath: string;
  /** Components whose findings benefit from this scenario. */
  exercises: string[];
  /** Hard timeout in ms. */
  timeoutMs: number;
  /** How many iterations to run for heap-growth comparison. */
  iterations: number;
}

/**
 * Result of one scenario run, joined to findings via `runtimeRefs`.
 */
export interface RuntimeTrace {
  id: string;
  scenarioId: string;
  startedAt: string;
  finishedAt: string;
  /** Object-store keys, not inline payloads. */
  heapSnapshots: string[];
  /** Component → render count. */
  renderCounts: Record<string, number>;
  /** Component → CD cycles + total ms. */
  changeDetection: Record<string, { cycles: number; totalMs: number }>;
  subscriptions: SubscriptionEvent[];
  signalUpdates: Record<string, number>;
  longTasks: Array<{ url: string; startMs: number; durationMs: number }>;
  networkRequests: Array<{ url: string; method: string; count: number }>;
  /** True if the scenario completed without errors. */
  ok: boolean;
  /** Captured console errors. */
  consoleErrors: string[];
}

export interface SubscriptionEvent {
  /** A stable ID assigned at subscribe-site instrumentation. */
  id: string;
  /** Source location guessed from the call site. */
  sourceLocation?: { file: string; line: number };
  openedAtMs: number;
  closedAtMs?: number;
  /** True if still open when the scenario ended. */
  leaked: boolean;
  /** The component instance that owned the subscription if discoverable. */
  ownerComponent?: string;
}
