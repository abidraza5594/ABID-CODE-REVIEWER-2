import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Find the repo root by walking up from this source file until we find a
 * `pnpm-workspace.yaml`. Cached after the first call.
 *
 * Why we need this: pnpm filter starts the CLI with cwd=apps/cli. Any code
 * that resolves paths from cwd lands in the wrong place. Use this helper
 * to resolve `prompts/`, `.env`, and similar repo-root assets.
 */
let cached: string | null = null;

export function findRepoRoot(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      cached = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd. Caller should still work in most cases — paths just
  // won't resolve to the repo root.
  cached = process.cwd();
  return cached;
}

export function repoPath(...segments: string[]): string {
  return path.join(findRepoRoot(), ...segments);
}
