import { stableId, type Finding } from '@abid/core';

/**
 * Build a stable fingerprint for a finding. Used for exact dedup and as a key
 * for the semantic-dedup embedding cache.
 *
 * Strategy: hash (ruleId + normalized evidence snippets). We deliberately
 * exclude the file path so the same issue in different files clusters together.
 */
export async function fingerprintOf(f: Finding): Promise<string> {
  const parts: string[] = [f.ruleId];
  for (const e of f.evidence) {
    switch (e.kind) {
      case 'ast':
        parts.push(`ast:${e.nodeKind}:${normalize(e.snippet ?? '')}`);
        break;
      case 'type':
        parts.push(`type:${e.allowsNullish}:${normalize(e.typeText)}`);
        break;
      case 'callgraph':
        parts.push(`cg:${e.path.length}`);
        break;
      case 'template-binding':
        parts.push(`tb:${normalize(e.expression)}`);
        break;
      case 'runtime':
        parts.push(`rt:${e.metric}`);
        break;
      case 'heap':
        parts.push(`heap:${e.retainedTypes[0]?.type ?? 'unknown'}`);
        break;
      case 'network':
        parts.push(`net:${e.count}`);
        break;
      case 'cross-file':
        parts.push(`xf:${e.matches.length}`);
        break;
    }
  }
  return stableId(parts.join('|'));
}

function normalize(s: string): string {
  // Normalize whitespace, strip identifier suffixes commonly varying across
  // files (`_2`, `Component`, etc.), and lowercase. The goal is "looks like
  // the same code shape" not "exactly identical text".
  return s
    .replace(/\s+/g, ' ')
    .replace(/\b\w+(Component|Service|Module|Directive|Pipe)\b/g, 'X')
    .trim()
    .toLowerCase();
}
