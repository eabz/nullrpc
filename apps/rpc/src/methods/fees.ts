// Fee methods, from served headers and receipts (ported from the exe Worker, which matched
// go-ethereum and Erigon):
//
//   eth_feeHistory            base fees, gas used ratios, blob fees and reward percentiles
//   eth_maxPriorityFeePerGas  go-ethereum's gas price oracle with full-node defaults: the 60th
//                             percentile of the three lowest effective tips (≥ 2 wei, not sent by
//                             the fee recipient) of each of the latest 20 blocks
//   eth_gasPrice              that tip plus the latest base fee
//   eth_blobBaseFee           the latest block's blob base fee
//
// Every method reads a few fields of each block and, for the oracle and reward percentiles, the
// effective tip of every transaction: the block's fee inputs (FeeInputs). They are fixed by the
// block's hash, so once computed from a record they are kept per isolate and per data center
// under that hash, and a block whose hash the request knows without reading it (the pinned
// head's listing of the live window, the archive's offsets) costs no record read. On a chain
// with large blocks every new head would otherwise read and decode the oracle's whole window
// of 20 records for one answer; now it reads one, the head's.

import { Lru } from "../archive/lru";
import type { Chain } from "../chain";
import { data, parseQuantity, quantity, toBigInt } from "../eth/hex";
import { effectiveGasPrice } from "../eth/tx";
import type { BlockRecord } from "../eth/record";
import { blockRef, invalidParams, RpcError, type EdgeCache, type Handler, type MethodEnv } from "../rpc";
import { bytes } from "../eth/rlp";

const MAX_BLOCKS = 256;
const MAX_PERCENTILES = 100;
const GAS_PER_BLOB = 1n << 17n;
const BLOB_BASE_COST = 1n << 13n;
const SLOT_SECONDS = 12;

// Gas price oracle (go-ethereum eth/gasprice defaults).
const CHECK_BLOCKS = 20;
const PERCENTILE = 60;
const SAMPLES_PER_BLOCK = 3;
const IGNORE_PRICE = 2n;
const MAX_PRICE = 500_000_000_000n;
/** Geth's default miner tip (0.001 gwei), used for blocks without samples. */
const DEFAULT_PRICE = 1_000_000n;

/** The header fields the fee math reads. */
interface Header {
  number: number;
  timestamp: number;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFee: bigint | null;
  blobGasUsed: bigint | null;
  excessBlobGas: bigint | null;
}

/**
 * What the fee methods read of one block, fixed by its hash: its header fields, the oracle's
 * samples (the lowest effective tips of at least IGNORE_PRICE not paid by the fee recipient,
 * ascending, at most SAMPLES_PER_BLOCK) and every transaction's effective tip with its gas
 * used, sorted by tip, which the reward percentiles walk.
 */
export interface FeeInputs extends Header {
  /** 0x-prefixed lowercase. */
  hash: string;
  samples: bigint[];
  weighted: [bigint, bigint][];
}

const byTip = (a: { tip: bigint }, b: { tip: bigint }) => (a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0);

function inputsOf(rec: BlockRecord): FeeInputs {
  const f = rec.block.header.fields;
  const opt = (i: number) => (f.length > i ? toBigInt(bytes(f[i])) : null);
  const baseFee = rec.block.header.baseFee;
  const miner = data(bytes(f[2]));
  let previous = 0n;
  const txs = rec.block.txs.map((tx, i) => {
    const cumulative = rec.receipts[i]!.cumulativeGasUsed;
    const gas = cumulative - previous;
    previous = cumulative;
    return { tip: effectiveGasPrice(tx, baseFee) - (baseFee ?? 0n), gas, sender: rec.senders[i]! };
  });
  txs.sort(byTip);
  return {
    hash: data(rec.block.header.hash),
    number: rec.block.header.number,
    timestamp: rec.block.header.timestamp,
    gasUsed: toBigInt(bytes(f[10])),
    gasLimit: toBigInt(bytes(f[9])),
    baseFee,
    blobGasUsed: opt(17),
    excessBlobGas: opt(18),
    samples: txs
      .filter((t) => t.tip >= IGNORE_PRICE && data(t.sender) !== miner)
      .slice(0, SAMPLES_PER_BLOCK)
      .map((t) => t.tip),
    weighted: txs.map((t) => [t.tip, t.gas]),
  };
}

// ---- the inputs cache: per isolate by hash, and per data center as JSON

/** Blocks whose inputs the isolate keeps: the oracle's window twice over, and eth_feeHistory's longest range. */
export const FEE_INPUTS_ENTRIES = 512;
/** Seconds an entry stays in the edge cache; it is immutable per hash and simply goes unused after a reorg. */
export const FEE_INPUTS_TTL_S = 86_400;
/** Bump when FeeInputs or its JSON changes. */
const FEE_INPUTS_VERSION = "v1";

/** One per isolate, shared by every request. Exported for tests. */
export const feeInputs = new Lru<string, FeeInputs>(FEE_INPUTS_ENTRIES);

/** The synthetic URL a block's inputs are cached under at the edge. */
export function feeInputsUrl(origin: string, chainId: number, hash: string): string {
  return `${origin}/_cache/fees/${FEE_INPUTS_VERSION}/${chainId}/${hash}`;
}

const big = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? BigInt(v) : null);
const bigOrNull = (v: unknown): bigint | null | undefined => (v === null ? null : (big(v) ?? undefined));
const hexOrNull = (v: bigint | null) => (v === null ? null : quantity(v));

function encodeInputs(b: FeeInputs): string {
  return JSON.stringify({
    n: b.number,
    t: b.timestamp,
    gu: quantity(b.gasUsed),
    gl: quantity(b.gasLimit),
    bf: hexOrNull(b.baseFee),
    bg: hexOrNull(b.blobGasUsed),
    eb: hexOrNull(b.excessBlobGas),
    s: b.samples.map(quantity),
    w: b.weighted.map(([tip, gas]) => [quantity(tip), quantity(gas)]),
  });
}

/** The inputs an edge entry holds, or null when it is damaged (then a miss, overwritten by the fresh computation). */
function decodeInputs(raw: unknown, hash: string): FeeInputs | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const gasUsed = big(o.gu);
  const gasLimit = big(o.gl);
  const baseFee = bigOrNull(o.bf);
  const blobGasUsed = bigOrNull(o.bg);
  const excessBlobGas = bigOrNull(o.eb);
  if (!Number.isSafeInteger(o.n) || !Number.isSafeInteger(o.t) || gasUsed === null || gasLimit === null) return null;
  if (baseFee === undefined || blobGasUsed === undefined || excessBlobGas === undefined) return null;
  if (!Array.isArray(o.s) || !Array.isArray(o.w)) return null;
  const samples: bigint[] = [];
  for (const v of o.s) {
    const tip = big(v);
    if (tip === null) return null;
    samples.push(tip);
  }
  const weighted: [bigint, bigint][] = [];
  for (const pair of o.w) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const tip = big(pair[0]);
    const gas = big(pair[1]);
    if (tip === null || gas === null) return null;
    weighted.push([tip, gas]);
  }
  return { hash, number: o.n as number, timestamp: o.t as number, gasUsed, gasLimit, baseFee, blobGasUsed, excessBlobGas, samples, weighted };
}

async function edgeRead(edge: EdgeCache, chainId: number, hash: string): Promise<FeeInputs | null> {
  try {
    const res = await edge.cache.match(feeInputsUrl(edge.origin, chainId, hash));
    return res ? decodeInputs(await res.json(), hash) : null;
  } catch {
    return null;
  }
}

function edgeWrite(edge: EdgeCache, chainId: number, b: FeeInputs): void {
  const res = new Response(encodeInputs(b), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${FEE_INPUTS_TTL_S}` } });
  edge.defer(edge.cache.put(feeInputsUrl(edge.origin, chainId, b.hash), res).catch(() => undefined));
}

/**
 * Block `n`'s fee inputs. When the request knows the block's hash without reading it, from the
 * isolate's entries, then the edge's; else, or when neither has them, computed from the record
 * (read as any method reads a block) and kept in both.
 */
async function inputs(chain: Chain, env: MethodEnv, n: number): Promise<FeeInputs> {
  const hash = await chain.hashOf(n);
  if (hash) {
    const kept = feeInputs.get(hash);
    if (kept) return kept;
    const shared = env.edge ? await edgeRead(env.edge, env.chainId, hash) : null;
    if (shared) {
      feeInputs.set(hash, shared);
      return shared;
    }
  }
  const computed = inputsOf(await mustBlock(chain, n));
  feeInputs.set(computed.hash, computed);
  if (env.edge) edgeWrite(env.edge, env.chainId, computed);
  return computed;
}

// ---- blob schedule (EIP-7840)

interface BlobParams {
  target: bigint;
  max: bigint;
  fraction: bigint;
}

const FORKS = ["cancun", "prague", "osaka", "bpo1", "bpo2", "amsterdam", "bpo3", "bpo4", "bpo5"];
const DEFAULTS: Record<string, BlobParams> = {
  cancun: { target: 3n, max: 6n, fraction: 3_338_477n },
  prague: { target: 6n, max: 9n, fraction: 5_007_716n },
};

export class BlobSchedule {
  private constructor(
    private readonly forks: [number, BlobParams][],
    private readonly osaka: number | null,
  ) {}

  static from(config: Record<string, unknown>): BlobSchedule {
    const forks: [number, BlobParams][] = [];
    const schedule = (config.blobSchedule ?? {}) as Record<string, { target?: number; max?: number; baseFeeUpdateFraction?: number }>;
    for (const name of FORKS) {
      const time = config[`${name}Time`];
      if (typeof time !== "number") continue;
      const e = schedule[name];
      const params = e && typeof e.target === "number" && typeof e.max === "number" && typeof e.baseFeeUpdateFraction === "number"
        ? { target: BigInt(e.target), max: BigInt(e.max), fraction: BigInt(e.baseFeeUpdateFraction) }
        : DEFAULTS[name];
      if (params) forks.push([time, params]);
    }
    forks.sort((a, b) => a[0] - b[0]);
    return new BlobSchedule(forks, typeof config.osakaTime === "number" ? config.osakaTime : null);
  }

  at(time: number): BlobParams | null {
    for (let i = this.forks.length - 1; i >= 0; i--) if (this.forks[i]![0] <= time) return this.forks[i]![1];
    return null;
  }

  /** baseFeePerBlobGas and blobGasUsedRatio of a block (zeros before Cancun). */
  block(h: Header): [bigint, number] {
    const p = this.at(h.timestamp);
    if (!p || h.excessBlobGas === null) return [0n, 0];
    return [fakeExponential(h.excessBlobGas, p.fraction), h.blobGasUsed === null ? 0 : Number(h.blobGasUsed) / Number(p.max * GAS_PER_BLOB)];
  }

  /** The blob base fee of the block after `parent` (the served successor's if given). */
  next(parent: Header, successor: Header | null): bigint {
    if (parent.excessBlobGas === null) return 0n;
    if (successor) return this.block(successor)[0];
    const time = parent.timestamp + SLOT_SECONDS;
    const p = this.at(time);
    if (!p) return 0n;
    const used = parent.blobGasUsed ?? 0n;
    const total = parent.excessBlobGas + used;
    const target = p.target * GAS_PER_BLOB;
    let excess = total < target ? 0n : total - target;
    if (total >= target && this.osaka !== null && time >= this.osaka) {
      // EIP-7918: the blob price never falls below the execution reserve.
      const reserve = (parent.baseFee ?? 0n) * BLOB_BASE_COST;
      const price = fakeExponential(parent.excessBlobGas, p.fraction) * GAS_PER_BLOB;
      if (reserve > price) excess = parent.excessBlobGas + (used * (p.max - p.target)) / (p.max > 0n ? p.max : 1n);
    }
    return fakeExponential(excess, p.fraction);
  }
}

/** EIP-4844 fake_exponential(1, numerator, denominator). */
export function fakeExponential(numerator: bigint, denominator: bigint): bigint {
  let output = 0n;
  let acc = denominator;
  for (let i = 1n; acc > 0n; i++) {
    output += acc;
    acc = (acc * numerator) / (denominator * i);
  }
  return output / denominator;
}

/** EIP-1559 base fee of the block after `parent` (elasticity 2, denominator 8). */
export function nextBaseFee(parent: Header): bigint | null {
  if (parent.baseFee === null) return null;
  const target = parent.gasLimit / 2n;
  if (parent.gasUsed === target || target === 0n) return parent.baseFee;
  if (parent.gasUsed > target) {
    const delta = (parent.baseFee * (parent.gasUsed - target)) / target / 8n;
    return parent.baseFee + (delta > 1n ? delta : 1n);
  }
  const delta = (parent.baseFee * (target - parent.gasUsed)) / target / 8n;
  return parent.baseFee > delta ? parent.baseFee - delta : 0n;
}

function rewards(b: FeeInputs, percentiles: number[]): string[] {
  const { weighted, gasUsed } = b;
  if (weighted.length === 0) return percentiles.map(() => "0x0");
  const out: string[] = [];
  let index = 0;
  let accumulated = weighted[0]![1];
  for (const p of percentiles) {
    const threshold = BigInt(Math.floor((Number(gasUsed) * p) / 100));
    while (accumulated < threshold && index + 1 < weighted.length) accumulated += weighted[++index]![1];
    out.push(quantity(weighted[index]![0]));
  }
  return out;
}

function blockCount(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string") {
    const n = /^0x/i.test(v) ? parseQuantity(v.toLowerCase()) : /^\d+$/.test(v) ? Number(v) : null;
    return n !== null && Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function parsePercentiles(v: unknown): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw invalidParams("rewardPercentiles must be an array");
  if (v.length > MAX_PERCENTILES) throw new RpcError(-32005, `at most ${MAX_PERCENTILES} percentiles`);
  let last = -1;
  return v.map((p) => {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100 || p <= last) throw invalidParams("percentiles must be increasing numbers from 0 to 100");
    return (last = p);
  });
}

async function mustBlock(chain: Chain, n: number): Promise<BlockRecord> {
  const rec = await chain.block(n);
  if (!rec) throw new RpcError(-32000, `block ${n} not found`);
  return rec;
}

async function readRange(chain: Chain, env: MethodEnv, from: number, to: number): Promise<FeeInputs[]> {
  const out: FeeInputs[] = [];
  for (let n = from; n <= to; n += 16) {
    const batch = await Promise.all(Array.from({ length: Math.min(16, to - n + 1) }, (_, i) => inputs(chain, env, n + i)));
    out.push(...batch);
  }
  return out;
}

async function schedule(chain: Chain): Promise<BlobSchedule> {
  return BlobSchedule.from(await chain.config());
}

// The oracle's answer is a function of the head block: the response cache keeps it per head
// (src/response-cache.ts), and the inputs cache makes recomputing it cheap.
async function suggestTip(chain: Chain, env: MethodEnv): Promise<{ tip: bigint; baseFee: bigint }> {
  const latest = chain.pointers().latest;
  const head = await inputs(chain, env, latest);
  const baseFee = head.baseFee ?? 0n;
  const lowest = Math.max(1, chain.pin.manifest.first_block);
  const sample = async (n: number) => [...(await inputs(chain, env, n)).samples];
  let next = latest;
  const pending: number[] = [];
  while (pending.length < CHECK_BLOCKS && next >= lowest) pending.push(next--);
  const results: bigint[] = [];
  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    const samples = await Promise.all(batch.map(sample));
    for (const values of samples) {
      if (values.length === 0) values.push(DEFAULT_PRICE);
      // Blocks yielding one value or none extend the sample, up to twice the blocks.
      if (values.length === 1 && results.length + 1 + pending.length < 2 * CHECK_BLOCKS && next >= lowest) pending.push(next--);
      results.push(...values);
    }
  }
  results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = results.length ? results[Math.floor(((results.length - 1) * PERCENTILE) / 100)]! : DEFAULT_PRICE;
  if (tip > MAX_PRICE) tip = MAX_PRICE;
  return { tip, baseFee };
}

export const FEE_METHODS: Record<string, Handler> = {
  eth_maxPriorityFeePerGas: async (chain, _params, env) => quantity((await suggestTip(chain, env)).tip),
  eth_gasPrice: async (chain, _params, env) => {
    const { tip, baseFee } = await suggestTip(chain, env);
    return quantity(tip + baseFee);
  },
  eth_blobBaseFee: async (chain, _params, env) => {
    const h = await inputs(chain, env, chain.pointers().latest);
    if (h.excessBlobGas === null) return null;
    return quantity((await schedule(chain)).block(h)[0]);
  },
  eth_feeHistory: async (chain, params, env) => {
    const count = blockCount(params[0]);
    if (count === null) throw invalidParams("blockCount must be a number");
    const percentiles = parsePercentiles(params[2]);
    if (count > MAX_BLOCKS) throw new RpcError(-32005, `at most ${MAX_BLOCKS} blocks per request`);
    if (params[1] === undefined) throw invalidParams("newestBlock required");
    const ref = blockRef(chain, params[1]);
    if (!("number" in ref)) throw invalidParams("newestBlock must be a number or tag");
    const newest = ref.number;
    if (count === 0) return { oldestBlock: "0x0", gasUsedRatio: null };
    const latest = chain.pointers().latest;
    const first = chain.pin.manifest.first_block;
    if (newest < first || newest > latest) throw new RpcError(-32000, "requested block is not available");
    const oldest = Math.max(first, newest - count + 1);
    const blocks = await readRange(chain, env, oldest, newest < latest ? newest + 1 : newest);
    const blobs = await schedule(chain);
    const base: string[] = [];
    const ratios: number[] = [];
    const blobFees: string[] = [];
    const blobRatios: number[] = [];
    const reward: string[][] = [];
    const span = newest - oldest + 1;
    for (let i = 0; i < span; i++) {
      const h = blocks[i]!;
      base.push(quantity(h.baseFee ?? 0n));
      ratios.push(Number(h.gasUsed) / Number(h.gasLimit));
      const [fee, ratio] = blobs.block(h);
      blobFees.push(quantity(fee));
      blobRatios.push(ratio);
      if (percentiles.length) reward.push(rewards(h, percentiles));
    }
    const last = blocks[span - 1]!;
    const successor = newest < latest ? blocks[span]! : null;
    if (successor) base.push(quantity(successor.baseFee ?? 0n));
    else {
      const next = nextBaseFee(last);
      if (next === null) throw new RpcError(-32000, "fee history before London needs a successor block");
      base.push(quantity(next));
    }
    blobFees.push(quantity(blobs.next(last, successor)));
    const out: Record<string, unknown> = { oldestBlock: quantity(oldest), baseFeePerGas: base, gasUsedRatio: ratios, baseFeePerBlobGas: blobFees, blobGasUsedRatio: blobRatios };
    if (percentiles.length) out.reward = reward;
    return out;
  },
};
