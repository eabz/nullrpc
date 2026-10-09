#!/bin/sh
# Builds the executor's WebAssembly into crate/pkg (git-ignored): cargo (wasm32, release),
# wasm-bindgen (--target web, so the Worker instantiates the module itself, lazily), then
# wasm-opt when it is installed. Requires wasm-bindgen-cli matching the wasm-bindgen crate:
#   cargo install wasm-bindgen-cli --version 0.2.129 --locked
set -eu
cd "$(dirname "$0")/../crate"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir pkg --out-name executor \
  target/wasm32-unknown-unknown/release/nullrpc_executor.wasm
# A Rust panic aborts (traps) the instance; initSync never instantiates twice. This hook lets
# src/index.ts drop a trapped instance so the next request gets a fresh one.
grep -q '^let wasmModule, wasmInstance, wasm;' pkg/executor.js || { echo "unexpected wasm-bindgen glue" >&2; exit 1; }
printf '\nexport function __nullrpc_reset() { wasm = undefined; wasmInstance = undefined; }\n' >> pkg/executor.js
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --strip-debug --strip-producers \
    -o pkg/executor_bg.wasm pkg/executor_bg.wasm
else
  echo "wasm-opt not found: skipping (install binaryen for a smaller module)" >&2
fi
ls -l pkg/executor_bg.wasm
