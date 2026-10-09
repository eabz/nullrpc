import { defineConfig } from "vitest/config";
import { executorWasmNode } from "@nullrpc/executor/test/vitest-wasm";
import { framesWasmNode } from "@nullrpc/frames/test/vitest-wasm";

// `cloudflare:workers` exists only in the Workers runtime; tests use a minimal stand-in. The
// executor and frames packages' `.wasm` imports are what wrangler bundles: under Node they are read
// from packages/*/crate/pkg (build them first: bun run build).
export default defineConfig({
  plugins: [executorWasmNode(), framesWasmNode()],
  resolve: { alias: { "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname } },
});
