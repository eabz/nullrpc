26 requests in the capture; CPU mean 239ms, p50 20ms, p95 1.28s

case                                     n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
---------------------------------------  -  -------  -------  --------  ---------  --------  --------
eth_getLogs 1000 blocks, Transfer topic  2    673ms    1.28s     975ms      1.95s     1.32s      ok=2
eth_getLogs 10000 blocks deep, Transfer  3     17ms    1.79s     605ms      1.81s      44ms      ok=3
eth_getLogs 10000 blocks, token          3    600ms    706ms     439ms      1.32s     3.56s      ok=3
eth_getLogs 1000 blocks deep             2    316ms    417ms     367ms      733ms     841ms      ok=2
eth_getLogs 10 blocks, token             3     49ms     67ms      47ms      141ms     200ms      ok=3
eth_getBlockReceipts deep                3     20ms     89ms      37ms      112ms     208ms      ok=3
eth_getLogs 10 blocks deep               2     13ms     47ms      30ms       60ms      21ms      ok=2
eth_getBlockByNumber deep full           3     11ms     22ms      14ms       43ms     297ms      ok=3
eth_getBlockReceipts recent              3      8ms      9ms       7ms       20ms      11ms      ok=3
eth_getLogs 1000 blocks, no filter       2      9ms     10ms      10ms       19ms     282ms      ok=2
