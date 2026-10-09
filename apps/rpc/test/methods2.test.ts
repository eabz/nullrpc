import { afterEach, describe, expect, test, vi } from "vitest";
import feeHistory from "./fixtures/fee-history.json";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { decodeWitness } from "../src/archive/witness";
import { Chain } from "../src/chain";
import { data } from "../src/eth/hex";
import type { ExecRequest, ExecutorApi, StateSource } from "../src/executor";
import { METHODS } from "../src/methods";
import { BlobSchedule, fakeExponential } from "../src/methods/fees";
import { buildArchive, MAINNET_CONFIG, PREFIX } from "./archive";
import { fixtures } from "./encode";

const FIXTURES = fixtures();
const OBJECTS = buildArchive(FIXTURES);
const open = () => Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), null, Date.now() + Math.random() * 1e12);

describe("fees", () => {
  test.each(Object.entries(feeHistory))("eth_feeHistory at %s equals the reference node", async (n, ref) => {
    const chain = await open();
    const got = await METHODS.eth_feeHistory!(chain, ["0x1", "0x" + Number(n).toString(16), ref.percentiles], { chainId: 1 });
    expect(got).toEqual(ref.result);
  });

  test("blob fee math: fake_exponential and the Prague schedule", () => {
    expect(fakeExponential(0n, 3_338_477n)).toBe(1n);
    expect(fakeExponential(10_000_000n, 3_338_477n)).toBe(19n);
    const s = BlobSchedule.from(MAINNET_CONFIG);
    expect(s.at(1746612311)?.max).toBe(9n);
    expect(s.at(1710338134)).toBeNull();
  });

  test("invalid fee history parameters", async () => {
    const chain = await open();
    await expect(METHODS.eth_feeHistory!(chain, ["0x1", "latest", [50, 10]], { chainId: 1 })).rejects.toMatchObject({ code: -32602 });
    await expect(METHODS.eth_feeHistory!(chain, ["0x1000", "latest", []], { chainId: 1 })).rejects.toMatchObject({ code: -32005 });
  });
});

describe("relay", () => {
  afterEach(() => vi.unstubAllGlobals());
  const RAW = data(Uint8Array.from([0x02, 0xc0]));

  test("checks the relay's chain, submits once, returns the hash", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body.method);
      return Response.json(body.method === "eth_chainId" ? { result: "0x1" } : { result: "0xabc" });
    });
    const chain = await open();
    const hash = await METHODS.eth_sendRawTransaction!(chain, [RAW], { chainId: 1, relayUrl: "https://relay.example" });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls).toEqual(["eth_chainId", "eth_sendRawTransaction"]);
  });

  test("refuses a relay on another chain and hides upstream error text", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ result: "0x5" }));
    const chain = await open();
    await expect(METHODS.eth_sendRawTransaction!(chain, [RAW], { chainId: 1, relayUrl: "https://other.example" })).rejects.toMatchObject({ code: -32603 });
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) =>
      Response.json(JSON.parse(String(init.body)).method === "eth_chainId" ? { result: "0x1" } : { error: { code: -32000, message: "nonce too low: secret-token-123" } }),
    );
    await expect(METHODS.eth_sendRawTransaction!(chain, [RAW], { chainId: 1, relayUrl: "https://relay2.example" })).rejects.toMatchObject({ code: -32000, message: "nonce too low" });
  });

  test("without a relay the method is unavailable", async () => {
    const chain = await open();
    await expect(METHODS.eth_sendRawTransaction!(chain, [RAW], { chainId: 1 })).rejects.toMatchObject({ code: -32601 });
  });
});

describe("executor hand-off", () => {
  function fakeExecutor() {
    const seen: ExecRequest[] = [];
    const api: ExecutorApi = {
      async execute(req: ExecRequest, state: StateSource) {
        seen.push(req);
        const [hash] = await state.read([{ kind: "blockHash", number: 20_000_000 }], 20_000_001);
        const block = await state.block(20_000_000);
        return { result: { hash, blockLength: block?.length ?? 0 } };
      },
    };
    return { api, seen };
  }

  test("eth_call runs at the resolved block with the request's pinned view", async () => {
    const { api, seen } = fakeExecutor();
    const chain = await open();
    const out = (await METHODS.eth_call!(chain, [{ to: "0x" + "11".repeat(20), data: "0x" }, "0x1312d01"], { chainId: 1, executor: api })) as { hash: string; blockLength: number };
    const b20 = FIXTURES.find((f) => Number(f.block.number) === 20_000_000)!;
    expect(out.hash).toEqual({ kind: "blockHash", hash: b20.block.hash });
    expect(out.blockLength).toBeGreaterThan(1000);
    expect(seen[0]!.method).toBe("eth_call");
    expect(seen[0]!.chain).toEqual(MAINNET_CONFIG);
    expect(seen[0]!.txIndex).toBeUndefined();
  });

  test("debug_traceTransaction passes the transaction's block and index", async () => {
    const { api, seen } = fakeExecutor();
    const chain = await open();
    const f = FIXTURES.at(-1)!;
    await METHODS.debug_traceTransaction!(chain, [f.block.transactions[9].hash, {}], { chainId: 1, executor: api });
    expect(seen[0]!.txIndex).toBe(9);
    await expect(METHODS.debug_traceTransaction!(chain, ["0x" + "ee".repeat(32), {}], { chainId: 1, executor: api })).rejects.toMatchObject({ code: -32000 });
    expect(await METHODS.trace_transaction!(chain, ["0x" + "ee".repeat(32)], { chainId: 1, executor: api })).toBeNull();
  });

  test("without an executor, execution methods are unavailable", async () => {
    const chain = await open();
    await expect(METHODS.eth_call!(chain, [{ to: "0x" + "11".repeat(20) }, "latest"], { chainId: 1 })).rejects.toMatchObject({ code: -32601 });
  });
});

describe("witness decoding", () => {
  test("accounts with and without code, and storage", () => {
    const addr = new Uint8Array(20).fill(0xaa);
    const bytes = Uint8Array.from([1, 2, ...addr, 3, 5, 1, 0x10, ...new Uint8Array(32).fill(0xcc), ...addr.map(() => 0xbb), 0, 0, 0, 1, ...addr, 1, ...new Uint8Array(32).fill(1), 1, 0x2a]);
    const w = decodeWitness(bytes);
    expect(w.accounts[0]).toEqual({ address: "0x" + "aa".repeat(20), exists: true, nonce: 5, balance: "0x10", codeHash: "0x" + "cc".repeat(32) });
    expect(w.accounts[1]).toEqual({ address: "0x" + "bb".repeat(20), exists: false, nonce: 0, balance: "0x0", codeHash: null });
    expect(w.storage[0]!.slots[0]).toEqual({ slot: "0x" + "01".repeat(32), value: "0x2a" });
  });
});
