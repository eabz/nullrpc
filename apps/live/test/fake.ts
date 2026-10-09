// Test doubles: Durable Object storage over bun:sqlite, and an Env whose namespaces hand out the
// objects themselves instead of stubs.
import { Database } from "bun:sqlite";
import { ChainDO } from "../src/chain";
import { encodeSections, type Section } from "../src/codec";
import type { Env } from "../src/env";
import { StateShard } from "../src/shard";

export class FakeStorage {
  readonly db = new Database(":memory:");
  alarm: number | null = null;
  readonly sql = {
    exec: (query: string, ...args: unknown[]) => {
      const rows = this.db.prepare(query).all(...(args as never[])) as Record<string, unknown>[];
      for (const r of rows) for (const [k, v] of Object.entries(r)) if (v instanceof Uint8Array) r[k] = v.slice().buffer;
      return { toArray: () => rows };
    },
  };
  transactionSync<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(t: number): Promise<void> {
    this.alarm = t;
  }
}

/** A fresh object over the same storage: what a wake after eviction looks like. */
export function wake<T>(cls: new (ctx: never, env: never) => T, storage: FakeStorage, env: Env): T {
  return new cls({ storage } as never, env as never);
}

export function testEnv(shards = 4): { env: Env; chainStorage: FakeStorage; shardStorage: FakeStorage[] } {
  const chainStorage = new FakeStorage();
  const shardStorage = Array.from({ length: shards }, () => new FakeStorage());
  const env = { CHAIN_ID: "560048", SHARDS: String(shards) } as Env;
  const chainDO = wake(ChainDO, chainStorage, env);
  const shardDOs = shardStorage.map((s) => wake(StateShard, s, env));
  env.CHAIN = { idFromName: (n: string) => n, get: () => chainDO } as never;
  env.SHARD = { idFromName: (n: string) => n, get: (id: string) => shardDOs[Number(id.split("-")[1])] } as never;
  return { env, chainStorage, shardStorage };
}

// ---------------------------------------------------------------- encodings

function uvarint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => [...p]));

function rlpLength(len: number, short: number): number[] {
  if (len < 56) return [short + len];
  const be: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) be.unshift(n % 256);
  return [short + 55 + be.length, ...be];
}

export const rlpBytes = (b: Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? b : cat(rlpLength(b.length, 0x80), b));
export const rlpList = (items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(rlpLength(body.length, 0xc0), body);
};
const intBytes = (n: number) => {
  const be: number[] = [];
  for (; n > 0; n = Math.floor(n / 256)) be.unshift(n % 256);
  return new Uint8Array(be);
};

/** A block record [raw_block, senders, receipts, blob_gas_price] whose header has `timestamp`. */
export function record(number: number, timestamp: number): Uint8Array {
  const header = Array.from({ length: 16 }, (_, i) =>
    rlpBytes(i === 8 ? intBytes(number) : i === 11 ? intBytes(timestamp) : i === 6 ? new Uint8Array(256) : new Uint8Array(32).fill(i)));
  const raw = rlpList([rlpList(header), rlpList([]), rlpList([])]);
  return rlpList([rlpBytes(raw), rlpBytes(new Uint8Array()), rlpList([]), rlpBytes(new Uint8Array())]);
}

export const hashOf = (n: number, fork = 0): string => "0xab" + (fork * 1_000_000 + n).toString(16).padStart(62, "0");
export const txOf = (n: number, i: number): string => (n * 1000 + i).toString(16).padStart(64, "0");
const unhexB = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

/** A ChainDO row for blocks first..last on fork `fork`, two transactions per block. */
export function chainRow(first: number, last: number, fork = 0) {
  const sections: Section[] = [];
  for (let n = first; n <= last; n++) {
    const txs = [txOf(n + fork * 1_000_000, 0), txOf(n + fork * 1_000_000, 1)];
    const rec = record(n, 1_700_000_000 + n * 12);
    const payload = cat(uvarint(rec.length), rec, uvarint(3), [1, 2, 3], uvarint(txs.length), ...txs.map(unhexB));
    sections.push({ number: n, hash: hashOf(n, fork), payload });
  }
  return { first, last, data: encodeSections(first, sections) };
}

export interface Change {
  domain: number;
  key: string; // hex without 0x
  value?: string; // hex; omitted for a wipe
}

/** A StateShard row: per block, its changes. */
export function shardRow(first: number, blocks: Record<number, Change[]>, fork = 0) {
  const sections: Section[] = Object.entries(blocks).map(([n, changes]) => ({
    number: Number(n),
    hash: hashOf(Number(n), fork),
    payload: cat(...changes.map((c) => (c.value === undefined ? cat([c.domain], unhexB(c.key)) : cat([c.domain], unhexB(c.key), uvarint(c.value.length / 2), unhexB(c.value))))),
  }));
  const last = Math.max(...sections.map((s) => s.number));
  return { first, last, data: encodeSections(first, sections) };
}
