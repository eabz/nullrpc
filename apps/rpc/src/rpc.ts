// JSON-RPC 2.0 envelope: single requests and batches, error codes, and parameter helpers.

import type { Chain } from "./chain";
import { parseData, parseQuantity } from "./eth/hex";

/** Batch items per request (the account app's docs and pricing say 32). */
export const MAX_BATCH = 32;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const invalidParams = (message: string) => new RpcError(-32602, message);

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
}

/** Per-request configuration the methods may need. */
export interface MethodEnv {
  chainId: number;
  /** HTTPS JSON-RPC endpoint of the transaction relay; unset disables eth_sendRawTransaction. */
  relayUrl?: string;
  /** The executor (in-process, or the executor Worker); unset disables execution and tracing. */
  executor?: import("./executor").ExecutorApi;
}

export type Handler = (chain: Chain, params: unknown[], env: MethodEnv) => Promise<unknown>;

export function errorResponse(id: RpcRequest["id"], e: RpcError) {
  const error: { code: number; message: string; data?: unknown } = { code: e.code, message: e.message };
  if (e.data !== undefined) error.data = e.data;
  return { jsonrpc: "2.0", id, error };
}

/** Checks one request object; returns an error response when it is not a valid request. */
export function validate(value: unknown): RpcRequest | ReturnType<typeof errorResponse> {
  const v = value as Partial<RpcRequest> | null;
  const id = v && (typeof v.id === "string" || typeof v.id === "number" || v.id === null) ? v.id : null;
  if (!v || typeof v !== "object" || v.jsonrpc !== "2.0" || typeof v.method !== "string") return errorResponse(id, new RpcError(-32600, "invalid request"));
  if (v.params !== undefined && !Array.isArray(v.params)) return errorResponse(id, new RpcError(-32602, "params must be an array"));
  return { jsonrpc: "2.0", id, method: v.method, params: v.params ?? [] };
}

// ---- parameters

export function hash32(value: unknown, name = "hash"): Uint8Array {
  const h = parseData(value, 32);
  if (!h) throw invalidParams(`${name} must be a 32-byte hex string`);
  return h;
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw invalidParams(`${name} must be a boolean`);
  return value;
}

export function index(value: unknown): number {
  const n = parseQuantity(value);
  if (n === null) throw invalidParams("index must be a hex quantity");
  return n;
}

export type BlockRef = { number: number } | { hash: Uint8Array; requireCanonical: boolean };

/** A block parameter: a tag, a hex number, or an EIP-1898 object. */
export function blockRef(chain: Chain, value: unknown): BlockRef {
  const p = chain.pointers();
  if (value === undefined || value === "latest" || value === "pending") return { number: p.latest };
  if (value === "safe") return { number: p.safe };
  if (value === "finalized") return { number: p.finalized };
  if (value === "earliest") return { number: p.earliest };
  if (typeof value === "string") {
    const n = parseQuantity(value);
    if (n === null) throw invalidParams("invalid block number or tag");
    return { number: n };
  }
  if (value && typeof value === "object") {
    const o = value as { blockHash?: unknown; blockNumber?: unknown; requireCanonical?: unknown };
    if (o.blockHash !== undefined) return { hash: hash32(o.blockHash, "blockHash"), requireCanonical: o.requireCanonical === true };
    if (o.blockNumber !== undefined) return blockRef(chain, o.blockNumber);
  }
  throw invalidParams("invalid block number or tag");
}
