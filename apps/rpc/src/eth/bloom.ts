// The header's logs bloom as eth_getLogs tests it: 2,048 bits, three per address or topic
// (bits 0-10 of each of the first three 16-bit words of keccak256(value)), bit `b` at
// `bloom[255 - (b >> 3)] & (1 << (b & 7))`. A value whose three bits are all set may be in
// the block; one with any bit clear is not. The matcher precomputes the bits of every filter
// value once, so testing a block is a few byte reads per value.

import { keccak } from "./block";

/** A filter field: the addresses (tag 0), or the values accepted at a topic position. */
export interface BloomGroup {
  values: Uint8Array[];
}

/** The byte index and mask of each of a value's three bits. */
export function bloomBits(value: Uint8Array): [number, number, number, number, number, number] {
  const h = keccak(value);
  const out = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
  for (let i = 0; i < 3; i++) {
    const bit = ((h[2 * i]! << 8) | h[2 * i + 1]!) & 2047;
    out[2 * i] = 255 - (bit >> 3);
    out[2 * i + 1] = 1 << (bit & 7);
  }
  return out;
}

/** Whether a value with `bits` may be in `bloom` (256 bytes). */
export function bloomHas(bloom: Uint8Array, bits: [number, number, number, number, number, number]): boolean {
  return (bloom[bits[0]]! & bits[1]) !== 0 && (bloom[bits[2]]! & bits[3]) !== 0 && (bloom[bits[4]]! & bits[5]) !== 0;
}

/**
 * Whether a block's bloom admits a filter: for every group, some value of the group may be in
 * the block. With no groups (no filter) every block is admitted.
 */
export function bloomAdmits(groups: BloomGroup[]): (bloom: Uint8Array) => boolean {
  const bits = groups.map((g) => g.values.map(bloomBits));
  return (bloom) => {
    if (bloom.length !== 256) return true;
    for (const group of bits) {
      let any = false;
      for (const b of group) {
        if (bloomHas(bloom, b)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    return true;
  };
}
