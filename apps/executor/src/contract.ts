// Copy of apps/rpc/src/executor.ts (the contract between the RPC Worker and this Worker,
// `nullrpc-executor`, entrypoint `Executor`): keep the two in sync.
//
// EVM execution and tracing with revm, compiled to WebAssembly.
//
// The executor never reads storage itself. The RPC Worker passes a `StateSource` (a Workers RPC
// target, received by the executor as a stub) and the executor asks it for what it needs, in
// batches: the executor runs, collects the keys it is missing, reads them in one call, and runs
// again (rounds). Mined-transaction traces read the block's witness instead, in one call.
//
// Everything crossing the binding is structured-clonable: hex strings (0x-prefixed, lowercase),
// numbers and plain objects. One executor serves every chain: the chain's rules come from the
// archive's config object (docs/storage.md, "Chain config"), passed with every request.

/** A key the executor reads. State keys are read at the end of block `at` of the request. */
export type StateKey =
  | { kind: "account"; address: string }
  | { kind: "storage"; address: string; slot: string }
  | { kind: "code"; hash: string }
  | { kind: "blockHash"; number: number };

/** Answers to StateKeys, in order. `null` for an absent account or unknown block hash. */
export type StateValue =
  | { kind: "account"; nonce: number; balance: string; codeHash: string | null }
  | { kind: "storage"; value: string }
  | { kind: "code"; code: string }
  | { kind: "blockHash"; hash: string }
  | null;

/** A block's pre-state (docs/storage.md, "Witnesses"); code is read by hash through `read`. */
export interface Witness {
  accounts: { address: string; exists: boolean; nonce: number; balance: string; codeHash: string | null }[];
  storage: { address: string; slots: { slot: string; value: string }[] }[];
}

/** Provided by the RPC Worker (an RpcTarget); the executor receives it as a stub. */
export interface StateSource {
  /** State at the end of block `at` (one pinned view for the whole request). */
  read(keys: StateKey[], at: number): Promise<StateValue[]>;
  /** The pre-state of block `number`, or null when the archive has no witness for it. */
  witness(number: number): Promise<Witness | null>;
  /** Block records (storage.md, "Block records": RLP hex) by number, for traces and replays. */
  block(number: number): Promise<string | null>;
}

export interface ExecRequest {
  /** The JSON-RPC method: eth_call, eth_estimateGas, eth_createAccessList, debug_traceCall,
   *  debug_traceTransaction, debug_traceBlockByNumber, debug_traceBlockByHash,
   *  trace_transaction, trace_block, trace_call, trace_replayTransaction,
   *  trace_replayBlockTransactions. */
  method: string;
  params: unknown[];
  /** The chain config object from the archive (geth genesis "config" plus blob schedule). */
  chain: Record<string, unknown>;
  /** The block the request runs at: for calls, state at its end and its header as the context;
   *  for traces, the block containing the transaction(s). Block record, RLP hex. */
  block: string;
  /** For mined-transaction traces: the transaction's index in `block`. */
  txIndex?: number;
}

export type ExecResponse = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/** The executor entrypoint as the RPC Worker calls it. */
export interface ExecutorApi {
  execute(request: ExecRequest, state: StateSource): Promise<ExecResponse>;
}

/** Methods the executor serves. */
export const EXECUTOR_METHODS = new Set([
  "eth_call",
  "eth_estimateGas",
  "eth_createAccessList",
  "debug_traceCall",
  "debug_traceTransaction",
  "debug_traceBlockByNumber",
  "debug_traceBlockByHash",
  "trace_transaction",
  "trace_block",
  "trace_call",
  "trace_replayTransaction",
  "trace_replayBlockTransactions",
]);
