import type { Finding } from '@abid/core';

/**
 * Embedding provider abstraction. The semantic-dedup pass needs vector
 * embeddings of finding summaries. In production we point this at Mistral's
 * embeddings API; in tests/local dev we use the deterministic fake.
 */
export interface EmbedClient {
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/** Deterministic fake — hashes text into a fixed-dim pseudo-vector. */
export class FakeEmbedClient implements EmbedClient {
  constructor(private readonly dim = 64) {}

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashVec(t, this.dim));
  }
}

function hashVec(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    const idx = (h1 ^ h2) % dim;
    v[idx] = (v[idx] ?? 0) + (((h1 & 0xffff) / 0xffff) * 2 - 1);
  }
  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Both expected to be unit vectors when produced by the providers we use.
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Text to embed for a finding. We use the title + the first AST evidence snippet. */
export function findingEmbeddingText(f: Finding): string {
  const ast = f.evidence.find((e) => e.kind === 'ast');
  const astSnippet = ast?.kind === 'ast' ? ast.snippet ?? ast.description : '';
  return `${f.ruleId}\n${f.message.title}\n${astSnippet}`;
}
