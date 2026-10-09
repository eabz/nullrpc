// Execution hints (src/state-source.ts `hints`): the state at the end of a block for the keys
// nearby witnesses hold. The witness of n+1 is exact; those of n and n-1 are checked against
// the live window in one read; at or below P only the exact kind is used.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import type { Witness } from "../src/executor";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live } from "../src/live";
import { ChainStateSource } from "../src/state-source";
import { buildArchive, encodeAccount, encodeWitness, PREFIX, witnessRange } from "./archive";
import { fixtures } from "./encode";

const P = 20_000_001;
const ARCHIVED = fixtures().filter((f) => Number(f.block.number) <= P);
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const CODE = Uint8Array.from([0x60, 0x80, 0x60, 0x40, 0x52, 0x00]);
const CODE_HASH = "0x" + Buffer.from(keccak_256(CODE)).toString("hex");
const SLOT1 = "0x" + "1".padStart(64, "0");
const SLOT2 = "0x" + "2".padStart(64, "0");
const hashOf = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** Witnesses: the pre-state of each block. */
const W: Record<number, Witness> = {
  // Block P's witness (in the archive): the state at the end of P-1.
  [P]: { accounts: [{ address: A, exists: true, nonce: 7, balance: "0x70", codeHash: CODE_HASH }], storage: [{ address: A, slots: [{ slot: SLOT2, value: "0x5" }] }] },
  // Blocks above P (in the live window).
  [P + 1]: { accounts: [{ address: B, exists: true, nonce: 1, balance: "0x100", codeHash: null }], storage: [] },
  [P + 2]: { accounts: [{ address: B, exists: true, nonce: 1, balance: "0x100", codeHash: null }, { address: C, exists: false, nonce: 0, balance: "0x0", codeHash: null }], storage: [] },
  [P + 3]: { accounts: [{ address: A, exists: true, nonce: 7, balance: "0x70", codeHash: CODE_HASH }], storage: [{ address: A, slots: [{ slot: SLOT1, value: "0x11" }] }] },
};
/** The live window's rows: what the blocks above P wrote. */
const ROWS: Record<string, { block: number; value: Uint8Array }> = {
  [`2:${A.slice(2)}${SLOT1.slice(2)}`]: { block: P + 3, value: Uint8Array.from([0x22]) },
  [`1:${B.slice(2)}`]: { block: P + 2, value: encodeAccount(5, 0x200n) },
};

function fakeLive(head: number) {
  const calls: string[] = [];
  const pin: BlockId = { number: head, hash: hashOf(head) };
  const state: LiveState = { head: pin, safe: pin, finalized: pin, promoted: { number: P, hash: hashOf(P) }, generation: 1, shards: 1 };
  const api: LiveApi = {
    async state() {
      return state;
    },
    async block() {
      return null;
    },
    async witness(n) {
      calls.push(`witness:${n}`);
      return n > P && n <= head && W[n] ? { stale: false, witness: Buffer.from(encodeWitness(W[n]!)).toString("hex") } : null;
    },
    async txBlock() {
      return null;
    },
    async getPinned() {
      return { stale: false, block: null, value: null };
    },
    async getPinnedMany(keys, n) {
      calls.push(`many:${keys.length}@${n}`);
      return {
        stale: false,
        values: keys.map((k) => {
          const row = ROWS[`${k.domain}:${k.key.replace(/^0x/, "").toLowerCase()}`];
          return row && row.block <= n ? { block: row.block, value: Buffer.from(row.value).toString("hex") } : { block: null, value: null };
        }),
      };
    },
    async scanPinned() {
      return { stale: false, slots: {} };
    },
  };
  return { api, calls };
}

// The archive holds A's code, so hints that name A carry it.
const OBJECTS = buildArchive(ARCHIVED, {
  state: { entries: [{ domain: "code", key: Uint8Array.from(Buffer.from(CODE_HASH.slice(2), "hex")), block: 0, value: CODE }], layers: [[0, P]] },
  extra: (b) => ({ witnesses: { first_block: 0, ranges: [witnessRange(b, P, [encodeWitness(W[P]!)])] } }),
});

async function open(head: number) {
  const { api, calls } = fakeLive(head);
  const source = new MemorySource(OBJECTS);
  const chain = await Chain.open(new Archive(source, PREFIX), new Live(api), Date.now() + Math.random() * 1e12);
  return { chain, calls, source, state: new ChainStateSource(chain) };
}

const byKey = (h: { keys: unknown[]; values: unknown[] }) => Object.fromEntries(h.keys.map((k, i) => [JSON.stringify(k), h.values[i]]));

describe("execution hints", () => {
  test("at the head: the witnesses of the head and the block before, checked against the window", async () => {
    const { chain, calls, source, state } = await open(P + 3);
    const h = (await state.hints(P + 3))!;
    expect(calls).toEqual(expect.arrayContaining([`witness:${P + 3}`, `witness:${P + 2}`, `many:4@${P + 3}`]));
    expect(h.keys).toHaveLength(5); // four state keys and A's code
    const got = byKey(h);
    // A was not written in the window: its witness value stands; its slot was, so the window's value does.
    expect(got[JSON.stringify({ kind: "account", address: A })]).toEqual({ kind: "account", nonce: 7, balance: "0x70", codeHash: CODE_HASH });
    expect(got[JSON.stringify({ kind: "storage", address: A, slot: SLOT1 })]).toEqual({ kind: "storage", value: "0x22" });
    // B was written at P+2: the window's row.
    expect(got[JSON.stringify({ kind: "account", address: B })]).toEqual({ kind: "account", nonce: 5, balance: "0x200", codeHash: null });
    // C did not exist.
    expect(got[JSON.stringify({ kind: "account", address: C })]).toBeNull();
    expect(chain.exec.hints).toBe(5);
    // No account or slot was read from the state history; only A's code was (by hash, at P).
    expect(source.reads.filter((r) => /accounts|storage/.test(r.key))).toHaveLength(0);
    expect(source.reads.filter((r) => /code/.test(r.key)).length).toBeGreaterThan(0);
  });

  test("below the head: the next block's witness is exact and wins over the checked ones", async () => {
    const { calls, state } = await open(P + 3);
    const got = byKey((await state.hints(P + 2))!);
    expect(calls).toEqual(expect.arrayContaining([`witness:${P + 3}`, `witness:${P + 2}`, `witness:${P + 1}`, `many:2@${P + 2}`]));
    // The slot was written at P+3, after P+2: the window says nothing at P+2, the witness of P+3 gives the value at the end of P+2.
    expect(got[JSON.stringify({ kind: "storage", address: A, slot: SLOT1 })]).toEqual({ kind: "storage", value: "0x11" });
    expect(got[JSON.stringify({ kind: "account", address: B })]).toEqual({ kind: "account", nonce: 5, balance: "0x200", codeHash: null });
  });

  test("at P: only the exact witness (P+1, from the window), no window check", async () => {
    const { calls, state } = await open(P + 3);
    const h = (await state.hints(P))!;
    expect(h.keys).toEqual([{ kind: "account", address: B }]);
    expect(h.values).toEqual([{ kind: "account", nonce: 1, balance: "0x100", codeHash: null }]);
    expect(calls.filter((c) => c.startsWith("many"))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("witness"))).toEqual([`witness:${P + 1}`]);
  });

  test("below P: the exact witness comes from the archive", async () => {
    const { calls, state } = await open(P + 3);
    const got = byKey((await state.hints(P - 1))!);
    expect(got[JSON.stringify({ kind: "storage", address: A, slot: SLOT2 })]).toEqual({ kind: "storage", value: "0x5" });
    expect(got[JSON.stringify({ kind: "account", address: A })]).toEqual({ kind: "account", nonce: 7, balance: "0x70", codeHash: CODE_HASH });
    // The code of the contracts the hints name comes with them.
    expect(got[JSON.stringify({ kind: "code", hash: CODE_HASH })]).toEqual({ kind: "code", code: "0x" + Buffer.from(CODE).toString("hex") });
    expect(calls).toEqual([]);
  });

  test("nothing known: null", async () => {
    const { state } = await open(P + 3);
    expect(await state.hints(P - 10)).toBeNull();
    expect(await state.hints(P + 4)).toBeNull();
    expect(await state.hints(-1)).toBeNull();
  });
});
