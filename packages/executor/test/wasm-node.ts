// The executor's WebAssembly module under Node (tests): what wrangler's CompiledWasm rule
// provides in a Worker for `import wasm from "../crate/pkg/executor_bg.wasm"`. vitest configs
// resolve that import here through test/vitest-wasm.ts (packages/executor, apps/executor, apps/rpc).

import { readFileSync } from "node:fs";

const wasm: WebAssembly.Module = new WebAssembly.Module(readFileSync(new URL("../crate/pkg/executor_bg.wasm", import.meta.url)));
export default wasm;
