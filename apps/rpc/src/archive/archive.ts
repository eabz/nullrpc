// Reads the R2 archive (docs/storage.md). A request pins one generation: it reads HEAD.json
// (cached in the isolate for up to 10 seconds) and uses that manifest throughout. Every object
// is reached through manifest references; every reference and frame is checked (size and
// SHA-256) before it is used.

import { decompress } from "@nullrpc/zstd";
import { equal } from "../eth/hex";
import { Lru } from "./lru";
import type { Source } from "./source";
import { ArchiveError, type FrameRef, type Head, type Manifest, type ObjectRef, type SegmentEntry, type SegmentMeta } from "./types";

/** HEAD.json is re-read at most this often per isolate. */
const HEAD_TTL_MS = 10_000;
/** Frames larger than this uncompressed are refused (storage.md, "Packs"). */
export const MAX_FRAME = 8 * 1024 * 1024;
/** offsets.bin is read in aligned pages of this many records (20 KiB), so neighbours share a read. */
export const OFFSETS_PAGE = 256;
const OFFSET_RECORD = 80;
/**
 * Coalesced block reads (`planBlockRuns`): blocks.pack is viewed as aligned windows of this many
 * bytes; a run is the consecutive windows that hold wanted blocks, within one aligned group of
 * RUN_WINDOWS windows, so the same region reads under the same cache key whatever the query.
 */
export const RUN_WINDOW = 256 * 1024;
export const RUN_WINDOWS = 8;

// Isolate caches, shared across requests. Every entry is immutable (keyed by digest or by an
// immutable object's key), except the HEAD entry, which expires.
const heads = new Map<string, { at: number; pin: Promise<Pin> }>();
const json = new Lru<string, Promise<unknown>>(256);
const pages = new Lru<string, Promise<Uint8Array>>(512);

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** One generation of the archive, fixed for the duration of a request. */
export interface Pin {
  generation: number;
  manifest: Manifest;
}

export class Archive {
  constructor(
    private readonly source: Source,
    /**
     * `{chain-id}-{genesis-hash}`: the archive's namespace in the bucket, where HEAD.json is. Every
     * ObjectRef's `key` is a full bucket key that already starts with it (docs/storage.md).
     */
    private readonly prefix: string,
  ) {}

  /** The archive's namespace in the bucket (`{chain-id}-{genesis-hash}`). */
  get namespace(): string {
    return this.prefix;
  }

  /** The bucket key of `ref`: as written, or namespaced when a writer left the namespace off. */
  private key(ref: ObjectRef): string {
    return ref.key.startsWith(`${this.prefix}/`) ? ref.key : `${this.prefix}/${ref.key}`;
  }

  /**
   * The current generation; cached per isolate for up to 10 seconds. `fresh` re-reads HEAD.json
   * (after the live window reports a promotion newer than the cached manifest).
   */
  pin(now = Date.now(), fresh = false): Promise<Pin> {
    const cached = heads.get(this.prefix);
    if (!fresh && cached && now - cached.at < HEAD_TTL_MS) return cached.pin;
    const pin = this.readPin();
    heads.set(this.prefix, { at: now, pin });
    // A failed read must not be served from the cache.
    pin.catch(() => heads.get(this.prefix)?.pin === pin && heads.delete(this.prefix));
    return pin;
  }

  private async readPin(): Promise<Pin> {
    const raw = await this.source.get(`${this.prefix}/HEAD.json`);
    if (!raw) throw new ArchiveError("archive has no HEAD.json");
    const head = JSON.parse(new TextDecoder().decode(raw)) as Head;
    if (head.version !== 1) throw new ArchiveError(`unsupported HEAD version ${head.version}`);
    const manifest = await this.json<Manifest>(head.manifest);
    if (manifest.format !== "nullrpc-archive" || manifest.version !== 1) throw new ArchiveError("unsupported manifest");
    if (manifest.generation !== head.generation) throw new ArchiveError("HEAD and manifest generations differ");
    return { generation: head.generation, manifest };
  }

  /** A whole JSON object, checked against its reference; cached by digest. */
  json<T>(ref: ObjectRef): Promise<T> {
    const id = ref.sha256;
    let p = json.get(id);
    if (!p) {
      p = (async () => {
        const raw = await this.source.get(this.key(ref));
        if (!raw) throw new ArchiveError(`missing object ${ref.key}`);
        await this.check(raw, ref);
        return JSON.parse(new TextDecoder().decode(raw));
      })();
      json.set(id, p);
      p.catch(() => json.delete(id));
    }
    return p as Promise<T>;
  }

  private async check(raw: Uint8Array, ref: ObjectRef): Promise<void> {
    if (raw.length !== ref.bytes) throw new ArchiveError(`size mismatch for ${ref.key}`);
    if (!equal(await sha256(raw), hexToBytes(ref.sha256))) throw new ArchiveError(`digest mismatch for ${ref.key}`);
  }

  /** Raw bytes of an immutable object's range (no digest: callers check what they read). */
  range(ref: ObjectRef, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > ref.bytes) throw new ArchiveError(`range outside ${ref.key}`);
    return this.source.range(this.key(ref), offset, length);
  }

  /** One frame: checked compressed length and SHA-256, decompressed, checked uncompressed length. */
  async frame(f: FrameRef): Promise<Uint8Array> {
    if (f.uncompressed > MAX_FRAME) throw new ArchiveError("frame too large");
    return this.decodeFrame(await this.range(f.pack, f.offset, f.compressed), f);
  }

  /** `compressed` is frame `f` as read: checks its digest, decompresses, checks the length. */
  async decodeFrame(compressed: Uint8Array, f: FrameRef): Promise<Uint8Array> {
    if (!equal(await sha256(compressed), f.sha256)) throw new ArchiveError(`frame digest mismatch in ${f.pack.key}`);
    const out = decompress(compressed, new Uint8Array(f.uncompressed));
    if (out.length !== f.uncompressed) throw new ArchiveError(`frame length mismatch in ${f.pack.key}`);
    return out;
  }

  // ---- blocks

  /** The segment holding block `n`, or null if the pinned archive does not cover it. */
  segment(pin: Pin, n: number): SegmentEntry | null {
    const s = pin.manifest.segments;
    let lo = 0;
    let hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = s[mid]!;
      if (n < seg.first) hi = mid - 1;
      else if (n > seg.last) lo = mid + 1;
      else return seg;
    }
    return null;
  }

  /** The offsets page holding block `n` of `seg` (page ids count distinct reads). */
  static offsetsPage(seg: SegmentEntry, n: number): string {
    return `${seg.meta.sha256}:${Math.floor((n - seg.first) / OFFSETS_PAGE)}`;
  }

  private async offsetsRecord(meta: SegmentMeta, n: number): Promise<Uint8Array> {
    const i = n - meta.first;
    const page = Math.floor(i / OFFSETS_PAGE);
    const offsets = meta.files["offsets.bin"];
    const id = `${offsets.sha256}:${page}`;
    let p = pages.get(id);
    if (!p) {
      const start = page * OFFSETS_PAGE * OFFSET_RECORD;
      const count = Math.min(OFFSETS_PAGE, meta.last - meta.first + 1 - page * OFFSETS_PAGE);
      p = this.range(offsets, start, count * OFFSET_RECORD);
      pages.set(id, p);
      p.catch(() => pages.delete(id));
    }
    const at = (i % OFFSETS_PAGE) * OFFSET_RECORD;
    return (await p).subarray(at, at + OFFSET_RECORD);
  }

  /** Block `n`'s record frame (uncompressed) and its hash, or null outside the archive. */
  async blockFrame(pin: Pin, n: number): Promise<{ hash: Uint8Array; frame: Uint8Array } | null> {
    const seg = this.segment(pin, n);
    if (!seg) return null;
    const meta = await this.json<SegmentMeta>(seg.meta);
    if (meta.files["offsets.bin"].bytes !== (meta.last - meta.first + 1) * OFFSET_RECORD) throw new ArchiveError("offsets.bin has the wrong size");
    const rec = await this.offsetsRecord(meta, n);
    const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    const frame = await this.frame({
      pack: meta.files["blocks.pack"],
      offset: Number(view.getBigUint64(32, true)),
      compressed: view.getUint32(40, true),
      uncompressed: view.getUint32(44, true),
      sha256: rec.subarray(48, 80),
    });
    return { hash: rec.subarray(0, 32), frame };
  }

  // ---- coalesced block reads

  /**
   * The runs that read archived blocks `numbers` (sorted, in the archive) with the fewest range
   * reads: per segment, the wanted blocks' offsets records (one read per OFFSETS_PAGE), then
   * their frames grouped into aligned windows of blocks.pack (RUN_WINDOW). Blocks outside the
   * pinned archive are left out.
   */
  /**
   * Per block of `numbers` (sorted), whether reading it needs an offsets page no earlier block
   * needed (one read each, at most); blocks outside the archive need none.
   */
  offsetsPages(pin: Pin, numbers: number[]): boolean[] {
    const ids = new Set<string>();
    let seg: SegmentEntry | null = null;
    return numbers.map((n) => {
      if (!seg || n < seg.first || n > seg.last) seg = this.segment(pin, n);
      if (!seg) return false;
      const id = Archive.offsetsPage(seg, n);
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
  }

  async planBlockRuns(pin: Pin, numbers: number[]): Promise<BlockRun[]> {
    const runs: BlockRun[] = [];
    let seg: SegmentEntry | null = null;
    let batch: number[] = [];
    const flush = async () => {
      if (seg && batch.length) runs.push(...(await this.segmentRuns(seg, batch)));
      batch = [];
    };
    for (const n of numbers) {
      if (!seg || n < seg.first || n > seg.last) {
        await flush();
        seg = this.segment(pin, n);
        if (!seg) continue;
      }
      batch.push(n);
    }
    await flush();
    return runs;
  }

  private async segmentRuns(seg: SegmentEntry, numbers: number[]): Promise<BlockRun[]> {
    const meta = await this.json<SegmentMeta>(seg.meta);
    if (meta.files["offsets.bin"].bytes !== (meta.last - meta.first + 1) * OFFSET_RECORD) throw new ArchiveError("offsets.bin has the wrong size");
    const pack = meta.files["blocks.pack"];
    const blocks = await Promise.all(
      numbers.map(async (n) => {
        const rec = await this.offsetsRecord(meta, n);
        const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        const f: FrameRef = { pack, offset: Number(view.getBigUint64(32, true)), compressed: view.getUint32(40, true), uncompressed: view.getUint32(44, true), sha256: rec.subarray(48, 80) };
        if (f.uncompressed > MAX_FRAME) throw new ArchiveError("frame too large");
        if (f.offset + f.compressed > pack.bytes) throw new ArchiveError(`block ${n} lies outside ${pack.key}`);
        return { n, hash: rec.subarray(0, 32), frame: f };
      }),
    );
    // Frames are in block order within the pack; sorting by offset keeps runs contiguous anyway.
    blocks.sort((a, b) => a.frame.offset - b.frame.offset);
    const runs: BlockRun[] = [];
    const group = RUN_WINDOW * RUN_WINDOWS;
    let run: BlockRun | null = null;
    for (const b of blocks) {
      const start = Math.floor(b.frame.offset / RUN_WINDOW) * RUN_WINDOW;
      const end = Math.min(pack.bytes, Math.ceil((b.frame.offset + b.frame.compressed) / RUN_WINDOW) * RUN_WINDOW);
      if (run && Math.floor(start / group) === Math.floor(run.offset / group) && start <= run.offset + run.length) {
        run.length = Math.max(run.length, end - run.offset);
        run.blocks.push(b);
      } else {
        run = { pack, offset: start, length: end - start, blocks: [b] };
        runs.push(run);
      }
    }
    return runs;
  }

  /** Reads one run (one range read) and returns its blocks' records, checked, in order. */
  async readRun(run: BlockRun): Promise<{ n: number; hash: Uint8Array; frame: Uint8Array }[]> {
    const bytes = await this.range(run.pack, run.offset, run.length);
    return Promise.all(
      run.blocks.map(async (b) => {
        const at = b.frame.offset - run.offset;
        return { n: b.n, hash: b.hash, frame: await this.decodeFrame(bytes.subarray(at, at + b.frame.compressed), b.frame) };
      }),
    );
  }
}

/** One range read of a blocks.pack covering the frames of `blocks`. */
export interface BlockRun {
  pack: ObjectRef;
  offset: number;
  length: number;
  blocks: { n: number; hash: Uint8Array; frame: FrameRef }[];
}
