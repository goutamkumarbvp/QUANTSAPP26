/**
 * Fast integer hashing used by the procedural market: every random quantity is a pure
 * function of integer coordinates (contract id, day index, minute …), so any point in
 * time can be recomputed without storing history.
 */

export function hashInts(seed: number, a: number, b = 0, c = 0, d = 0): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ (a | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h ^ (d | 0), 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0x9e3779b1);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hashU(seed: number, a: number, b = 0, c = 0, d = 0): number {
  return hashInts(seed, a, b, c, d) / 4294967296;
}

/** Standard normal from integer coordinates (Box–Muller on two hashes). */
export function hashN(seed: number, a: number, b = 0, c = 0, d = 0): number {
  const u1 = Math.max(hashU(seed, a, b, c, d), 1e-12);
  const u2 = hashU(seed ^ 0x5bd1e995, a, b, c, d);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value as K;
      this.map.delete(first);
    }
  }
  getOrCreate(key: K, make: () => V): V {
    let v = this.get(key);
    if (v === undefined) {
      v = make();
      this.set(key, v);
    }
    return v;
  }
}
