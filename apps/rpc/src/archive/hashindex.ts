// Hash index (storage.md, "Hash index"): the block of a transaction or block hash, in a fixed
// number of reads. Per index object, in parallel: one 56-byte directory record, then one bucket
// frame. Matches are only candidates (keys are 6-byte prefixes); callers confirm each by
// reading the block and comparing the full hash.
//
// Directories are immutable (content-addressed), so their records are read in aligned pages
// kept per isolate: lookups in one request, and across requests, share them.

import type { Archive, Pin } from "./archive";
import { Lru } from "./lru";
import { ArchiveError, type HashIndexObject, type IndexPart } from "./types";

const DIRECTORY_RECORD = 56;
/** Directory records are read in aligned pages of this many (7 KiB), so neighbouring buckets share a read. */
export const DIRECTORY_PAGE = 128;
/** Directory pages per isolate, by directory digest and page number (immutable). Exported for tests. */
export const directoryPages = new Lru<string, Promise<Uint8Array>>(512);

export interface Candidate {
  block: number;
  /** Transaction index within the block (transactions only). */
  index: number;
}

/** Reads unsigned LEB128 values up to 2^53. */
export class Uvarint {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  next(): number {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.bytes[this.pos++];
      if (b === undefined) throw new ArchiveError("truncated uvarint");
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
      if (mul > 2 ** 56) throw new ArchiveError("uvarint too long");
    }
  }
}

/** The index key: the first `keyBytes` bytes of the hash, big-endian. */
export function indexKey(hash: Uint8Array, keyBytes: number): number {
  let k = 0;
  for (let i = 0; i < keyBytes; i++) k = k * 256 + hash[i]!;
  return k;
}

/** The page id a bucket's directory record is read under (page ids count distinct reads). */
export function directoryPage(part: IndexPart, bucket: number): string {
  return `${part.directory.sha256}:${Math.floor(bucket / DIRECTORY_PAGE)}`;
}

/** Bucket `bucket`'s 56-byte directory record, through the isolate's page cache. */
async function directoryRecord(archive: Archive, part: IndexPart, bucket: number): Promise<Uint8Array> {
  if ((bucket + 1) * DIRECTORY_RECORD > part.directory.bytes) throw new ArchiveError("hash index directory is too short");
  const page = Math.floor(bucket / DIRECTORY_PAGE);
  const id = directoryPage(part, bucket);
  let p = directoryPages.get(id);
  if (!p) {
    const start = page * DIRECTORY_PAGE * DIRECTORY_RECORD;
    p = archive.range(part.directory, start, Math.min(DIRECTORY_PAGE * DIRECTORY_RECORD, part.directory.bytes - start));
    directoryPages.set(id, p);
    p.catch(() => directoryPages.delete(id));
  }
  const at = (bucket % DIRECTORY_PAGE) * DIRECTORY_RECORD;
  return (await p).subarray(at, at + DIRECTORY_RECORD);
}

async function lookupObject(archive: Archive, obj: HashIndexObject, part: IndexPart, key: number, keyBytes: number, withIndex: boolean): Promise<Candidate[]> {
  const bucket = Math.floor(key / 2 ** (keyBytes * 8 - part.bucket_bits));
  const rec = await directoryRecord(archive, part, bucket);
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const entries = view.getUint32(16, true);
  if (entries === 0) return [];
  const pack = obj.packs[view.getUint16(20, true)];
  if (!pack) throw new ArchiveError("hash index directory names a missing pack");
  const frame = await archive.frame({
    pack,
    offset: Number(view.getBigUint64(0, true)),
    compressed: view.getUint32(8, true),
    uncompressed: view.getUint32(12, true),
    sha256: rec.subarray(24, 56),
  });
  const r = new Uvarint(frame);
  const out: Candidate[] = [];
  // Key deltas start from the bucket's base key.
  let k = bucket * 2 ** (keyBytes * 8 - part.bucket_bits);
  for (let i = 0; i < entries; i++) {
    k += r.next();
    const block = obj.first + r.next();
    const index = withIndex ? r.next() : 0;
    // Entries are sorted by key: stop once past it.
    if (k > key) break;
    if (k === key) out.push({ block, index });
  }
  return out;
}

async function lookup(archive: Archive, pin: Pin, hash: Uint8Array, kind: "transactions" | "blocks"): Promise<Candidate[]> {
  if (!pin.manifest.hash_index) return [];
  const { key_bytes, objects } = pin.manifest.hash_index;
  const key = indexKey(hash, key_bytes);
  const found = await Promise.all(objects.map((o) => lookupObject(archive, o, o[kind], key, key_bytes, kind === "transactions")));
  return found.flat();
}

/** Candidate locations (block, index) of a transaction hash. */
export function transactionCandidates(archive: Archive, pin: Pin, hash: Uint8Array): Promise<Candidate[]> {
  return lookup(archive, pin, hash, "transactions");
}

/** Candidate block numbers of a block hash. */
export async function blockCandidates(archive: Archive, pin: Pin, hash: Uint8Array): Promise<number[]> {
  return (await lookup(archive, pin, hash, "blocks")).map((c) => c.block);
}
