import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live } from "../src/live";
import { METHODS } from "../src/methods";
import { renderPage, statusBody } from "../src/page/page";
import { buildArchive, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
// The archive holds everything up to 20,000,001 (P); the live window holds the Prague blocks.
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const OBJECTS = buildArchive(ARCHIVED);
const hex = (n: number) => "0x" + n.toString(16);
const id = (f: Fixture): BlockId => ({ number: Number(f.block.number), hash: f.block.hash });
const recHex = (f: Fixture) => Buffer.from(encodeRecord(f)).toString("hex");

/** A fake LiveReads over WINDOW with a scriptable reorg. */
function fakeLive(opts: { promoted?: BlockId; staleOnce?: boolean } = {}) {
  let stale = opts.staleOnce ?? false;
  const head = id(WINDOW.at(-1)!);
  const calls: string[] = [];
  const state: LiveState = { head, safe: head, finalized: id(WINDOW[0]!), promoted: opts.promoted ?? id(ARCHIVED.at(-1)!), generation: 1, shards: 16 };
  const api: LiveApi = {
    async state() {
      calls.push("state");
      return state;
    },
    async block(key, pin) {
      calls.push(`block:${key}`);
      if (stale) {
        stale = false;
        return { stale: true };
      }
      const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key.toLowerCase()));
      if (!f || Number(f.block.number) > pin.number) return null;
      return { stale: false, number: Number(f.block.number), hash: f.block.hash, record: recHex(f) };
    },
    async witness() {
      return null;
    },
    async txBlock(hash, pin) {
      calls.push(`tx:${hash}`);
      const f = WINDOW.find((w) => w.block.transactions.some((t: { hash: string }) => t.hash === hash));
      return f && Number(f.block.number) <= pin.number ? { stale: false, number: Number(f.block.number) } : null;
    },
    async getPinned() {
      return { stale: false, block: null, value: null };
    },
    async scanPinned() {
      return { stale: false, slots: {} };
    },
  };
  return { api, calls };
}

async function open(api: LiveApi) {
  const archive = new Archive(new MemorySource(OBJECTS), PREFIX);
  // A distinct "now" per call keeps the isolate caches from leaking between tests.
  return Chain.open(archive, new Live(api), Date.now() + Math.random() * 1e12);
}
const call = (chain: Chain, method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });

describe("live window", () => {
  test("latest, safe and finalized come from the live pointers", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    expect(await call(chain, "eth_blockNumber")).toBe(WINDOW.at(-1)!.block.number);
    expect(chain.pointers()).toMatchObject({ archived: 20_000_001, finalized: Number(WINDOW[0]!.block.number) });
  });

  test("blocks above P come from the live window, below from the archive", async () => {
    const { api, calls } = fakeLive();
    const chain = await open(api);
    expect(await call(chain, "eth_getBlockByNumber", "latest", true)).toEqual(WINDOW.at(-1)!.block);
    expect(await call(chain, "eth_getBlockByNumber", hex(20_000_000), true)).toEqual(ARCHIVED.find((f) => Number(f.block.number) === 20_000_000)!.block);
    expect(calls.filter((c) => c === "block:20000000")).toHaveLength(0);
  });

  test("hashes and transactions resolve in the window first, then the archive", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    const liveTx = WINDOW[0]!.block.transactions[5];
    const oldTx = ARCHIVED[0]!.block.transactions[0];
    expect(await call(chain, "eth_getTransactionByHash", liveTx.hash)).toEqual(liveTx);
    expect(await call(chain, "eth_getTransactionReceipt", liveTx.hash)).toEqual(WINDOW[0]!.receipts[5]);
    expect(await call(chain, "eth_getTransactionByHash", oldTx.hash)).toEqual(oldTx);
    expect(((await call(chain, "eth_getBlockByHash", WINDOW[1]!.block.hash, false)) as { number: string }).number).toBe(WINDOW[1]!.block.number);
  });

  test("a stale pin (reorg) re-reads the live state and retries", async () => {
    const { api, calls } = fakeLive({ staleOnce: true });
    const chain = await open(api);
    expect(((await call(chain, "eth_getBlockByNumber", "latest", false)) as { hash: string }).hash).toBe(WINDOW.at(-1)!.block.hash);
    expect(calls.filter((c) => c === "state").length).toBeGreaterThanOrEqual(2);
  });

  test("a block promoted past the pinned manifest is read from the new generation", async () => {
    // The live window already pruned block 20,000,001, but this request pinned an older manifest
    // ending at 20,000,000; the chain must re-read HEAD.json rather than answer null.
    const older = new Map(OBJECTS);
    const newer = buildArchive(ARCHIVED);
    const olderObjects = buildArchive(ARCHIVED.slice(0, -1));
    for (const [k, v] of olderObjects) older.set(k, v);
    const source = new MemorySource(older);
    const archive = new Archive(source, PREFIX);
    const now = Date.now() + Math.random() * 1e12;
    await archive.pin(now); // caches the older generation
    for (const [k, v] of newer) older.set(k, v);
    const { api } = fakeLive({ promoted: id(ARCHIVED.at(-1)!) });
    const chain = await Chain.open(archive, new Live(api), now + 1);
    expect(chain.archived).toBe(20_000_001);
    expect(((await call(chain, "eth_getBlockByNumber", hex(20_000_001), false)) as { hash: string }).hash).toBe(ARCHIVED.at(-1)!.block.hash);
  });
});

describe("page and status", () => {
  test("status.json reports the live head with its timestamp and the archive tip", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    const tip = WINDOW.at(-1)!.block;
    const s = await statusBody({ chainId: 1, name: "Ethereum", statusUrl: null, keys: true }, chain, Number(tip.timestamp) * 1000 + 5_000);
    expect(s).toMatchObject({ chain_id: 1, state: "following", archived_through: 20_000_001, latest: { number: Number(tip.number), timestamp: Number(tip.timestamp) } });
    expect(s.window).toBe(Number(tip.number) - 20_000_001);
  });

  test("the page escapes values and points at this origin", () => {
    const html = renderPage({ chainId: 1, name: "Ethereum <x>", statusUrl: "https://status.nullrpc.dev", keys: true }, "https://eth.nullrpc.dev");
    expect(html).toContain("Ethereum &#60;x&#62;");
    expect(html).toContain('data-usage="/_status/usage"');
    expect(html).toContain("https://eth.nullrpc.dev/&lt;key&gt;");
    expect(html).not.toMatch(/\{\{[a-z_]+\}\}/);
  });
});
