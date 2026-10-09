# Hash locations and selective block reads

Before: the Worker deployed at 2026-10-09T21:57:51Z (version 22214403), main at 7f329dd; keyless
(10 rps budget), `node bench/scenario.mjs --phase calls --only "deep|ByHash|Receipt" --repeat 8`.
After: the same command against the deploy of e544a2b (verified hash locations and directory
pages per isolate; blocks, headers and transactions read a layout-2 block's frame alone).
`reads/call` below is hit+miss of `x-nullrpc-archive-cache` per call (the scenario's `r2/call`
column counts misses only).
