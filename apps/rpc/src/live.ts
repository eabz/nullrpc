// The live window (blocks P+1 to head) through the chain's `nullrpc-live-{id}` Worker, service
// binding with entrypoint `LiveReads` (apps/live/src/index.ts). Every read carries the head pin;
// `{stale: true}` means a reorg removed it, and the caller re-reads state() and retries.

import { Lru } from "./archive/lru";

export interface BlockId {
  number: number;
  /** 0x-prefixed lowercase. */
  hash: string;
}

export interface LiveState {
  head: BlockId | null;
  safe: BlockId | null;
  finalized: BlockId | null;
  promoted: BlockId | null;
  generation: number;
  shards: number | null;
}

type Stale = { stale: true };

/** The LiveReads entrypoint as the RPC Worker calls it (JS RPC over the service binding). */
export interface LiveApi {
  state(): Promise<LiveState>;
  block(numberOrHash: number | string, pin: BlockId): Promise<Stale | { stale: false; number: number; hash: string; record: string } | null>;
  witness(number: number, pin: BlockId): Promise<Stale | { stale: false; witness: string } | null>;
  txBlock(txHash: string, pin: BlockId): Promise<Stale | { stale: false; number: number } | null>;
  getPinned(domain: number, keyHex: string, n: number, pin: BlockId): Promise<Stale | { stale: false; block: number | null; value: string | null }>;
  scanPinned(addressHex: string, n: number, pin: BlockId): Promise<Stale | { stale: false; slots: Record<string, string> }>;
}

export class StaleError extends Error {
  constructor() {
    super("the pinned head was removed by a reorg");
  }
}

/** state() is shared per isolate for half a block time (storage.md, "ChainDO"). */
const STATE_TTL_MS = 6_000;
const states = new WeakMap<LiveApi, { at: number; state: Promise<LiveState> }>();
// Records are immutable per block hash, so they are kept with no expiry.
const records = new Lru<string, Uint8Array>(512);

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class Live {
  constructor(private readonly api: LiveApi) {}

  /** The live pointers; `fresh` bypasses the isolate cache (after a stale answer). */
  state(fresh = false, now = Date.now()): Promise<LiveState> {
    const cached = states.get(this.api);
    if (!fresh && cached && now - cached.at < STATE_TTL_MS) return cached.state;
    const state = this.api.state();
    states.set(this.api, { at: now, state });
    state.catch(() => states.get(this.api)?.state === state && states.delete(this.api));
    return state;
  }

  /** A block record in the window at or below the pin, or null. Throws StaleError. */
  async block(numberOrHash: number | string, pin: BlockId): Promise<{ number: number; hash: string; record: Uint8Array } | null> {
    const r = await this.api.block(numberOrHash, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    let record = records.get(r.hash);
    if (!record) {
      record = fromHex(r.record);
      records.set(r.hash, record);
    }
    return { number: r.number, hash: r.hash, record };
  }

  /**
   * A state value at the end of block `n` in the window: bytes (empty when absent or zero), or
   * null when the key has not changed since P (read the archive at P). Throws StaleError.
   */
  async stateValue(domain: 1 | 2 | 3, key: Uint8Array, n: number, pin: BlockId): Promise<Uint8Array | null> {
    const keyHex = Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");
    const r = await this.api.getPinned(domain, keyHex, n, pin);
    if (r.stale) throw new StaleError();
    if (r.block === null || r.value === null) return null;
    return fromHex(r.value);
  }

  /** A block's witness bytes in the window, or null. Throws StaleError. */
  async witness(n: number, pin: BlockId): Promise<Uint8Array | null> {
    const r = await this.api.witness(n, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    return fromHex(r.witness);
  }

  /** The block number of a transaction in the window, or null. Throws StaleError. */
  async txBlock(hash: string, pin: BlockId): Promise<number | null> {
    const r = await this.api.txBlock(hash, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    return r.number;
  }
}
