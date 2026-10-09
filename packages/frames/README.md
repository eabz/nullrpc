# @nullrpc/frames

Archive frame decoding for the RPC Worker, in WebAssembly: zstd decompression of pack frames
(`apps/rpc/src/archive/archive.ts`) and eth_getLogs extraction from block records
(`apps/rpc/src/eth/record.ts`). The C zstd library (1.5.7, through the `zstd-safe` crate,
decompression only) and a Rust RLP cursor compiled to one module, about 120 KB, with
JavaScript fallbacks (`fzstd`, the Worker's own decoder) when the module cannot be instantiated.

```ts
import { decompress, frameLogs, receiptsLogs } from "@nullrpc/frames";
const frame = decompress(compressed, new Uint8Array(uncompressedLength)); // the caller checks frame.length
const logs = frameLogs(frame, blockHash, { addresses: [], topics: [[TRANSFER]] }); // null: module unavailable
const same = receiptsLogs(receiptsFrame, blockHash, blockNumber, filter); // a layout-2 receipts frame
```

`decompress(compressed, out)` has fzstd's interface: it fills `out` and returns it, or the filled
prefix when the frame is shorter; a malformed frame or one larger than `out` throws.

`frameLogs(frame, hash, filter)` returns the accepted logs as eth_getLogs returns them, decoding
only the header, the receipts and the hash of a transaction with an accepted log. It throws
`FrameError` when the module refuses the record (malformed, header not hashing to `hash`,
receipts and transactions differing in number); `apps/rpc/src/eth/record.ts` then decodes in
JavaScript, which reports the precise error.

`receiptsLogs(frame, hash, number, filter)` is the same over a layout-2 receipts frame
(docs/storage.md, "Block bundles": `[number, timestamp, tx_hashes, receipts, extras]`), which
carries everything a log needs, so no transaction is decoded or hashed; the frame's number must
be the offsets record's `number` (code -7 otherwise).

## Why

Per MB of frame on V8: pure-JavaScript zstd about 40 ms, the C library in WebAssembly about
0.5 ms; the JavaScript log extraction (which materializes the record's whole RLP tree) about
13 ms, the module's cursor well under 1 ms. A 1,000-block `eth_getLogs` decodes several hundred
block frames, so these two were nearly all of its CPU time.

## Layout

- `crate/`: the Rust crate (`cdylib`, no wasm-bindgen). `src/lib.rs` has the exports:
  `nullrpc_alloc`, `nullrpc_free`, `nullrpc_decompress(src, srcLen, dst, dstLen) -> bytes | -error`
  with one `ZSTD_DCtx` reused for every frame, `nullrpc_frame_logs(frame, frameLen, hash, filter,
  filterLen) -> jsonBytes | -code` writing to an output buffer read through `nullrpc_out_ptr`.
  `src/rlp.rs` is the cursor (items are located, not materialized); `src/logs.rs` the extraction
  and JSON formatting (the same fields in the same order as the JavaScript decoder).
  `scripts/build.sh` builds `crate/pkg/frames.wasm` (git-ignored), which wrangler bundles as a
  compiled module.
- `src/index.ts`: the wrapper. The instance is created on the first call (Workers' startup
  limit) and keeps input, output and filter buffers in the module's memory, grown to the largest
  input seen (frames are at most 8 MiB, `MAX_FRAME`); frames are copied in, results out. Filters
  are encoded once per filter object.
- `test/vitest-wasm.ts`: the Vite plugin that answers the `.wasm` import under Node (used by this
  package's and apps/rpc's vitest configs). The extraction is tested against the JavaScript
  decoder in `apps/rpc/test/frames.test.ts`, where the record encoder lives.

## Building

Requires the `wasm32-unknown-unknown` target, a clang with the wasm32 backend (Apple's has it),
and an LLVM `ar` for the C static library (`rustup component add llvm-tools`; the system `ar` on
macOS cannot index wasm objects). `wasm-opt` (binaryen) is used when installed.

```bash
bun run build     # from packages/frames, or as part of apps/rpc's build
bun run test
```
