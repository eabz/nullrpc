import { defineConfig } from "vitest/config";
import { executorWasmNode } from "./test/vitest-wasm";

// src/index.ts imports the WebAssembly as wrangler bundles it (a compiled module); under Node
// the module is read from crate/pkg instead (test/wasm-node.ts).
export default defineConfig({ plugins: [executorWasmNode()] });
