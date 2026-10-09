// End to end: the WebAssembly executor (crate/pkg, built by scripts/build.sh) behind the round
// loop (src/shell.ts), with a StateSource answering from Hoodi fixtures (test/fixtures, made by
// fetch.mjs). Every case's answer must equal the reference node's (one of its answers: drpc
// balances over backends of different versions, see fetch.mjs).

import { readFileSync, readdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecRequest, ExecResponse, StateKey, StateSource, StateValue, Witness } from "../src/contract";
import { execute, type WasmSession } from "../src/shell";
// @ts-ignore -- generated JavaScript
import { initSync, Session } from "../crate/pkg/executor.js";
// @ts-ignore -- plain JavaScript test helper
import { canonicalKey } from "./fixtures/encode.mjs";

const DIR = new URL("./fixtures/", import.meta.url);
const configs: Record<string, Record<string, unknown>> = {
  hoodi: JSON.parse(readFileSync(new URL("hoodi-config.json", DIR), "utf8")),
  mainnet: JSON.parse(readFileSync(new URL("mainnet-config.json", DIR), "utf8")),
};

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

const fixtures: [string, Fixture][] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json.zst"))
  .map((f) => [f, JSON.parse(zstdDecompressSync(readFileSync(new URL(f, DIR))).toString()) as Fixture]);

/** Answers only what the fixture recorded: an unrecorded read fails the test. */
class FixtureState implements StateSource {
  reads = 0;
  witnesses = 0;
  constructor(private readonly f: Fixture) {}
  async read(keys: StateKey[], at: number): Promise<StateValue[]> {
    if (keys.length > 256) throw new Error("more than 256 keys in one read");
    this.reads += keys.length;
    return keys.map((k) => {
      if (k.kind === "code") {
        const code = this.f.code[k.hash];
        if (!code) throw new Error(`unrecorded code ${k.hash}`);
        return { kind: "code", code };
      }
      const value = this.f.reads[at]?.[canonicalKey(k)];
      if (value === undefined) throw new Error(`unrecorded read at ${at}: ${canonicalKey(k)}`);
      return value;
    });
  }
  async witness(n: number): Promise<Witness | null> {
    this.witnesses++;
    return n === this.f.number ? this.f.witness : null;
  }
  async block(): Promise<string | null> {
    return null;
  }
}

/** Nethermind (the struct logger reference) lists empty memory; the executor omits it. */
function normalize(c: Case, answer: ExecResponse): unknown {
  if (c.reference !== "nethermind" || !("result" in answer)) return answer;
  const result = structuredClone(answer.result) as { structLogs?: { memory?: unknown[] }[] };
  for (const log of result.structLogs ?? []) if (Array.isArray(log.memory) && log.memory.length === 0) delete log.memory;
  return { result };
}

const session = (json: string) => new Session(json) as WasmSession;

beforeAll(() => {
  initSync({ module: new WebAssembly.Module(readFileSync(new URL("../crate/pkg/executor_bg.wasm", import.meta.url))) });
});

for (const [file, f] of fixtures) {
  describe(file, () => {
    f.cases.forEach((c, i) => {
      const label = `${i} ${c.request.method} ${c.request.txIndex ?? ""} ${JSON.stringify(c.request.params.slice(1)).slice(0, 60)}`;
      it(label, async () => {
        const request: ExecRequest = { ...c.request, chain: configs[f.chain]!, block: f.record };
        const got = await execute(request, new FixtureState(f), session);
        const expected = c.expected.map((e) => normalize(c, e));
        const match = expected.find((e) => JSON.stringify(sortKeys(e)) === JSON.stringify(sortKeys(got)));
        expect(got).toEqual(match ?? expected[0]);
      });
    });
  });
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

describe("protocol", () => {
  const f = fixtures.find(([, f]) => f.chain === "hoodi")![1];
  const chain = configs.hoodi!;
  it("mined traces read the witness once and little else", async () => {
    const state = new FixtureState(f);
    const c = f.cases.find((c) => c.request.method === "debug_traceTransaction")!;
    await execute({ ...c.request, chain, block: f.record }, state, session);
    expect(state.witnesses).toBeLessThanOrEqual(1);
  });
  it("unknown methods and broken records are errors", async () => {
    const state = new FixtureState(f);
    const bad = await execute({ method: "debug_traceTransaction", params: ["0x"], txIndex: 0, chain, block: "0x00" }, state, session);
    expect("error" in bad && bad.error.code).toBe(-32000);
    const missing = await execute({ method: "debug_traceTransaction", params: ["0x"], chain, block: f.record }, state, session);
    expect("error" in missing && missing.error.code).toBe(-32602);
  });
  it("a state source failure is an execution error", async () => {
    const failing: StateSource = { read: async () => { throw new Error("down"); }, witness: async () => null, block: async () => null };
    const c = f.cases.find((c) => c.request.method === "eth_call")!;
    // On a chain id the cache has not seen, so the call reads state (the cases above filled
    // the cache for this block on the fixture's chain).
    const got = await execute({ ...c.request, chain: { ...chain, chainId: 0xdead }, block: f.record }, failing, session);
    expect(got).toEqual({ error: { code: -32000, message: "execution unavailable: state could not be read" } });
  });
});
