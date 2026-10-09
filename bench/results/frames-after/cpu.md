10 requests in the capture; CPU mean 264ms, p50 13ms, p95 800ms

case                                     n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
---------------------------------------  -  -------  -------  --------  ---------  --------  --------
eth_getLogs 1000 blocks, Transfer topic  2    773ms    800ms     787ms      1.57s     1.40s      ok=2
eth_getLogs 10000 blocks, token          1    676ms    676ms     676ms      676ms     4.72s      ok=1
eth_getLogs 1000 blocks deep             3    146ms    210ms     121ms      363ms     548ms      ok=3
eth_getLogs 10000 blocks deep, Transfer  1     13ms     13ms      13ms       13ms      43ms      ok=1
eth_getBlockByNumber deep full           1      7ms      7ms       7ms        7ms     323ms      ok=1
eth_getBlockReceipts deep                1      7ms      7ms       7ms        7ms     270ms      ok=1
eth_getLogs 1000 blocks, no filter       1      4ms      4ms       4ms        4ms     239ms      ok=1
