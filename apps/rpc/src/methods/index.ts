// The JSON-RPC methods served from the archive: chain identity, blocks, transactions, receipts
// and their raw encodings. Results follow the reference execution clients' JSON exactly.

import type { BlockNeed } from "../archive/archive";
import type { Chain } from "../chain";
import { headerJson } from "../eth/block";
import { concat, data, quantity } from "../eth/hex";
import { blockResult, logsBloom, receiptResult, receiptsResult, txResult, type BlockPart, type BlockRecord } from "../eth/record";
import { encodeBytes, encodeList, intBytes } from "../eth/rlp";
import { blockRef, bool, hash32, index, type Handler } from "../rpc";
import { EXEC_METHODS } from "./exec";
import { FEE_METHODS } from "./fees";
import { LOG_METHODS } from "./logs";
import { MISC_METHODS } from "./misc";
import { STATE_METHODS } from "./state";

export const CLIENT_VERSION = "nullrpc/0.1.0";

/**
 * The block a block parameter names, or null when unknown: its whole record, or with `need`
 * "block" the block without its receipts (a layout-2 segment then reads one frame, not two).
 */
function resolve(chain: Chain, param: unknown): Promise<BlockRecord | null>;
function resolve(chain: Chain, param: unknown, need: "block"): Promise<BlockPart | null>;
function resolve(chain: Chain, param: unknown, need: BlockNeed = "record"): Promise<BlockPart | null> {
  const ref = blockRef(chain, param);
  return "number" in ref ? (need === "block" ? chain.part(ref.number) : chain.block(ref.number)) : chain.blockByHash(ref.hash, need);
}

function byHash(chain: Chain, param: unknown): Promise<BlockRecord | null>;
function byHash(chain: Chain, param: unknown, need: "block"): Promise<BlockPart | null>;
function byHash(chain: Chain, param: unknown, need: BlockNeed = "record"): Promise<BlockPart | null> {
  return chain.blockByHash(hash32(param, "blockHash"), need);
}

function uncleResult(rec: BlockPart | null, i: number) {
  const u = rec?.block.uncles[i];
  if (!u) return null;
  const out = headerJson(u);
  // An uncle is reported as a block with no transactions or uncles of its own.
  out.size = quantity(encodeList([u.raw, encodeList([]), encodeList([])]).length);
  out.uncles = [];
  return out;
}

/** A receipt in consensus encoding, as debug_getRawReceipts returns it. */
function rawReceipt(rec: BlockRecord, i: number): Uint8Array {
  const r = rec.receipts[i]!;
  const logs = encodeList(r.logs.map(([address, topics, payload]) => encodeList([address!.raw, topics!.raw, payload!.raw])));
  const body = encodeList([encodeBytes(r.status), encodeBytes(intBytes(r.cumulativeGasUsed)), encodeBytes(logsBloom(r.logs)), logs]);
  return r.type === 0 ? body : concat(Uint8Array.of(r.type), body);
}

const txCount = (rec: BlockPart | null) => (rec ? quantity(rec.block.txs.length) : null);
const uncleCount = (rec: BlockPart | null) => (rec ? quantity(rec.block.uncles.length) : null);

const BLOCK_METHODS: Record<string, Handler> = {
  web3_clientVersion: async () => CLIENT_VERSION,
  eth_chainId: async (chain) => quantity(chain.pin.manifest.chain.id),
  net_version: async (chain) => chain.pin.manifest.chain.network_id,
  eth_syncing: async () => false,
  eth_blockNumber: async (chain) => quantity(chain.pointers().latest),

  // Blocks, headers and transactions need no receipts: these read the block alone.
  eth_getBlockByNumber: async (chain, [ref, full]) => {
    const rec = await resolve(chain, ref, "block");
    return rec ? blockResult(rec, bool(full, "full")) : null;
  },
  eth_getBlockByHash: async (chain, [hash, full]) => {
    const rec = await byHash(chain, hash, "block");
    return rec ? blockResult(rec, bool(full, "full")) : null;
  },
  eth_getBlockTransactionCountByNumber: async (chain, [ref]) => txCount(await resolve(chain, ref, "block")),
  eth_getBlockTransactionCountByHash: async (chain, [hash]) => txCount(await byHash(chain, hash, "block")),
  eth_getUncleCountByBlockNumber: async (chain, [ref]) => uncleCount(await resolve(chain, ref, "block")),
  eth_getUncleCountByBlockHash: async (chain, [hash]) => uncleCount(await byHash(chain, hash, "block")),
  eth_getUncleByBlockNumberAndIndex: async (chain, [ref, i]) => uncleResult(await resolve(chain, ref, "block"), index(i)),
  eth_getUncleByBlockHashAndIndex: async (chain, [hash, i]) => uncleResult(await byHash(chain, hash, "block"), index(i)),

  eth_getTransactionByHash: async (chain, [hash]) => {
    const found = await chain.transaction(hash32(hash), "block");
    return found ? txResult(found.rec, found.index) : null;
  },
  eth_getTransactionByBlockNumberAndIndex: async (chain, [ref, i]) => {
    const rec = await resolve(chain, ref, "block");
    return rec ? txResult(rec, index(i)) : null;
  },
  eth_getTransactionByBlockHashAndIndex: async (chain, [hash, i]) => {
    const rec = await byHash(chain, hash, "block");
    return rec ? txResult(rec, index(i)) : null;
  },
  eth_getRawTransactionByHash: async (chain, [hash]) => {
    const found = await chain.transaction(hash32(hash), "block");
    return found ? data(found.rec.block.txs[found.index]!.raw) : null;
  },
  eth_getRawTransactionByBlockNumberAndIndex: async (chain, [ref, i]) => {
    const tx = (await resolve(chain, ref, "block"))?.block.txs[index(i)];
    return tx ? data(tx.raw) : null;
  },
  eth_getRawTransactionByBlockHashAndIndex: async (chain, [hash, i]) => {
    const tx = (await byHash(chain, hash, "block"))?.block.txs[index(i)];
    return tx ? data(tx.raw) : null;
  },

  // A receipt is formatted from the receipt and its transaction's context (sender, type, gas
  // price against the header's base fee): the whole record.
  eth_getTransactionReceipt: async (chain, [hash]) => {
    const found = await chain.transaction(hash32(hash));
    return found ? receiptResult(found.rec, found.index) : null;
  },
  eth_getBlockReceipts: async (chain, [ref]) => {
    const rec = await resolve(chain, ref);
    return rec ? receiptsResult(rec) : null;
  },

  debug_getRawBlock: async (chain, [ref]) => {
    const rec = await resolve(chain, ref, "block");
    return rec ? data(rec.block.raw) : null;
  },
  debug_getRawHeader: async (chain, [ref]) => {
    const rec = await resolve(chain, ref, "block");
    return rec ? data(rec.block.header.raw) : null;
  },
  debug_getRawTransaction: async (chain, [hash]) => {
    const found = await chain.transaction(hash32(hash), "block");
    return found ? data(found.rec.block.txs[found.index]!.raw) : null;
  },
  debug_getRawReceipts: async (chain, [ref]) => {
    const rec = await resolve(chain, ref);
    return rec ? rec.receipts.map((_, i) => data(rawReceipt(rec, i))) : null;
  },
};

export const METHODS: Record<string, Handler> = { ...BLOCK_METHODS, ...STATE_METHODS, ...LOG_METHODS, ...FEE_METHODS, ...EXEC_METHODS, ...MISC_METHODS };
