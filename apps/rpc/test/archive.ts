// Test-only archive writer: builds a complete generation in memory (HEAD.json, manifest,
// segments with blocks.pack and offsets.bin, and a hash index) from the mainnet fixtures,
// following docs/storage.md. The Worker's reader is tested against it through MemorySource.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import type { HashIndexObject, ObjectRef } from "../src/archive/types";
import { concat, parseData } from "../src/eth/hex";
import { encodeRecord, encodeRecordParts, type Fixture } from "./encode";

/** Ethereum mainnet's genesis `config` (fork schedule and blob parameters). */
export const MAINNET_CONFIG = {
  chainId: 1, homesteadBlock: 1150000, daoForkBlock: 1920000, daoForkSupport: true, eip150Block: 2463000, eip155Block: 2675000,
  eip158Block: 2675000, byzantiumBlock: 4370000, constantinopleBlock: 7280000, petersburgBlock: 7280000, istanbulBlock: 9069000,
  muirGlacierBlock: 9200000, berlinBlock: 12244000, londonBlock: 12965000, arrowGlacierBlock: 13773000, grayGlacierBlock: 15050000,
  terminalTotalDifficulty: 58750000000000000000000, shanghaiTime: 1681338455, cancunTime: 1710338135, pragueTime: 1746612311,
  osakaTime: 1764798551, depositContractAddress: "0x00000000219ab540356cbb839cbe05303d7705fa",
  blobSchedule: { cancun: { target: 3, max: 6, baseFeeUpdateFraction: 3338477 }, prague: { target: 6, max: 9, baseFeeUpdateFraction: 5007716 }, osaka: { target: 6, max: 9, baseFeeUpdateFraction: 5007716 } },
};

export const PREFIX = "1-d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3";
const KEY_BYTES = 6;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class Builder {
  readonly objects = new Map<string, Uint8Array>();
  put(key: string, bytes: Uint8Array): ObjectRef {
    // References carry full bucket keys, as the daemon writes them (docs/storage.md).
    this.objects.set(`${PREFIX}/${key}`, bytes);
    return { key: `${PREFIX}/${key}`, bytes: bytes.length, sha256: hexOf(sha(bytes)) };
  }
  putJson(key: string, value: unknown): ObjectRef {
    return this.put(key, new TextEncoder().encode(JSON.stringify(value)));
  }
}

function packHeader(codec: number): Uint8Array {
  const h = new Uint8Array(16);
  h.set(new TextEncoder().encode("NRPCPACK"));
  new DataView(h.buffer).setUint16(8, 1, true);
  new DataView(h.buffer).setUint16(10, codec, true);
  return h;
}

export function uvarint(v: number): number[] {
  const out: number[] = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** Packs frames into one .pack and returns each frame's location. */
function pack(frames: Uint8Array[], codec: number) {
  const parts: Uint8Array[] = [packHeader(codec)];
  let offset = 16;
  const located = frames.map((f) => {
    const c = new Uint8Array(zstdCompressSync(f));
    parts.push(c);
    const at = { offset, compressed: c.length, uncompressed: f.length, sha256: sha(c) };
    offset += c.length;
    return at;
  });
  return { bytes: concat(...parts), frames: located };
}

function hashIndex(b: Builder, fixtures: Fixture[], first: number, last: number, bucketBits: { tx: number; block: number }): HashIndexObject {
  type Entry = { k: number; block: number; index: number };
  const key = (hash: string) => {
    const h = parseData(hash)!;
    let k = 0;
    for (let i = 0; i < KEY_BYTES; i++) k = k * 256 + h[i]!;
    return k;
  };
  const txs: Entry[] = [];
  const blocks: Entry[] = [];
  for (const f of fixtures) {
    const n = Number(f.block.number);
    blocks.push({ k: key(f.block.hash), block: n, index: 0 });
    f.block.transactions.forEach((t: { hash: string }, i: number) => txs.push({ k: key(t.hash), block: n, index: i }));
  }
  const frames: Uint8Array[] = [];
  const directories: Record<string, { bits: number; records: { frame: number; entries: number }[] }> = {};
  for (const [name, entries, bits, withIndex] of [["transactions", txs, bucketBits.tx, true], ["blocks", blocks, bucketBits.block, false]] as const) {
    entries.sort((a, b) => a.k - b.k || a.block - b.block || a.index - b.index);
    const buckets = new Map<number, Entry[]>();
    for (const e of entries) {
      const bucket = Math.floor(e.k / 2 ** (KEY_BYTES * 8 - bits));
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), e]);
    }
    const records: { frame: number; entries: number }[] = Array.from({ length: 2 ** bits }, () => ({ frame: -1, entries: 0 }));
    for (const [bucket, es] of buckets) {
      // Key deltas start from the bucket's base key (services/internal/core/hashindex.go).
      let prev = bucket * 2 ** (KEY_BYTES * 8 - bits);
      const bytes: number[] = [];
      for (const e of es) {
        bytes.push(...uvarint(e.k - prev), ...uvarint(e.block - first));
        if (withIndex) bytes.push(...uvarint(e.index));
        prev = e.k;
      }
      records[bucket] = { frame: frames.length, entries: es.length };
      frames.push(Uint8Array.from(bytes));
    }
    directories[name] = { bits, records };
  }
  const p = pack(frames, 3);
  const packRef = b.put(`hash-index/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}/pack-${hexOf(sha(p.bytes))}.pack`, p.bytes);
  const part = (name: string) => {
    const d = directories[name]!;
    const dir = new Uint8Array(d.records.length * 56);
    const view = new DataView(dir.buffer);
    d.records.forEach((r, i) => {
      if (r.frame < 0) return;
      const f = p.frames[r.frame]!;
      view.setBigUint64(i * 56, BigInt(f.offset), true);
      view.setUint32(i * 56 + 8, f.compressed, true);
      view.setUint32(i * 56 + 12, f.uncompressed, true);
      view.setUint32(i * 56 + 16, r.entries, true);
      view.setUint16(i * 56 + 20, 0, true);
      dir.set(f.sha256, i * 56 + 24);
    });
    const ref = b.put(`hash-index/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}/${name}-${hexOf(sha(dir))}.dir`, dir);
    return { bucket_bits: d.bits, entries: d.records.reduce((s, r) => s + r.entries, 0), directory: ref };
  };
  return { first, last, transactions: part("transactions"), blocks: part("blocks"), packs: [packRef] };
}

/**
 * Builds a generation: one segment per run of consecutive fixture blocks, and the hash index
 * split into two objects (as promotion tiers produce), so lookups exercise several objects.
 */
export interface StateEntry {
  domain: "accounts" | "storage" | "code";
  key: Uint8Array;
  block: number;
  value: Uint8Array;
}

export interface ArchiveOptions {
  /** State history entries, split into one layer per [first, last] range. */
  state?: { entries: StateEntry[]; layers: [number, number][]; filters?: boolean };
  /** Extra manifest fields (log index, witnesses, config). */
  extra?: (b: Builder) => Record<string, unknown>;
  /** Segment layout (storage.md, "Block bundles"): 2 (the default, what the daemon writes) or 1 (older generations). */
  layout?: 1 | 2;
}

export function buildArchive(fixtures: Fixture[], opts: ArchiveOptions = {}): Map<string, Uint8Array> {
  const b = new Builder();
  const runs: Fixture[][] = [];
  for (const f of fixtures) {
    const last = runs.at(-1);
    if (last && Number(last.at(-1)!.block.number) + 1 === Number(f.block.number)) last.push(f);
    else runs.push([f]);
  }
  const layout = opts.layout ?? 2;
  const segments = runs.map((run) => {
    const first = Number(run[0]!.block.number);
    const last = Number(run.at(-1)!.block.number);
    const parts = run.map(encodeRecordParts);
    const p = pack(layout === 2 ? parts.map((x) => x.block) : run.map(encodeRecord), 1);
    const rp = layout === 2 ? pack(parts.map((x) => x.receipts), 6) : null;
    const len = layout === 2 ? 128 : 80;
    const offsets = new Uint8Array(run.length * len);
    const view = new DataView(offsets.buffer);
    const put = (at: number, fr: { offset: number; compressed: number; uncompressed: number; sha256: Uint8Array }) => {
      view.setBigUint64(at, BigInt(fr.offset), true);
      view.setUint32(at + 8, fr.compressed, true);
      view.setUint32(at + 12, fr.uncompressed, true);
      offsets.set(fr.sha256, at + 16);
    };
    run.forEach((f, i) => {
      offsets.set(parseData(f.block.hash)!, i * len);
      put(i * len + 32, p.frames[i]!);
      if (rp) put(i * len + 80, rp.frames[i]!);
    });
    const dir = `segments/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}-${run.at(-1)!.block.hash.slice(2)}/c0ffee`;
    const files: Record<string, ObjectRef> = { "blocks.pack": b.put(`${dir}/blocks.pack`, p.bytes), "offsets.bin": b.put(`${dir}/offsets.bin`, offsets) };
    if (rp) files["receipts.pack"] = b.put(`${dir}/receipts.pack`, rp.bytes);
    const meta = b.putJson(`${dir}/meta.json`, { first, last, first_parent_hash: run[0]!.block.parentHash, last_hash: run.at(-1)!.block.hash, ...(layout === 2 ? { layout } : {}), files });
    return { first, last, last_hash: run.at(-1)!.block.hash, meta };
  });
  const half = Math.ceil(fixtures.length / 2);
  const lo = fixtures.slice(0, half);
  const hi = fixtures.slice(half);
  const objects = [
    hashIndex(b, lo, Number(lo[0]!.block.number), Number(lo.at(-1)!.block.number), { tx: 6, block: 2 }),
    hashIndex(b, hi, Number(hi[0]!.block.number), Number(hi.at(-1)!.block.number), { tx: 6, block: 2 }),
  ];
  const tip = fixtures.at(-1)!.block;
  const config = b.putJson("config/genesis.json", { config: MAINNET_CONFIG, alloc: {} });
  const manifest = b.putJson("manifests/00000000000000000001-test.json", {
    format: "nullrpc-archive",
    version: 1,
    generation: 1,
    chain: { id: 1, network_id: "1", genesis_hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3" },
    config,
    first_block: 0,
    archived_through: { number: Number(tip.number), hash: tip.hash, state_root: tip.stateRoot },
    finalized_observed: { number: Number(tip.number), hash: tip.hash },
    chunk_blocks: 8192,
    segments,
    hash_index: { key_bytes: KEY_BYTES, objects },
    log_index: { key_bytes: 6, partition_blocks: 65536, objects: [] },
    state_history: { layers: opts.state ? opts.state.layers.map(([first, last], i) => stateLayer(b, opts.state!.entries, first, last, i, opts.state!.filters ?? true)) : [] },
    witnesses: { first_block: 0, ranges: [] },
    created_at: "2026-10-08T00:00:00Z",
    ...(opts.extra ? opts.extra(b) : {}),
  });
  b.putJson("HEAD.json", { version: 1, generation: 1, manifest });
  return b.objects;
}

// ---- state history (storage.md, "State history"). Pages are tiny so lookups cross page and
// index-page boundaries.

const DATA_PAGE_TARGET = 120;
const INDEX_PAGE_ENTRIES = 3;

function cmpKey(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function bloom(keys: Uint8Array[]): Uint8Array {
  const blocks = Math.max(1, Math.ceil((keys.length * 10) / 32768));
  const out = new Uint8Array(16 + blocks * 4096);
  out.set(new TextEncoder().encode("NRPCBLM1"));
  const v = new DataView(out.buffer);
  v.setUint32(8, blocks, true);
  v.setUint32(12, 7, true);
  for (const key of keys) {
    const h = keccak_256(key);
    const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const block = hv.getUint32(0, true) % blocks;
    const h1 = hv.getBigUint64(8, true);
    const h2 = hv.getBigUint64(16, true);
    for (let i = 0n; i < 7n; i++) {
      const bit = Number((h1 + i * h2) % 32768n);
      out[16 + block * 4096 + (bit >> 3)]! |= 1 << (bit & 7);
    }
  }
  return out;
}

function stateLayer(b: Builder, all: StateEntry[], first: number, last: number, n: number, filters: boolean) {
  const dir = `state/layers/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}-l${n}`;
  const domains: Record<string, unknown> = {};
  for (const domain of ["accounts", "storage", "code"] as const) {
    const entries = all
      .filter((e) => e.domain === domain && e.block >= first && e.block <= last)
      .sort((x, y) => cmpKey(x.key, y.key) || x.block - y.block);
    if (!entries.length) {
      // Domains without entries are still listed, with an empty root.
      const empty = pack([], 2);
      domains[domain] = { keys: 0, entries: 0, pages: 0, packs: [b.put(`${dir}/${domain}.0000.pack`, empty.bytes)], index: b.put(`${dir}/${domain}.index.pack`, empty.bytes), filter: null, root: [] };
      continue;
    }
    // Data pages: groups of (key, entries); a key's run may continue on the next page.
    const pages: { first: StateEntry; bytes: number[] }[] = [];
    let cur: { first: StateEntry; bytes: number[] } | null = null;
    let i = 0;
    while (i < entries.length) {
      if (!cur || cur.bytes.length >= DATA_PAGE_TARGET) {
        cur = { first: entries[i]!, bytes: [] };
        pages.push(cur);
      }
      const key = entries[i]!.key;
      const run: StateEntry[] = [];
      while (i < entries.length && cmpKey(entries[i]!.key, key) === 0 && (run.length < 2 || cur.bytes.length < DATA_PAGE_TARGET)) run.push(entries[i++]!);
      cur.bytes.push(...uvarint(key.length), ...key, ...uvarint(run.length));
      let prev = 0;
      run.forEach((e, j) => {
        cur!.bytes.push(...uvarint(j === 0 ? e.block : e.block - prev), ...uvarint(e.value.length), ...e.value);
        prev = e.block;
      });
    }
    const data = pack(pages.map((p) => Uint8Array.from(p.bytes)), 2);
    const dataRef = b.put(`${dir}/${domain}.0000.pack`, data.bytes);
    // Index pages over the data pages.
    const indexFrames: Uint8Array[] = [];
    const indexFirsts: StateEntry[] = [];
    for (let p = 0; p < pages.length; p += INDEX_PAGE_ENTRIES) {
      const chunk = pages.slice(p, p + INDEX_PAGE_ENTRIES);
      const bytes: number[] = [...uvarint(chunk.length)];
      chunk.forEach((pg, j) => {
        const fr = data.frames[p + j]!;
        bytes.push(...uvarint(pg.first.key.length), ...pg.first.key, ...uvarint(pg.first.block), ...uvarint(0), ...uvarint(fr.offset), ...uvarint(fr.compressed), ...uvarint(fr.uncompressed), ...fr.sha256);
      });
      indexFrames.push(Uint8Array.from(bytes));
      indexFirsts.push(chunk[0]!.first);
    }
    const index = pack(indexFrames, 2);
    const indexRef = b.put(`${dir}/${domain}.index.pack`, index.bytes);
    const keys = [...new Map(entries.map((e) => [hexOf(e.key), e.key])).values()];
    const filter = filters ? b.put(`${dir}/${domain}.filter`, bloom(keys)) : null;
    domains[domain] = {
      keys: keys.length,
      entries: entries.length,
      pages: pages.length,
      packs: [dataRef],
      index: indexRef,
      root: index.frames.map((fr, j) => ({
        first_key: hexOf(indexFirsts[j]!.key),
        first_block: indexFirsts[j]!.block,
        // block_number is the index page's ordinal (services/internal/core/statebuild.go).
        record: { block_number: j, offset: fr.offset, length: fr.compressed, uncompressed_length: fr.uncompressed, sha256: hexOf(fr.sha256) },
      })),
      filter,
    };
  }
  const descriptor = b.putJson(`${dir}/layer.json`, { first, last, domains });
  return { first, last, level: n, descriptor };
}

/** A witness range (storage.md, "Witnesses"): one frame per block from `first` on, in order. */
export function witnessRange(b: Builder, first: number, frames: Uint8Array[]) {
  const p = pack(frames, 1);
  const offsets = new Uint8Array(frames.length * 56);
  const view = new DataView(offsets.buffer);
  p.frames.forEach((fr, i) => {
    view.setBigUint64(i * 56, BigInt(fr.offset), true);
    view.setUint32(i * 56 + 8, fr.compressed, true);
    view.setUint32(i * 56 + 12, fr.uncompressed, true);
    view.setUint16(i * 56 + 16, 0, true);
    offsets.set(fr.sha256, i * 56 + 24);
  });
  const last = first + frames.length - 1;
  const dir = `witnesses/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}`;
  return { first, last, offsets: b.put(`${dir}/offsets.bin`, offsets), packs: [b.put(`${dir}/witness.0.pack`, p.bytes)] };
}

/** The executor's JSON witness as the archive stores it (storage.md, "Witnesses"). */
export function encodeWitness(w: Witness): Uint8Array {
  const bigBytes = (hex: string) => {
    const b = parseData("0x" + (hex.slice(2).length % 2 ? "0" : "") + hex.slice(2))!;
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    return b.subarray(i);
  };
  const out: number[] = [1, ...uvarint(w.accounts.length)];
  for (const a of w.accounts) {
    const balance = bigBytes(a.balance);
    out.push(...parseData(a.address, 20)!, (a.exists ? 1 : 0) | (a.codeHash ? 2 : 0), ...uvarint(a.nonce), ...uvarint(balance.length), ...balance);
    if (a.codeHash) out.push(...parseData(a.codeHash, 32)!);
  }
  out.push(...uvarint(w.storage.length));
  for (const s of w.storage) {
    out.push(...parseData(s.address, 20)!, ...uvarint(s.slots.length));
    for (const slot of s.slots) {
      const value = bigBytes(slot.value);
      out.push(...parseData("0x" + slot.slot.slice(2).padStart(64, "0"), 32)!, ...uvarint(value.length), ...value);
    }
  }
  return Uint8Array.from(out);
}

/** An `accounts` value: uvarint(nonce) uvarint(len) balance code_hash?. */
export function encodeAccount(nonce: number, balance: bigint, codeHash?: Uint8Array): Uint8Array {
  const bal: number[] = [];
  for (let x = balance; x > 0n; x >>= 8n) bal.unshift(Number(x & 0xffn));
  return Uint8Array.from([...uvarint(nonce), ...uvarint(bal.length), ...bal, ...(codeHash ?? [])]);
}

// ---- log index (storage.md, "Log index"; services/internal/core/logindex.go), built from the
// fixtures' receipts: one object, every partition its range touches, one concatenated directory.

export function logIndex(b: Builder, fixtures: Fixture[], partitionBlocks = 65_536, bucketBits = 4) {
  const keyOf = (tag: number, value: string) => {
    const h = sha(Uint8Array.from([tag, ...parseData(value)!]));
    let k = 0;
    for (let i = 0; i < KEY_BYTES; i++) k = k * 256 + h[i]!;
    return k;
  };
  const first = Number(fixtures[0]!.block.number);
  const last = Number(fixtures.at(-1)!.block.number);
  const firstPart = Math.floor(first / partitionBlocks);
  const count = Math.floor(last / partitionBlocks) - firstPart + 1;
  // partition ordinal -> key -> blocks
  const parts = Array.from({ length: count }, () => new Map<number, Set<number>>());
  for (const f of fixtures) {
    const n = Number(f.block.number);
    const keys = parts[Math.floor(n / partitionBlocks) - firstPart]!;
    for (const r of f.receipts)
      for (const l of r.logs) {
        const add = (k: number) => keys.set(k, (keys.get(k) ?? new Set()).add(n));
        add(keyOf(0, l.address));
        l.topics.forEach((t: string, i: number) => add(keyOf(1 + i, t)));
      }
  }
  const frames: Uint8Array[] = [];
  const records: { frame: number; keys: number }[][] = [];
  const meta: { bucket_bits: number; keys: number; entries: number }[] = [];
  parts.forEach((keys, j) => {
    const lo = Math.max((firstPart + j) * partitionBlocks, first);
    const buckets = new Map<number, [number, number[]][]>();
    for (const [k, set] of [...keys].sort((x, y) => x[0] - y[0])) {
      const bucket = Math.floor(k / 2 ** (KEY_BYTES * 8 - bucketBits));
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), [k, [...set].sort((x, y) => x - y)]]);
    }
    const recs = Array.from({ length: 2 ** bucketBits }, () => ({ frame: -1, keys: 0 }));
    let entries = 0;
    for (const [bucket, list] of buckets) {
      const bytes: number[] = [];
      let prev = bucket * 2 ** (KEY_BYTES * 8 - bucketBits);
      for (const [k, blocks] of list) {
        bytes.push(...uvarint(k - prev), ...uvarint(blocks.length));
        blocks.forEach((bl, i) => bytes.push(...uvarint(i === 0 ? bl - lo : bl - blocks[i - 1]! - 1)));
        prev = k;
        entries += blocks.length;
      }
      recs[bucket] = { frame: frames.length, keys: list.length };
      frames.push(Uint8Array.from(bytes));
    }
    records.push(recs);
    meta.push({ bucket_bits: bucketBits, keys: keys.size, entries });
  });
  const p = pack(frames, 4);
  const range = `${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}`;
  const packRef = b.put(`log-index/${range}/pack-${hexOf(sha(p.bytes))}.pack`, p.bytes);
  const dir = new Uint8Array(records.reduce((n, r) => n + r.length * 56, 0));
  const view = new DataView(dir.buffer);
  let at = 0;
  for (const recs of records)
    for (const r of recs) {
      if (r.frame >= 0) {
        const fr = p.frames[r.frame]!;
        view.setBigUint64(at, BigInt(fr.offset), true);
        view.setUint32(at + 8, fr.compressed, true);
        view.setUint32(at + 12, fr.uncompressed, true);
        view.setUint32(at + 16, r.keys, true);
        dir.set(fr.sha256, at + 24);
      }
      at += 56;
    }
  const directory = b.put(`log-index/${range}/directory-${hexOf(sha(dir))}.dir`, dir);
  return { key_bytes: KEY_BYTES, partition_blocks: partitionBlocks, objects: [{ first, last, partitions: meta, directory, packs: [packRef] }] };
}
