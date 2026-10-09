24 requests in the capture; CPU mean 411ms, p50 21ms, p95 2.40s

case                                     n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
---------------------------------------  -  -------  -------  --------  ---------  --------  --------
eth_getLogs 1000 blocks, Transfer topic  3    1.55s    2.40s     1.83s      5.49s     2.08s      ok=3
eth_getLogs 10000 blocks deep, Transfer  2     21ms    2.43s     1.23s      2.46s     244ms      ok=2
eth_getLogs 1000 blocks deep             2    683ms    923ms     803ms      1.61s     1.13s      ok=2
eth_getLogs 10 blocks, token             2     49ms     57ms      53ms      106ms      70ms      ok=2
eth_getLogs 10 blocks deep               3      7ms     64ms      25ms       76ms     436ms      ok=3
eth_getLogs 10000 blocks, token          2     14ms     22ms      18ms       36ms      23ms      ok=2
eth_getBlockReceipts recent              2     12ms     21ms      17ms       33ms     223ms      ok=2
eth_getBlockReceipts deep                2      2ms     31ms      17ms       33ms      16ms      ok=2
eth_getLogs 1000 blocks, no filter       4      2ms      3ms       3ms       10ms       9ms      ok=4
eth_getBlockByNumber deep full           2      3ms      4ms       4ms        7ms     214ms      ok=2
