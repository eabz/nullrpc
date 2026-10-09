# nullrpc-executor

The executor (`packages/executor`: revm in WebAssembly behind the round loop) as a Worker of its
own, reached only through a service binding to the `Executor` entrypoint (no routes, no
workers.dev). `src/index.ts` forwards `execute(request, state)` to the package; everything
else (the crate, the shell, the contract, the fixtures and tests) lives in
[packages/executor](../../packages/executor/README.md).

## What still uses it

Nothing by default. Since the RPC Workers bundle the package and execute in-process
(`apps/rpc/src/index.ts`), a dependency round is a function call plus the state reads, with no
service binding in the path. `apps/rpc/wrangler.jsonc` no longer binds `EXECUTOR`; an RPC
Worker that binds it (`{ "binding": "EXECUTOR", "service": "nullrpc-executor", "entrypoint":
"Executor" }` under its `services`) uses this Worker instead of the in-process path, for example
to move execution's CPU and memory out of the RPC isolates again. Keep it deployed while any
such configuration exists; it is otherwise idle and can be deleted.

## Commands

```sh
bun run build        # the package's scripts/build.sh (cargo → wasm-bindgen → wasm-opt into packages/executor/crate/pkg)
bun run test         # build, then vitest: one fixture case through the entrypoint (the package's suite covers the rest)
bun run typecheck
bun run deploy       # build, then wrangler deploy
npx wrangler deploy --dry-run
```

Needs `wasm-bindgen-cli` 0.2.129 and the `wasm32-unknown-unknown` target (see the package
README); `wasm-opt` is optional.
