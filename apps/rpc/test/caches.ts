/** An in-memory stand-in for `caches.default`: URL-keyed, bodies copied on put and on match. */
export class FakeCache {
  readonly entries = new Map<string, { bytes: Uint8Array; headers: [string, string][] }>();
  puts = 0;

  private url(key: RequestInfo | URL): string {
    return typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
  }

  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    const e = this.entries.get(this.url(key));
    return e ? new Response(e.bytes.slice() as BodyInit, { headers: e.headers }) : undefined;
  }

  async put(key: RequestInfo | URL, res: Response): Promise<void> {
    this.puts++;
    this.entries.set(this.url(key), { bytes: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] });
  }

  async delete(key: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.url(key));
  }

  get keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Installs this cache as the global `caches.default` for the duration of `f`. */
  async install<T>(f: () => Promise<T>): Promise<T> {
    const g = globalThis as { caches?: unknown };
    const before = g.caches;
    g.caches = { default: this as unknown as Cache };
    try {
      return await f();
    } finally {
      if (before === undefined) delete g.caches;
      else g.caches = before;
    }
  }
}
