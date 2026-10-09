# Deep 1,000-block Transfer-topic eth_getLogs after the zstd WebAssembly deploy (dff24c41), 2026-10-09T16:2xZ, keyless

Eight random archive ranges, one at a time, cold (no earlier run on those ranges), plus the verification calls. Worker CPU from the wrangler tail capture (bench/cpu.mjs).

```
┌─────────┬─────────┬──────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
│ (index) │ from    │ ms   │ logs      │ error                                                                       │
├─────────┼─────────┼──────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 2280054 │ 3448 │ 4565      │ undefined                                                                   │
│ 1       │ 1242593 │ 4795 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x12f5e1-0x12f8a1' │
│ 2       │ 2089264 │ 4004 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1fe130-0x1fe24e' │
│ 3       │ 3638881 │ 2876 │ 8578      │ undefined                                                                   │
│ 4       │ 2541793 │ 4812 │ 9420      │ undefined                                                                   │
│ 5       │ 2043664 │ 2715 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1f2f10-0x1f3017' │
│ 6       │ 3230579 │ 3751 │ 2771      │ undefined                                                                   │
│ 7       │ 3388861 │ 2605 │ 1821      │ undefined                                                                   │
└─────────┴─────────┴──────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
verify wide eth_getLogs 3782851 to 3783851 : 3694 ms, 8545 logs  first: {
  block: '0x39b8c3',
  address: '0x37ed7e0d37cb44423d51a9fa1e9157eb5a6d579e',
  topics: 3
}
verify deep eth_getBlockByNumber 1234567 : 1187 ms,  number 0x12d687 hash 0x0c13998c976f81a69d42d79e81fa5fefed21d198852ef50a6a8eaa49f335e357 txs 29 first tx 0xf7c1dce28730d124fe6d3ba4eeade66193181b4adfe73ef4c9a652943fb6bca2
verify deep eth_getBlockByNumber 2345678 : 1407 ms,  txs 72 parent 0xf801ac2b725ccdc5091882a3202facc87149197425944a506731be600e636bc4
```

```
11 requests in the capture; CPU mean 918ms, p50 1.08s, p95 1.56s

case                                          n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
--------------------------------------------  -  -------  -------  --------  ---------  --------  --------
eth_getLogs 1000 blocks deep, Transfer topic  8    1.08s    1.56s     1.08s      8.61s     2.95s      ok=8
verify wide getLogs                           1    1.41s    1.41s     1.41s      1.41s     3.48s      ok=1
verify deep getBlockByNumber full             2     34ms     42ms      38ms       76ms     1.26s      ok=2
```

Before (bench/results/zstd-before/cpu.md, head case "eth_getLogs 1000 blocks, Transfer topic"): CPU p50 1.55s for 3 samples; the earlier session measured the deep query at 3.7s cold with about 750 candidate blocks decoded at roughly 2ms each.
