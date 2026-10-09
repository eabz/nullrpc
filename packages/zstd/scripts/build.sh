#!/bin/sh
# Builds the zstd decoder's WebAssembly into crate/pkg (git-ignored): cargo (wasm32, release),
# then wasm-opt when it is installed. The C library compiles with the host clang's wasm32 target
# through zstd-sys's libc shim; no wasm-bindgen is involved (plain C-ABI exports). The static
# archive must be indexed by an LLVM ar (the system `ar` on macOS cannot read wasm objects):
#   rustup component add llvm-tools
set -eu
cd "$(dirname "$0")/../crate"
HOST=$(rustc -vV | sed -n 's/^host: //p')
LLVM_AR="$(rustc --print sysroot)/lib/rustlib/$HOST/bin/llvm-ar"
if [ -x "$LLVM_AR" ]; then
  export AR_wasm32_unknown_unknown="$LLVM_AR"
elif command -v llvm-ar >/dev/null 2>&1; then
  export AR_wasm32_unknown_unknown="$(command -v llvm-ar)"
else
  echo "llvm-ar not found: run 'rustup component add llvm-tools'" >&2
  exit 1
fi
cargo build --release --target wasm32-unknown-unknown
mkdir -p pkg
cp target/wasm32-unknown-unknown/release/nullrpc_zstd.wasm pkg/zstd.wasm
if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    --strip-debug --strip-producers -o pkg/zstd.wasm pkg/zstd.wasm
else
  echo "wasm-opt not found: skipping (install binaryen for a smaller module)" >&2
fi
ls -l pkg/zstd.wasm
