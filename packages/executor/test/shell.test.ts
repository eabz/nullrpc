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

/** A record whose header is 16 fields, the 9th the block number (below 256); `salt` makes distinct hashes. */
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

// ---- hints: the source's keys for the block, read with the first round and cached per block

/** A source whose hints are a table; counts the hint reads. */
class HintingState extends CountingState {
  hinted = 0;
  constructor(table: Record<string, StateValue>, private readonly hintTable: { keys: StateKey[]; values: StateValue[] } | null, public hintAt: number[] = []) {
    super(table);
  }
  async hints(at: number) {
    this.hinted++;
    this.hintAt.push(at);
    return this.hintTable;
  }
}

const C = "0x" + "cd".repeat(20);
const HINT_CODE_HASH = "0x" + "ee".repeat(32);
const HINTS = {
  keys: [
    { kind: "account", address: C },
    { kind: "storage", address: C, slot: "0x2" },
    { kind: "account", address: A },
  ] as StateKey[],
  values: [{ kind: "account", nonce: 3, balance: "0x30", codeHash: HINT_CODE_HASH }, { kind: "storage", value: "0x9" }, { kind: "account", nonce: 1, balance: "0x10", codeHash: CODE_HASH }] as StateValue[],
};

describe("hints", () => {
  it("are read alongside the first round and handed over before it, with the code the cache has", async () => {
    const r = record(200);
    const request: ExecRequest = { method: "eth_call", params: [], chain: chain(902), block: r.record };
    const state = new HintingState(TABLE, HINTS);
    const s = session({ missing: [{ kind: "account", address: B }, { kind: "blockHash", number: 5 }], at: 200 });
    await execute(request, state, s.session);
    expect(state.hintAt).toEqual([200]);
    const input = JSON.parse(s.inputs[1]!) as { keys: StateKey[]; values: StateValue[] };
    // The hints first (the code of A is cached from the earlier tests, C's is not), then the round's own keys.
    expect(input.keys).toEqual([...HINTS.keys, { kind: "code", hash: CODE_HASH }, { kind: "account", address: B }, { kind: "blockHash", number: 5 }]);
    expect(input.values).toEqual([...HINTS.values, { kind: "code", code: "0x6001" }, null, { kind: "blockHash", hash: "0x" + "05".repeat(32) }]);
    // The source was asked only for the round's keys.
    expect(flat(state.asked)).toEqual([`a:${B}`, "b:5"]);
  });

  it("are shared per block: a second request at the same block reads none", async () => {
    const r = record(200);
    const request: ExecRequest = { method: "eth_estimateGas", params: [], chain: chain(902), block: r.record };
    const state = new HintingState(TABLE, HINTS);
    const s = session({ missing: [{ kind: "blockHash", number: 5 }], at: 200 });
    await execute(request, state, s.session);
    expect(state.hinted).toBe(0);
    const input = JSON.parse(s.inputs[1]!) as { keys: StateKey[] };
    expect(input.keys.slice(0, 3)).toEqual(HINTS.keys);
  });

  it("are not read for mined-transaction traces, nor for a round at another block", async () => {
    const traced = new HintingState(TABLE, HINTS);
    await execute({ method: "debug_traceTransaction", params: [], chain: chain(903), block: record(300).record, txIndex: 0 }, traced, session({ missing: [{ kind: "blockHash", number: 5 }], at: 299 }).session);
    expect(traced.hinted).toBe(0);
    const elsewhere = new HintingState(TABLE, HINTS);
    const s = session({ missing: [{ kind: "blockHash", number: 5 }], at: 150 });
    await execute({ method: "eth_call", params: [], chain: chain(903), block: record(301).record }, elsewhere, s.session);
    expect(elsewhere.hinted).toBe(1);
    expect((JSON.parse(s.inputs[1]!) as { keys: StateKey[] }).keys).toEqual([{ kind: "blockHash", number: 5 }]);
  });

  it("a failing or absent hint source leaves the round as it was", async () => {
    const failing = new HintingState(TABLE, null);
    failing.hints = async () => {
      throw new Error("no witnesses");
    };
    const s = session({ missing: [{ kind: "blockHash", number: 5 }], at: 302 });
    const out = await execute({ method: "eth_call", params: [], chain: chain(903), block: record(302).record }, failing, s.session);
    expect(out).toEqual({ result: { keys: [{ kind: "blockHash", number: 5 }], values: [{ kind: "blockHash", hash: "0x" + "05".repeat(32) }] } });
  });

  it("a source refusing a request (its read budget) is the answer", async () => {
    const refusing = new CountingState(TABLE);
    refusing.read = async () => {
      throw Object.assign(new Error("execution exceeded its read budget"), { rpcCode: -32005 });
    };
    const out = await execute({ method: "eth_call", params: [], chain: chain(904), block: record(303).record }, refusing, session({ missing: [{ kind: "blockHash", number: 7 }], at: 303 }).session);
    expect(out).toEqual({ error: { code: -32005, message: "execution exceeded its read budget" } });
  });
});

describe("blockOf", () => {
  it("reads the number with the hash", async () => {
    const { blockOf } = await import("../src/shell");
    expect(blockOf(record(123).record)).toEqual({ hash: record(123).hash, number: 123 });
  });
});

// ---- profiles: what calls to a contract and function read, prefetched for the next such call

/** A scripted session of several read rounds, then done with the last input. */
function rounds(scripts: Script[]): { session: (json: string) => WasmSession; inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    session: () => {
      let round = 0;
      return {
        run(input: string) {
          inputs.push(input);
          const script = scripts[round++];
          if (script) return JSON.stringify({ missing: script.missing, at: script.at });
          return JSON.stringify({ done: true, response: { result: "ok" } });
        },
        usage: () => "{}",
      };
    },
  };
}

describe("profiles", () => {
  const call = (block: number) => ({ method: "eth_call", params: [{ to: A, data: "0x12345678abcd" }, "latest"], chain: chain(905), block: record(block).record }) as ExecRequest;
  const keysOf = (input: string) => (JSON.parse(input) as { keys: StateKey[] }).keys.map((k) => (k.kind === "account" ? `a:${k.address}` : k.kind === "storage" ? `s:${k.slot}` : k.kind === "code" ? "code" : `b:${k.number}`));

  it("a call of three read rounds teaches its profile; the next call to the same function reads it in the first round", async () => {
    const first = new CountingState(TABLE);
    await execute(call(40), first, rounds([{ missing: [{ kind: "account", address: B }], at: 40 }, { missing: [{ kind: "storage", address: A, slot: "0x1" }], at: 40 }, { missing: [{ kind: "blockHash", number: 5 }], at: 40 }]).session);
    expect(first.asked).toHaveLength(3);

    const second = new CountingState(TABLE);
    const s = rounds([{ missing: [{ kind: "blockHash", number: 5 }], at: 41 }]);
    await execute(call(41), second, s.session);
    // The profile (block hashes are not kept) was read with the round's own keys.
    expect(flat(second.asked).sort()).toEqual([`a:${B}`, "b:5", "s:0x1"].sort());
    expect(keysOf(s.inputs[1]!)).toEqual([`a:${B}`, "s:0x1", "b:5"]);
  });

  it("another function or contract has its own profile, and a short call teaches none", async () => {
    const other = new CountingState(TABLE);
    const s = rounds([{ missing: [{ kind: "blockHash", number: 5 }], at: 42 }]);
    await execute({ ...call(42), params: [{ to: B, data: "0x12345678" }, "latest"] }, other, s.session);
    expect(keysOf(s.inputs[1]!)).toEqual(["b:5"]);
    const again = new CountingState(TABLE);
    const t = rounds([{ missing: [{ kind: "blockHash", number: 5 }], at: 43 }]);
    await execute({ ...call(43), params: [{ to: B, data: "0x12345678" }, "latest"] }, again, t.session);
    expect(keysOf(t.inputs[1]!)).toEqual(["b:5"]);
  });
});
