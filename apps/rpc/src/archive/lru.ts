/** A small least-recently-used map, bounded by entry count. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/** A least-recently-used map bounded by the total size of its values (bytes, as given per entry). */
export class SizedLru<K, V> {
  private readonly map = new Map<K, { value: V; size: number }>();
  private total = 0;

  constructor(private readonly budget: number) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Stores the entry unless it alone exceeds the budget; evicts the least recently used ones to fit. */
  set(key: K, value: V, size: number): void {
    if (size > this.budget) return;
    const old = this.map.get(key);
    if (old) this.total -= old.size;
    this.map.delete(key);
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }

  get bytes(): number {
    return this.total;
  }
}
