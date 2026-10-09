// Reads the R2 archive (docs/storage.md). A request pins one generation: it reads HEAD.json
// (cached in the isolate for up to 10 seconds) and uses that manifest throughout. Every object
// is reached through manifest references; every reference and frame is checked (size and
// SHA-256) before it is used.

import { decompress } from "@nullrpc/frames";
import { equal } from "../eth/hex";
import { joinRecord } from "../eth/record";
import { Lru } from "./lru";
import { shared } from "../shared";
import type { Source } from "./source";
import { ArchiveError, type FrameRef, type Head, type Manifest, type ObjectRef, type SegmentEntry, type SegmentMeta } from "./types";

/** HEAD.json is re-read at most this often per isolate. */
const HEAD_TTL_MS = 10_000;
/** Frames larger than this uncompressed are refused (storage.md, "Packs"). */
export const MAX_FRAME = 8 * 1024 * 1024;
/** offsets.bin is read in aligned pages of this many records (20 or 32 KiB), so neighbours share a read. */
export const OFFSETS_PAGE = 256;

/**
 * A segment's offsets.bin record length by layout (storage.md, "Block bundles"): 80 bytes for
 * one record frame per block, 128 when the receipts frame in receipts.pack follows it. Also
 * checks the file's size and, for layout 2, that receipts.pack is there.
 */
function offsetRecordLength(meta: SegmentMeta): number {
  const layout = meta.layout ?? 1;
  if (layout !== 1 && layout !== 2) throw new ArchiveError(`unsupported segment layout ${layout}`);
  if (layout === 2 && !meta.files["receipts.pack"]) throw new ArchiveError("layout 2 segment lacks receipts.pack");
  const len = layout === 2 ? 128 : 80;
  if (meta.files["offsets.bin"].bytes !== (meta.last - meta.first + 1) * len) throw new ArchiveError("offsets.bin has the wrong size");
  return len;
}

/** The frame reference at byte `at` of an offsets record: offset (u64), lengths (u32, u32), SHA-256. */
function frameRefAt(rec: Uint8Array, at: number, pack: ObjectRef): FrameRef {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  return { pack, offset: Number(view.getBigUint64(at, true)), compressed: view.getUint32(at + 8, true), uncompressed: view.getUint32(at + 12, true), sha256: rec.subarray(at + 16, at + 48) };
}

/** What a block run decodes: whole records (layout 1, blocks.pack) or receipts frames (layout 2, receipts.pack). */
export type RunKind = "record" | "receipts";
/**
 * What a caller needs of a block: the whole record (receipts too), or only the block (header,
 * transactions, senders), which a layout-2 segment answers from its block frame alone.
 */
export type BlockNeed = "record" | "block";
/** What `blockFrame` returned: a whole record, or (layout 2, need "block") the block frame alone. */
export interface BlockFrame {
  hash: Uint8Array;
  kind: BlockNeed;
  frame: Uint8Array;
}
/**
 * Coalesced block reads (`planBlockRuns`): blocks.pack is viewed as aligned windows of this many
 * bytes; a run is the consecutive windows that hold wanted blocks, within one aligned group of
 * RUN_WINDOWS windows, so the same region reads under the same cache key whatever the query.
 */
export const RUN_WINDOW = 256 * 1024;
export const RUN_WINDOWS = 8;

// Isolate caches, shared across requests as settled values, never as reads in flight
// (src/shared.ts). Every entry is immutable (keyed by digest or by an immutable object's key),
// except the HEAD entry, which expires.
const heads = new Map<string, { at: number; pin: Pin }>();
const json = new Lru<string, unknown>(256);
const pages = new Lru<string, Uint8Array>(512);

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
  /** Reads of this request in flight, so that one request reads each object once (src/shared.ts). */
  private readonly pending = new Map<string, Promise<unknown>>();

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
   * (after the live window reports a promotion newer than the cached manifest). The isolate
   * shares the settled pin, never a read in flight: a request that finds it missing or expired
   * reads HEAD.json itself (src/shared.ts).
   */
  pin(now = Date.now(), fresh = false): Promise<Pin> {
    const cached = heads.get(this.prefix);
    if (!fresh && cached && now - cached.at < HEAD_TTL_MS) return Promise.resolve(cached.pin);
    return this.readPin(now, fresh);
  }

  private async readPin(now: number, fresh: boolean): Promise<Pin> {
    const pin = await this.readHead();
    // A fresh read is the authority; otherwise the newest read wins.
    const cached = heads.get(this.prefix);
    if (fresh || !cached || cached.at <= now) heads.set(this.prefix, { at: now, pin });
    return pin;
  }

  private async readHead(): Promise<Pin> {
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
    return shared(json, this.pending, `json:${ref.sha256}`, async () => {
      const raw = await this.source.get(this.key(ref));
      if (!raw) throw new ArchiveError(`missing object ${ref.key}`);
      await this.check(raw, ref);
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    }) as Promise<T>;
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

  private async offsetsRecord(meta: SegmentMeta, n: number, len: number): Promise<Uint8Array> {
    const i = n - meta.first;
    const page = Math.floor(i / OFFSETS_PAGE);
    const offsets = meta.files["offsets.bin"];
    const id = `${offsets.sha256}:${page}`;
    const whole = await shared(pages, this.pending, `page:${id}`, () => {
      const start = page * OFFSETS_PAGE * len;
      const count = Math.min(OFFSETS_PAGE, meta.last - meta.first + 1 - page * OFFSETS_PAGE);
      return this.range(offsets, start, count * len);
    });
    const at = (i % OFFSETS_PAGE) * len;
    return whole.subarray(at, at + len);
  }

  /**
   * Block `n`'s record (uncompressed; storage.md, "Block records") and its hash, or null
   * outside the archive. A layout-2 segment's block and receipts frames are read together and
   * joined, so the record is the same whatever the layout; when the caller needs only the block
   * (`need` "block"), the receipts frame is not read and the block frame is returned as is
   * (`kind` "block"). A layout-1 segment always answers with the record.
   */
  async blockFrame(pin: Pin, n: number, need: BlockNeed = "record"): Promise<BlockFrame | null> {
    const seg = this.segment(pin, n);
    if (!seg) return null;
    const meta = await this.json<SegmentMeta>(seg.meta);
    const len = offsetRecordLength(meta);
    const rec = await this.offsetsRecord(meta, n, len);
    const hash = rec.subarray(0, 32);
    const block = this.frame(frameRefAt(rec, 32, meta.files["blocks.pack"]));
    if (len === 80) return { hash, kind: "record", frame: await block };
    if (need === "block") return { hash, kind: "block", frame: await block };
    const [b, r] = await Promise.all([block, this.frame(frameRefAt(rec, 80, meta.files["receipts.pack"]!))]);
    return { hash, kind: "record", frame: joinRecord(b, r) };
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

  /**
   * `kind` "receipts" plans the frames a log query decodes: the receipts frames of layout-2
   * segments (receipts.pack), the whole records of layout-1 ones; "record" plans whole records
   * only, so it refuses layout-2 segments (their records are two frames: blockFrame).
   */
  async planBlockRuns(pin: Pin, numbers: number[], kind: RunKind = "receipts"): Promise<BlockRun[]> {
    const runs: BlockRun[] = [];
    let seg: SegmentEntry | null = null;
    let batch: number[] = [];
    const flush = async () => {
      if (seg && batch.length) runs.push(...(await this.segmentRuns(seg, batch, kind)));
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

  private async segmentRuns(seg: SegmentEntry, numbers: number[], kind: RunKind): Promise<BlockRun[]> {
    const meta = await this.json<SegmentMeta>(seg.meta);
    const len = offsetRecordLength(meta);
    if (len === 128 && kind === "record") throw new ArchiveError("layout 2 segments store records as two frames");
    const receipts = len === 128;
    const pack = receipts ? meta.files["receipts.pack"]! : meta.files["blocks.pack"];
    const at = receipts ? 80 : 32;
    const blocks = await Promise.all(
      numbers.map(async (n) => {
        const rec = await this.offsetsRecord(meta, n, len);
        const f = frameRefAt(rec, at, pack);
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
        run = { pack, kind: receipts ? "receipts" : "record", offset: start, length: end - start, blocks: [b] };
        runs.push(run);
      }
    }
    return runs;
  }

  /** Reads one run (one range read) and returns its blocks' frames, checked, in order. */
  async readRun(run: BlockRun): Promise<RunBlock[]> {
    const bytes = await this.range(run.pack, run.offset, run.length);
    return Promise.all(
      run.blocks.map(async (b) => {
        const at = b.frame.offset - run.offset;
        return { n: b.n, hash: b.hash, kind: run.kind, frame: await this.decodeFrame(bytes.subarray(at, at + b.frame.compressed), b.frame) };
      }),
    );
  }
}

/** One range read of a pack covering the frames of `blocks`: whole records or receipts frames (`kind`). */
export interface BlockRun {
  pack: ObjectRef;
  kind: RunKind;
  offset: number;
  length: number;
  blocks: { n: number; hash: Uint8Array; frame: FrameRef }[];
}

/** A block read from a run: its decompressed frame, a whole record or a receipts frame (`kind`). */
export interface RunBlock {
  n: number;
  hash: Uint8Array;
  kind: RunKind;
  frame: Uint8Array;
}
