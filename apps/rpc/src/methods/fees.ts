// Fee methods, from served headers and receipts (ported from the exe Worker, which matched
// go-ethereum and Erigon):
//
//   eth_feeHistory            base fees, gas used ratios, blob fees and reward percentiles
//   eth_maxPriorityFeePerGas  go-ethereum's gas price oracle with full-node defaults: the 60th
//                             percentile of the three lowest effective tips (≥ 2 wei, not sent by
//                             the fee recipient) of each of the latest 20 blocks
//   eth_gasPrice              that tip plus the latest base fee
//   eth_blobBaseFee           the latest block's blob base fee

import type { Chain } from "../chain";
import { data, parseQuantity, quantity, toBigInt } from "../eth/hex";
import { effectiveGasPrice } from "../eth/tx";
import type { BlockRecord } from "../eth/record";
import { blockRef, invalidParams, RpcError, type Handler } from "../rpc";
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

interface Header {
  number: number;
  timestamp: number;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFee: bigint | null;
  blobGasUsed: bigint | null;
  excessBlobGas: bigint | null;
  miner: Uint8Array;
}

function header(rec: BlockRecord): Header {
  const f = rec.block.header.fields;
  const opt = (i: number) => (f.length > i ? toBigInt(bytes(f[i])) : null);
  return {
    number: rec.block.header.number,
    timestamp: rec.block.header.timestamp,
    gasUsed: toBigInt(bytes(f[10])),
    gasLimit: toBigInt(bytes(f[9])),
    baseFee: rec.block.header.baseFee,
    blobGasUsed: opt(17),
    excessBlobGas: opt(18),
    miner: bytes(f[2]),
  };
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

function rewards(rec: BlockRecord, h: Header, percentiles: number[]): string[] {
  if (rec.block.txs.length === 0) return percentiles.map(() => "0x0");
  const weighted: [bigint, bigint][] = [];
  let previous = 0n;
  rec.block.txs.forEach((tx, i) => {
    const cumulative = rec.receipts[i]!.cumulativeGasUsed;
    weighted.push([effectiveGasPrice(tx, h.baseFee) - (h.baseFee ?? 0n), cumulative - previous]);
    previous = cumulative;
  });
  weighted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: string[] = [];
  let index = 0;
  let accumulated = weighted[0]![1];
  for (const p of percentiles) {
    const threshold = BigInt(Math.floor((Number(h.gasUsed) * p) / 100));
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

async function readRange(chain: Chain, from: number, to: number): Promise<BlockRecord[]> {
  const out: BlockRecord[] = [];
  for (let n = from; n <= to; n += 16) {
    const batch = await Promise.all(Array.from({ length: Math.min(16, to - n + 1) }, (_, i) => mustBlock(chain, n + i)));
    out.push(...batch);
  }
  return out;
}

async function schedule(chain: Chain): Promise<BlobSchedule> {
  return BlobSchedule.from(await chain.config());
}

// The oracle's answer is a function of the head block; one per isolate.
let lastTip: { head: string; tip: bigint } | null = null;

async function suggestTip(chain: Chain): Promise<{ tip: bigint; baseFee: bigint }> {
  const latest = chain.pointers().latest;
  const head = await mustBlock(chain, latest);
  const baseFee = head.block.header.baseFee ?? 0n;
  const headHash = data(head.block.header.hash);
  if (lastTip?.head === headHash) return { tip: lastTip.tip, baseFee };
  const lowest = Math.max(1, chain.pin.manifest.first_block);
  const sample = async (n: number) => {
    const rec = await mustBlock(chain, n);
    const h = header(rec);
    const tips = rec.block.txs
      .map((tx, i) => ({ tip: effectiveGasPrice(tx, h.baseFee) - (h.baseFee ?? 0n), sender: rec.senders[i]! }))
      .sort((a, b) => (a.tip < b.tip ? -1 : a.tip > b.tip ? 1 : 0))
      .filter((t) => t.tip >= IGNORE_PRICE && data(t.sender) !== data(h.miner))
      .slice(0, SAMPLES_PER_BLOCK)
      .map((t) => t.tip);
    return tips;
  };
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
  lastTip = { head: headHash, tip };
  return { tip, baseFee };
}

export const FEE_METHODS: Record<string, Handler> = {
  eth_maxPriorityFeePerGas: async (chain) => quantity((await suggestTip(chain)).tip),
  eth_gasPrice: async (chain) => {
    const { tip, baseFee } = await suggestTip(chain);
    return quantity(tip + baseFee);
  },
  eth_blobBaseFee: async (chain) => {
    const h = header(await mustBlock(chain, chain.pointers().latest));
    if (h.excessBlobGas === null) return null;
    return quantity((await schedule(chain)).block(h)[0]);
  },
  eth_feeHistory: async (chain, params) => {
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
    const blocks = await readRange(chain, oldest, newest < latest ? newest + 1 : newest);
    const blobs = await schedule(chain);
    const base: string[] = [];
    const ratios: number[] = [];
    const blobFees: string[] = [];
    const blobRatios: number[] = [];
    const reward: string[][] = [];
    const span = newest - oldest + 1;
    for (let i = 0; i < span; i++) {
      const rec = blocks[i]!;
      const h = header(rec);
      base.push(quantity(h.baseFee ?? 0n));
      ratios.push(Number(h.gasUsed) / Number(h.gasLimit));
      const [fee, ratio] = blobs.block(h);
      blobFees.push(quantity(fee));
      blobRatios.push(ratio);
      if (percentiles.length) reward.push(rewards(rec, h, percentiles));
    }
    const last = header(blocks[span - 1]!);
    const successor = newest < latest ? header(blocks[span]!) : null;
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
