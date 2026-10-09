# Deep 1,000-block Transfer-topic eth_getLogs after the frames deploy (03f1c23d: zstd and log extraction in WebAssembly), 2026-10-09T18:xxZ, keyless

Three passes of eight random archive ranges, one query at a time, plus the verification calls. Worker CPU from wrangler tail captures (bench/cpu.mjs); the tail attaches 30 to 60 seconds after it starts, so the first two passes were captured only partially.

## Pass 1, right after the deploy: the ranges of the zstd-only capture (bench/results/zstd-after/deep-transfer.md), two hours later

```
┌─────────┬─────────┬──────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
│ (index) │ from    │ ms   │ logs      │ error                                                                       │
├─────────┼─────────┼──────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 2280253 │ 1419 │ 4650      │ undefined                                                                   │
│ 1       │ 1242693 │ 1085 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x12f645-0x12f904' │
│ 2       │ 2089445 │ 1045 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1fe1e5-0x1fe2c7' │
│ 3       │ 3639210 │ 1086 │ 8858      │ undefined                                                                   │
│ 4       │ 2542018 │ 1038 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x26c9c2-0x26cd6d' │
│ 5       │ 2043840 │ 1052 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1f2fc0-0x1f30c0' │
│ 6       │ 3230870 │ 934  │ 2831      │ undefined                                                                   │
│ 7       │ 3389167 │ 1069 │ 1857      │ undefined                                                                   │
└─────────┴─────────┴──────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
verify wide eth_getLogs 3783185 to 3784185 : 2022 ms, 8335 logs  first: {
  block: '0x39ba12',
  address: '0x2117b8c1d6f1396292a6a1803c01c593596cdfd0',
  topics: 3
}
verify deep eth_getBlockByNumber 1234567 : 72 ms,  number 0x12d687 hash 0x0c13998c976f81a69d42d79e81fa5fefed21d198852ef50a6a8eaa49f335e357 txs 29 first tx 0xf7c1dce28730d124fe6d3ba4eeade66193181b4adfe73ef4c9a652943fb6bca2
verify deep eth_getBlockByNumber 2345678 : 60 ms,  txs 72 parent 0xf801ac2b725ccdc5091882a3202facc87149197425944a506731be600e636bc4
```

## Pass 2, the same ranges again (edge-warm)

```
┌─────────┬─────────┬──────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
│ (index) │ from    │ ms   │ logs      │ error                                                                       │
├─────────┼─────────┼──────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 2280261 │ 1145 │ 4660      │ undefined                                                                   │
│ 1       │ 1242697 │ 523  │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x12f649-0x12f90c' │
│ 2       │ 2089452 │ 373  │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1fe1ec-0x1fe2cc' │
│ 3       │ 3639223 │ 733  │ 8870      │ undefined                                                                   │
│ 4       │ 2542027 │ 571  │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x26c9cb-0x26cd71' │
│ 5       │ 2043847 │ 661  │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x1f2fc7-0x1f30cb' │
│ 6       │ 3230881 │ 642  │ 2827      │ undefined                                                                   │
│ 7       │ 3389179 │ 729  │ 1849      │ undefined                                                                   │
└─────────┴─────────┴──────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
verify wide eth_getLogs 3783198 to 3784198 : 2277 ms, 8358 logs  first: {
  block: '0x39ba1e',
  address: '0x352aee9651e30b5fb0f770d7f4a0000c4a80e7fd',
  topics: 3
}
verify deep eth_getBlockByNumber 1234567 : 313 ms,  number 0x12d687 hash 0x0c13998c976f81a69d42d79e81fa5fefed21d198852ef50a6a8eaa49f335e357 txs 29 first tx 0xf7c1dce28730d124fe6d3ba4eeade66193181b4adfe73ef4c9a652943fb6bca2
verify deep eth_getBlockByNumber 2345678 : 231 ms,  txs 72 parent 0xf801ac2b725ccdc5091882a3202facc87149197425944a506731be600e636bc4
```

## Pass 3, new ranges (cold), fully captured

```
┌─────────┬─────────┬──────┬───────────┬─────────────────────────────────────────────────────────────────────────────┐
│ (index) │ from    │ ms   │ logs      │ error                                                                       │
├─────────┼─────────┼──────┼───────────┼─────────────────────────────────────────────────────────────────────────────┤
│ 0       │ 2473489 │ 3069 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x25be11-0x25bef5' │
│ 1       │ 1529620 │ 3227 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x175714-0x17583d' │
│ 2       │ 3102896 │ 1963 │ 3647      │ undefined                                                                   │
│ 3       │ 1312897 │ 2728 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x140881-0x140a56' │
│ 4       │ 1554117 │ 2032 │ undefined │ 'query returns more than 10000 logs; narrow the range to 0x17b6c5-0x17b855' │
│ 5       │ 2573862 │ 2005 │ 5421      │ undefined                                                                   │
│ 6       │ 3018317 │ 1970 │ 2446      │ undefined                                                                   │
│ 7       │ 2651938 │ 2451 │ 6939      │ undefined                                                                   │
└─────────┴─────────┴──────┴───────────┴─────────────────────────────────────────────────────────────────────────────┘
verify wide eth_getLogs 3783204 to 3784204 : 1433 ms, 8363 logs  first: {
  block: '0x39ba24',
  address: '0xda38de6dba36918e716ade6a3ac7944d6a5d5683',
  topics: 3
}
verify deep eth_getBlockByNumber 1234567 : 347 ms,  number 0x12d687 hash 0x0c13998c976f81a69d42d79e81fa5fefed21d198852ef50a6a8eaa49f335e357 txs 29 first tx 0xf7c1dce28730d124fe6d3ba4eeade66193181b4adfe73ef4c9a652943fb6bca2
verify deep eth_getBlockByNumber 2345678 : 65 ms,  txs 72 parent 0xf801ac2b725ccdc5091882a3202facc87149197425944a506731be600e636bc4
```

```
11 requests in the capture; CPU mean 196ms, p50 132ms, p95 691ms

case                                          n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
--------------------------------------------  -  -------  -------  --------  ---------  --------  --------
eth_getLogs 1000 blocks deep, Transfer topic  8    132ms    464ms     183ms      1.46s     2.15s      ok=8
verify wide getLogs                           1    691ms    691ms     691ms      691ms     1.49s      ok=1
verify deep getBlockByNumber full             2      4ms      4ms       4ms        8ms      20ms      ok=2
```

Before (bench/results/zstd-after/deep-transfer.md, zstd in WebAssembly but the log extraction still in JavaScript): CPU p50 1.08s, wall p50 2.95s on comparable cold ranges. Before the zstd swap the head case measured CPU p50 1.55s (bench/results/zstd-before/cpu.md). The cold wall time is now R2: 13 to 19 range reads in waves of six, with CPU 6 to 9 percent of it.
