// Account and storage state at a block: balance, nonce, code and storage slots, from the state
// history (archive) and the live window's state shards.

import { decodeAccount } from "../archive/state";
import type { Chain } from "../chain";
import { concat, data, parseData, quantity } from "../eth/hex";
import { blockRef, invalidParams, RpcError, type Handler } from "../rpc";

/** The block number a block parameter names, checked to exist (geth: "header not found"). */
export async function stateBlock(chain: Chain, param: unknown): Promise<number> {
  const ref = blockRef(chain, param);
  let n: number;
  if ("number" in ref) n = ref.number;
  else {
    const rec = await chain.blockByHash(ref.hash, "block");
    if (!rec) throw new RpcError(-32000, `header for hash not found`);
    n = rec.block.header.number;
  }
  if (n > chain.pointers().latest || n < chain.pin.manifest.first_block) throw new RpcError(-32000, "header not found");
  return n;
}

function address(value: unknown): Uint8Array {
  const a = parseData(value, 20);
  if (!a) throw invalidParams("address must be a 20-byte hex string");
  return a;
}

/** A storage slot: any hex quantity or 32-byte value, left-padded to 32 bytes. */
function slot(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw invalidParams("storage slot must be hex, at most 32 bytes");
  return parseData("0x" + value.slice(2).padStart(64, "0"))!;
}

const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

export async function account(chain: Chain, addr: Uint8Array, n: number) {
  return decodeAccount(await chain.stateValue("accounts", addr, n));
}

export const STATE_METHODS: Record<string, Handler> = {
  eth_getBalance: async (chain, [addr, block]) => {
    const a = await account(chain, address(addr), await stateBlock(chain, block));
    return quantity(a?.balance ?? 0n);
  },
  eth_getTransactionCount: async (chain, [addr, block]) => {
    const a = await account(chain, address(addr), await stateBlock(chain, block));
    return quantity(a?.nonce ?? 0);
  },
  eth_getCode: async (chain, [addr, block]) => {
    const a = await account(chain, address(addr), await stateBlock(chain, block));
    if (!a?.codeHash || data(a.codeHash) === EMPTY_CODE_HASH) return "0x";
    return data(await chain.code(a.codeHash));
  },
  eth_getStorageAt: async (chain, [addr, key, block]) => {
    const v = await chain.stateValue("storage", concat(address(addr), slot(key)), await stateBlock(chain, block));
    // Values are stored without leading zeros; the RPC returns 32 bytes.
    const out = new Uint8Array(32);
    out.set(v.subarray(Math.max(0, v.length - 32)), 32 - Math.min(32, v.length));
    return data(out);
  },
  debug_codeByHash: async (chain, [hash]) => {
    const h = parseData(hash, 32);
    if (!h) throw invalidParams("hash must be a 32-byte hex string");
    const code = await chain.code(h);
    return code.length ? data(code) : null;
  },
};
