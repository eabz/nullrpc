// Log index (storage.md, "Log index"): the archived blocks that may contain logs matching a
// filter. Per field value and per partition the query touches, in parallel: one 56-byte
// directory record and one bucket frame. The caller reads each candidate block and applies the
// exact filter, so results equal a full scan.

import type { Archive, Pin } from "./archive";
import { indexKey, Uvarint } from "./hashindex";
import { ArchiveError, type ObjectRef } from "./types";

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
interface LogIndexObject {
  first: number;
  last: number;
  partitions: Partition[];
  directory: ObjectRef;
  packs: ObjectRef[];
}

const DIRECTORY_RECORD = 56;

/** A field value: tag 0x00 for the address, 0x01 + i for the topic at position i. */
export async function logKey(tag: number, value: Uint8Array, keyBytes: number): Promise<number> {
  const input = new Uint8Array(1 + value.length);
  input[0] = tag;
  input.set(value, 1);
  return indexKey(new Uint8Array(await crypto.subtle.digest("SHA-256", input)), keyBytes);
}

async function partitionBlocks(archive: Archive, obj: LogIndexObject, p: Partition, dirOffset: number, lo: number, key: number, keyBytes: number, from: number, to: number): Promise<number[]> {
  const shift = 2 ** (keyBytes * 8 - p.bucket_bits);
  const bucket = Math.floor(key / shift);
  const rec = await archive.range(obj.directory, dirOffset + bucket * DIRECTORY_RECORD, DIRECTORY_RECORD);
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const keys = view.getUint32(16, true);
  if (keys === 0) return [];
  const pack = obj.packs[view.getUint16(20, true)];
  if (!pack) throw new ArchiveError("log index directory names a missing pack");
  const frame = await archive.frame({
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
      b = j === 0 ? lo + r.next() : b + r.next() + 1;
      if (k === key && b >= from && b <= to) blocks.push(b);
    }
    if (k === key) return blocks;
    if (k > key) break;
  }
  return [];
}

/** Archived blocks in [from, to] whose logs may contain the field value. */
async function blocksFor(archive: Archive, pin: Pin, tag: number, value: Uint8Array, from: number, to: number): Promise<Set<number>> {
  const index = pin.manifest.log_index as { key_bytes: number; partition_blocks: number; objects: LogIndexObject[] } | null;
  if (!index) return new Set();
  const { key_bytes, partition_blocks: pb, objects } = index;
  const key = await logKey(tag, value, key_bytes);
  const reads: Promise<number[]>[] = [];
  for (const obj of objects ?? []) {
    if (obj.last < from || obj.first > to) continue;
    let dirOffset = 0;
    obj.partitions.forEach((p, j) => {
      const abs = Math.floor(obj.first / pb) + j;
      const lo = Math.max(abs * pb, obj.first);
      const hi = Math.min(abs * pb + pb - 1, obj.last);
      if (hi >= from && lo <= to) reads.push(partitionBlocks(archive, obj, p, dirOffset, lo, key, key_bytes, from, to));
      dirOffset += DIRECTORY_RECORD * 2 ** p.bucket_bits;
    });
  }
  return new Set((await Promise.all(reads)).flat());
}

/**
 * Candidate archived blocks for a filter in [from, to]: per group (the addresses; each
 * constrained topic position) the union of its values' blocks, then the intersection of groups.
 * Null when the filter constrains nothing (every block is a candidate).
 */
export async function logCandidates(archive: Archive, pin: Pin, groups: { tag: number; values: Uint8Array[] }[], from: number, to: number): Promise<number[] | null> {
  if (groups.length === 0) return null;
  const sets = await Promise.all(
    groups.map(async (g) => {
      const parts = await Promise.all(g.values.map((v) => blocksFor(archive, pin, g.tag, v, from, to)));
      const union = new Set<number>();
      for (const s of parts) for (const b of s) union.add(b);
      return union;
    }),
  );
  sets.sort((a, b) => a.size - b.size);
  const [smallest, ...rest] = sets;
  return [...smallest!].filter((b) => rest.every((s) => s.has(b))).sort((a, b) => a - b);
}
