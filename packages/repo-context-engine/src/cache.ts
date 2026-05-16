/**
 * RepoContext cache interface. The orchestrator implementation backs this with
 * an object store (S3 / Azure Blob); local tests can implement with a Map.
 *
 * Serialization note: the in-memory RepoContext holds Maps, Sets, and class
 * instances. Serializers must convert these to plain JSON. We accept the cost
 * because cache reads are ~50ms vs. a 10–60s rebuild.
 */
import type { RepoContext } from './context.js';

export interface ContextCache {
  get(key: ContextCacheKey): Promise<RepoContext | null>;
  put(key: ContextCacheKey, value: RepoContext): Promise<void>;
}

export interface ContextCacheKey {
  tenantId: string;
  repositoryId: string;
  sha: string;
}

export function cacheKeyString(key: ContextCacheKey): string {
  return `t/${key.tenantId}/repo/${key.repositoryId}/ctx/${key.sha}.json`;
}

/** In-memory implementation. Tests + local dev use this. */
export class InMemoryContextCache implements ContextCache {
  private map = new Map<string, RepoContext>();

  async get(key: ContextCacheKey): Promise<RepoContext | null> {
    return this.map.get(cacheKeyString(key)) ?? null;
  }
  async put(key: ContextCacheKey, value: RepoContext): Promise<void> {
    this.map.set(cacheKeyString(key), value);
  }
}
