import type { Finding } from '@abid/core';
import { cosine } from './embed.js';

/**
 * A cluster of findings the dedup engine considers "the same issue".
 * The anchor is what gets posted; siblings are listed in its body.
 */
export interface Cluster {
  anchor: Finding;
  siblings: Finding[];
}

export interface ClusterOptions {
  /** Cosine similarity threshold above which two findings are merged. */
  semanticThreshold: number;
  /** Hard cap on cluster size — beyond this we shard. */
  maxClusterSize: number;
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  semanticThreshold: 0.86,
  maxClusterSize: 12,
};

/**
 * Single-pass agglomerative clustering bounded by rule_id partitions.
 *
 * Why per-rule partitions: two findings from different rules should never
 * cluster together even if their embeddings are close — they trigger
 * different fixes. We only collapse same-rule findings.
 */
export function clusterFindings(
  findings: Finding[],
  embeddings: Map<string, Float32Array>,
  opts: ClusterOptions = DEFAULT_CLUSTER_OPTIONS,
): Cluster[] {
  // Partition by rule first.
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId)!.push(f);
  }

  const clusters: Cluster[] = [];
  for (const [, members] of byRule) {
    // Within a rule, exact-fingerprint dedup first.
    const byFp = new Map<string, Finding[]>();
    for (const f of members) {
      const key = f.fingerprint ?? f.id;
      if (!byFp.has(key)) byFp.set(key, []);
      byFp.get(key)!.push(f);
    }

    // Now seed semantic clustering: each fingerprint group becomes one seed cluster.
    const seedGroups = [...byFp.values()];
    const merged: Cluster[] = [];

    for (const group of seedGroups) {
      const placed = tryMergeIntoExisting(group, merged, embeddings, opts);
      if (!placed) {
        merged.push({ anchor: pickAnchor(group), siblings: group.filter((g) => g.id !== pickAnchor(group).id) });
      }
    }

    clusters.push(...merged);
  }

  return clusters;
}

function tryMergeIntoExisting(
  group: Finding[],
  existing: Cluster[],
  embeddings: Map<string, Float32Array>,
  opts: ClusterOptions,
): boolean {
  if (group.length === 0) return false;
  const sample = group[0]!;
  const sampleVec = embeddings.get(sample.id);
  if (!sampleVec) return false;

  for (const cluster of existing) {
    if (cluster.siblings.length + 1 >= opts.maxClusterSize) continue;
    const anchorVec = embeddings.get(cluster.anchor.id);
    if (!anchorVec) continue;
    const sim = cosine(sampleVec, anchorVec);
    if (sim >= opts.semanticThreshold) {
      // Merge group into this cluster. Anchor may shift to higher-confidence finding.
      const candidates = [cluster.anchor, ...cluster.siblings, ...group];
      const newAnchor = pickAnchor(candidates);
      cluster.anchor = newAnchor;
      cluster.siblings = candidates.filter((c) => c.id !== newAnchor.id);
      return true;
    }
  }
  return false;
}

/**
 * Anchor selection: highest confidence wins. Ties broken by:
 *   1. Most evidence items (richer report wins).
 *   2. Lower line number (more "top of file" = usually the source of the issue).
 *   3. Deterministic by finding ID for stability across re-runs.
 */
export function pickAnchor(group: Finding[]): Finding {
  return [...group].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.evidence.length !== a.evidence.length) return b.evidence.length - a.evidence.length;
    if (a.location.startLine !== b.location.startLine) return a.location.startLine - b.location.startLine;
    return a.id.localeCompare(b.id);
  })[0]!;
}
