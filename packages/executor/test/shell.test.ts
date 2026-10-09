// The round loop's caches (src/shell.ts) over a scripted session: account and storage values
// are kept per (chain, block hash, block, key) and never read twice at the same block; code
// by hash; nothing is shared across blocks.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it, vi } from "vitest";
import type { ExecRequest, StateKey, StateSource, StateValue } from "../src/contract";
import { blockHashOf, execute, type WasmSession } from "../src/shell";

// ---- a minimal RLP writer for block records: [raw_block, senders, receipts, blob_gas_price]

const bytes = (b: number[] | Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(prefix(b.length, 0x80), b));
const list = (items: Uint8Array[]): Uint8Array => {
  const body = cat(...items);
  return cat(prefix(body.length, 0xc0), body);
};
function prefix(len: number, short: number): number[] {
  if (len < 56) return [short + len];
  const be: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) be.unshift(n % 256);
  return [short + 55 + be.length, ...be];
}
const cat = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A record whose header is 16 fields, the 9th the block number; `salt` makes distinct hashes. */
function record(number: number, salt = 0): { record: string; hash: string } {
  const header = list(Array.from({ length: 16 }, (_, i) => bytes(i === 8 ? [number] : i === 6 ? new Uint8Array(256) : new Uint8Array(32).fill(i + salt))));
  const raw = list([header, list([]), list([])]);
  const rec = list([bytes(raw), bytes([]), list([]), bytes([])]);
  return { record: hex(rec), hash: hex(keccak_256(header)) };
}

// ---- a scripted session: one read round, then done with whatever it was given

interface Script {
  missing: StateKey[];
  at: number;
}

function session(script: Script): { session: (json: string) => WasmSession; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    session: () => {
      let round = 0;
      return {
        run(input: string) {
          inputs.push(input);
          if (round++ === 0) return JSON.stringify({ missing: script.missing, at: script.at });
          return JSON.stringify({ done: true, response: { result: JSON.parse(input) } });
        },
        usage: () => "{}",
      };
    },
  };
}

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const CODE_HASH = "0x" + "cc".repeat(32);

/** Answers from a table and counts what it was asked. */
class CountingState implements StateSource {
  asked: StateKey[][] = [];
  constructor(private readonly table: Record<string, StateValue>) {}
  async read(keys: StateKey[]): Promise<StateValue[]> {
    this.asked.push(keys);
    return keys.map((k) => {
      const id = k.kind === "account" ? `a:${k.address}` : k.kind === "storage" ? `s:${k.address}:${BigInt(k.slot)}` : k.kind === "code" ? `c:${k.hash}` : `b:${k.number}`;
      if (!(id in this.table)) throw new Error(`unexpected read ${id}`);
      return this.table[id]!;
    });
  }
  async witness() {
    return null;
  }
  async block() {
    return null;
  }
}

const TABLE: Record<string, StateValue> = {
  [`a:${A}`]: { kind: "account", nonce: 1, balance: "0x10", codeHash: CODE_HASH },
  [`a:${B}`]: null,
  [`s:${A}:1`]: { kind: "storage", value: "0x7" },
  [`c:${CODE_HASH}`]: { kind: "code", code: "0x6001" },
  "b:5": { kind: "blockHash", hash: "0x" + "05".repeat(32) },
};
const KEYS: StateKey[] = [
  { kind: "account", address: A },
  { kind: "account", address: B },
  { kind: "storage", address: A, slot: "0x1" },
  { kind: "blockHash", number: 5 },
];
const chain = (chainId: number) => ({ chainId });
const flat = (asked: StateKey[][]) => asked.flat().map((k) => (k.kind === "account" ? `a:${k.address}` : k.kind === "storage" ? `s:${k.slot}` : k.kind === "code" ? "code" : `b:${k.number}`));

describe("blockHashOf", () => {
  it("hashes the header of a record and rejects what is not one", () => {
    const r = record(100);
    expect(blockHashOf(r.record)).toBe(r.hash);
    expect(blockHashOf("0x00")).toBeNull();
    expect(blockHashOf("0xc0")).toBeNull();
    expect(blockHashOf("0xf8")).toBeNull();
    expect(record(100, 1).hash).not.toBe(r.hash);
  });
});

describe("state cache", () => {
  it("answers repeated reads at the same block from the cache, with the code of cached accounts", async () => {
    const r = record(100);
    const request: ExecRequest = { method: "eth_call", params: [], chain: chain(901), block: r.record };
    const first = new CountingState(TABLE);
    const s1 = session({ missing: KEYS, at: 100 });
    const out1 = await execute(request, first, s1.session);
    expect(flat(first.asked)).toEqual([`a:${A}`, `a:${B}`, "s:0x1", "b:5", "code"]);

    const second = new CountingState(TABLE);
    const s2 = session({ missing: KEYS, at: 100 });
    const out2 = await execute(request, second, s2.session);
    // Only the block hash is read again; the account, the absent account, the slot and the code come from the caches.
    expect(flat(second.asked)).toEqual(["b:5"]);
    expect(out2).toEqual(out1);
    const answered = JSON.parse(s2.inputs[1]!) as { keys: StateKey[]; values: StateValue[] };
    expect(answered.values).toEqual([
      { kind: "account", nonce: 1, balance: "0x10", codeHash: CODE_HASH },
      null,
      { kind: "storage", value: "0x7" },
      { kind: "blockHash", hash: "0x" + "05".repeat(32) },
      { kind: "code", code: "0x6001" },
    ]);
  });

  it("keys match in any spelling of the address and slot", async () => {
    const r = record(101);
    const request: ExecRequest = { method: "eth_call", params: [], chain: chain(901), block: r.record };
    await execute(request, new CountingState(TABLE), session({ missing: [{ kind: "storage", address: A, slot: "0x1" }], at: 101 }).session);
    const again = new CountingState(TABLE);
    await execute(request, again, session({ missing: [{ kind: "storage", address: A.toUpperCase().replace("0X", "0x"), slot: "0x" + "1".padStart(64, "0") }], at: 101 }).session);
    expect(again.asked).toEqual([]);
  });

  it("shares nothing across blocks, chains or read heights", async () => {
    const r = record(102);
    const req = (c: number, block: string): ExecRequest => ({ method: "eth_call", params: [], chain: chain(c), block });
    await execute(req(901, r.record), new CountingState(TABLE), session({ missing: KEYS, at: 102 }).session);
    for (const [what, request, at] of [
      ["another block", req(901, record(102, 1).record), 102],
      ["another chain", req(902, r.record), 102],
      ["another height", req(901, r.record), 101],
    ] as const) {
      const state = new CountingState(TABLE);
      await execute(request, state, session({ missing: KEYS, at }).session);
      expect(flat(state.asked), what).toEqual([`a:${A}`, `a:${B}`, "s:0x1", "b:5"]);
    }
    // Back at the first block, everything is still there.
    const state = new CountingState(TABLE);
    await execute(req(901, r.record), state, session({ missing: KEYS, at: 102 }).session);
    expect(flat(state.asked)).toEqual(["b:5"]);
  });

  it("runs uncached on a record it cannot hash", async () => {
    const request: ExecRequest = { method: "eth_call", params: [], chain: chain(901), block: "0x00" };
    for (let i = 0; i < 2; i++) {
      const state = new CountingState(TABLE);
      await execute(request, state, session({ missing: KEYS.slice(0, 3), at: 1 }).session);
      expect(flat(state.asked)).toEqual([`a:${A}`, `a:${B}`, "s:0x1"]);
    }
  });
});

describe("rounds and the event loop", () => {
  const request = (): ExecRequest => ({ method: "eth_call", params: [], chain: chain(903), block: "0x00" });
  const state = () => new CountingState(TABLE);
  it("a round that ran 10 ms or more is followed by a turn of the event loop", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      let t = 0;
      await execute(request(), state(), session({ missing: KEYS.slice(0, 1), at: 1 }).session, () => (t += 20));
      expect(timers).toHaveBeenCalledTimes(1);
      timers.mockClear();
      await execute(request(), state(), session({ missing: KEYS.slice(0, 1), at: 1 }).session, () => t);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  });
});
