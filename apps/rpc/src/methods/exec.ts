// Execution and tracing, run by the executor (src/executor.ts: @nullrpc/executor in-process,
// or the executor Worker when EXECUTOR is bound). This module resolves the block (or the
// transaction's block) and hands the executor a StateSource over the request's pinned view; a
// dependency round is then a function call plus the state reads. The executor returns the
// JSON-RPC result or error.

import type { Chain } from "../chain";
import { data } from "../eth/hex";
import type { BlockRecord } from "../eth/record";
import { EXECUTOR_METHODS, type ExecRequest } from "../executor";
import { blockRef, hash32, invalidParams, RpcError, type Handler, type MethodEnv } from "../rpc";
import { ChainStateSource } from "../state-source";

/** Position of the block parameter for call-style methods. */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_estimateGas: 1, eth_createAccessList: 1, debug_traceCall: 1, trace_call: 2 };
const BY_TX = new Set(["debug_traceTransaction", "trace_transaction", "trace_replayTransaction"]);
const BY_BLOCK = new Set(["debug_traceBlockByNumber", "debug_traceBlockByHash", "trace_block", "trace_replayBlockTransactions"]);

async function blockFor(chain: Chain, param: unknown): Promise<BlockRecord> {
  const ref = blockRef(chain, param ?? "latest");
  const rec = "number" in ref ? (ref.number <= chain.pointers().latest ? await chain.block(ref.number) : null) : await chain.blockByHash(ref.hash);
  if (!rec) throw new RpcError(-32000, "header not found");
  return rec;
}

async function run(chain: Chain, env: MethodEnv, method: string, params: unknown[], rec: BlockRecord, txIndex?: number): Promise<unknown> {
  if (!env.executor) throw new RpcError(-32601, `the method ${method} does not exist/is not available`);
  const request: ExecRequest = { method, params, chain: await chain.config(), block: rec.frame, blockHash: data(rec.block.header.hash), blockNumber: rec.block.header.number, txIndex };
  let response;
  try {
    response = await env.executor.execute(request, new ChainStateSource(chain));
  } catch (e) {
    console.error(JSON.stringify({ event: "executor_error", method, error: e instanceof Error ? e.message : String(e) }));
    throw new RpcError(-32603, "execution unavailable");
  }
  if ("error" in response) throw new RpcError(response.error.code, response.error.message, response.error.data);
  return response.result;
}

function handler(method: string): Handler {
  return async (chain, params, env) => {
    if (BY_TX.has(method)) {
      const found = await chain.transaction(hash32(params[0], "transaction hash"));
      if (!found) {
        if (method.startsWith("trace_")) return null;
        throw new RpcError(-32000, "transaction not found");
      }
      return run(chain, env, method, params, found.rec, found.index);
    }
    if (BY_BLOCK.has(method)) {
      const rec = method === "debug_traceBlockByHash" ? await chain.blockByHash(hash32(params[0], "block hash")) : await blockFor(chain, params[0]);
      if (!rec) {
        if (method.startsWith("trace_")) return null;
        throw new RpcError(-32000, "block not found");
      }
      return run(chain, env, method, params, rec);
    }
    const at = BLOCK_PARAM[method];
    if (at === undefined) throw invalidParams("unsupported method");
    if (!params[0] || typeof params[0] !== "object") throw invalidParams("transaction call object required");
    return run(chain, env, method, params, await blockFor(chain, params[at]));
  };
}

export const EXEC_METHODS: Record<string, Handler> = Object.fromEntries([...EXECUTOR_METHODS].map((m) => [m, handler(m)]));
