import { beforeEach, describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { METHODS } from "../src/methods";
import worker from "../src/index";
import { buildArchive, PREFIX } from "./archive";
import { fixtures } from "./encode";

const FIXTURES = fixtures();
const OBJECTS = buildArchive(FIXTURES);
const hex = (n: number) => "0x" + n.toString(16);

let source: MemorySource;
let chain: Chain;
beforeEach(async () => {
  source = new MemorySource(OBJECTS);
  // A fresh prefix per test keeps the isolate HEAD cache from hiding reads.
  const archive = new Archive(source, PREFIX);
  chain = await Chain.open(archive, null, Date.now() + Math.random() * 1e9);
});

const call = (method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });

describe("blocks", () => {
  test.each(FIXTURES.map((f) => [Number(f.block.number), f] as const))("block %i by number and by hash", async (n, f) => {
    expect(await call("eth_getBlockByNumber", hex(n), true)).toEqual(f.block);
    expect(await call("eth_getBlockByHash", f.block.hash, false)).toEqual({ ...f.block, transactions: f.block.transactions.map((t: { hash: string }) => t.hash) });
    expect(await call("eth_getBlockTransactionCountByHash", f.block.hash)).toBe(hex(f.block.transactions.length));
    expect(await call("eth_getUncleCountByBlockNumber", hex(n))).toBe(hex(f.uncles.length));
    expect(await call("eth_getBlockReceipts", hex(n))).toEqual(f.receipts);
  });

  test("uncle by block and index", async () => {
    const f = FIXTURES.find((x) => x.uncles.length)!;
    expect(await call("eth_getUncleByBlockNumberAndIndex", f.block.number, "0x0")).toEqual(f.uncles[0]);
    expect(await call("eth_getUncleByBlockHashAndIndex", f.block.hash, "0x1")).toBeNull();
  });

  test("tags resolve to the archive tip", async () => {
    const tip = FIXTURES.at(-1)!.block;
    expect(await call("eth_blockNumber")).toBe(tip.number);
    expect(((await call("eth_getBlockByNumber", "latest", false)) as { hash: string }).hash).toBe(tip.hash);
    expect(((await call("eth_getBlockByNumber", { blockHash: tip.hash }, false)) as { hash: string }).hash).toBe(tip.hash);
  });

  test("unknown blocks are null", async () => {
    expect(await call("eth_getBlockByNumber", "0x2", false)).toBeNull();
    expect(await call("eth_getBlockByHash", "0x" + "11".repeat(32), false)).toBeNull();
  });

  test("a block by number costs one offsets read and the block frame after the pin; its receipts cost the receipts frame", async () => {
    const f = FIXTURES[5]!;
    await call("eth_getBlockByNumber", f.block.number, false); // warms meta.json
    source.reads.length = 0;
    await call("eth_getBlockByNumber", FIXTURES[4]!.block.number, false);
    expect(source.reads.map((r) => r.key.split("/").at(-1)).sort()).toEqual(["blocks.pack"]);
    source.reads.length = 0;
    await call("eth_getBlockReceipts", FIXTURES[4]!.block.number);
    // The request keeps what it read: the block frame is not read again.
    expect(source.reads.map((r) => r.key.split("/").at(-1)).sort()).toEqual(["blocks.pack", "receipts.pack"]);
  });
});

describe("transactions", () => {
  const all = FIXTURES.flatMap((f) => f.block.transactions.map((t: { hash: string }, i: number) => ({ t, r: f.receipts[i]! })));

  test(`all ${all.length} transactions and receipts by hash`, async () => {
    for (const { t, r } of all) {
      expect(await call("eth_getTransactionByHash", t.hash)).toEqual(t);
      expect(await call("eth_getTransactionReceipt", t.hash)).toEqual(r);
    }
  });

  test("by block and index, and raw encodings hash to the transaction hash", async () => {
    const f = FIXTURES.at(-1)!;
    expect(await call("eth_getTransactionByBlockNumberAndIndex", f.block.number, "0x3")).toEqual(f.block.transactions[3]);
    expect(await call("eth_getTransactionByBlockHashAndIndex", f.block.hash, hex(f.block.transactions.length))).toBeNull();
    const { keccak } = await import("../src/eth/block");
    const { data, parseData } = await import("../src/eth/hex");
    const raw = (await call("eth_getRawTransactionByHash", f.block.transactions[7].hash)) as string;
    expect(data(keccak(parseData(raw)!))).toBe(f.block.transactions[7].hash);
  });

  test("unknown hashes are null", async () => {
    expect(await call("eth_getTransactionByHash", "0x" + "ab".repeat(32))).toBeNull();
    expect(await call("eth_getTransactionReceipt", "0x" + "ab".repeat(32))).toBeNull();
  });

  test("invalid parameters are -32602", async () => {
    await expect(call("eth_getTransactionByHash", "0x1234")).rejects.toMatchObject({ code: -32602 });
    await expect(call("eth_getBlockByNumber", "pending-ish", false)).rejects.toMatchObject({ code: -32602 });
  });
});

describe("raw receipts", () => {
  test("are consensus-encoded: type byte, then [status, cumulativeGas, bloom, logs]", async () => {
    const { parseData } = await import("../src/eth/hex");
    const { decode, list } = await import("../src/eth/rlp");
    const f = FIXTURES.find((x) => Number(x.block.number) >= 20_000_000)!;
    const raws = (await call("debug_getRawReceipts", f.block.number)) as string[];
    expect(raws).toHaveLength(f.receipts.length);
    raws.forEach((raw, i) => {
      const bytes = parseData(raw)!;
      const type = Number(f.receipts[i]!.type);
      const fields = list(decode(type === 0 ? bytes : bytes.subarray(1)));
      if (type !== 0) expect(bytes[0]).toBe(type);
      expect(fields).toHaveLength(4);
      expect(list(fields[3])).toHaveLength(f.receipts[i]!.logs.length);
    });
  });
});

describe("worker", () => {
  function fakeBucket(objects: Map<string, Uint8Array>): R2Bucket {
    return {
      async get(key: string, opts?: { range?: { offset: number; length: number } }) {
        const o = objects.get(key);
        if (!o) return null;
        const b = opts?.range ? o.slice(opts.range.offset, opts.range.offset + opts.range.length) : o;
        return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
      },
    } as unknown as R2Bucket;
  }
  const env = { ARCHIVE: fakeBucket(OBJECTS), ARCHIVE_PREFIX: PREFIX, CHAIN_ID: "1" };
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const post = async (body: unknown) => {
    const res = await worker.fetch(new Request("https://eth.nullrpc.dev/", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
    return res.json() as Promise<any>;
  };

  test("single, batch and error envelopes", async () => {
    expect(await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    const batch = await post([
      { jsonrpc: "2.0", id: "a", method: "net_version" },
      { jsonrpc: "2.0", id: "b", method: "eth_nope" },
      { id: 3, method: "eth_chainId" },
    ]);
    expect(batch[0]).toEqual({ jsonrpc: "2.0", id: "a", result: "1" });
    expect(batch[1].error.code).toBe(-32601);
    expect(batch[2].error.code).toBe(-32600);
    expect((await post("{not json")).error.code).toBe(-32700);
    expect((await post([])).error.code).toBe(-32600);
  });
});
