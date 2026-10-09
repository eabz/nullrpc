import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { METHODS } from "../src/methods";
import { buildArchive, logIndex, PREFIX } from "./archive";
import { fixtures } from "./encode";

const FIXTURES = fixtures();
const OBJECTS = buildArchive(FIXTURES, { extra: (b) => ({ log_index: logIndex(b, FIXTURES) }) });
const ALL_LOGS = FIXTURES.flatMap((f) => f.receipts.flatMap((r) => r.logs));

async function getLogs(filter: unknown) {
  const chain = await Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), null, Date.now() + Math.random() * 1e12);
  return METHODS.eth_getLogs!(chain, [filter], { chainId: 1 }) as Promise<Record<string, unknown>[]>;
}

/** The reference: a full scan of the fixtures' receipts. */
function scan(pred: (l: { address: string; topics: string[]; blockNumber: string }) => boolean) {
  return ALL_LOGS.filter(pred);
}

const hex = (n: number) => "0x" + n.toString(16);
const busiest = (() => {
  const counts = new Map<string, number>();
  for (const l of ALL_LOGS) counts.set(l.address, (counts.get(l.address) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
})();
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("eth_getLogs", () => {
  test("by address over a range spanning eras", async () => {
    const old = FIXTURES.find((x) => Number(x.block.number) === 4_000_014)!.receipts.flatMap((r) => r.logs)[0]!.address;
    const got = await getLogs({ fromBlock: hex(3_995_000), toBlock: hex(4_004_000), address: old });
    expect(got.length).toBeGreaterThan(0);
    expect(got).toEqual(scan((l) => l.address === old && Number(l.blockNumber) >= 3_995_000 && Number(l.blockNumber) <= 4_004_000));
    const all = await getLogs({ fromBlock: hex(19_999_000), toBlock: hex(20_000_001), address: busiest });
    expect(all).toEqual(scan((l) => l.address === busiest && Number(l.blockNumber) >= 19_999_000 && Number(l.blockNumber) <= 20_000_001));
  });

  test("by topic0 (ERC-20 Transfer) and by address OR topic position", async () => {
    const from = 22_999_500, to = 23_000_001;
    expect(await getLogs({ fromBlock: hex(from), toBlock: hex(to), topics: [TRANSFER] })).toEqual(
      scan((l) => l.topics[0] === TRANSFER && Number(l.blockNumber) >= from),
    );
    const addrs = [...new Set(ALL_LOGS.filter((l) => Number(l.blockNumber) >= from).map((l) => l.address))].slice(0, 3);
    expect(await getLogs({ fromBlock: hex(from), toBlock: hex(to), address: addrs, topics: [TRANSFER] })).toEqual(
      scan((l) => addrs.includes(l.address) && l.topics[0] === TRANSFER && Number(l.blockNumber) >= from),
    );
  });

  test("by block hash, and with no filter over a short range", async () => {
    const f = FIXTURES.find((x) => Number(x.block.number) === 12_250_001)!;
    expect(await getLogs({ blockHash: f.block.hash })).toEqual(f.receipts.flatMap((r) => r.logs));
    expect(await getLogs({ fromBlock: hex(20_000_000), toBlock: hex(20_000_001) })).toEqual(scan((l) => Number(l.blockNumber) >= 20_000_000 && Number(l.blockNumber) <= 20_000_001));
  });

  test("limits: range and invalid filters", async () => {
    await expect(getLogs({ fromBlock: "0x0", toBlock: hex(20_000) })).rejects.toMatchObject({ code: -32005 });
    await expect(getLogs({ blockHash: "0x12", fromBlock: "0x1" })).rejects.toMatchObject({ code: -32602 });
    expect(await getLogs({ fromBlock: hex(5), toBlock: hex(4) })).toEqual([]);
  });
});
