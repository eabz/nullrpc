// nullrpc-executor: EVM execution and tracing (@nullrpc/executor, revm in WebAssembly) as a
// Worker of its own, reached only through service bindings to the `Executor` entrypoint. The
// RPC Workers run the same package in-process (apps/rpc); this Worker remains for a deployment
// that binds EXECUTOR instead (apps/rpc/wrangler.jsonc).

import { WorkerEntrypoint } from "cloudflare:workers";
import { execute, type ExecRequest, type ExecResponse, type ExecutorApi, type StateSource } from "@nullrpc/executor";

export class Executor extends WorkerEntrypoint implements ExecutorApi {
  execute(request: ExecRequest, state: StateSource): Promise<ExecResponse> {
    return execute(request, state);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
