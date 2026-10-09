// The round loop's caches (src/shell.ts) over a scripted session: account and storage values
// are kept per (chain, block hash, block, key) and never read twice at the same block; code
// by hash; nothing is shared across blocks.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it, vi } from "vitest";
import type { ExecRequest, StateKey, StateSource, StateValue } from "../src/contract";
import { blockHashOf, execute, readFailureCause, type SessionFactory, type WasmSession } from "../src/shell";

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

/** The coinbase every test record names (header field 2, 20 bytes). */
const COINBASE = "0x" + "c0".repeat(20);
/** A record whose header is 16 fields, the 9th the block number (below 256), the 3rd the coinbase; `salt` makes distinct hashes. */
function record(number: number, salt = 0): { record: string; hash: string } {
  const header = list(Array.from({ length: 16 }, (_, i) => bytes(i === 8 ? [number] : i === 6 ? new Uint8Array(256) : i === 2 ? new Uint8Array(20).fill(0xc0) : new Uint8Array(32).fill(i + salt))));
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

describe("readFailureCause", () => {
  it("names the cause a state read failed for", () => {
    expect(readFailureCause(new Error("Durable Object is overloaded. Requests queued for too long."))).toBe("overloaded");
    expect(readFailureCause(new Error("the pinned head was removed by a reorg"))).toBe("stale");
    expect(readFailureCause(new Error("missing object 1-ab/live/records/x.bin"))).toBe("missing");
    expect(readFailureCause(new Error("Network connection lost; timed out"))).toBe("timeout");
    expect(readFailureCause(new Error("down"))).toBe("error");
    expect(readFailureCause("not an error")).toBe("error");
  });
});

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
  it("a round the isolate's caches answered is followed by a turn of the event loop; one that read is not", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      // Besides the budget timer, zero-delay timers are the turns between rounds.
      const turns = () => timers.mock.calls.filter((c) => c[1] === 0).length;
      const r = record(60);
      const at = (block: string): ExecRequest => ({ ...request(), block });
      // Two rounds that read (B, then the storage slot): no turn, the awaited reads yield on their own.
      await execute(at(r.record), state(), rounds([{ missing: [KEYS[1]!], at: 60 }, { missing: [KEYS[2]!], at: 60 }]).session);
      expect(turns()).toBe(0);
      timers.mockClear();
      // The same keys again at the same block come from the cache: each such round is followed by a turn.
      await execute(at(r.record), state(), rounds([{ missing: [KEYS[1]!], at: 60 }, { missing: [KEYS[2]!], at: 60 }]).session);
      expect(turns()).toBe(2);
      timers.mockClear();
      // A block the shell cannot hash has no cache scope: every round reads, no turns, as before.
      await execute(request(), state(), rounds([{ missing: KEYS.slice(0, 1), at: 1 }, { missing: KEYS.slice(0, 1), at: 1 }]).session);
      expect(turns()).toBe(0);
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
  it("reads the number and the coinbase with the hash", async () => {
    const { blockOf } = await import("../src/shell");
    expect(blockOf(record(123).record)).toEqual({ hash: record(123).hash, number: 123, coinbase: COINBASE });
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
    // The profile (the dependent rounds' keys; block hashes are not kept, nor the first round's
    // own keys) was read with the round's own keys.
    expect(flat(second.asked).sort()).toEqual(["b:5", "s:0x1"].sort());
    expect(keysOf(s.inputs[1]!)).toEqual(["s:0x1", "b:5"]);
  });

  it("another function or contract has its own profile, and a call that asked only for block hashes teaches none", async () => {
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

describe("time budget", () => {
  it("a stalled state read answers the time-budget error when the budget ends, not when the read does", async () => {
    const stalled = new CountingState(TABLE);
    stalled.read = () => new Promise(() => {});
    const t0 = Date.now();
    const out = await execute({ method: "eth_call", params: [], chain: chain(906), block: record(50).record }, stalled, session({ missing: [{ kind: "blockHash", number: 5 }], at: 50 }).session, Date.now, 60);
    expect(out).toEqual({ error: { code: -32005, message: "execution exceeded its time budget (timeout)" } });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a stalled witness read too", async () => {
    const stalled = new CountingState(TABLE);
    stalled.witness = () => new Promise(() => {});
    const witnessWanted = () => ({ run: () => JSON.stringify({ witness: 60, hash: "0x" + "60".repeat(32) }), usage: () => "" });
    const out = await execute({ method: "debug_traceTransaction", params: [], chain: chain(906), block: record(61).record, txIndex: 0 }, stalled, witnessWanted, Date.now, 60);
    expect(out).toEqual({ error: { code: -32005, message: "execution exceeded its time budget (timeout)" } });
  });
});

// ---- what the module keeps by block hash: a request there sends neither the record nor hints

describe("module cache", () => {
  /** A scripted factory that remembers the blocks it decoded and the snapshots it was asked for. */
  function caching(script: Script) {
    const blocks = new Set<string>();
    const known = new Set<string>();
    const requests: Record<string, unknown>[] = [];
    const inputs: string[] = [];
    const factory = ((json: string) => {
      const request = JSON.parse(json) as { block?: string; blockHash?: string; seed?: string };
      requests.push(request);
      if (request.block) blocks.add(blockHashOf(request.block)!);
      let round = 0;
      return {
        run(input: string) {
          inputs.push(input);
          if (input) {
            const snapshot = (JSON.parse(input) as { snapshot?: string }).snapshot;
            if (snapshot) known.add(snapshot);
          }
          if (round++ === 0) return JSON.stringify({ missing: script.missing, at: script.at });
          return JSON.stringify({ done: true, response: { result: "ok" } });
        },
        usage: () => "{}",
      };
    }) as SessionFactory;
    factory.has = (kind, hash) => (kind === "block" ? blocks.has(hash) : known.has(hash));
    return { factory, requests, inputs };
  }

  it("the first call at a block sends the record and a snapshot mark; the next sends the hash and a seed, and reads no hints", async () => {
    const r = record(70);
    const { factory, requests, inputs } = caching({ missing: [{ kind: "blockHash", number: 5 }], at: 70 });
    const first = new HintingState(TABLE, HINTS);
    await execute({ method: "eth_call", params: [], chain: chain(907), block: r.record }, first, factory);
    expect(requests[0]).toMatchObject({ block: r.record, blockHash: r.hash });
    expect(requests[0]!.seed).toBeUndefined();
    expect(first.hinted).toBe(1);
    expect(JSON.parse(inputs[1]!)).toMatchObject({ snapshot: r.hash });

    const second = new HintingState(TABLE, HINTS);
    await execute({ method: "eth_call", params: [], chain: chain(907), block: r.record, blockHash: r.hash, blockNumber: 70 }, second, factory);
    expect(requests[1]!.block).toBeUndefined();
    expect(requests[1]).toMatchObject({ blockHash: r.hash, seed: r.hash });
    expect(second.hinted).toBe(0);
    const input = JSON.parse(inputs[3]!) as { keys: StateKey[]; snapshot?: string };
    expect(input.keys).toEqual([{ kind: "blockHash", number: 5 }]);
    expect(input.snapshot).toBeUndefined();
  });

  it("a trace at a known block sends the hash without a record, and never a seed", async () => {
    const r = record(71);
    const { factory, requests } = caching({ missing: [{ kind: "blockHash", number: 5 }], at: 70 });
    await execute({ method: "eth_call", params: [], chain: chain(907), block: r.record }, new CountingState(TABLE), factory);
    await execute({ method: "debug_traceTransaction", params: [], chain: chain(907), block: r.record, txIndex: 0 }, new CountingState(TABLE), factory);
    expect(requests[1]!.block).toBeUndefined();
    expect(requests[1]!.seed).toBeUndefined();
  });
});

// ---- hints and profiles after 2026-10-09: shared in flight, skipped by cheap profiled calls, late for large ones

describe("hints wave and profiles", () => {
  /** A source whose hints and reads each take `ticks` turns of the event loop. */
  class SlowState extends HintingState {
    constructor(table: Record<string, StateValue>, hints: { keys: StateKey[]; values: StateValue[] } | null, private readonly hintTicks: number, private readonly readTicks: number) {
      super(table, hints);
    }
    override async read(keys: StateKey[]): Promise<StateValue[]> {
      for (let i = 0; i < this.readTicks; i++) await new Promise((r) => setTimeout(r, 0));
      return super.read(keys);
    }
    override async hints(at: number) {
      for (let i = 0; i < this.hintTicks; i++) await new Promise((r) => setTimeout(r, 0));
      return super.hints(at);
    }
  }
  const keysOf = (input: string) => (JSON.parse(input) as { keys: StateKey[] }).keys.map((k) => (k.kind === "account" ? `a:${k.address}` : k.kind === "storage" ? `s:${k.slot}` : k.kind === "code" ? "code" : `b:${k.number}`));

  it("simultaneous requests at one block share one hint read", async () => {
    const r = record(80);
    const state = new SlowState(TABLE, HINTS, 1, 0);
    const a = session({ missing: [{ kind: "blockHash", number: 5 }], at: 80 });
    const b = session({ missing: [{ kind: "account", address: B }], at: 80 });
    const request = (): ExecRequest => ({ method: "eth_call", params: [], chain: chain(910), block: r.record });
    await Promise.all([execute(request(), state, a.session), execute(request(), state, b.session)]);
    expect(state.hinted).toBe(1);
    expect(keysOf(a.inputs[1]!).slice(0, 3)).toEqual([`a:${C}`, "s:0x2", `a:${A}`]);
    expect(keysOf(b.inputs[1]!).slice(0, 3)).toEqual([`a:${C}`, "s:0x2", `a:${A}`]);
  });

  it("a one-round call teaches an empty profile; the next call to it is cheap: no hints read, no snapshot", async () => {
    const call = (block: number): ExecRequest => ({ method: "eth_call", params: [{ to: C, data: "0xabcdef01" }, "latest"], chain: chain(911), block: record(block).record });
    // A factory that answers `has` (the module cache), so snapshot marks are sent.
    const marking = (s: ReturnType<typeof session>) => Object.assign(s.session, { has: () => false }) as SessionFactory;
    const first = new HintingState(TABLE, HINTS);
    const s1 = session({ missing: [{ kind: "account", address: B }], at: 90 });
    await execute(call(90), first, marking(s1));
    // The first call to this function had no profile: it waited for the hints and marked the snapshot.
    expect(first.hinted).toBe(1);
    expect(JSON.parse(s1.inputs[1]!)).toMatchObject({ snapshot: record(90).hash });
    const second = new HintingState(TABLE, HINTS);
    const s2 = session({ missing: [{ kind: "storage", address: A, slot: "0x1" }], at: 91 });
    await execute(call(91), second, marking(s2));
    // Cheap (the first call needed nothing beyond its first round): the hints were not read.
    expect(second.hinted).toBe(0);
    expect(flat(second.asked)).toEqual(["s:0x1"]);
    expect(keysOf(s2.inputs[1]!)).toEqual(["s:0x1"]);
    expect((JSON.parse(s2.inputs[1]!) as { snapshot?: string }).snapshot).toBeUndefined();
  });

  it("a profile carries neither the call's own accounts (sender, callee, calldata addresses) nor the block's coinbase", async () => {
    const F = "0x" + "f0".repeat(20);
    const table: Record<string, StateValue> = { ...TABLE, [`a:${F}`]: null, [`a:${COINBASE}`]: null, [`a:${C}`]: null };
    const call = (block: number): ExecRequest => ({ method: "eth_call", params: [{ from: F, to: B, data: "0x70a08231" + C.slice(2).padStart(64, "0") }, "latest"], chain: chain(913), block: record(block).record });
    const first = new CountingState(table);
    // Round one: the module's own keys; round two: the sender, the calldata's address, the coinbase and a slot.
    await execute(call(97), first, rounds([{ missing: [{ kind: "account", address: B }], at: 97 }, { missing: [{ kind: "account", address: F }, { kind: "account", address: C }, { kind: "account", address: COINBASE }, { kind: "storage", address: A, slot: "0x1" }], at: 97 }]).session);
    const second = new CountingState(table);
    const s = rounds([{ missing: [{ kind: "blockHash", number: 5 }], at: 98 }]);
    await execute(call(98), second, s.session);
    // Only the slot was worth keeping: the accounts come with every call's first round or change per block.
    expect(keysOf(s.inputs[1]!)).toEqual(["s:0x1", "b:5"]);
  });

  it("a call with a large profile does not wait for the hints: they join the round they arrive for, with the snapshot mark, without keys already answered", async () => {
    const slots = Array.from({ length: 40 }, (_, i) => ({ kind: "storage", address: B, slot: "0x" + (i + 0x100).toString(16) }) as StateKey);
    const table: Record<string, StateValue> = { ...TABLE };
    for (const k of slots) if (k.kind === "storage") table[`s:${B}:${BigInt(k.slot)}`] = { kind: "storage", value: "0x1" };
    const call = (block: number): ExecRequest => ({ method: "eth_call", params: [{ to: B, data: "0x0badf00d" }, "latest"], chain: chain(912), block: record(block).record });
    await execute(call(95), new SlowState(table, HINTS, 0, 0), rounds([{ missing: [{ kind: "account", address: A }], at: 95 }, { missing: slots, at: 95 }]).session);
    // Hints take two turns, a read one: they are not there for the first round, there for the second.
    const state = new SlowState(table, HINTS, 2, 1);
    const s = rounds([{ missing: [{ kind: "account", address: A }], at: 96 }, { missing: [{ kind: "blockHash", number: 5 }], at: 96 }]);
    await execute(call(96), state, Object.assign(s.session, { has: () => false }) as SessionFactory);
    expect(state.hinted).toBe(1);
    const first = JSON.parse(s.inputs[1]!) as { keys: StateKey[]; snapshot?: string };
    // Round one: the profile's 40 slots, the round's A with its code; no hints, no snapshot yet.
    expect(keysOf(s.inputs[1]!).filter((k) => k.startsWith("s:"))).toHaveLength(40);
    expect(keysOf(s.inputs[1]!)).toContain(`a:${A}`);
    expect(keysOf(s.inputs[1]!)).not.toContain(`a:${C}`);
    expect(first.snapshot).toBeUndefined();
    const second = JSON.parse(s.inputs[2]!) as { keys: StateKey[]; snapshot?: string };
    // Round two: the hints without A (answered exactly in round one), then the round's key; the snapshot mark.
    expect(keysOf(s.inputs[2]!)).toEqual([`a:${C}`, "s:0x2", "b:5"]);
    expect(second.snapshot).toBe(record(96).hash);
  });
});
