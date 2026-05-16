/**
 * Heap diff utilities. The runtime-runner persists V8 heap snapshots
 * (`.heapsnapshot` JSON) to object storage. The memory analyzer reads two
 * snapshots and reports the delta in retained bytes per type.
 *
 * Why we don't parse the full snapshot here: a single snapshot for a real
 * Angular app is 100–500 MB JSON. We use a streaming reader keyed off the
 * `node_types` table to bucket nodes by type without materializing the full
 * graph. The orchestrator runs this on a memory-budgeted worker (max 1 GB).
 */
export interface HeapTypeDelta {
  type: string;
  baselineCount: number;
  finalCount: number;
  baselineBytes: number;
  finalBytes: number;
  deltaCount: number;
  deltaBytes: number;
}

export interface HeapDiffResult {
  topDeltas: HeapTypeDelta[];
  totalDeltaBytes: number;
  /** Detached DOM nodes seen only in the final snapshot. */
  detachedDom: number;
  /** Subscription objects net-growth (`type === 'Subscription'`). */
  retainedSubscriptions: number;
}

/**
 * Streamed snapshot reader. Caller passes async iterables of chunked text;
 * we use the V8 snapshot format invariants:
 *   - file is a single JSON object
 *   - `meta.node_types` lists the type strings indexed by node-type id
 *   - `nodes` is a flat array where each node occupies `meta.node_fields.length`
 *     positions, with `[type, name, id, self_size, ...]`
 *
 * For *this stub* we operate on the already-parsed JSON for clarity. The
 * production implementation switches to JSONStream + a SAX-style accumulator.
 */
export interface ParsedSnapshot {
  meta: {
    node_fields: string[];
    node_types: string[][];
    edge_fields: string[];
    edge_types: string[][];
  };
  nodes: number[];
  strings: string[];
}

export function diffSnapshots(baseline: ParsedSnapshot, final: ParsedSnapshot): HeapDiffResult {
  const baseCounts = bucketByType(baseline);
  const finalCounts = bucketByType(final);

  const allTypes = new Set<string>([...baseCounts.keys(), ...finalCounts.keys()]);
  const out: HeapTypeDelta[] = [];

  for (const type of allTypes) {
    const a = baseCounts.get(type) ?? { count: 0, bytes: 0 };
    const b = finalCounts.get(type) ?? { count: 0, bytes: 0 };
    out.push({
      type,
      baselineCount: a.count,
      finalCount: b.count,
      baselineBytes: a.bytes,
      finalBytes: b.bytes,
      deltaCount: b.count - a.count,
      deltaBytes: b.bytes - a.bytes,
    });
  }

  out.sort((x, y) => y.deltaBytes - x.deltaBytes);
  const topDeltas = out.filter((d) => d.deltaBytes > 0).slice(0, 25);
  const totalDeltaBytes = topDeltas.reduce((s, d) => s + d.deltaBytes, 0);
  const detachedDom = finalCounts.get('Detached HTMLDivElement')?.count ?? 0;
  const retainedSubscriptions = (finalCounts.get('Subscription')?.count ?? 0) - (baseCounts.get('Subscription')?.count ?? 0);

  return {
    topDeltas,
    totalDeltaBytes,
    detachedDom,
    retainedSubscriptions: Math.max(0, retainedSubscriptions),
  };
}

function bucketByType(snap: ParsedSnapshot): Map<string, { count: number; bytes: number }> {
  const out = new Map<string, { count: number; bytes: number }>();
  const stride = snap.meta.node_fields.length;
  const typeIdx = snap.meta.node_fields.indexOf('type');
  const nameIdx = snap.meta.node_fields.indexOf('name');
  const sizeIdx = snap.meta.node_fields.indexOf('self_size');
  const nodeTypeStrings = snap.meta.node_types[typeIdx] ?? [];

  for (let i = 0; i < snap.nodes.length; i += stride) {
    const tIdx = snap.nodes[i + typeIdx]!;
    const nameStrIdx = snap.nodes[i + nameIdx]!;
    const size = snap.nodes[i + sizeIdx]!;
    const typeBase = nodeTypeStrings[tIdx] ?? 'unknown';
    const nameStr = snap.strings[nameStrIdx] ?? '';
    // Prefer the named class for objects (e.g. 'Subscription'); fall back to typeBase.
    const key = typeBase === 'object' && nameStr ? nameStr : typeBase;
    const cur = out.get(key) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += size;
    out.set(key, cur);
  }
  return out;
}
