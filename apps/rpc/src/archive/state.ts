// State history (storage.md, "State history"): the value of an account, storage slot or code at
// the end of any archived block. Per lookup: one round of Bloom filter blocks across every
// layer that starts at or before the block (in parallel), then two page reads (index page, data
// page) in the newest layer whose filter accepts the key, until one has an entry.
//
// One StateHistory serves one request: its layer descriptors are resolved once, and its reads
// are counted against a budget, so a request that keeps asking for new keys (an execution
// walking a large structure) stops instead of running to the time limit. Decoded pages, filter
// headers and filter blocks are shared by the isolate; a small filter (most layers above the
// base) is read whole once per isolate, so a key costs one filter read, the base layer's.

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Archive, Pin } from "./archive";
import { Uvarint } from "./hashindex";
import { Lru } from "./lru";
import { shared } from "../shared";
import { ArchiveError, ReadBudgetError, type ObjectRef } from "./types";

export type Domain = "accounts" | "storage" | "code";

/** One index page: its first (key, block) and its frame in the domain's `index` pack. */
interface RootEntry {
  /** Hex without 0x. */
  first_key: string;
  first_block: number;
  /** `block_number` is the index page's ordinal; offset and lengths locate it in `index`. */
  record: { block_number: number; offset: number; length: number; uncompressed_length: number; sha256: string };
}

interface DomainDescriptor {
  keys: number;
  entries: number;
  pages: number;
  packs: ObjectRef[];
  index: ObjectRef;
  filter: ObjectRef | null;
  root: RootEntry[];
}

interface LayerDescriptor {
  first: number;
  last: number;
  domains: Partial<Record<Domain, DomainDescriptor>>;
}

interface LayerRef {
  first: number;
  last: number;
  level: number;
  descriptor: ObjectRef;
}

const FILTER_BLOCK = 4096;
const FILTER_HEADER = 16;
/** Filters up to this size are read whole and kept per isolate, instead of a block per key. */
const WHOLE_FILTER_MAX = FILTER_HEADER + 64 * FILTER_BLOCK;
/** Archive reads (ranges and frames) one request may make through its state history. */
export const READ_BUDGET = 8192;

// Decoded immutable pages, per isolate. Entry counts are sized for a 128 MB isolate: an index
// page decodes to a few hundred KB, a data page to 32 KiB, a filter block is 4 KiB and a whole
// filter at most 256 KiB.
const indexPages = new Lru<string, IndexEntry[]>(128);
const dataPages = new Lru<string, Uint8Array>(768);
const filterHeaders = new Lru<string, { blocks: number; k: number }>(1024);
const filterBlocks = new Lru<string, Uint8Array>(4096);
const wholeFilters = new Lru<string, Uint8Array>(48);
const roots = new WeakMap<RootEntry[], { key: Uint8Array; block: number }[]>();

interface IndexEntry {
  key: Uint8Array;
  firstBlock: number;
  pack: number;
  offset: number;
  length: number;
  uncompressed: number;
  sha256: Uint8Array;
}

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compares (key, block) pairs: keys as bytes, then blocks. */
function compare(ak: Uint8Array, ab: number, bk: Uint8Array, bb: number): number {
  const n = Math.min(ak.length, bk.length);
  for (let i = 0; i < n; i++) if (ak[i] !== bk[i]) return ak[i]! - bk[i]!;
  if (ak.length !== bk.length) return ak.length - bk.length;
  return ab - bb;
}

/** Index of the last element at or before (key, n), or -1. */
function lastAtOrBefore<T>(items: T[], at: (t: T) => [Uint8Array, number], key: Uint8Array, n: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [k, b] = at(items[mid]!);
    if (compare(k, b, key, n) <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function bytes(r: Uvarint, frame: Uint8Array, n: number): Uint8Array {
  const out = frame.subarray(r.pos, r.pos + n);
  if (out.length !== n) throw new ArchiveError("truncated state page");
  r.pos += n;
  return out;
}

function parseIndexPage(frame: Uint8Array): IndexEntry[] {
  const r = new Uvarint(frame);
  const n = r.next();
  const out: IndexEntry[] = [];
  for (let i = 0; i < n; i++) {
    const key = bytes(r, frame, r.next());
    out.push({ key, firstBlock: r.next(), pack: r.next(), offset: r.next(), length: r.next(), uncompressed: r.next(), sha256: bytes(r, frame, 32) });
  }
  return out;
}

/** The key's last value at or before `n` in a data page: Uint8Array, or undefined if none. */
function findInDataPage(frame: Uint8Array, key: Uint8Array, n: number): Uint8Array | undefined {
  const r = new Uvarint(frame);
  while (!r.done) {
    const k = bytes(r, frame, r.next());
    const count = r.next();
    const cmp = compare(k, 0, key, 0);
    let block = 0;
    let found: Uint8Array | undefined;
    for (let i = 0; i < count; i++) {
      block = i === 0 ? r.next() : block + r.next();
      const v = bytes(r, frame, r.next());
      if (cmp === 0 && block <= n) found = v;
    }
    if (cmp === 0) return found;
    if (cmp > 0) return undefined;
  }
  return undefined;
}

function parseFilterHeader(h: Uint8Array, ref: ObjectRef): { blocks: number; k: number } {
  if (new TextDecoder().decode(h.subarray(0, 8)) !== "NRPCBLM1") throw new ArchiveError(`bad filter ${ref.key}`);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  return { blocks: v.getUint32(8, true), k: v.getUint32(12, true) };
}

export class StateHistory {
  /** Archive reads this history made (not counting what the isolate's caches answered). */
  reads = 0;
  /** Reads of this request in flight, so that one request reads each page once (src/shared.ts). */
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly sorted: LayerRef[];
  private descriptors: Promise<LayerDescriptor[]> | null = null;

  constructor(
    private readonly archive: Archive,
    pin: Pin,
    /** Reads this request may make; beyond it every lookup fails with ReadBudgetError. */
    private readonly budget = READ_BUDGET,
  ) {
    this.sorted = (pin.manifest.state_history.layers as LayerRef[]).slice().sort((a, b) => a.first - b.first);
  }

  private charge(): void {
    if (++this.reads > this.budget) throw new ReadBudgetError(this.reads);
  }

  private range(ref: ObjectRef, offset: number, length: number): Promise<Uint8Array> {
    this.charge();
    return this.archive.range(ref, offset, length);
  }

  private frame(f: Parameters<Archive["frame"]>[0]): Promise<Uint8Array> {
    this.charge();
    return this.archive.frame(f);
  }

  /** Every layer's descriptor, in block order, resolved once per request. */
  private layerDescriptors(): Promise<LayerDescriptor[]> {
    if (!this.descriptors) this.descriptors = Promise.all(this.sorted.map((l) => this.archive.json<LayerDescriptor>(l.descriptor)));
    return this.descriptors;
  }

  /** The filter's header and the 4 KiB block `block` of it, through the isolate's caches. */
  private async filterBlock(ref: ObjectRef, block: (header: { blocks: number; k: number }) => number): Promise<{ header: { blocks: number; k: number }; bits: Uint8Array } | null> {
    if (ref.bytes <= WHOLE_FILTER_MAX) {
      const whole = await shared(wholeFilters, this.pending, `whole:${ref.sha256}`, () => this.range(ref, 0, ref.bytes));
      const header = parseFilterHeader(whole, ref);
      if (header.blocks === 0) return null;
      const at = FILTER_HEADER + block(header) * FILTER_BLOCK;
      return { header, bits: whole.subarray(at, at + FILTER_BLOCK) };
    }
    const header = await shared(filterHeaders, this.pending, `header:${ref.sha256}`, () => this.range(ref, 0, FILTER_HEADER).then((h) => parseFilterHeader(h, ref)));
    if (header.blocks === 0) return null;
    const b = block(header);
    const bits = await shared(filterBlocks, this.pending, `bits:${ref.sha256}:${b}`, () => this.range(ref, FILTER_HEADER + b * FILTER_BLOCK, FILTER_BLOCK));
    return { header, bits };
  }

  /** Whether a layer's filter may contain the key (true when the layer has no filter). */
  private async mayContain(d: DomainDescriptor, key: Uint8Array): Promise<boolean> {
    if (!d.filter) return true;
    const h = keccak_256(key);
    const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const found = await this.filterBlock(d.filter, (header) => hv.getUint32(0, true) % header.blocks);
    if (!found) return false;
    const { header, bits } = found;
    const h1 = hv.getBigUint64(8, true);
    const h2 = hv.getBigUint64(16, true);
    for (let i = 0n; i < BigInt(header.k); i++) {
      const bit = Number((h1 + i * h2) % 32768n);
      if ((bits[bit >> 3]! & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }

  private rootKeys(d: DomainDescriptor) {
    let r = roots.get(d.root);
    if (!r) {
      r = d.root.map((e) => ({ key: fromHex(e.first_key), block: e.first_block }));
      roots.set(d.root, r);
    }
    return r;
  }

  /** The key's newest value at or before `n` within one layer; undefined if the layer has none. */
  private async inLayer(d: DomainDescriptor, key: Uint8Array, n: number): Promise<Uint8Array | undefined> {
    const rk = this.rootKeys(d);
    const ri = lastAtOrBefore(rk, (e) => [e.key, e.block], key, n);
    if (ri < 0) return undefined;
    const rec = d.root[ri]!.record;
    const page = await shared(indexPages, this.pending, `index:${d.index.sha256}:${rec.offset}`, () =>
      this.frame({ pack: d.index, offset: rec.offset, compressed: rec.length, uncompressed: rec.uncompressed_length, sha256: fromHex(rec.sha256) }).then(parseIndexPage),
    );
    const di = lastAtOrBefore(page, (e) => [e.key, e.firstBlock], key, n);
    if (di < 0) return undefined;
    const e = page[di]!;
    const pack = d.packs[e.pack];
    if (!pack) throw new ArchiveError("state index names a missing pack");
    const data = await shared(dataPages, this.pending, `data:${pack.sha256}:${e.offset}`, () => this.frame({ pack, offset: e.offset, compressed: e.length, uncompressed: e.uncompressed, sha256: e.sha256 }));
    return findInDataPage(data, key, n);
  }

  /** The value at the end of block `n` (empty when absent or zero). */
  async get(domain: Domain, key: Uint8Array, n: number): Promise<Uint8Array> {
    const descriptors = await this.layerDescriptors();
    // Layers that start after n hold nothing at n; domains without entries have an empty root.
    const withDomain = descriptors.filter((d, i) => this.sorted[i]!.first <= n).map((d) => d.domains[domain]).filter((d): d is DomainDescriptor => !!d && d.root.length > 0);
    const accepted = await Promise.all(withDomain.map((d) => this.mayContain(d, key)));
    // Newest layer first: the first with an entry at or before n answers.
    for (let i = withDomain.length - 1; i >= 0; i--) {
      if (!accepted[i]) continue;
      const v = await this.inLayer(withDomain[i]!, key, n);
      if (v !== undefined) return v;
    }
    return new Uint8Array();
  }
}

export interface Account {
  nonce: number;
  balance: bigint;
  /** 32 bytes, or null for an account without code. */
  codeHash: Uint8Array | null;
}

/** Decodes an `accounts` value; null when empty (no account). */
export function decodeAccount(v: Uint8Array): Account | null {
  if (v.length === 0) return null;
  const r = new Uvarint(v);
  const nonce = r.next();
  const len = r.next();
  let balance = 0n;
  for (let i = 0; i < len; i++) balance = (balance << 8n) | BigInt(v[r.pos + i]!);
  r.pos += len;
  const codeHash = r.pos < v.length ? v.subarray(r.pos, r.pos + 32) : null;
  if (codeHash && codeHash.length !== 32) throw new ArchiveError("bad account code hash");
  return { nonce, balance, codeHash };
}
