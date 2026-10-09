// The header logs bloom as eth_getLogs tests it (src/eth/bloom.ts), against real headers: every
// log's address and topics are admitted by its block's bloom (the bloom never excludes a block
// that holds a match), the bloom computed from the block's logs is the header's bit for bit,
// and an empty bloom admits nothing but the empty filter.

import { describe, expect, test } from "vitest";
import { bloomAdmits, bloomBits, bloomHas } from "../src/eth/bloom";
import { parseData } from "../src/eth/hex";
import { decodeRecord, logsBloom } from "../src/eth/record";
import { encodeRecord, fixtures } from "./encode";

const FIXTURES = fixtures();
const unhex = (s: string) => parseData(s)!;

describe("header logs blooms", () => {
  test("every log of a block is admitted by the block's header bloom", () => {
    let logs = 0;
    for (const f of FIXTURES) {
      const bloom = unhex(f.block.logsBloom);
      expect(bloom.length).toBe(256);
      for (const r of f.receipts) {
        for (const l of r.logs as { address: string; topics: string[] }[]) {
          logs++;
          expect(bloomHas(bloom, bloomBits(unhex(l.address)))).toBe(true);
          for (const t of l.topics) expect(bloomHas(bloom, bloomBits(unhex(t)))).toBe(true);
          const groups = [{ values: [unhex(l.address)] }, ...l.topics.map((t) => ({ values: [unhex(t)] }))];
          expect(bloomAdmits(groups)(bloom)).toBe(true);
          // Any listed value admits: the right one among wrong ones.
          expect(bloomAdmits([{ values: [new Uint8Array(20), unhex(l.address)] }])(bloom)).toBe(true);
        }
      }
    }
    expect(logs).toBeGreaterThan(100);
  });

  test("the bloom of a block's logs is the header's", () => {
    for (const f of FIXTURES) {
      const rec = decodeRecord(encodeRecord(f));
      expect(logsBloom(rec.receipts.flatMap((r) => r.logs))).toEqual(unhex(f.block.logsBloom));
    }
  });

  test("an empty bloom admits only the empty filter; a group with no admitted value refuses the block", () => {
    const empty = new Uint8Array(256);
    expect(bloomAdmits([])(empty)).toBe(true);
    const f = FIXTURES.at(-1)!;
    const log = f.receipts.flatMap((r) => r.logs as { address: string; topics: string[] }[])[0]!;
    expect(bloomAdmits([{ values: [unhex(log.address)] }])(empty)).toBe(false);
    // A value whose bits are all set in a bloom with only those bits set is admitted; one bit short is not.
    const bits = bloomBits(unhex(log.address));
    const sparse = new Uint8Array(256);
    sparse[bits[0]]! |= bits[1];
    sparse[bits[2]]! |= bits[3];
    expect(bloomHas(sparse, bits)).toBe(false);
    sparse[bits[4]]! |= bits[5];
    expect(bloomHas(sparse, bits)).toBe(true);
    expect(bloomAdmits([{ values: [unhex(log.address)] }, { values: [unhex(log.topics[0]!)] }])(sparse)).toBe(false);
    // A bloom of the wrong size never excludes.
    expect(bloomAdmits([{ values: [unhex(log.address)] }])(new Uint8Array(10))).toBe(true);
  });
});
