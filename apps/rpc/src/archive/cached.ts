// An edge cache in front of the archive bucket. Every archive object except HEAD.json is
// immutable and content-addressed (docs/storage.md), so a range or a whole object, once read
// from R2, is stored in the data center's Cache API (`caches.default`) under a synthetic URL
// built from the object key, offset and length, and served from there for a day. Misses fill
// the cache after the response (ctx.waitUntil); HEAD.json always goes to the bucket.

import type { Source } from "./source";

/** Seconds an immutable object stays in the edge cache. */
export const ARCHIVE_CACHE_TTL_S = 86_400;
/** Bump when the stored representation changes. */
const VERSION = "v1";

/** Reads one request issued to the edge cache (HEAD.json reads are not counted). */
export interface ArchiveCacheCounter {
  hit: number;
  miss: number;
}

/** The counter as the response header reports it. */
export function archiveCacheHeader(c: ArchiveCacheCounter): string {
  return `hit=${c.hit} miss=${c.miss}`;
}

/** The synthetic URL a read is cached under; `length` undefined means the whole object. */
export function archiveCacheUrl(origin: string, key: string, offset?: number, length?: number): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = `${origin}/_cache/archive/${VERSION}/${path}`;
  return length === undefined ? url : `${url}?o=${offset}&l=${length}`;
}

export class CachedSource implements Source {
  readonly counter: ArchiveCacheCounter = { hit: 0, miss: 0 };

  constructor(
    private readonly inner: Source,
    /** `caches.default`, or null to read through (tests, local development). */
    private readonly cache: Cache | null,
    /** Keys are scoped to this origin (the Worker's own hostname). */
    private readonly origin: string,
    /** `ctx.waitUntil`: cache fills run after the response. */
    private readonly defer: (p: Promise<unknown>) => void,
  ) {}

  async range(key: string, offset: number, length: number): Promise<Uint8Array> {
    if (!this.cache) return this.inner.range(key, offset, length);
    const url = archiveCacheUrl(this.origin, key, offset, length);
    const hit = await this.lookup(url, length);
    if (hit) return hit;
    const bytes = await this.inner.range(key, offset, length);
    this.store(url, bytes);
    return bytes;
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (!this.cache || key.endsWith("/HEAD.json") || key === "HEAD.json") return this.inner.get(key);
    const url = archiveCacheUrl(this.origin, key);
    const hit = await this.lookup(url);
    if (hit) return hit;
    const bytes = await this.inner.get(key);
    // A missing object is not cached: the manifest may be ahead of a slow write, and the next
    // generation may name the key.
    if (bytes) this.store(url, bytes);
    return bytes;
  }

  /** The cached bytes, or null on a miss (a damaged entry counts as a miss and is refilled). */
  private async lookup(url: string, length?: number): Promise<Uint8Array | null> {
    let res: Response | undefined;
    try {
      res = await this.cache!.match(url);
    } catch {
      res = undefined;
    }
    if (res) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (length === undefined || bytes.length === length) {
        this.counter.hit++;
        return bytes;
      }
    }
    this.counter.miss++;
    return null;
  }

  private store(url: string, bytes: Uint8Array): void {
    const res = new Response(bytes as BodyInit, {
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length), "cache-control": `public, max-age=${ARCHIVE_CACHE_TTL_S}` },
    });
    this.defer(this.cache!.put(url, res).catch(() => undefined));
  }
}

