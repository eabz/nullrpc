import { describe, expect, test } from "vitest";
import { data } from "../src/eth/hex";
import { blockResult, decodeRecord, receiptsResult } from "../src/eth/record";
import { encodeRecord, fixtures } from "./encode";

// Field-by-field comparison against the reference node's JSON, so a failure names the field.
describe.each(fixtures().map((f) => [Number(f.block.number), f] as const))("block %i", (_, f) => {
  const rec = decodeRecord(encodeRecord(f));

  test("block hash matches the chain", () => {
    expect(data(rec.block.header.hash)).toBe(f.block.hash);
  });

  test("full block equals the reference", () => {
    expect(blockResult(rec, true)).toEqual(f.block);
  });

  test("hash-only block lists transaction hashes", () => {
    expect(blockResult(rec, false).transactions).toEqual(f.block.transactions.map((t: { hash: string }) => t.hash));
  });

  test("receipts equal the reference", () => {
    expect(receiptsResult(rec)).toEqual(f.receipts);
  });
});
