// Values shared per isolate across requests, without sharing promises.
//
// workerd ties every promise to the request whose handler created it: the I/O behind it is
// canceled when that request ends, and a request that awaits another request's promise waits
// on work it does not own. On the platform the runtime cancels such a request as hung ("The
// Workers runtime canceled this request because it detected that your Worker's code had hung
// and would never generate a response") and, when the promise later settles, warns that "a
// promise was resolved or rejected from a different request context than the one it was created
// in"; under wrangler dev the wait never ends once the creating request has finished. So an
// isolate cache holds settled values only: a request that finds none reads for itself, and the
// first read to settle fills the cache for the requests after it. A read one request issues
// twice is shared within that request alone, through a `pending` map the request's own object
// owns (Archive, Live and StateHistory are built per request).

/** The settled side of an isolate cache: a Map, an Lru, or any get/set pair. */
export interface Settled<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
}

/**
 * `key`'s value: from `settled` when it holds one, else from `read`, which runs once per request
 * (`pending`, the request's own) and whose answer is kept in `settled` when `keep` admits it (by
 * default always; `undefined` is never kept).
 */
export function shared<K, V>(settled: Settled<K, V>, pending: Map<K, Promise<unknown>>, key: K, read: () => Promise<V>, keep: (value: V) => boolean = () => true): Promise<V> {
  const have = settled.get(key);
  if (have !== undefined) return Promise.resolve(have);
  let p = pending.get(key) as Promise<V> | undefined;
  if (!p) {
    p = read().then((value) => {
      if (value !== undefined && keep(value)) settled.set(key, value);
      return value;
    });
    pending.set(key, p);
    p.then(
      () => pending.delete(key),
      () => pending.delete(key),
    );
  }
  return p;
}
