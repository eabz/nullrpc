import { defineConfig } from "vitest/config";

// `cloudflare:workers` exists only in the Workers runtime; tests use a minimal stand-in.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname } },
});
