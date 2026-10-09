// Test-only archive writer: builds a complete generation in memory (HEAD.json, manifest,
// segments with blocks.pack and offsets.bin, and a hash index) from the mainnet fixtures,
// following docs/storage.md. The Worker's reader is tested against it through MemorySource.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import type { HashIndexObject, ObjectRef } from "../src/archive/types";
import { concat, parseData } from "../src/eth/hex";
import { encodeRecord, type Fixture } from "./encode";

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
    this.objects.set(`${PREFIX}/${key}`, bytes);
    return { key, bytes: bytes.length, sha256: hexOf(sha(bytes)) };
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

function uvarint(v: number): number[] {
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
      let prev = 0;
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
}

export function buildArchive(fixtures: Fixture[], opts: ArchiveOptions = {}): Map<string, Uint8Array> {
  const b = new Builder();
  const runs: Fixture[][] = [];
  for (const f of fixtures) {
    const last = runs.at(-1);
    if (last && Number(last.at(-1)!.block.number) + 1 === Number(f.block.number)) last.push(f);
    else runs.push([f]);
  }
  const segments = runs.map((run) => {
    const first = Number(run[0]!.block.number);
    const last = Number(run.at(-1)!.block.number);
    const p = pack(run.map(encodeRecord), 1);
    const offsets = new Uint8Array(run.length * 80);
    const view = new DataView(offsets.buffer);
    run.forEach((f, i) => {
      const fr = p.frames[i]!;
      offsets.set(parseData(f.block.hash)!, i * 80);
      view.setBigUint64(i * 80 + 32, BigInt(fr.offset), true);
      view.setUint32(i * 80 + 40, fr.compressed, true);
      view.setUint32(i * 80 + 44, fr.uncompressed, true);
      offsets.set(fr.sha256, i * 80 + 48);
    });
    const dir = `segments/${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}-${run.at(-1)!.block.hash.slice(2)}/c0ffee`;
    const blocks = b.put(`${dir}/blocks.pack`, p.bytes);
    const offs = b.put(`${dir}/offsets.bin`, offsets);
    const meta = b.putJson(`${dir}/meta.json`, { first, last, last_hash: run.at(-1)!.block.hash, blocks, offsets: offs });
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
  const config = b.putJson("config/genesis.json", MAINNET_CONFIG);
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
    if (!entries.length) continue;
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
      packs: [dataRef],
      index: indexRef,
      filter,
      root: index.frames.map((fr, j) => [hexOf(indexFirsts[j]!.key), indexFirsts[j]!.block, fr.offset, fr.compressed, fr.uncompressed, hexOf(fr.sha256)]),
    };
  }
  const descriptor = b.putJson(`${dir}/layer.json`, { first, last, level: n, domains });
  return { first, last, level: n, descriptor };
}

/** An `accounts` value: uvarint(nonce) uvarint(len) balance code_hash?. */
export function encodeAccount(nonce: number, balance: bigint, codeHash?: Uint8Array): Uint8Array {
  const bal: number[] = [];
  for (let x = balance; x > 0n; x >>= 8n) bal.unshift(Number(x & 0xffn));
  return Uint8Array.from([...uvarint(nonce), ...uvarint(bal.length), ...bal, ...(codeHash ?? [])]);
}

// ---- log index (storage.md, "Log index"), built from the fixtures' receipts.

export function logIndex(b: Builder, fixtures: Fixture[], partitionBlocks = 65_536, bucketBits = 4) {
  const keyOf = (tag: number, value: string) => {
    const h = sha(Uint8Array.from([tag, ...parseData(value)!]));
    let k = 0;
    for (let i = 0; i < KEY_BYTES; i++) k = k * 256 + h[i]!;
    return k;
  };
  const first = Number(fixtures[0]!.block.number);
  const last = Number(fixtures.at(-1)!.block.number);
  // partition start -> key -> blocks
  const parts = new Map<number, Map<number, Set<number>>>();
  for (const f of fixtures) {
    const n = Number(f.block.number);
    const start = Math.max(first, Math.floor(n / partitionBlocks) * partitionBlocks);
    const keys = parts.get(start) ?? new Map<number, Set<number>>();
    parts.set(start, keys);
    for (const r of f.receipts)
      for (const l of r.logs) {
        const add = (k: number) => keys.set(k, (keys.get(k) ?? new Set()).add(n));
        add(keyOf(0, l.address));
        l.topics.forEach((t: string, i: number) => add(keyOf(1 + i, t)));
      }
  }
  const frames: Uint8Array[] = [];
  const directories: { start: number; records: { frame: number; entries: number }[] }[] = [];
  for (const [start, keys] of [...parts].sort((a, c) => a[0] - c[0])) {
    const buckets = new Map<number, [number, number[]][]>();
    for (const [k, set] of [...keys].sort((a, c) => a[0] - c[0])) {
      const bucket = Math.floor(k / 2 ** (KEY_BYTES * 8 - bucketBits));
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), [k, [...set].sort((a, c) => a - c)]]);
    }
    const records = Array.from({ length: 2 ** bucketBits }, () => ({ frame: -1, entries: 0 }));
    for (const [bucket, list] of buckets) {
      const bytes: number[] = [];
      let prev = 0;
      for (const [k, blocks] of list) {
        bytes.push(...uvarint(k - prev), ...uvarint(blocks.length));
        blocks.forEach((bl, i) => bytes.push(...uvarint(i === 0 ? bl - start : bl - blocks[i - 1]! - 1)));
        prev = k;
      }
      records[bucket] = { frame: frames.length, entries: list.length };
      frames.push(Uint8Array.from(bytes));
    }
    directories.push({ start, records });
  }
  const p = pack(frames, 4);
  const range = `${String(first).padStart(20, "0")}-${String(last).padStart(20, "0")}`;
  const packRef = b.put(`log-index/${range}/pack-${hexOf(sha(p.bytes))}.pack`, p.bytes);
  const partitions = directories.map((d) => {
    const dir = new Uint8Array(d.records.length * 56);
    const view = new DataView(dir.buffer);
    d.records.forEach((r, i) => {
      if (r.frame < 0) return;
      const fr = p.frames[r.frame]!;
      view.setBigUint64(i * 56, BigInt(fr.offset), true);
      view.setUint32(i * 56 + 8, fr.compressed, true);
      view.setUint32(i * 56 + 12, fr.uncompressed, true);
      view.setUint32(i * 56 + 16, r.entries, true);
      dir.set(fr.sha256, i * 56 + 24);
    });
    return { start: d.start, bucket_bits: bucketBits, directory: b.put(`log-index/${range}/directory-${d.start}-${hexOf(sha(dir))}.dir`, dir) };
  });
  return { key_bytes: KEY_BYTES, partition_blocks: partitionBlocks, objects: [{ first, last, partitions, packs: [packRef] }] };
}
