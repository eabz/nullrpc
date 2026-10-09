// The Worker's entrypoint over the package: one fixture case end to end (the package's own
// suite covers every case), and the method check.

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ExecResponse, StateKey, StateSource, StateValue, Witness } from "@nullrpc/executor";
import { Executor } from "../src/index";

const DIR = new URL("../../../packages/executor/test/fixtures/", import.meta.url);
const config = JSON.parse(readFileSync(new URL("hoodi-config.json", DIR), "utf8")) as Record<string, unknown>;
const fixture = JSON.parse(zstdDecompressSync(readFileSync(new URL("hoodi-3780608.json.zst", DIR))).toString()) as {
  number: number;
  record: string;
  witness: Witness;
  reads: Record<string, Record<string, StateValue>>;
  code: Record<string, string>;
  cases: { request: { method: string; params: unknown[]; txIndex?: number }; expected: ExecResponse[] }[];
};

const canonical = (k: StateKey) =>
  k.kind === "account" ? `account:${k.address.toLowerCase()}` : k.kind === "storage" ? `storage:${k.address.toLowerCase()}:${BigInt(k.slot).toString(16)}` : k.kind === "code" ? `code:${k.hash.toLowerCase()}` : `blockHash:${k.number}`;

const state: StateSource = {
  async read(keys, at) {
    return keys.map((k) => (k.kind === "code" ? { kind: "code", code: fixture.code[k.hash]! } : (fixture.reads[at]?.[canonical(k)] ?? null)));
  },
  async witness(n) {
    return n === fixture.number ? fixture.witness : null;
  },
  async block() {
    return null;
  },
};

describe("Executor entrypoint", () => {
  const executor = new Executor();
  it("answers a call like the reference node", async () => {
    const c = fixture.cases.find((c) => c.request.method === "eth_call")!;
    const got = await executor.execute({ ...c.request, chain: config, block: fixture.record }, state);
    expect(c.expected).toContainEqual(got);
  });
  it("refuses methods the executor does not serve", async () => {
    const got = await executor.execute({ method: "eth_getBalance", params: [], chain: config, block: fixture.record }, state);
    expect(got).toEqual({ error: { code: -32601, message: "the method eth_getBalance does not exist/is not available" } });
  });
});
