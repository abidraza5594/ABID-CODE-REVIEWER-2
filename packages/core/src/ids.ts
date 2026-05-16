/**
 * ULID generator. We use ULIDs rather than UUIDs because they sort lexicographically by time,
 * which makes log-correlated debugging much easier and reduces Postgres index bloat.
 *
 * Reference: https://github.com/ulid/spec
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_MAX = Math.pow(2, 48) - 1;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  if (now > TIME_MAX) throw new Error('cannot encode time > 2^48-1');
  let str = '';
  for (let i = len; i > 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    now = (now - mod) / ENCODING_LEN;
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  // Web Crypto is available in Node 20+ via globalThis.crypto.
  globalThis.crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < len; i++) {
    str += ENCODING.charAt(bytes[i]! % ENCODING_LEN);
  }
  return str;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

/**
 * Deterministic ID derived from a logical key. Used for fingerprints and
 * cache keys where stability across runs matters more than entropy.
 */
export async function stableId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
