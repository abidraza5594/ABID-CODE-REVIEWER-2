import type { AstProject } from '@abid/ast-engine';
import { SyntaxKind } from 'ts-morph';

/**
 * Maps signal/computed/effect dependencies. Used by:
 *   - signal-over-trigger rule: detects effects that read from highly-changing signals
 *   - change-detection rule: a signal whose graph fans out to 30 computed values
 *     warrants a closer look at the template that depends on it
 */
export type SignalNodeKind = 'signal' | 'computed' | 'effect';

export interface SignalNode {
  id: string;
  kind: SignalNodeKind;
  /** Class member or top-level binding name. */
  name: string;
  file: string;
  /** Initial value type if statically known (e.g. for `signal<User | null>(null)`). */
  typeText?: string;
}

export class SignalGraph {
  nodes = new Map<string, SignalNode>();
  /** node → signals it READS. */
  readsFrom = new Map<string, Set<string>>();
  /** node → signals it WRITES. */
  writesTo = new Map<string, Set<string>>();

  addNode(node: SignalNode): void {
    this.nodes.set(node.id, node);
  }

  read(from: string, signal: string): void {
    if (!this.readsFrom.has(from)) this.readsFrom.set(from, new Set());
    this.readsFrom.get(from)!.add(signal);
  }
  write(from: string, signal: string): void {
    if (!this.writesTo.has(from)) this.writesTo.set(from, new Set());
    this.writesTo.get(from)!.add(signal);
  }

  /** Consumers of a signal — computeds/effects that read from it. */
  consumersOf(signalId: string): string[] {
    const out: string[] = [];
    for (const [id, set] of this.readsFrom) {
      if (set.has(signalId)) out.push(id);
    }
    return out;
  }
}

/**
 * Build a project-wide signal graph.
 *
 * Heuristic: we identify signal-like fields by their initializer head
 * (`signal(...)`, `computed(...)`, `effect(...)`). Inside computed/effect
 * bodies we collect callable accesses `someField()` whose target is a known
 * signal node. This is light-weight but covers the common idioms; tracking
 * untyped signal aliases through let-bindings is out of scope.
 */
export function buildSignalGraph(project: AstProject): SignalGraph {
  const g = new SignalGraph();

  // First pass: register declarations.
  for (const sf of project.sourceFiles()) {
    const file = project.relativePath(sf);
    for (const cls of sf.getClasses()) {
      const owner = cls.getName() ?? '<anon>';
      for (const prop of cls.getProperties()) {
        const init = prop.getInitializer();
        if (!init) continue;
        if (init.getKind() !== SyntaxKind.CallExpression) continue;
        const call = init.asKindOrThrow(SyntaxKind.CallExpression);
        const callee = call.getExpression().getText();
        let kind: SignalNodeKind | null = null;
        if (callee === 'signal') kind = 'signal';
        else if (callee === 'computed') kind = 'computed';
        else if (callee === 'effect') kind = 'effect';
        if (!kind) continue;
        g.addNode({
          id: `${file}#${owner}.${prop.getName()}`,
          kind,
          name: prop.getName(),
          file,
          typeText: prop.getType().getText(),
        });
      }
    }
  }

  // Second pass: inside computed/effect bodies, collect read edges.
  for (const node of g.nodes.values()) {
    if (node.kind === 'signal') continue;
    const sf = project.getSourceFile(node.file);
    if (!sf) continue;
    const cls = sf.getClasses().find((c) => (c.getName() ?? '<anon>') === node.id.split('#')[1]!.split('.')[0]);
    if (!cls) continue;
    const prop = cls.getProperty(node.name);
    if (!prop) continue;
    const init = prop.getInitializer();
    if (!init) continue;

    init.forEachDescendant((d) => {
      // We look for callable accesses to signal-like names on `this`.
      if (d.getKind() !== SyntaxKind.CallExpression) return;
      const call = d.asKindOrThrow(SyntaxKind.CallExpression);
      const callee = call.getExpression();
      if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
      const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (pa.getExpression().getText() !== 'this') return;
      const member = pa.getName();
      // Find a matching signal node in the same class.
      const ownerName = node.id.split('#')[1]!.split('.')[0]!;
      const candidateId = `${node.file}#${ownerName}.${member}`;
      if (g.nodes.has(candidateId)) {
        const target = g.nodes.get(candidateId)!;
        // Reading a signal: `this.signalA()` with no args is a read.
        if (call.getArguments().length === 0 && target.kind === 'signal') {
          g.read(node.id, candidateId);
        }
        // Writes happen via `.set` / `.update` on the signal accessor, not the call form.
      }
    });
  }

  return g;
}
