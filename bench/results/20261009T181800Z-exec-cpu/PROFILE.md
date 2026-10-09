# Where a token balanceOf eth_call spends its CPU (2026-10-09)

Measured on the Worker under `wrangler dev --config wrangler.profile.jsonc` (local workerd, real
Hoodi R2 and live bindings) with V8's sampling profiler through the inspector
(`bench/profile-worker.mjs`, 100 µs samples, 30 requests after 3 warm-ups, all at one head so
every cache is warm), and inside the module alone with `bench/rounds.mjs --profile` (the real
WebAssembly under Node, phases timed with hrtime). The Mac's CPU is faster than the edge's;
production CPU per request (`wrangler tail`) is about 2 to 3× these numbers.

## Before (main at 33b1193)

Warm balanceOf: **12.7 ms** of sampled CPU per request.

| where | ms | what |
|---|---:|---|
| wasm (hints round) | 5.2 | parsing the 586 KB hints JSON: 1,050 keys and the code of 34 contracts, each keccak-hashed and jump-analysed again |
| `passStringToWasm0` | 1.0 | copying that JSON into the module's memory |
| `unhex` + `keccakP` + `blockOf` | 1.4 | decoding the 29 KB record hex and hashing its header in the shell |
| `decodeAt` (RLP) | 0.5 | decoding the live block record in JS for `latest` |
| `execute` self + JSON | 0.5 | building the hints JSON |
| EVM (wasm) | < 1 | the balanceOf itself |
| request plumbing (`rpc`, `readBody`, fetch) | 1.0 | |
| idle / GC | 1.7 | |

Inside the module (`rounds.mjs --profile`, hinted balanceOf): `new Session` 0.32 ms (record
decode), first run 0.02, hints JSON stringify 1.19, hints apply + execute 4.27, total 5.9 ms;
without hints the same call is 0.7 ms. So the fixed cost was the state handed to the module
on every call, not the EVM and not instantiation (one instance per isolate, `Session` per
request; nothing is compiled or instantiated per request).

## After (worktree-exec-cpu)

The module keeps, per instance, the newest decoded blocks and a state snapshot per block hash
(`crate/src/cache.rs`); a call at a block it has seen sends `blockHash` + `seed` and no record
or hints. The RPC Worker passes the block's hash and number it already decoded, caches decoded
records per isolate, and hands the record as bytes (hex only when the module lacks the block).

Warm balanceOf: **4.1 ms** sampled, 1.3 ms of it idle: about **3 ms** of work.

| where | ms |
|---|---:|
| `passStringToWasm0` (request JSON: params + chain config) | 0.4 |
| request plumbing (`readBody`, `rpc`, fetch, response) | 1.0 |
| `open` / `state` / `liveRecord` (chain view, pointers, record cache) | 0.4 |
| wasm (seeded session + EVM) | 0.2 |
| idle / GC / program | 1.7 |

Real-calldata eth_call (warm, reverts): 12.0 → 5.6 ms sampled.

## Cold path (first call at a block in an isolate)

Unchanged in kind: the witnesses around the block are read and the hints built once per block
per isolate (one live witness read or two, one live window check, the hinted contracts' code
from the archive), the hints JSON is handed to the module once, and the module snapshots it.
Every later call at that head pays the numbers above.
