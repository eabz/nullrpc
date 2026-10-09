// The executor's contract (StateSource, ExecRequest, ExecResponse, the methods it serves), from
// the shared package: @nullrpc/executor runs in-process (src/index.ts, src/methods/exec.ts) or
// behind the executor Worker's `Executor` entrypoint when EXECUTOR is bound.

export type { ExecRequest, ExecResponse, ExecutorApi, StateKey, StateSource, StateValue, Witness } from "@nullrpc/executor/contract";
export { EXECUTOR_METHODS } from "@nullrpc/executor/contract";
