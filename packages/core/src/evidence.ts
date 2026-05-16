/**
 * Evidence is the *why we believe this is an issue* trail attached to every finding.
 * The confidence engine reads it. The LLM voice-rewrite step reads it. The internal
 * audit log stores it. Without evidence, a finding cannot pass the confidence floor.
 */

export type Evidence =
  | AstEvidence
  | TypeEvidence
  | CallGraphEvidence
  | TemplateBindingEvidence
  | RuntimeMetricEvidence
  | HeapDiffEvidence
  | NetworkEvidence
  | CrossFileEvidence;

export interface AstEvidence {
  kind: 'ast';
  /** SyntaxKind name from TypeScript Compiler API, or Angular AST node name. */
  nodeKind: string;
  description: string;
  snippet?: string;
}

export interface TypeEvidence {
  kind: 'type';
  /** The TypeChecker.typeToString() output. */
  typeText: string;
  /** Whether the type allows null/undefined at this position. */
  allowsNullish: boolean;
  description: string;
}

export interface CallGraphEvidence {
  kind: 'callgraph';
  /** Symbol path from the changed code to the suspicious sink. */
  path: string[];
  description: string;
}

export interface TemplateBindingEvidence {
  kind: 'template-binding';
  /** The template expression, e.g. `user.name`. */
  expression: string;
  /** Whether an *ngIf or @if upstream narrows the expression to non-nullable. */
  guardedByUpstream: boolean;
  /** Whether the binding is inside an `async` pipe. */
  asyncPipeWrapped: boolean;
  description: string;
}

export interface RuntimeMetricEvidence {
  kind: 'runtime';
  traceId: string;
  metric:
    | 'render-count'
    | 'change-detection-cycles'
    | 'subscription-open-without-close'
    | 'signal-update-frequency'
    | 'rxjs-emissions-per-second'
    | 'long-task-duration-ms'
    | 'event-listener-count';
  value: number;
  /** Optional threshold the value exceeded. */
  threshold?: number;
  description: string;
}

export interface HeapDiffEvidence {
  kind: 'heap';
  /** Snapshot pair object-store IDs. */
  snapshotPair: [string, string];
  deltaBytes: number;
  /** Top retained types in the delta. */
  retainedTypes: Array<{ type: string; instances: number; bytes: number }>;
  description: string;
}

export interface NetworkEvidence {
  kind: 'network';
  /** Same URL hit N times within one scenario iteration. */
  url: string;
  count: number;
  description: string;
}

export interface CrossFileEvidence {
  kind: 'cross-file';
  /** Same fingerprint matched in N other files (used for sibling listing). */
  matches: Array<{ file: string; line: number }>;
  description: string;
}
