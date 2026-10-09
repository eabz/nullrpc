113 requests in the capture; CPU mean 79ms, p50 16ms, p95 337ms

case                            n  cpu p50  cpu p95  cpu mean  cpu total  wall p50  outcomes
-----------------------------  --  -------  -------  --------  ---------  --------  --------
debug_traceCall callTracer      7     64ms    1.02s     348ms      2.43s     1.88s      ok=7
eth_call real calldata latest   8     76ms    429ms     188ms      1.50s     979ms      ok=8
eth_estimateGas real calldata  10     63ms    337ms     122ms      1.22s     1.32s     ok=10
trace_call                      7     86ms    240ms     103ms      721ms     1.26s      ok=7
debug_traceCall replay at n-1   5    147ms    362ms     136ms      679ms     358ms      ok=5
eth_estimateGas transfer        7     27ms    295ms      95ms      662ms     355ms      ok=7
eth_call replay at n-1          3    215ms    230ms     201ms      602ms     780ms      ok=3
eth_estimateGas replay at n-1   5     42ms    239ms     104ms      519ms     396ms      ok=5
(untagged)                     56      7ms     19ms       8ms      465ms     307ms     ok=56
eth_call balanceOf              5     38ms     76ms      32ms      158ms     554ms      ok=5
