import type { Finding } from '@abid/core';
import type { ImportGraph } from '@abid/repo-context-engine';
import { clusterFindings, type Cluster, type ClusterOptions, DEFAULT_CLUSTER_OPTIONS } from './cluster.js';
import { type EmbedClient, findingEmbeddingText } from './embed.js';
import { fingerprintOf } from './fingerprint.js';

/**
 * Top-level dedup pipeline:
 *   1. Compute fingerprints on every finding (stamps onto `Finding.fingerprint`).
 *   2. Compute embeddings for the surviving titles in one batch.
 *   3. Cluster by rule + fingerprint exactness, with semantic merging.
 *   4. Re-anchor by import-graph centrality when ties remain.
 *   5. Stamp `siblings` array on each anchor + mark non-anchors as `summarized` /
 *      `dropped` per `siblingsPolicy`.
 */
export type SiblingsPolicy = 'list-on-anchor' | 'separate-summary' | 'drop-siblings';

export interface DedupOptions extends ClusterOptions {
  siblingsPolicy: SiblingsPolicy;
  /** When 'list-on-anchor', cap the bullet list at this size. */
  maxSiblingsListed: number;
}

export const DEFAULT_DEDUP_OPTIONS: DedupOptions = {
  ...DEFAULT_CLUSTER_OPTIONS,
  siblingsPolicy: 'list-on-anchor',
  maxSiblingsListed: 8,
};

export interface DedupResult {
  clusters: Cluster[];
  /** Findings after dedup: anchors only, with siblings stamped, plus non-anchors marked appropriately. */
  outFindings: Finding[];
}

export async function dedupFindings(
  input: Finding[],
  embedder: EmbedClient,
  imports?: ImportGraph,
  opts: DedupOptions = DEFAULT_DEDUP_OPTIONS,
): Promise<DedupResult> {
  // 1) Fingerprint pass.
  const withFp: Finding[] = await Promise.all(
    input.map(async (f) => ({
      ...f,
      fingerprint: f.fingerprint ?? (await fingerprintOf(f)),
    })),
  );

  // 2) Embedding pass — one batch call.
  const texts = withFp.map(findingEmbeddingText);
  const vecs = await embedder.embedBatch(texts);
  const embeddings = new Map<string, Float32Array>();
  withFp.forEach((f, i) => embeddings.set(f.id, vecs[i]!));

  // 3) Cluster.
  const clusters = clusterFindings(withFp, embeddings, opts);

  // 4) Re-anchor by import-graph centrality when present and confidence is tied.
  if (imports) {
    for (const cluster of clusters) {
      const candidates = [cluster.anchor, ...cluster.siblings];
      const top = candidates
        .slice()
        .sort((a, b) => b.confidence - a.confidence);
      if (top.length < 2) continue;
      const topConf = top[0]!.confidence;
      const tied = top.filter((c) => Math.abs(c.confidence - topConf) < 1e-9);
      if (tied.length === 1) continue;
      const best = tied
        .slice()
        .sort((a, b) => imports.centrality(b.location.file) - imports.centrality(a.location.file))[0]!;
      cluster.anchor = best;
      cluster.siblings = candidates.filter((c) => c.id !== best.id);
    }
  }

  // 5) Stamp + emit.
  const out: Finding[] = [];
  for (const cluster of clusters) {
    const siblings = cluster.siblings
      .slice(0, opts.maxSiblingsListed)
      .map((s) => ({ file: s.location.file, line: s.location.startLine }));

    const anchor: Finding = {
      ...cluster.anchor,
      siblings,
      stage: 'clustered',
      updatedAt: new Date().toISOString(),
    };
    out.push(anchor);

    for (const s of cluster.siblings) {
      out.push({
        ...s,
        stage: opts.siblingsPolicy === 'drop-siblings' ? 'dropped' : 'summarized',
        dispositionReason: opts.siblingsPolicy === 'drop-siblings' ? 'sibling' : 'duplicate-of',
        duplicateOf: anchor.id,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return { clusters, outFindings: out };
}
