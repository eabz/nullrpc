import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { decodeAccount } from "../src/archive/state";
import { Chain } from "../src/chain";
import { METHODS } from "../src/methods";
import { buildArchive, encodeAccount, PREFIX, type StateEntry } from "./archive";
import { fixtures } from "./encode";

// A deterministic random history: 40 accounts and 120 storage slots changing at random blocks,
// split into four layers (a base and three newer ones) with Bloom filters, so lookups cross
// layers, pages and index pages.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
const TIP = 20_000_001;
const LAYERS: [number, number][] = [[0, 9_999_999], [10_000_000, 14_999_999], [15_000_000, 19_999_999], [20_000_000, TIP]];
const blockIn = () => Math.floor(rand() * (TIP + 1));

const accounts = Array.from({ length: 40 }, () => bytes(20));
const slots = Array.from({ length: 120 }, () => ({ address: accounts[Math.floor(rand() * 40)]!, slot: bytes(32) }));
const CODE = Uint8Array.from([0x60, 0x80, 0x60, 0x40, 0x52]);
const { keccak_256 } = await import("@noble/hashes/sha3.js");
const CODE_HASH = keccak_256(CODE);

const entries: StateEntry[] = [];
for (const a of accounts) for (let i = 0; i < 6; i++) entries.push({ domain: "accounts", key: a, block: blockIn(), value: encodeAccount(i + 1, BigInt(Math.floor(rand() * 1e15)) * 10n ** 6n, i === 5 ? CODE_HASH : undefined) });
// An account that was deleted (empty value) at some block.
entries.push({ domain: "accounts", key: accounts[0]!, block: 12_345_678, value: new Uint8Array() });
for (const s of slots) for (let i = 0; i < 4; i++) entries.push({ domain: "storage", key: Uint8Array.from([...s.address, ...s.slot]), block: blockIn(), value: bytes(1 + Math.floor(rand() * 32)).filter((_, j) => j > 0 || true) });
entries.push({ domain: "code", key: CODE_HASH, block: 0, value: CODE });

// Remove duplicate (key, block) pairs: the newest wins, as in a real history.
const dedup = new Map(entries.map((e) => [`${e.domain}:${Buffer.from(e.key).toString("hex")}:${e.block}`, e]));
const ENTRIES = [...dedup.values()];

const OBJECTS = buildArchive(fixtures().filter((f) => Number(f.block.number) <= TIP), { state: { entries: ENTRIES, layers: LAYERS } });

/** The reference answer: the newest entry at or before n. */
function model(domain: StateEntry["domain"], key: Uint8Array, n: number): Uint8Array {
  const hex = Buffer.from(key).toString("hex");
  let best: StateEntry | null = null;
  for (const e of ENTRIES) if (e.domain === domain && Buffer.from(e.key).toString("hex") === hex && e.block <= n && (!best || e.block > best.block)) best = e;
  return best?.value ?? new Uint8Array();
}

async function open() {
  return Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), null, Date.now() + Math.random() * 1e12);
}

describe("state history", () => {
  test("every account and slot at many blocks equals the model", async () => {
    const chain = await open();
    const probes = [0, 1, 9_999_999, 10_000_000, 12_345_677, 12_345_678, 17_000_000, TIP, ...Array.from({ length: 12 }, blockIn)];
    for (const n of probes) {
      for (const a of accounts) expect(Buffer.from(await chain.stateValue("accounts", a, n)).toString("hex")).toBe(Buffer.from(model("accounts", a, n)).toString("hex"));
      for (const s of slots) {
        const key = Uint8Array.from([...s.address, ...s.slot]);
        expect(Buffer.from(await chain.stateValue("storage", key, n)).toString("hex")).toBe(Buffer.from(model("storage", key, n)).toString("hex"));
      }
    }
  });

  test("a key in no layer is absent; a filtered-out key costs no page reads", async () => {
    const source = new MemorySource(OBJECTS);
    const chain = await Chain.open(new Archive(source, PREFIX), null, Date.now() + Math.random() * 1e12);
    source.reads.length = 0;
    expect((await chain.stateValue("accounts", bytes(20), TIP)).length).toBe(0);
    expect(source.reads.filter((r) => r.key.endsWith(".pack")).length).toBeLessThanOrEqual(2);
  });

  test("RPC methods: balance, nonce, code, storage", async () => {
    const chain = await open();
    const a = accounts[3]!;
    const expected = decodeAccount(model("accounts", a, TIP));
    const addr = "0x" + Buffer.from(a).toString("hex");
    expect(await METHODS.eth_getBalance!(chain, [addr, "latest"], { chainId: 1 })).toBe("0x" + (expected?.balance ?? 0n).toString(16));
    expect(await METHODS.eth_getTransactionCount!(chain, [addr, "0x" + TIP.toString(16)], { chainId: 1 })).toBe("0x" + (expected?.nonce ?? 0).toString(16));
    const withCode = accounts.find((x) => decodeAccount(model("accounts", x, TIP))?.codeHash)!;
    expect(await METHODS.eth_getCode!(chain, ["0x" + Buffer.from(withCode).toString("hex"), "latest"], { chainId: 1 })).toBe("0x6080604052");
    const s = slots[0]!;
    const v = model("storage", Uint8Array.from([...s.address, ...s.slot]), TIP);
    const got = (await METHODS.eth_getStorageAt!(chain, ["0x" + Buffer.from(s.address).toString("hex"), "0x" + Buffer.from(s.slot).toString("hex"), "latest"], { chainId: 1 })) as string;
    expect(BigInt(got)).toBe(v.length ? BigInt("0x" + Buffer.from(v).toString("hex")) : 0n);
    expect(got).toHaveLength(66);
    await expect(METHODS.eth_getBalance!(chain, [addr, "0x" + (TIP + 1).toString(16)], { chainId: 1 })).rejects.toMatchObject({ code: -32000 });
  });
});
