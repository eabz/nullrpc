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
import { buildArchive, encodeAccount, encodeWitness, PREFIX, witnessRange, type StateEntry } from "./archive";
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

/** The fixture's reads at its block as a witness of the next block (its pre-state is that state). */
function recordedAsWitness(): Witness {
  const reads = F.reads[String(F.number)] ?? {};
  const accounts: Witness["accounts"] = [];
  const storage = new Map<string, { slot: string; value: string }[]>();
  for (const [key, value] of Object.entries(reads)) {
    const [kind, address, slot] = key.split(":");
    if (kind === "account") accounts.push({ address: address!, exists: value !== null, nonce: value?.kind === "account" ? value.nonce : 0, balance: value?.kind === "account" ? value.balance : "0x0", codeHash: value?.kind === "account" ? value.codeHash : null });
    // A witness never lists a slot without its account; the executor read the account of every slot it read.
    else if (kind === "storage" && value?.kind === "storage" && reads[`account:${address}`] !== undefined) storage.set(address!, [...(storage.get(address!) ?? []), { slot: "0x" + slot!.padStart(64, "0"), value: value.value }]);
  }
  return { accounts, storage: [...storage].map(([address, slots]) => ({ address, slots })) };
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

  test("with the next block's witness as hints, every case answers the same in a read wave or two", async () => {
    const { ChainStateSource } = await import("../src/state-source");
    // An archive whose witness of block P+1 is the state the fixture recorded at P: exact hints
    // for a call at P, so the executor reads almost nothing itself.
    const objects = buildArchive(FIXTURES, {
      state: { entries: entries(), layers: [[0, TIP]] },
      extra: (b) => ({ witnesses: { first_block: 0, ranges: [witnessRange(b, F.number, [encodeWitness(F.witness), encodeWitness(recordedAsWitness())])] } }),
    });
    for (const c of F.cases.filter((c) => ["eth_call", "eth_estimateGas", "eth_createAccessList"].includes(c.request.method))) {
      // A fresh pin: the isolate's HEAD cache is keyed by the prefix, which this archive shares with the others.
      const archive = new Archive(new MemorySource(objects), PREFIX);
      const now = Date.now();
      await archive.pin(now, true);
      const chain = await Chain.open(archive, null, now);
      const hints = await new ChainStateSource(chain).hints(F.number);
      expect(hints!.keys.length).toBeGreaterThan(0);
      let got: ExecResponse;
      try {
        got = { result: await METHODS[c.request.method]!(chain, c.request.params, ENV) };
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        got = { error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } };
      }
      const expected = c.expected.map((e) => normalize(c, e));
      expect(got).toEqual(expected.find((e) => JSON.stringify(sortKeys(e)) === JSON.stringify(sortKeys(got))) ?? expected[0]);
      expect(chain.exec.hints).toBe(hints!.keys.length);
      // The executor's own hints round (sender, callee, calldata addresses), the code it then asks for, and at most one more wave.
      expect(chain.exec.rounds).toBeLessThanOrEqual(3);
    }
  });

  test("the executor is unavailable when the method environment has none", async () => {
    await expect(METHODS.eth_call!(await open(), [{ to: "0x" + "11".repeat(20) }, "0x3d090e"], { chainId: 1 })).rejects.toMatchObject({ code: -32601 });
  });
});
