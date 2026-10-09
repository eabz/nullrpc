import { defineConfig } from "vitest/config";
import { framesWasmNode } from "./test/vitest-wasm";

// The `.wasm` import is what wrangler bundles: under Node it is read from crate/pkg (build it
// first: bun run build).
export default defineConfig({ plugins: [framesWasmNode()] });
