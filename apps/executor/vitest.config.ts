import { defineConfig } from "vitest/config";
import { executorWasmNode } from "@nullrpc/executor/test/vitest-wasm";

// `cloudflare:workers` exists only in the Workers runtime, and the package's `.wasm` import is
// what wrangler bundles: tests use stand-ins for both.
export default defineConfig({
  plugins: [executorWasmNode()],
  resolve: { alias: { "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname } },
});
