// Log index (storage.md, "Log index"): the archived blocks that may contain logs matching a
// filter. Reads are planned before they are issued so a query's cost is known (`logIndexCost`):
// a small index object (directory and pack under WHOLE_DIRECTORY / WHOLE_PACK) is read whole,
// twice at most, whatever the filter; a large one costs one 56-byte directory record and one
// bucket frame per field value and partition the query touches, identical reads shared. The
// caller reads each candidate block and applies the exact filter, so results equal a full scan.

import type { Archive, Pin } from "./archive";
import { indexKey, Uvarint } from "./hashindex";
import { ArchiveError, type FrameRef, type ObjectRef } from "./types";

interface Partition {
  bucket_bits: number;
  keys: number;
  entries: number;
}

/**
 * One log index object. Partition j covers absolute partition `floor(first / PB) + j`, clipped
 * to [first, last]; its 56-byte bucket records start in `directory` after the records of the
 * partitions before it (each `56 << bucket_bits` bytes).
 */
export interface LogIndexObject {
  first: number;
  last: number;
  partitions: Partition[];
  directory: ObjectRef;
  packs: ObjectRef[];
}

interface LogIndex {
  key_bytes: number;
  partition_blocks: number;
  objects: LogIndexObject[];
}

const DIRECTORY_RECORD = 56;
/** A directory up to this size is read whole (one read serves every key). */
export const WHOLE_DIRECTORY = 64 * 1024;
/** A single pack up to this size is read whole (one read serves every bucket frame). */
export const WHOLE_PACK = 256 * 1024;

/** A field value: tag 0x00 for the address, 0x01 + i for the topic at position i. */
export async function logKey(tag: number, value: Uint8Array, keyBytes: number): Promise<number> {
  const input = new Uint8Array(1 + value.length);
  input[0] = tag;
  input.set(value, 1);
  return indexKey(new Uint8Array(await crypto.subtle.digest("SHA-256", input)), keyBytes);
}

/** A filter field: the addresses (tag 0), or the values accepted at a topic position (tag 1 + i). */
export interface Group {
  tag: number;
  values: Uint8Array[];
}

/** A partition of an object the query touches, with the directory offset of its records. */
interface Touched {
  obj: LogIndexObject;
  p: Partition;
  dirOffset: number;
  /** The partition's first block (block numbers in its frames are relative to it). */
  lo: number;
}

function whole(obj: LogIndexObject): boolean {
  return obj.directory.bytes <= WHOLE_DIRECTORY && obj.packs.length === 1 && obj.packs[0]!.bytes <= WHOLE_PACK;
}

function touched(index: LogIndex, from: number, to: number): Touched[] {
  const out: Touched[] = [];
  for (const obj of index.objects ?? []) {
    if (obj.last < from || obj.first > to) continue;
    let dirOffset = 0;
    obj.partitions.forEach((p, j) => {
      const abs = Math.floor(obj.first / index.partition_blocks) + j;
      const lo = Math.max(abs * index.partition_blocks, obj.first);
      const hi = Math.min(abs * index.partition_blocks + index.partition_blocks - 1, obj.last);
      if (hi >= from && lo <= to) out.push({ obj, p, dirOffset, lo });
      dirOffset += DIRECTORY_RECORD * 2 ** p.bucket_bits;
    });
  }
  return out;
}

/**
 * An upper bound on the reads `logCandidates` issues for the filter over [from, to], from the
 * manifest alone: 2 per small object, else 2 per distinct value per touched partition.
 */
export function logIndexCost(pin: Pin, groups: Group[], from: number, to: number): number {
  const index = pin.manifest.log_index as LogIndex | null;
  if (!index || groups.length === 0) return 0;
  const values = groups.reduce((n, g) => n + g.values.length, 0);
  let cost = 0;
  const seen = new Set<LogIndexObject>();
  for (const t of touched(index, from, to)) {
    if (whole(t.obj)) {
      if (!seen.has(t.obj)) cost += 2;
      seen.add(t.obj);
    } else cost += 2 * values;
  }
  return cost;
}

/**
 * The widest range ending at `to` whose index reads fit `budget`, or null when the newest
 * object alone does not (too many field values). Objects are dropped oldest first.
 */
export function logIndexRangeFor(pin: Pin, groups: Group[], from: number, to: number, budget: number): { from: number; to: number } | null {
  const index = pin.manifest.log_index as LogIndex | null;
  if (!index || groups.length === 0) return { from, to };
  const objects = (index.objects ?? []).filter((o) => o.last >= from && o.first <= to).sort((a, b) => b.first - a.first);
  let start: number | null = null;
  for (const o of objects) {
    const candidate = Math.max(from, o.first);
    if (logIndexCost(pin, groups, candidate, to) > budget) break;
    start = candidate;
  }
  return start === null ? null : { from: start, to };
}

/** Reads of one query: identical ranges and frames are issued once; `reads` counts them. */
class Reader {
  reads = 0;
  private readonly ranges = new Map<string, Promise<Uint8Array>>();
  private readonly frames = new Map<string, Promise<Uint8Array>>();
  private readonly wholePacks = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly archive: Archive) {}

  range(ref: ObjectRef, offset: number, length: number): Promise<Uint8Array> {
    const id = `${ref.sha256}:${offset}:${length}`;
    let p = this.ranges.get(id);
    if (!p) {
      this.reads++;
      p = this.archive.range(ref, offset, length);
      this.ranges.set(id, p);
    }
    return p;
  }

  /** A bucket frame: sliced out of the whole pack when the object is small, else one read. */
  frame(obj: LogIndexObject, f: FrameRef): Promise<Uint8Array> {
    const id = `${f.pack.sha256}:${f.offset}`;
    let p = this.frames.get(id);
    if (!p) {
      p = whole(obj) ? this.wholePack(f.pack).then((bytes) => this.archive.decodeFrame(bytes.subarray(f.offset, f.offset + f.compressed), f)) : this.archive.frame(f);
      if (!whole(obj)) this.reads++;
      this.frames.set(id, p);
    }
    return p;
  }

  private wholePack(pack: ObjectRef): Promise<Uint8Array> {
    let p = this.wholePacks.get(pack.sha256);
    if (!p) {
      p = this.range(pack, 0, pack.bytes);
      this.wholePacks.set(pack.sha256, p);
    }
    return p;
  }
}

/** The bucket record of `key` in a touched partition: whole directory for small objects. */
async function directoryRecord(reader: Reader, t: Touched, bucket: number): Promise<Uint8Array> {
  const at = t.dirOffset + bucket * DIRECTORY_RECORD;
  if (whole(t.obj)) return (await reader.range(t.obj.directory, 0, t.obj.directory.bytes)).subarray(at, at + DIRECTORY_RECORD);
  return reader.range(t.obj.directory, at, DIRECTORY_RECORD);
}

async function partitionBlocks(reader: Reader, t: Touched, key: number, keyBytes: number, from: number, to: number): Promise<number[]> {
  const shift = 2 ** (keyBytes * 8 - t.p.bucket_bits);
  const bucket = Math.floor(key / shift);
  const rec = await directoryRecord(reader, t, bucket);
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const keys = view.getUint32(16, true);
  if (keys === 0) return [];
  const pack = t.obj.packs[view.getUint16(20, true)];
  if (!pack) throw new ArchiveError("log index directory names a missing pack");
  const frame = await reader.frame(t.obj, {
    pack,
    offset: Number(view.getBigUint64(0, true)),
    compressed: view.getUint32(8, true),
    uncompressed: view.getUint32(12, true),
    sha256: rec.subarray(24, 56),
  });
  const r = new Uvarint(frame);
  // Key deltas start from the bucket's base key; block numbers from the partition's first block.
  let k = bucket * shift;
  for (let i = 0; i < keys; i++) {
    k += r.next();
    const n = r.next();
    const blocks: number[] = [];
    let b = 0;
    for (let j = 0; j < n; j++) {
      b = j === 0 ? t.lo + r.next() : b + r.next() + 1;
      if (k === key && b >= from && b <= to) blocks.push(b);
    }
    if (k === key) return blocks;
    if (k > key) break;
  }
  return [];
}

/** Archived blocks in [from, to] whose logs may contain the field value. */
async function blocksFor(reader: Reader, index: LogIndex, parts: Touched[], tag: number, value: Uint8Array, from: number, to: number): Promise<Set<number>> {
  const key = await logKey(tag, value, index.key_bytes);
  const found = await Promise.all(parts.map((t) => partitionBlocks(reader, t, key, index.key_bytes, from, to)));
  return new Set(found.flat());
}

/**
 * Candidate archived blocks for a filter in [from, to]: per group (the addresses; each
 * constrained topic position) the union of its values' blocks, then the intersection of groups.
 * `blocks` is null when the filter constrains nothing (every block is a candidate); `reads` is
 * the number of archive reads issued (at most `logIndexCost`).
 */
export async function logCandidates(archive: Archive, pin: Pin, groups: Group[], from: number, to: number): Promise<{ blocks: number[] | null; reads: number }> {
  if (groups.length === 0) return { blocks: null, reads: 0 };
  const index = pin.manifest.log_index as LogIndex | null;
  if (!index) return { blocks: [], reads: 0 };
  const reader = new Reader(archive);
  const parts = touched(index, from, to);
  const sets = await Promise.all(
    groups.map(async (g) => {
      const found = await Promise.all(g.values.map((v) => blocksFor(reader, index, parts, g.tag, v, from, to)));
      const union = new Set<number>();
      for (const s of found) for (const b of s) union.add(b);
      return union;
    }),
  );
  sets.sort((a, b) => a.size - b.size);
  const [smallest, ...rest] = sets;
  return { blocks: [...smallest!].filter((b) => rest.every((s) => s.has(b))).sort((a, b) => a - b), reads: reader.reads };
}
