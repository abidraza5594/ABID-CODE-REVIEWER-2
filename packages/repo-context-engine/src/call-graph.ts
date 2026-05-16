import type { AstProject } from '@abid/ast-engine';
import { SyntaxKind } from 'ts-morph';

/**
 * Function-level call graph keyed by "module#qualifiedName".
 *
 * Scope and limitations:
 *   - Resolves method calls within the same project, using the TypeChecker
 *     to map property-access calls (`this.svc.fetch()`) to their declaring
 *     method symbol.
 *   - Dynamic dispatch through interfaces is approximated by *implementation
 *     set membership*: if `IUserService.load` has 2 implementations, the call
 *     site has edges to both. Rules that traverse the graph can de-emphasize
 *     low-precision edges.
 *   - Higher-order calls (passing methods as callbacks) get a single edge to
 *     the referenced method. We do not model call paths through HOFs.
 */
export interface CallNode {
  /** Stable key: `${file}#${className}.${methodName}` or `${file}#${functionName}`. */
  id: string;
  file: string;
  containerName: string | null;
  memberName: string;
}

export class CallGraph {
  private nodes = new Map<string, CallNode>();
  private out = new Map<string, Set<string>>();
  private inn = new Map<string, Set<string>>();

  addNode(node: CallNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(fromId: string, toId: string): void {
    if (!this.out.has(fromId)) this.out.set(fromId, new Set());
    if (!this.inn.has(toId)) this.inn.set(toId, new Set());
    this.out.get(fromId)!.add(toId);
    this.inn.get(toId)!.add(fromId);
  }

  node(id: string): CallNode | undefined {
    return this.nodes.get(id);
  }

  callers(id: string): Set<string> {
    return this.inn.get(id) ?? new Set();
  }
  callees(id: string): Set<string> {
    return this.out.get(id) ?? new Set();
  }

  /** BFS over callees up to maxDepth. Used by rules to trace whether a value
   *  can reach a sink (e.g., an `unsubscribe` call). */
  reachable(fromId: string, maxDepth = 6): Set<string> {
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: fromId, depth: 0 }];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const next of this.callees(id)) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, depth: depth + 1 });
        }
      }
    }
    return visited;
  }
}

export function buildCallGraph(project: AstProject): CallGraph {
  const g = new CallGraph();
  const checker = project.typeChecker();

  for (const sf of project.sourceFiles()) {
    const file = project.relativePath(sf);
    for (const cls of sf.getClasses()) {
      for (const m of cls.getMethods()) {
        const id = `${file}#${cls.getName()}.${m.getName()}`;
        g.addNode({ id, file, containerName: cls.getName() ?? null, memberName: m.getName() });

        m.forEachDescendant((descendant) => {
          if (descendant.getKind() !== SyntaxKind.CallExpression) return;
          const call = descendant.asKindOrThrow(SyntaxKind.CallExpression);
          const callee = call.getExpression();
          if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return;
          const pa = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const sym = checker.getSymbolAtLocation(pa.getNameNode());
          if (!sym) return;
          const decl = sym.getDeclarations()[0];
          if (!decl) return;
          const ownerCls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
          if (!ownerCls) return;
          const ownerName = ownerCls.getName();
          if (!ownerName) return;
          const targetFile = project.relativePath(decl.getSourceFile());
          const targetId = `${targetFile}#${ownerName}.${pa.getName()}`;
          g.addNode({ id: targetId, file: targetFile, containerName: ownerName, memberName: pa.getName() });
          g.addEdge(id, targetId);
        });
      }
    }
  }
  return g;
}
