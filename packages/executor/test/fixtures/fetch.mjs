// Builds the end-to-end fixtures from Hoodi through a public RPC (default https://hoodi.drpc.org),
// one zstd JSON file per block:
//   record    the block record (docs/storage.md, "Block records"), RLP hex
//   witness   the block's pre-state, synthesized from debug_traceBlockByNumber's prestateTracer
//             (each key's value at the first transaction that touched it)
//   reads     state the executor read beyond the witness, by block: recorded by running the
//             executor (crate/pkg, build it first) against the RPC (eth_getBalance and friends)
//   code      bytecode by hash
//   cases     requests (as the RPC Worker passes them) with the reference answers: drpc balances
//             requests over backends of different versions, so each request is asked five
//             times and every distinct answer is kept (`expected`, a list). drpc refuses the
//             default struct logger; those cases use a public Nethermind node (`reference`).
// Run: node test/fixtures/fetch.mjs [rpc-url]   (after `sh scripts/build.sh`)
//      node test/fixtures/fetch.mjs --fill       keeps every fixture's cases and reference
//                                                answers, and records only the reads the
//                                                current executor makes beyond what is stored
//                                                (after a change to what it asks for)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { initSync, Session } from "../../crate/pkg/executor.js";
import { encodeRecord, canonicalKey } from "./encode.mjs";

const FILL = process.argv.includes("--fill");
const urls = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const RPCS = { hoodi: urls[0] ?? "https://hoodi.drpc.org", mainnet: urls[1] ?? "https://eth.drpc.org" };
let RPC = RPCS.hoodi;
const STRUCT_LOG_RPC = "https://rpc.hoodi.ethpandaops.io";
const DIR = new URL("./", import.meta.url);
const configs = { hoodi: JSON.parse(readFileSync(new URL("hoodi-config.json", DIR), "utf8")), mainnet: JSON.parse(readFileSync(new URL("mainnet-config.json", DIR), "utf8")) };
initSync({ module: new WebAssembly.Module(readFileSync(new URL("../../crate/pkg/executor_bg.wasm", import.meta.url))) });

let id = 0;
async function rpc(method, params, url = RPC) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const body = await res.json();
      if (body.error && /rate|limit|timeout|busy|temporar/i.test(body.error.message) && attempt < 5) throw new Error(body.error.message);
      return body;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}
async function result(method, params) {
  const body = await rpc(method, params);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
/** The reference answers as ExecResponses (distinct answers of five requests). */
async function reference(method, params, url) {
  const answers = [];
  for (let i = 0; i < 5; i++) {
    const body = await rpc(method, params, url);
    const answer = body.error ? { error: body.error } : { result: body.result };
    if (!answers.some((a) => JSON.stringify(a) === JSON.stringify(answer))) answers.push(answer);
  }
  return answers;
}

const hex = (n) => "0x" + n.toString(16);
const keccak = (code) => "0x" + Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex");
const EMPTY = keccak("0x");

/** Witness from per-transaction prestates: the first value seen for each key. */
function witness(prestates, codes) {
  const accounts = new Map();
  const storage = new Map();
  for (const { result: pre } of prestates) {
    for (const [address, a] of Object.entries(pre)) {
      if (!accounts.has(address)) {
        let codeHash = null;
        if (a.code && a.code !== "0x") {
          codeHash = keccak(a.code);
          codes[codeHash] = a.code;
        }
        // The prestate tracer lists accounts a transaction creates with zero values: they
        // did not exist (no empty accounts exist after EIP-161).
        const exists = codeHash !== null || (a.nonce ?? 0) !== 0 || BigInt(a.balance ?? "0x0") !== 0n;
        accounts.set(address, { address, exists, nonce: a.nonce ?? 0, balance: a.balance ?? "0x0", codeHash });
      }
      for (const [slot, value] of Object.entries(a.storage ?? {})) {
        const slots = storage.get(address) ?? new Map();
        if (!slots.has(slot)) slots.set(slot, "0x" + BigInt(value).toString(16));
        storage.set(address, slots);
      }
    }
  }
  return {
    accounts: [...accounts.values()],
    storage: [...storage].map(([address, slots]) => ({ address, slots: [...slots].map(([slot, value]) => ({ slot, value })) })),
  };
}

/** One state value at the end of block `at`, from the RPC. */
async function remote(key, at, codes) {
  const tag = hex(at);
  switch (key.kind) {
    case "account": {
      const [balance, nonce, code] = await Promise.all([
        result("eth_getBalance", [key.address, tag]),
        result("eth_getTransactionCount", [key.address, tag]),
        result("eth_getCode", [key.address, tag]),
      ]);
      if (BigInt(balance) === 0n && BigInt(nonce) === 0n && code === "0x") return null;
      let codeHash = null;
      if (code !== "0x") {
        codeHash = keccak(code);
        codes[codeHash] = code;
      }
      return { kind: "account", nonce: Number(nonce), balance: hex(BigInt(balance)), codeHash };
    }
    case "storage":
      return { kind: "storage", value: hex(BigInt(await result("eth_getStorageAt", [key.address, key.slot, tag]))) };
    case "code":
      if (!codes[key.hash]) throw new Error(`unknown code ${key.hash}`);
      return { kind: "code", code: codes[key.hash] };
    case "blockHash": {
      const b = await result("eth_getBlockByNumber", [hex(key.number), false]);
      return b ? { kind: "blockHash", hash: b.hash } : null;
    }
  }
  throw new Error("unknown key");
}

/** Runs the executor on `request`, recording every state read it makes. */
async function record(request, fixture) {
  const session = new Session(JSON.stringify(request));
  let input = "";
  for (;;) {
    const out = JSON.parse(session.run(input));
    if (out.done) return out.response;
    if (out.witness !== undefined) {
      input = JSON.stringify({ witness: fixture.witness });
      continue;
    }
    const reads = (fixture.reads[out.at] ??= {});
    const values = [];
    for (let i = 0; i < out.missing.length; i += 16) {
      values.push(
        ...(await Promise.all(
          out.missing.slice(i, i + 16).map(async (key) => {
            const k = canonicalKey(key);
            if (key.kind === "code") return remote(key, out.at, fixture.code);
            if (!(k in reads)) reads[k] = await remote(key, out.at, fixture.code);
            return reads[k];
          }),
        )),
      );
    }
    input = JSON.stringify({ keys: out.missing, values });
  }
}

/** Calls replaying a block transaction (`from`, `to`, `input`, `value`) at the block's end. */
function callOf(tx) {
  const call = { from: tx.from, input: tx.input };
  if (tx.to) call.to = tx.to;
  if (BigInt(tx.value) !== 0n) call.value = tx.value;
  return call;
}

const PLANS = [
  {
    chain: "hoodi",
    number: 3780608,
    traces: [
      [2, { tracer: "callTracer" }],
      [2, { tracer: "prestateTracer" }],
      [2, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
      [3, { tracer: "callTracer", tracerConfig: { withLog: true } }],
      [4, { tracer: "callTracer" }],
      [7, { tracer: "prestateTracer" }],
      [18, {}],
      [18, { enableMemory: true, enableReturnData: true }],
      [19, { enableMemory: true }],
      [12, { tracer: "callTracer" }],
    ],
    parity: [2, 3, 4, 7, 19],
    replay: [[3, ["trace", "stateDiff"]]],
    block: [{ tracer: "callTracer" }],
    traceBlock: true,
    calls: [2, 3, 7, 18, 19, 4],
    replayBlock: [["trace"], ["stateDiff"]],
    traceCalls: [2, 3],
  },
  {
    chain: "hoodi",
    number: 3780610,
    traces: [
      [1, { tracer: "callTracer" }],
      [1, {}],
      [19, { tracer: "prestateTracer" }],
      [18, { tracer: "callTracer" }],
    ],
    parity: [1, 19],
    replay: [],
    block: [],
    traceBlock: false,
    calls: [1, 19],
    replayBlock: [],
    traceCalls: [19],
  },
  // Mainnet before the Merge: Spurious Dragon with an uncle (block and uncle rewards), and the
  // DAO fork block (its irregular state change runs before the transactions).
  {
    chain: "mainnet",
    number: 4000014,
    traces: [
      [0, { tracer: "callTracer" }],
      [1, { tracer: "prestateTracer" }],
      [2, { tracer: "callTracer" }],
    ],
    parity: [0, 2],
    replay: [[1, ["trace", "stateDiff"]]],
    block: [{ tracer: "callTracer" }],
    traceBlock: true,
    calls: [0, 2],
    replayBlock: [],
    traceCalls: [],
  },
  {
    chain: "mainnet",
    number: 1920000,
    traces: [[0, { tracer: "callTracer" }]],
    parity: [],
    replay: [],
    block: [{ tracer: "prestateTracer" }],
    traceBlock: true,
    calls: [],
    replayBlock: [["stateDiff"]],
    traceCalls: [],
  },
];

if (FILL) {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json.zst"))) {
    const fixture = JSON.parse(zstdDecompressSync(readFileSync(new URL(file, DIR))).toString());
    RPC = RPCS[fixture.chain];
    const base = { chain: configs[fixture.chain], block: fixture.record };
    const before = Object.values(fixture.reads).reduce((n, r) => n + Object.keys(r).length, 0);
    for (const c of fixture.cases) {
      const got = await record({ ...base, ...c.request }, fixture);
      const same = c.expected.some((e) => JSON.stringify(e) === JSON.stringify(got));
      if (!same) console.log(file, c.request.method, c.request.txIndex ?? "", "DIFFERENT", JSON.stringify(got).slice(0, 120));
    }
    const after = Object.values(fixture.reads).reduce((n, r) => n + Object.keys(r).length, 0);
    console.log(file, `${after - before} reads added (${after} total)`);
    writeFileSync(new URL(file, DIR), zstdCompressSync(Buffer.from(JSON.stringify(fixture))));
  }
  process.exit(0);
}

for (const plan of PLANS) {
  RPC = RPCS[plan.chain];
  const chain = configs[plan.chain];
  const tag = hex(plan.number);
  const block = await result("eth_getBlockByNumber", [tag, true]);
  const receipts = await result("eth_getBlockReceipts", [tag]);
  const uncles = [];
  for (let i = 0; i < block.uncles.length; i++) uncles.push(await result("eth_getUncleByBlockNumberAndIndex", [tag, hex(i)]));
  const prestates = await result("debug_traceBlockByNumber", [tag, { tracer: "prestateTracer" }]);
  const fixture = { chain: plan.chain, number: plan.number, record: encodeRecord({ block, receipts, uncles }), witness: null, reads: {}, code: {}, cases: [] };
  fixture.witness = witness(prestates, fixture.code);
  const base = { chain, block: fixture.record };
  const cases = [];
  for (const [index, options] of plan.traces) {
    const hash = block.transactions[index].hash;
    const params = Object.keys(options).length ? [hash, options] : [hash];
    cases.push({ request: { method: "debug_traceTransaction", params, txIndex: index } });
  }
  for (const index of plan.parity) {
    cases.push({ request: { method: "trace_transaction", params: [block.transactions[index].hash], txIndex: index } });
  }
  for (const [index, types] of plan.replay) {
    cases.push({ request: { method: "trace_replayTransaction", params: [block.transactions[index].hash, types], txIndex: index } });
  }
  for (const options of plan.block) cases.push({ request: { method: "debug_traceBlockByNumber", params: [tag, options] } });
  if (plan.traceBlock) cases.push({ request: { method: "trace_block", params: [tag] } });
  for (const types of plan.replayBlock) cases.push({ request: { method: "trace_replayBlockTransactions", params: [tag, types] } });
  for (const index of plan.traceCalls) {
    // Explicit gas: drpc's gas cap (600M) is not geth's default (50M, which the executor
    // applies). `data` too: drpc's trace_call backend reads only `data`.
    const call = { ...callOf(block.transactions[index]), gas: "0x2faf080" };
    call.data = call.input;
    cases.push({ request: { method: "debug_traceCall", params: [call, tag, { tracer: "callTracer" }] } });
    cases.push({ request: { method: "debug_traceCall", params: [call, tag, { tracer: "prestateTracer" }] } });
    cases.push({ request: { method: "trace_call", params: [call, ["trace"], tag] } });
    // State overrides: the sender with 1000 ether more.
    const overrides = { [call.from]: { balance: "0x3635c9adc5dea00000" } };
    cases.push({ request: { method: "eth_call", params: [call, tag, overrides] } });
  }
  for (const index of plan.calls) {
    const call = callOf(block.transactions[index]);
    cases.push({ request: { method: "eth_call", params: [call, tag] } });
    cases.push({ request: { method: "eth_estimateGas", params: [call, tag] } });
    cases.push({ request: { method: "eth_createAccessList", params: [call, tag] } });
  }
  for (const c of cases) {
    const structLogger = c.request.method === "debug_traceTransaction" && !c.request.params[1]?.tracer;
    if (structLogger) c.reference = "nethermind";
    // The struct logger reference wants the options argument.
    const params = structLogger && c.request.params.length === 1 ? [...c.request.params, {}] : c.request.params;
    c.expected = await reference(c.request.method, params, structLogger ? STRUCT_LOG_RPC : RPC);
    const got = await record({ ...base, ...c.request }, fixture);
    const same = c.expected.some((e) => JSON.stringify(e) === JSON.stringify(got));
    console.log(plan.number, c.request.method, c.request.txIndex ?? "", JSON.stringify(c.request.params.slice(1)).slice(0, 80), same ? "same" : "DIFFERENT", c.expected.length);
    fixture.cases.push(c);
  }
  writeFileSync(new URL(`${plan.chain}-${plan.number}.json.zst`, DIR), zstdCompressSync(Buffer.from(JSON.stringify(fixture))));
}
