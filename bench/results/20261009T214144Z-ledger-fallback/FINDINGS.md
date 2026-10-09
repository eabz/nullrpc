# Ledger fallback under load: the Scale-stage 429s on the internal key

Follow-up to the 21:10 milestone (`20261009T211054Z-milestone`), where 2,121 of 44,564 Scale-stage
requests (4.8%) through the internal-plan key were refused with HTTP 429 "Rate limit exceeded",
the plan limiter's message, on a plan that is never rate-limited. Keyed runs from one laptop
against hoodi.nullrpc.dev, tails on `nullrpc-rpc-560048` (search `lease_error`) and `nullrpc-app`.

## Reproduction (before the fix, deployed code of 19:48)

| run | stage | achieved | n | 429 "Rate limit exceeded" | other errors |
|---|---|---:|---:|---:|---|
| 21:36 scale only (`before/scale-only-2136.md`) | scale | 1,630 req/s | 34,651 | 0 | 86 state reads overloaded, 5 internal |
| 21:37 ramp (`before/ramp-2137.md`) | scale | 684 req/s | 25,195 | 0 | 2 budget timeouts |
| 21:42 ramp (`before/report.md`, `before/console.txt`) | scale | 1,163 req/s | 52,440 | **90** | 5 budget timeouts |

The refusals are intermittent: they need the app's lease calls to fail during the stage. In the
21:42 run the tails (`before/tails.txt`) show the whole chain:

- `nullrpc-app`: 387 `POST /lease` calls answered 500 (320) or were canceled (67), all with
  `D1_ERROR: D1 DB is overloaded. Requests queued for too long` (313) or `Too many requests
  queued` (74); wall time p50 17ms, p90 16.2s, p99 23s.
- `nullrpc-rpc-560048`: 601 `lease_error` events, `lease HTTP 500`, between 21:42:58 and
  21:43:37 (the Scale stage ran from about 21:42:50 to 21:43:58 by the client's clock); 521 of
  them carried 2 lines and 5 carried 3 for one key.
- The client saw the 429s in the same window.

Cloudflare analytics for the milestone's Scale minute (21:12 UTC) show the same shape at a
larger scale: the app served 6,656 requests in the minute (about 110 lease calls per second)
with wall time p50 6.6s, p90 22s, p99 28.5s, while D1's own per-query time stayed under 1ms
(the time went to D1's queue, not its queries).

## Cause

Two defects in `apps/rpc/src/access/ledger.ts`, and one consequence of them:

1. **Renewal storms.** `renewDue()` (called from `ctx.waitUntil` after every request) renewed
   every due line without marking it as renewing. A line becomes due once per 30s, but it stays
   due until the app answers, so every request that arrived during a renewal's round trip
   started another one: at 100 req/s per isolate and a 200ms lease call, 20 renewals instead
   of one, each reporting the same served credits (and each subtracting them on return).
2. **A paid key's line was sent twice per call.** After the first grant the line is stored under
   its subject (account-wide) and stays under `subject@net`, and `renewDue` iterated the map's
   values: two entries for one line, so `lines: 2` in the lease calls and the usage reported
   twice.
3. Under 1 and 2, D1 in the account app queued and refused (`D1 DB is overloaded`), the app
   answered 500, the ledger entered its 10s backoff, and every isolate that started under the
   load (Cloudflare spreads a burst over new isolates) had no grant yet: its line held the
   FALLBACK entitlement, plan `free`, and `limitByPlan` applied `RPC_RATE_LIMIT_FREE`, 200
   requests per 10s per location keyed by the subject, shared by all those isolates in the
   colo. Everything above that was 429 "Rate limit exceeded". A line that had been granted
   kept its `internal` entitlement (the code already did), so warm isolates served normally,
   which is why the refusals were a few percent and not all.

## Fix (commit "ledger: one renewal per line at a time; …")

- `renewDue` dedupes the lines and sets one shared `renewing` promise on each: requests that
  find a line due while its renewal is in flight do nothing, and a synchronous renewal joins
  it. Promotion to the account-wide key removes the per-network entry.
- `Ledger.admit` returns `granted`: whether the entitlement came from the app. In `rpc()` the
  plan's rate limits (`limitByPlan`, `takeStrict`) run only for a granted line. A line the app
  never answered for is served fail-open within the ledger's soft bound (20,000 credits per
  line per isolate per minute, 500,000 per isolate), as `rate.ts` already does on
  infrastructure errors. A granted line keeps its plan through lease errors and the backoff
  window (unchanged behaviour, now covered by a test).
- Lease calls time out after 8s (`AbortSignal.timeout`) instead of holding requests for as
  long as D1's queue.
- `apps/app/src/leases.ts`: the sweep of expired leases runs at most every 10s per isolate on
  the lease path (the 2-minute cron sweeps as well), one D1 round trip fewer per call.

Tests: `apps/rpc/test/access.test.ts` ("a granted line keeps its plan through lease errors and
the backoff window", "a line never granted is served provisionally while the app is down", "a
due line renews once at a time", and the Worker-level "the plan's rate limit applies to a
granted plan, not to a key the app never answered for"). `bun run test` 282 passed, `bun run
typecheck` clean in apps/rpc and apps/app.

## After (deployed 21:57 UTC: nullrpc-app 449762d5, nullrpc-rpc-560048 22214403)

Two Scale stages through the internal key, run from the main checkout right after the deploy
(the RPC version also carries the shared response-cache misses and the running log index in
receipts, both unrelated to admission). The same tails were attached throughout.

| run | achieved | n | ok | access refusals | 429 "Rate limit exceeded" | errors | p50 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 21:58 (`after/report.md`) | 429 req/s | 23,416 | 22,711 | 0 | **0** | 600 client timeouts | 278ms | 40s (client) |
| 22:00 (`after-2/report.md`) | 2,198 req/s | 44,784 | 44,514 | 0 | **0** | 0 | 199ms | 1.73s |

The "refused" column of both reports (105 and 270) is the eth_estimateGas "insufficient funds"
answers of the user mix, as in every run; no request was refused by access. The second run,
2,198 req/s achieved, is the highest Scale rate served so far and had no error of any kind.

The first run's 600 errors were on the client, not the new admission path. They are exactly
the client's in-flight cap (600), all 13 methods of the mix in proportion, all at the client's
40s fetch timeout, and the last 600 samples to complete: the client's slots filled with stalled
connections in the minute after the deploy, which is also why it achieved 429 req/s and dropped
38,994 sends. The server did not hold them: Cloudflare's own numbers for the RPC Worker in the
21:58 minute are 23,387 requests (the client sent 23,416) with wall p50 7ms, p90 54ms, p99 1.3s;
600 requests held for 40s would be 2.6% of the minute, far above that p99. The lease path was
quiet too: every lease call in the window answered 200 within 1.5s, so the 8s lease timeout
never fired, and an internal line (5M credits reserved) never waits on a renewal. Two minutes
later the second run, same code, had no timeout at five times the rate.

Lease traffic (`after/tails.txt`, `after/app-analytics.txt`): 0 `lease_error` events in the
RPC tail for both runs (601 in the 21:42 reproduction); the app answered every lease call 200
(before: 387 D1 "overloaded" 500s). The app saw 539 + 152 + 579 requests in the three minutes
of the two runs, about 6 per second against 110 per second in the milestone's Scale minute,
with a burst of 126 first grants in the three seconds the second run's isolates started, one per
isolate, then one renewal per isolate per 30s. Lease wall time: p50 0.49 to 1.07s, p99 1.0 to
1.4s per minute (milestone: p50 6.6s, p99 28.5s); D1 writes 34 to 318 per minute (milestone:
6,664), since each line's usage is now reported once.
