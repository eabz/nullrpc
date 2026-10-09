// The archive's JSON objects (docs/storage.md, "R2").

export interface ObjectRef {
  key: string;
  bytes: number;
  sha256: string;
}

export interface Head {
  version: number;
  generation: number;
  manifest: ObjectRef;
}

export interface SegmentEntry {
  first: number;
  last: number;
  last_hash: string;
  meta: ObjectRef;
}

export interface SegmentMeta {
  first: number;
  last: number;
  first_parent_hash: string;
  last_hash: string;
  files: { "blocks.pack": ObjectRef; "offsets.bin": ObjectRef };
}

export interface IndexPart {
  bucket_bits: number;
  entries: number;
  directory: ObjectRef;
}

export interface HashIndexObject {
  first: number;
  last: number;
  transactions: IndexPart;
  blocks: IndexPart;
  packs: ObjectRef[];
}

export interface Manifest {
  format: string;
  version: number;
  generation: number;
  chain: { id: number; network_id: string; genesis_hash: string };
  config: ObjectRef;
  first_block: number;
  archived_through: { number: number; hash: string; state_root: string };
  finalized_observed: { number: number; hash: string };
  chunk_blocks: number;
  segments: SegmentEntry[];
  hash_index: { key_bytes: number; objects: HashIndexObject[] } | null;
  log_index: { key_bytes: number; partition_blocks: number; objects: unknown[] } | null;
  state_history: { layers: unknown[] };
  witnesses: unknown;
  created_at: string;
}

/** Where a frame lives and how to check it: a pack, its offset, lengths and digest. */
export interface FrameRef {
  pack: ObjectRef;
  offset: number;
  compressed: number;
  uncompressed: number;
  sha256: Uint8Array;
}

export class ArchiveError extends Error {}
