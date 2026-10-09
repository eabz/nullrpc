// A vitest (Vite) plugin that answers the package's `.wasm` import with test/wasm-node.ts: under
// Node the WebAssembly module is read from crate/pkg, where wrangler's CompiledWasm rule would
// bundle it. Every Worker that tests over this package uses it in its vitest config.

import type { Plugin } from "vitest/config";

const WASM_NODE = new URL("./wasm-node.ts", import.meta.url).pathname;

export function framesWasmNode(): Plugin {
  return { name: "frames-wasm-node", enforce: "pre", resolveId: (id) => (id.endsWith("/crate/pkg/frames.wasm") ? WASM_NODE : null) };
}
