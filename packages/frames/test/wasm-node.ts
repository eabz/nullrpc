// The frame decoders' WebAssembly module under Node (tests): what wrangler's CompiledWasm rule
// provides in a Worker for `import module from "../crate/pkg/frames.wasm"`. vitest configs resolve
// that import here through test/vitest-wasm.ts (packages/frames, apps/rpc).

import { readFileSync } from "node:fs";

const wasm: WebAssembly.Module = new WebAssembly.Module(readFileSync(new URL("../crate/pkg/frames.wasm", import.meta.url)));
export default wasm;
