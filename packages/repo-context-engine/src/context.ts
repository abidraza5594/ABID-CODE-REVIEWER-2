import type { AstProject, ComponentDescriptor } from '@abid/ast-engine';
import { scanComponents } from '@abid/ast-engine';
import { buildCallGraph, type CallGraph } from './call-graph.js';
import { buildImportGraph, type ImportGraph } from './import-graph.js';
import { buildResolverRegistry, type ResolverRegistry } from './resolver-registry.js';
import { buildSignalGraph, type SignalGraph } from './signal-graph.js';

/**
 * RepoContext is the fully-built static snapshot of a repository at a single
 * commit. Rules receive a RepoContext for each PR review job and never
 * mutate it. The cache layer serializes RepoContext per (repo, sha).
 */
export interface RepoContext {
  components: ComponentDescriptor[];
  imports: ImportGraph;
  calls: CallGraph;
  resolvers: ResolverRegistry;
  signals: SignalGraph;
  /** Commit SHA this context was built from. */
  sha: string;
  /** Wall-clock build duration. */
  buildMs: number;
}

export async function buildContext(project: AstProject, sha: string): Promise<RepoContext> {
  const startedAt = Date.now();
  const components = scanComponents(project);
  const imports = buildImportGraph(project);
  const calls = buildCallGraph(project);
  const resolvers = buildResolverRegistry(project);
  const signals = buildSignalGraph(project);
  return {
    components,
    imports,
    calls,
    resolvers,
    signals,
    sha,
    buildMs: Date.now() - startedAt,
  };
}
