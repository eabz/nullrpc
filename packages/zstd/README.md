# @nullrpc/zstd

zstd frame decompression for the RPC Worker's archive reads (`apps/rpc/src/archive/archive.ts`):
the C library (zstd 1.5.7, through the `zstd-safe` crate, decompression only) compiled to
WebAssembly, with the pure-JavaScript `fzstd` as the fallback when the module cannot be
instantiated.

```ts
import { decompress } from "@nullrpc/zstd";
const out = decompress(compressed, new Uint8Array(uncompressedLength)); // out.length is checked by the caller
```

`decompress(compressed, out)` has fzstd's interface: it fills `out` and returns it, or the filled
prefix when the frame is shorter; a malformed frame or one larger than `out` throws.

## Why

Pure-JavaScript zstd runs at about 40 ms per MB on V8; the C library in WebAssembly at about
0.5 ms per MB (Node, the fixture frames under `apps/rpc/test/fixtures/mainnet`). A 1,000-block
`eth_getLogs` decodes several hundred block frames, so the decoder was most of its CPU time.

## Layout

- `crate/`: the Rust crate (`cdylib`, no wasm-bindgen): `nullrpc_alloc`, `nullrpc_free` and
  `nullrpc_decompress(src, srcLen, dst, dstLen) -> bytes | -error`, with one `ZSTD_DCtx` reused
  for every frame. `scripts/build.sh` builds it into `crate/pkg/zstd.wasm` (git-ignored, about
  110 KB), which wrangler bundles as a compiled module.
- `src/index.ts`: the wrapper. The instance is created on the first frame (Workers' startup
  limit), keeps an input and an output buffer in the module's memory, grown to the largest frame
  seen (frames are at most 8 MiB, `MAX_FRAME`), and copies each frame in and out.
- `test/vitest-wasm.ts`: the Vite plugin that answers the `.wasm` import under Node (used by this
  package's and apps/rpc's vitest configs).

## Building

Requires the `wasm32-unknown-unknown` target, a clang with the wasm32 backend (Apple's has it),
and an LLVM `ar` for the C static library (`rustup component add llvm-tools`; the system `ar` on
macOS cannot index wasm objects). `wasm-opt` (binaryen) is used when installed.

```bash
bun run build     # from packages/zstd, or as part of apps/rpc's build
bun run test
```
