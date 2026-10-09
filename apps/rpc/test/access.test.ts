import { describe, expect, test } from "vitest";
import { deriveKey } from "../../app/src/keys";
import { credits, estimate } from "../src/access/credits";
import { caller, clientBlock, clientNet, verifyKey } from "../src/access/identity";
import { Ledger, type AccessApi } from "../src/access/ledger";
import { takePublic } from "../src/access/rate";
import worker from "../src/index";
import { buildArchive, PREFIX } from "./archive";
import { fixtures } from "./encode";

const SECRET = "test-key-secret";
const ID = "00112233445566778899aabbccddeeff";

describe("keys", () => {
  test("a key derived by the app verifies to its id", async () => {
    const key = await deriveKey(SECRET, ID);
    expect(await verifyKey(SECRET, key)).toBe(ID);
  });
  test("a tampered, foreign or malformed key is refused", async () => {
    const key = await deriveKey(SECRET, ID);
    const flipped = key.slice(0, 20) + (key[20] === "A" ? "B" : "A") + key.slice(21);
    expect(await verifyKey(SECRET, flipped)).toBeNull();
    expect(await verifyKey("other-secret", key)).toBeNull();
    expect(await verifyKey(SECRET, key.slice(0, -1))).toBeNull();
    expect(await verifyKey(SECRET, "nr_" + "!".repeat(43))).toBeNull();
  });
});

describe("client networks", () => {
  test("IPv4 is the address, IPv6 the /64; blocks are /24 and /48", () => {
    expect(clientNet("203.0.113.7")).toBe("203.0.113.7");
    expect(clientNet("2001:db8:0:1:aaaa::1")).toBe("2001:db8:0:1::/64");
    expect(clientNet("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(clientBlock("203.0.113.7")).toBe("203.0.113.0/24");
    expect(clientBlock("2001:db8:1:2::1")).toBe("2001:db8:1::/48");
  });
  test("only keyed hashes leave identity: no raw address in subject, net or block", async () => {
    const req = new Request("https://eth.nullrpc.dev/", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    const c = await caller(SECRET, req, null);
    expect(c.subject).toMatch(/^anon:[0-9a-f]{32}$/);
    expect(c.block).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify({ subject: c.subject, net: c.net, block: c.block })).not.toContain("203.0.113");
  });
});

describe("credits", () => {
  test("methods are priced from the app's table; unknown and malformed calls", () => {
    expect(credits("eth_chainId", [])).toBe(5);
    expect(credits("eth_getBlockByNumber", [])).toBe(20);
    expect(credits("eth_somethingNew", [])).toBe(20);
    expect(credits("eth_getBlockByNumber", [], -32602)).toBe(20);
    expect(credits("eth_nope", [], -32601)).toBe(5);
    expect(credits(undefined, undefined)).toBe(5);
  });
  test("getLogs by range: base up to 1,000 blocks, +5 per started 1,000", () => {
    expect(credits("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x3e8" }])).toBe(50);
    expect(credits("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x3e9" }])).toBe(55);
    expect(credits("eth_getLogs", [{ blockHash: "0x" + "00".repeat(32) }])).toBe(50);
    expect(credits("eth_getLogs", [{ fromBlock: "latest" }])).toBe(50);
  });
  test("the estimate is the worst case of the batch, at least 5", () => {
    expect(estimate([{ method: "eth_chainId" }, { method: "eth_getLogs" }])).toBe(5 + 95);
    expect(estimate([])).toBe(5);
  });
});

describe("keyless bucket", () => {
  test("bursts 20, then refills at 10 per second", () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(takePublic("198.51.100.1", t)).toBe(true);
    expect(takePublic("198.51.100.1", t)).toBe(false);
    expect(takePublic("198.51.100.1", t + 100)).toBe(true);
    expect(takePublic("198.51.100.2", t)).toBe(true);
  });
});

/** A fake account app: records lease calls and answers with a scripted grant. */
function fakeApp(grant: (line: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Record<string, unknown>[][] = [];
  let failing = false;
  const app: AccessApi & { calls: typeof calls; fail(on: boolean): void } = {
    calls,
    fail(on) {
      failing = on;
    },
    async fetch(request: Request) {
      if (failing) return new Response("down", { status: 500 });
      const body = (await request.json()) as { lines: Record<string, unknown>[] };
      calls.push(body.lines);
      return Response.json({ lines: body.lines.map(grant) });
    },
  };
  return app;
}

const anon = { subject: "anon:aa", keyed: false, net: "aa", rateKey: "1.2.3.4", block: "bb", asn: 1 };
const keyed = { subject: `key:${ID}`, keyed: true, net: "aa", rateKey: "1.2.3.4" };

describe("ledger", () => {
  test("first request renews synchronously; later ones are served from the lease", async () => {
    const app = fakeApp(() => ({ status: "active", plan: "public", rps: 10, lease: "L1", reserved: 1000, ttl_ms: 60_000 }));
    const ledger = new Ledger(app);
    const a = await ledger.admit(anon, 20);
    expect(a.ok).toBe(true);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]![0]).toMatchObject({ subject: "anon:aa", need: 20, used: 0, net: "aa", block: "bb", asn: 1 });
    if (a.ok) ledger.settle(a.line, 20, 15);
    const b = await ledger.admit(anon, 20);
    expect(b.ok).toBe(true);
    expect(app.calls).toHaveLength(1);
  });

  test("served credits are reported once the line is due, idempotently", async () => {
    const app = fakeApp((l) => ({ status: "active", plan: "free", rps: 20, lease: "L1", reserved: 1000, ttl_ms: 60_000, _echo: l }));
    const ledger = new Ledger(app);
    const a = await ledger.admit(keyed, 20);
    if (!a.ok) throw new Error("refused");
    ledger.settle(a.line, 20, 15);
    await ledger.renewDue(Date.now() + 31_000);
    expect(app.calls).toHaveLength(2);
    expect(app.calls[1]![0]).toMatchObject({ subject: `key:${ID}`, lease: "L1", used: 15, requests: 1, total: 15, requests_total: 1 });
  });

  test("a refusal is cached and returned before the body is read", async () => {
    const app = fakeApp(() => ({ status: "exhausted", lease: null, reserved: 0, ttl_ms: 60_000 }));
    const ledger = new Ledger(app);
    const a = await ledger.admit(anon, 20);
    expect(a).toEqual({ ok: false, status: "exhausted" });
    expect(ledger.refusal(anon)).toBe("exhausted");
  });

  test("when the app is down, a bounded amount is served (fail soft), then busy", async () => {
    const app = fakeApp(() => ({ status: "active", lease: "L", reserved: 1000, ttl_ms: 60_000 }));
    app.fail(true);
    const ledger = new Ledger(app);
    let served = 0;
    for (let i = 0; i < 2000; i++) {
      const r = await ledger.admit(anon, 20);
      if (!r.ok) break;
      ledger.settle(r.line, 20, 20);
      served += 20;
    }
    expect(served).toBe(20_000);
  });
});

describe("worker with access", () => {
  const OBJECTS = buildArchive(fixtures().slice(-2));
  function bucket(): R2Bucket {
    return {
      async get(key: string, opts?: { range?: { offset: number; length: number } }) {
        const o = OBJECTS.get(key);
        if (!o) return null;
        const b = opts?.range ? o.slice(opts.range.offset, opts.range.offset + opts.range.length) : o;
        return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
      },
    } as unknown as R2Bucket;
  }
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const app = fakeApp(() => ({ status: "active", plan: "builder", account: "0xabc", rps: 250, limiter: false, lease: "L", reserved: 100_000, ttl_ms: 60_000 }));
  const env = { ARCHIVE: bucket(), ARCHIVE_PREFIX: PREFIX, CHAIN_ID: "1", ACCESS: "keys", KEY_SECRET: SECRET, APP: app };
  const post = (path: string, body: unknown, ip = "192.0.2.10") =>
    worker.fetch(new Request(`https://eth.nullrpc.dev${path}`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify(body) }), env, ctx);

  test("an invalid key is 401 -32001 with no lease call", async () => {
    const res = await post("/nr_" + "A".repeat(43), { jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect(app.calls).toHaveLength(0);
  });

  test("a valid key is served and leases credits for its subject", async () => {
    const key = await deriveKey(SECRET, ID);
    const res = await post(`/${key}`, [{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(2);
    expect(app.calls.at(-1)![0]).toMatchObject({ subject: `key:${ID}`, need: 15 });
  });

  test("keyless clients are limited per network: 20 burst, then 429 -32005", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) last = await post("/", { jsonrpc: "2.0", id: i, method: "eth_chainId" }, "192.0.2.99");
    expect(last!.status).toBe(429);
    expect(last!.headers.get("retry-after")).toBe("1");
  });

  test("an oversized body is 413", async () => {
    const res = await post("/", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: ["x".repeat(300_000)] }, "192.0.2.50");
    expect(res.status).toBe(413);
  });
});
