import type { ParsedSnapshot } from './heap-diff.js';

/**
 * Counts detached-DOM nodes between two snapshots. Detached DOM is a strong
 * indicator of a retained component subtree — usually held by:
 *   - a forgotten event listener on `document` / `window`
 *   - a forgotten subscription whose closure references DOM refs
 *   - a `@ViewChild` reference held in a parent that wasn't destroyed
 *
 * "Detached" in V8 snapshots corresponds to nodes whose type is `HTMLElement`
 * (or a subclass name) that are NOT reachable from `window.document`.
 *
 * The cheap proxy: count nodes whose `name` starts with `Detached `. Chrome's
 * snapshot format labels them that way for unmounted DOM. This is the metric
 * Chrome DevTools' Memory pane shows.
 */
export interface DetachedDomReport {
  detachedNodeCount: number;
  /** Top-named detached element types (e.g. "Detached HTMLDivElement"). */
  topNames: Array<{ name: string; count: number }>;
}

export function detachedDom(final: ParsedSnapshot): DetachedDomReport {
  const stride = final.meta.node_fields.length;
  const typeIdx = final.meta.node_fields.indexOf('type');
  const nameIdx = final.meta.node_fields.indexOf('name');
  const nodeTypeStrings = final.meta.node_types[typeIdx] ?? [];

  const counts = new Map<string, number>();
  for (let i = 0; i < final.nodes.length; i += stride) {
    const tIdx = final.nodes[i + typeIdx]!;
    const t = nodeTypeStrings[tIdx] ?? '';
    if (t !== 'object') continue;
    const nameStrIdx = final.nodes[i + nameIdx]!;
    const nameStr = final.strings[nameStrIdx] ?? '';
    if (!nameStr.startsWith('Detached ')) continue;
    counts.set(nameStr, (counts.get(nameStr) ?? 0) + 1);
  }

  let total = 0;
  const sorted: Array<{ name: string; count: number }> = [];
  for (const [name, count] of counts) {
    total += count;
    sorted.push({ name, count });
  }
  sorted.sort((a, b) => b.count - a.count);
  return { detachedNodeCount: total, topNames: sorted.slice(0, 10) };
}
