#!/usr/bin/env node
// Rounds, keys and WebAssembly CPU of execution requests, measured locally: the executor's
// module (packages/executor/crate/pkg; `bun run --cwd packages/executor build` first) runs under
// Node with a state source over a node's JSON-RPC, so every dependent read round and every key
// is visible, and each `Session.run` (the EVM re-running over what it knows) is timed.
//
// `--hints` also runs each case the way apps/rpc's ChainStateSource feeds the executor: the
// touched state of nearby blocks (their pre-state from debug_traceBlockByNumber's prestateTracer,
// corrected by diffMode's post-values for the keys those blocks wrote) is handed to the executor
// before its first round, and the rounds that remain are counted.
//
//   node bench/rounds.mjs --chain 560048 --cases <json: [{label, method, params}…]> [--hints] [--depth 2]
//   node bench/rounds.mjs --chain 560048 --call '{"method":"eth_call","params":[{…},"latest"]}'
//
// `--state URL` is the node the state is read from (default: the chain's reference node in
// lib.mjs, which serves the tracers; the target endpoint only gives the head). `--out FILE`
// writes every case's rounds as JSON.

import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { initSync, Session } from "../packages/executor/crate/pkg/executor.js";
import { encodeRecord } from "../packages/executor/test/fixtures/encode.mjs";
import { fmtMs, hex, num, parseArgs, rpc, target } from "./lib.mjs";

// bench/ has no dependencies of its own: keccak comes from the executor package's.
const { keccak_256 } = await import(new URL("../packages/executor/node_modules/@noble/hashes/sha3.js", import.meta.url));

const args = parseArgs(process.argv.slice(2));
const t = target(args);
const STATE = String(args.state ?? t.ref ?? t.url);
const DEPTH = Number(args.depth ?? 2);
const CONFIGS = { 560048: "hoodi", 1: "mainnet" };
const configName = CONFIGS[t.chainId];
if (!configName) throw new Error(`no chain config for ${t.chainId} (packages/executor/test/fixtures)`);
const CHAIN = JSON.parse(readFileSync(new URL(`../packages/executor/test/fixtures/${configName}-config.json`, import.meta.url), "utf8"));
initSync({ module: new WebAssembly.Module(readFileSync(new URL("../packages/executor/crate/pkg/executor_bg.wasm", import.meta.url))) });

async function call(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await rpc(url, method, params, { timeoutMs: 120_000 });
    if (r.ok) return r.result;
    if (attempt < 6 && (r.http === 429 || r.http === 0 || r.http >= 500 || /rate|limit|busy|timeout/i.test(r.error.message))) {
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  }
}
const state = (method, params) => call(STATE, method, params);

const keccak = (code) => "0x" + Buffer.from(keccak_256(Buffer.from(code.slice(2), "hex"))).toString("hex");
const EMPTY_CODE_HASH = keccak("0x");
const slotHex = (s) => "0x" + BigInt(s).toString(16).padStart(64, "0");

const codes = new Map();
const records = new Map();
const blocks = new Map();
async function block(n) {
  if (!blocks.has(n)) blocks.set(n, state("eth_getBlockByNumber", [hex(n), true]));
  return blocks.get(n);
}
async function record(n) {
  if (!records.has(n)) {
    records.set(
      n,
      (async () => {
        const b = await block(n);
        const receipts = await state("eth_getBlockReceipts", [hex(n)]);
        const uncles = [];
        for (let i = 0; i < b.uncles.length; i++) uncles.push(await state("eth_getUncleByBlockNumberAndIndex", [hex(n), hex(i)]));
        return encodeRecord({ block: b, receipts, uncles });
      })(),
    );
  }
  return records.get(n);
}

/** One state value at the end of block `at`. */
async function remote(key, at) {
  const tag = hex(at);
  switch (key.kind) {
    case "account": {
      const [balance, nonce, code] = await Promise.all([state("eth_getBalance", [key.address, tag]), state("eth_getTransactionCount", [key.address, tag]), state("eth_getCode", [key.address, tag])]);
      if (BigInt(balance) === 0n && BigInt(nonce) === 0n && code === "0x") return null;
      let codeHash = null;
      if (code !== "0x") {
        codeHash = keccak(code);
        codes.set(codeHash, code);
      }
      return { kind: "account", nonce: Number(nonce), balance: hex(BigInt(balance)), codeHash };
    }
    case "storage":
      return { kind: "storage", value: hex(BigInt(await state("eth_getStorageAt", [key.address, key.slot, tag]))) };
    case "code": {
      let code = codes.get(key.hash);
      if (!code) {
        code = await state("debug_codeByHash", [key.hash]).catch(() => call(t.url, "debug_codeByHash", [key.hash]));
        if (!code) throw new Error(`unknown code ${key.hash}`);
        codes.set(key.hash, code);
      }
      return { kind: "code", code };
    }
    case "blockHash": {
      const b = await state("eth_getBlockByNumber", [hex(key.number), false]);
      return b ? { kind: "blockHash", hash: b.hash } : null;
    }
  }
  throw new Error("unknown key");
}

const keyId = (k) => (k.kind === "account" ? `a:${k.address.toLowerCase()}` : k.kind === "storage" ? `s:${k.address.toLowerCase()}:${slotHex(k.slot)}` : k.kind === "code" ? `c:${k.hash}` : `b:${k.number}`);

// ---- witness hints: the state at the end of block M for the keys blocks near M touched

const prestates = new Map();
function trace(n, diff) {
  const id = `${n}:${diff}`;
  if (!prestates.has(id)) prestates.set(id, state("debug_traceBlockByNumber", [hex(n), diff ? { tracer: "prestateTracer", tracerConfig: { diffMode: true } } : { tracer: "prestateTracer" }]));
  return prestates.get(id);
}

function accountValue(a) {
  let codeHash = null;
  if (a.code && a.code !== "0x") {
    codeHash = keccak(a.code);
    codes.set(codeHash, a.code);
  }
  const exists = codeHash !== null || (a.nonce ?? 0) !== 0 || BigInt(a.balance ?? "0x0") !== 0n;
  return exists ? { kind: "account", nonce: a.nonce ?? 0, balance: hex(BigInt(a.balance ?? "0x0")), codeHash } : null;
}

/** Applies a block's pre-state (first value per key) then, with `post`, what it wrote. */
function apply(into, traces, post) {
  const seen = new Set();
  for (const { result } of traces) {
    const pre = post ? result.pre : result;
    for (const [address, a] of Object.entries(pre)) {
      const id = `a:${address.toLowerCase()}`;
      if (!seen.has(id)) {
        seen.add(id);
        into.set(id, { key: { kind: "account", address }, value: accountValue(a) });
      }
      for (const [slot, value] of Object.entries(a.storage ?? {})) {
        const sid = `s:${address.toLowerCase()}:${slotHex(slot)}`;
        if (!seen.has(sid)) {
          seen.add(sid);
          into.set(sid, { key: { kind: "storage", address, slot: slotHex(slot) }, value: { kind: "storage", value: hex(BigInt(value)) } });
        }
      }
    }
  }
  if (!post) return;
  // The post-values: every key the block wrote, after its last transaction that wrote it.
  for (const { result } of traces) {
    for (const [address, a] of Object.entries(result.post)) {
      const id = `a:${address.toLowerCase()}`;
      const old = into.get(id)?.value;
      const merged = { balance: a.balance ?? old?.balance ?? "0x0", nonce: a.nonce ?? old?.nonce ?? 0, code: a.code ?? (old?.codeHash ? codes.get(old.codeHash) : undefined) };
      into.set(id, { key: { kind: "account", address }, value: accountValue(merged) });
      for (const [slot, value] of Object.entries(a.storage ?? {})) {
        into.set(`s:${address.toLowerCase()}:${slotHex(slot)}`, { key: { kind: "storage", address, slot: slotHex(slot) }, value: { kind: "storage", value: hex(BigInt(value)) } });
      }
    }
    // Accounts the block deleted appear in pre only.
    for (const address of Object.keys(result.pre)) if (!(address in result.post) && result.pre[address].balance !== undefined && Object.keys(result.pre[address]).length && !result.post[address]) {
      /* unchanged */
    }
  }
}

/** Hints for a call at block M: witnesses of M-depth+1 … M (corrected) and M+1 (exact), as {keys, values}. */
async function hints(M, head) {
  const into = new Map();
  const from = Math.max(1, M - DEPTH + 1);
  const t0 = performance.now();
  const corrected = await Promise.all(Array.from({ length: M - from + 1 }, (_, i) => Promise.all([trace(from + i, false), trace(from + i, true)])));
  for (const [pre, diff] of corrected) {
    apply(into, pre, false);
    apply(into, diff, true);
  }
  let exact = 0;
  if (M + 1 <= head) {
    const before = into.size;
    apply(into, await trace(M + 1, false), false);
    exact = into.size - before;
  }
  const keys = [];
  const values = [];
  for (const { key, value } of into.values()) {
    keys.push(key);
    values.push(value);
  }
  return { keys, values, blocks: `${from}..${M}${M + 1 <= head ? `+${M + 1}` : ""}`, exactNew: exact, ms: performance.now() - t0 };
}

// ---- the round loop, timed

async function run(request, seed) {
  const session = new Session(JSON.stringify(request));
  const rounds = [];
  const read = new Set();
  let input = seed ? JSON.stringify(seed) : "";
  let codeOf = 0;
  for (;;) {
    const t0 = performance.now();
    const out = JSON.parse(session.run(input));
    const wasm = performance.now() - t0;
    if (out.done) {
      const usage = Object.fromEntries(session.usage().split(";").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
      return { response: out.response, rounds, read: [...read], usage, lastWasm: wasm };
    }
    const t1 = performance.now();
    if (out.witness !== undefined) {
      const traces = await trace(out.witness, false);
      const into = new Map();
      apply(into, traces, false);
      const accounts = [];
      const storage = new Map();
      for (const { key, value } of into.values()) {
        if (key.kind === "account") accounts.push({ address: key.address, exists: value !== null, nonce: value?.nonce ?? 0, balance: value?.balance ?? "0x0", codeHash: value?.codeHash ?? null });
        else {
          const s = storage.get(key.address) ?? [];
          s.push({ slot: key.slot, value: value.value });
          storage.set(key.address, s);
        }
      }
      input = JSON.stringify({ witness: { accounts, storage: [...storage].map(([address, slots]) => ({ address, slots })) } });
      rounds.push({ wasm, io: performance.now() - t1, keys: { witness: into.size } });
      continue;
    }
    const kinds = { account: 0, storage: 0, code: 0, blockHash: 0 };
    for (const k of out.missing) kinds[k.kind]++;
    const values = [];
    for (let i = 0; i < out.missing.length; i += 8) values.push(...(await Promise.all(out.missing.slice(i, i + 8).map((key) => remote(key, out.at)))));
    // Code of accounts answered here travels with them (as apps/rpc's shell attaches it).
    const keys = [...out.missing];
    for (const [i, key] of out.missing.entries()) {
      read.add(keyId(key));
      const v = values[i];
      if (v?.kind === "account" && v.codeHash && v.codeHash !== EMPTY_CODE_HASH && !keys.some((k) => k.kind === "code" && k.hash === v.codeHash)) {
        keys.push({ kind: "code", hash: v.codeHash });
        values.push(await remote({ kind: "code", hash: v.codeHash }, out.at));
        codeOf++;
      }
    }
    input = JSON.stringify({ keys, values });
    rounds.push({ wasm, io: performance.now() - t1, keys: kinds, attached: codeOf });
    codeOf = 0;
  }
}

function summary(r) {
  const wasm = r.rounds.reduce((a, x) => a + x.wasm, 0) + r.lastWasm;
  const io = r.rounds.reduce((a, x) => a + x.io, 0);
  const keys = r.rounds.map((x) => Object.entries(x.keys).filter(([, n]) => n).map(([k, n]) => `${n}${k[0]}`).join("+")).join(" ");
  return { rounds: r.rounds.length, wasm, io, keys, usage: r.usage };
}

// ---- cases

let cases;
if (args.call) cases = [{ label: "call", ...JSON.parse(String(args.call)) }];
else if (args.cases) cases = JSON.parse(readFileSync(String(args.cases), "utf8")).filter((c) => Array.isArray(c.params) && (!args.filter || new RegExp(String(args.filter)).test(c.label)));
else throw new Error("--cases FILE or --call JSON");
const BLOCK_PARAM = { eth_call: 1, eth_estimateGas: 1, eth_createAccessList: 1, debug_traceCall: 1, trace_call: 2 };
const BY_TX = new Set(["debug_traceTransaction", "trace_transaction", "trace_replayTransaction"]);
const BY_BLOCK = new Set(["debug_traceBlockByNumber", "debug_traceBlockByHash", "trace_block", "trace_replayBlockTransactions"]);

const head = num(await call(t.url, "eth_blockNumber", []));
console.log(`target ${t.url} head ${head}; state from ${STATE}`);
const results = [];
for (const c of cases) {
  // The block the request runs on: a call's block parameter, a traced transaction's block, or
  // the traced block itself (mined-transaction traces take the block's witness in a round).
  let M;
  let txIndex;
  if (BY_TX.has(c.method)) {
    const tx = await state("eth_getTransactionByHash", [c.params[0]]);
    if (!tx?.blockNumber) throw new Error(`${c.label}: transaction not found`);
    M = num(tx.blockNumber);
    txIndex = num(tx.transactionIndex);
  } else if (BY_BLOCK.has(c.method)) {
    const tag = c.params[0];
    M = typeof tag === "string" && tag.length === 66 ? num((await state("eth_getBlockByHash", [tag, false])).number) : tag === "latest" ? head : num(tag);
  } else {
    const at = BLOCK_PARAM[c.method];
    if (at === undefined) {
      console.log(`${c.label}: ${c.method} is not served by the executor, skipped`);
      continue;
    }
    const tag = c.params[at] ?? "latest";
    M = tag === "latest" || tag === "pending" ? head : num(tag);
  }
  const rec = await record(M);
  const request = { method: c.method, params: c.params, chain: CHAIN, block: rec, ...(txIndex === undefined ? {} : { txIndex }) };
  const plain = await run(request, null);
  const s = summary(plain);
  const line = (name, s, extra = "") => console.log(`${c.label} @${M} ${name}: rounds ${s.rounds}, wasm ${fmtMs(s.wasm)}, io ${fmtMs(s.io)}, executions ${s.usage.executions ?? "?"}, executed gas ${s.usage.executed_gas ?? "?"}, keys per round [${s.keys}]${extra}`);
  line("plain", s, "error" in plain.response ? ` -> error ${plain.response.error.code} ${String(plain.response.error.message).slice(0, 60)}` : "");
  const entry = { label: c.label, method: c.method, block: M, plain: { ...s, response: plain.response, read: plain.read.length, keys: plain.read } };
  if (args.hints && !BY_TX.has(c.method) && !BY_BLOCK.has(c.method)) {
    const h = await hints(M, head).catch((e) => (console.log(`  (no hints: ${e.message})`), null));
    if (!h) {
      results.push(entry);
      continue;
    }
    const have = new Set(h.keys.map(keyId));
    const covered = plain.read.filter((k) => have.has(k)).length;
    const hinted = await run(request, { keys: h.keys, values: h.values });
    const hs = summary(hinted);
    line("hinted", hs, ` | hints ${h.keys.length} keys from ${h.blocks} (${h.exactNew} exact-only) cover ${covered}/${plain.read.length} of the plain run's keys; trace fetch ${fmtMs(h.ms)}`);
    if (JSON.stringify(hinted.response) !== JSON.stringify(plain.response)) console.log(`  !! hinted answer differs: ${JSON.stringify(hinted.response).slice(0, 200)}`);
    entry.hinted = { ...hs, hints: h.keys.length, covered, of: plain.read.length, blocks: h.blocks };
  }
  results.push(entry);
}
if (args.out) writeFileSync(String(args.out), JSON.stringify(results, null, 1));
