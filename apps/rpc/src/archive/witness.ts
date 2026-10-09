// Witnesses (storage.md, "Witnesses"): a block's pre-state, one frame per block, for replaying
// and tracing mined transactions without per-key reads.

import { data } from "../eth/hex";
import type { Witness } from "../executor";
import type { Archive, Pin } from "./archive";
import { Uvarint } from "./hashindex";
import { ArchiveError, type ObjectRef } from "./types";

interface WitnessRange {
  first: number;
  last: number;
  offsets: ObjectRef;
  packs: ObjectRef[];
}

const RECORD = 56;

export async function archiveWitness(archive: Archive, pin: Pin, n: number): Promise<Uint8Array | null> {
  const w = pin.manifest.witnesses as { first_block: number; ranges: WitnessRange[] };
  const range = w.ranges.find((r) => r.first <= n && n <= r.last);
  if (!range) return null;
  const rec = await archive.range(range.offsets, (n - range.first) * RECORD, RECORD);
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const pack = range.packs[v.getUint16(16, true)];
  if (!pack) throw new ArchiveError("witness offsets name a missing pack");
  return archive.frame({ pack, offset: Number(v.getBigUint64(0, true)), compressed: v.getUint32(8, true), uncompressed: v.getUint32(12, true), sha256: rec.subarray(24, 56) });
}

function take(r: Uvarint, b: Uint8Array, n: number): Uint8Array {
  const out = b.subarray(r.pos, r.pos + n);
  if (out.length !== n) throw new ArchiveError("truncated witness");
  r.pos += n;
  return out;
}

const big = (b: Uint8Array) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return "0x" + x.toString(16);
};

/** Decodes a witness frame into the executor's JSON form. */
export function decodeWitness(b: Uint8Array): Witness {
  const r = new Uvarint(b);
  r.pos = 1;
  if (b[0] !== 1) throw new ArchiveError(`unsupported witness version ${b[0]}`);
  const accounts: Witness["accounts"] = [];
  for (let i = 0, n = r.next(); i < n; i++) {
    const address = data(take(r, b, 20));
    const flags = take(r, b, 1)[0]!;
    const nonce = r.next();
    const balance = big(take(r, b, r.next()));
    const codeHash = flags & 2 ? data(take(r, b, 32)) : null;
    accounts.push({ address, exists: (flags & 1) !== 0, nonce, balance, codeHash });
  }
  const storage: Witness["storage"] = [];
  for (let i = 0, n = r.next(); i < n; i++) {
    const address = data(take(r, b, 20));
    const slots: { slot: string; value: string }[] = [];
    for (let j = 0, m = r.next(); j < m; j++) slots.push({ slot: data(take(r, b, 32)), value: big(take(r, b, r.next())) });
    storage.push({ address, slots });
  }
  return { accounts, storage };
}
