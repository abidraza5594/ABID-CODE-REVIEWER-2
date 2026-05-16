import type { AstProject } from '@abid/ast-engine';

/**
 * Directed graph of `who imports what`. Used by:
 *   - blast-radius scoring (a service imported by 50 components is high-centrality)
 *   - dedup anchor selection (anchor the comment on the most-imported file)
 *   - cache invalidation (invalidate downstream files when an upstream changes)
 */
export class ImportGraph {
  /** file → set of files it imports. */
  private out = new Map<string, Set<string>>();
  /** file → set of files that import it. */
  private inn = new Map<string, Set<string>>();

  addEdge(from: string, to: string): void {
    if (!this.out.has(from)) this.out.set(from, new Set());
    if (!this.inn.has(to)) this.inn.set(to, new Set());
    this.out.get(from)!.add(to);
    this.inn.get(to)!.add(from);
  }

  /** Files this file imports directly. */
  imports(file: string): Set<string> {
    return this.out.get(file) ?? new Set();
  }

  /** Files that import this file directly. */
  importers(file: string): Set<string> {
    return this.inn.get(file) ?? new Set();
  }

  /** In-degree centrality: how many files import this one. */
  centrality(file: string): number {
    return this.importers(file).size;
  }

  /** Transitive reverse closure: all files (in)directly importing this. */
  transitiveImporters(file: string, maxDepth = 5): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
    while (queue.length > 0) {
      const { file: cur, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const imp of this.importers(cur)) {
        if (!visited.has(imp)) {
          visited.add(imp);
          queue.push({ file: imp, depth: depth + 1 });
        }
      }
    }
    return visited;
  }
}

export function buildImportGraph(project: AstProject): ImportGraph {
  const g = new ImportGraph();
  for (const sf of project.sourceFiles()) {
    const from = project.relativePath(sf);
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue; // external module — out of scope for in-repo graph
      const to = project.relativePath(target);
      g.addEdge(from, to);
    }
  }
  return g;
}
