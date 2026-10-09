// Execution in-process: the executor package (revm in WebAssembly) behind the RPC methods, with
// the state read through the real chain path (Chain, ChainStateSource, the archive's state
// layers and witnesses). The archive holds mainnet block 4000014 (test/fixtures/mainnet) and the
// state the executor's fixture of that block recorded (packages/executor/test/fixtures); every
// case's answer must equal the reference node's, as in the package's own end-to-end suite.

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { executor } from "@nullrpc/executor";
import { blockHashOf } from "@nullrpc/executor/shell";
import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { data, parseData } from "../src/eth/hex";
import type { ExecResponse, StateValue, Witness } from "../src/executor";
import { METHODS } from "../src/methods";
import { RpcError, type MethodEnv } from "../src/rpc";
import { buildArchive, encodeAccount, PREFIX, uvarint, witnessRange, type StateEntry } from "./archive";
import { fixtures } from "./encode";

interface Case {
  request: { method: string; params: unknown[]; txIndex?: number };
  expected: ExecResponse[];
  reference?: string;
}
interface Fixture {
  chain: string;
  number: number;
  record: string;
  witness: Witness;
  reads: Record<string, Record<string, StateValue>>;
  code: Record<string, string>;
  cases: Case[];
}

const EXEC = new URL("../../../packages/executor/test/fixtures/mainnet-4000014.json.zst", import.meta.url);
const F = JSON.parse(zstdDecompressSync(readFileSync(EXEC)).toString()) as Fixture;
const FIXTURES = fixtures();
const TIP = Number(FIXTURES.at(-1)!.block.number);

const bigBytes = (hex: string) => {
  const b = parseData("0x" + (hex.slice(2).length % 2 ? "0" : "") + hex.slice(2))!;
  let i = 0;
  while (i < b.length && b[i] === 0) i++;
  return b.subarray(i);
};

/** The executor's JSON witness as the archive stores it (storage.md, "Witnesses"). */
function encodeWitness(w: Witness): Uint8Array {
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

/** The fixture's recorded reads as state history entries: each value at the block it was read at. */
function entries(): StateEntry[] {
  const out: StateEntry[] = [];
  for (const [at, reads] of Object.entries(F.reads)) {
    for (const [key, value] of Object.entries(reads)) {
      const [kind, address, slot] = key.split(":");
      if (kind === "account") {
        const a = value?.kind === "account" ? value : null;
        out.push({ domain: "accounts", key: parseData(address!, 20)!, block: Number(at), value: a ? encodeAccount(a.nonce, BigInt(a.balance), a.codeHash ? parseData(a.codeHash, 32)! : undefined) : new Uint8Array() });
      } else if (kind === "storage") {
        out.push({ domain: "storage", key: Uint8Array.from([...parseData(address!, 20)!, ...parseData("0x" + slot!.padStart(64, "0"), 32)!]), block: Number(at), value: value?.kind === "storage" ? bigBytes(value.value) : new Uint8Array() });
      }
    }
  }
  for (const [hash, code] of Object.entries(F.code)) out.push({ domain: "code", key: parseData(hash, 32)!, block: 0, value: parseData(code)! });
  return out;
}

const OBJECTS = buildArchive(FIXTURES, {
  state: { entries: entries(), layers: [[0, TIP]] },
  extra: (b) => ({ witnesses: { first_block: 0, ranges: [witnessRange(b, F.number, [encodeWitness(F.witness)])] } }),
});
const open = () => Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), null, Date.now() + Math.random() * 1e12);
const ENV: MethodEnv = { chainId: 1, executor };

/** Nethermind (the struct logger reference) lists empty memory; the executor omits it. */
function normalize(c: Case, answer: ExecResponse): unknown {
  if (c.reference !== "nethermind" || !("result" in answer)) return answer;
  const result = structuredClone(answer.result) as { structLogs?: { memory?: unknown[] }[] };
  for (const log of result.structLogs ?? []) if (Array.isArray(log.memory) && log.memory.length === 0) delete log.memory;
  return { result };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

async function answer(c: Case): Promise<ExecResponse> {
  try {
    return { result: await METHODS[c.request.method]!(await open(), c.request.params, ENV) };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return { error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } };
  }
}

describe("execution in-process (mainnet 4000014 through the chain path)", () => {
  test("the archive's record of the block is the executor fixture's block", async () => {
    // The two test-only encoders agree on the block (hash) and senders; the fixture's receipts
    // carry pre-Byzantium roots the RPC fixtures lack, which execution never reads.
    const rec = await (await open()).block(F.number);
    expect(blockHashOf(data(rec!.frame))).toBe(blockHashOf(F.record));
  });

  for (const [i, c] of F.cases.entries()) {
    const label = `${i} ${c.request.method} ${c.request.txIndex ?? ""} ${JSON.stringify(c.request.params.slice(1)).slice(0, 60)}`;
    test(label, async () => {
      const got = await answer(c);
      const expected = c.expected.map((e) => normalize(c, e));
      const match = expected.find((e) => JSON.stringify(sortKeys(e)) === JSON.stringify(sortKeys(got)));
      expect(got).toEqual(match ?? expected[0]);
    });
  }

  test("the executor is unavailable when the method environment has none", async () => {
    await expect(METHODS.eth_call!(await open(), [{ to: "0x" + "11".repeat(20) }, "0x3d090e"], { chainId: 1 })).rejects.toMatchObject({ code: -32601 });
  });
});
