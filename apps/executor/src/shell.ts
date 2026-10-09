// The round loop around the WebAssembly executor (crate/): the executor runs as far as the
// values it knows allow and answers the response, the witness it wants, or the state keys it
// is missing; this loop reads them from the RPC Worker's StateSource and runs it again.
// Runtime-independent (Workers and Node tests share it).

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ExecRequest, ExecResponse, StateKey, StateSource, StateValue, Witness } from "./contract";

/** The WebAssembly session (crate/src/lib.rs `Session`). */
export interface WasmSession {
  run(stateJson: string): string;
  usage(): string;
  free?(): void;
}

type Round =
  | { done: true; response: ExecResponse }
  | { witness: number; hash: string }
  | { missing: StateKey[]; at: number };

/** Most keys per StateSource.read call (apps/rpc/src/state-source.ts). */
const READ_BATCH = 256;
/** Rounds a request may take (the executor's own limit is 256 dependent read rounds). */
const MAX_ROUNDS = 300;
/** Wall-clock budget of one request. */
const TIMEOUT_MS = 25_000;

/** A small LRU by total size. */
class Lru<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(private readonly maxSize: number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key: string, value: V, size: number): void {
    if (size > this.maxSize) return;
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.total += size;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxSize) break;
      this.map.delete(k);
      this.total -= v.size;
    }
  }
}

/** Per isolate: bytecode by hash (immutable), witnesses by block hash (immutable), and account
 *  and storage values by (chain, block hash, block, key): the state at the end of a block is
 *  fixed once the block is, so entries never need invalidating, only evicting. */
const codeCache = new Lru<string>(32 * 1024 * 1024);
const witnessCache = new Lru<Witness | null>(16 * 1024 * 1024);
const stateCache = new Lru<StateValue>(32 * 1024 * 1024);

/** The RLP item at `at` of `b`: where its payload starts and ends, and whether it is a list. */
function rlpItem(b: Uint8Array, at: number): { list: boolean; start: number; end: number } {
  const p = b[at];
  if (p === undefined) throw new Error("truncated rlp");
  if (p < 0x80) return { list: false, start: at, end: at + 1 };
  let start = at + 1;
  let len: number;
  const list = p >= 0xc0;
  if (p < 0xb8 || (list && p < 0xf8)) len = p - (list ? 0xc0 : 0x80);
  else {
    const n = p - (list ? 0xf7 : 0xb7);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (b[at + 1 + i] ?? 0);
    start += n;
  }
  if (start + len > b.length) throw new Error("truncated rlp");
  return { list, start, end: start + len };
}

function unhex(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The hash of the block of a request: its record is the RLP list [raw_block, …], raw_block the
 * block's RLP [header, …], and the hash keccak256 of the header's RLP. Null for a record the
 * executor will reject anyway (the request then runs uncached).
 */
export function blockHashOf(record: string): string | null {
  try {
    const b = unhex(record);
    const top = rlpItem(b, 0);
    const raw = rlpItem(b, top.start);
    if (!top.list || raw.list) return null;
    const block = rlpItem(b, raw.start);
    const header = rlpItem(b, block.start);
    if (!block.list || !header.list) return null;
    return "0x" + toHex(keccak_256(b.subarray(block.start, header.end)));
  } catch {
    return null;
  }
}

/** The cache key of an account or storage StateKey (addresses and slots in any case or padding). */
function stateKeyOf(scope: string, key: StateKey): string | null {
  switch (key.kind) {
    case "account":
      return `${scope}:a:${key.address.toLowerCase()}`;
    case "storage":
      return `${scope}:s:${key.address.toLowerCase()}:${BigInt(key.slot).toString(16)}`;
    default:
      return null;
  }
}

/** Roughly what a cached StateValue costs. */
function stateSize(value: StateValue): number {
  if (!value) return 64;
  switch (value.kind) {
    case "account":
      return 128 + 2 * (value.balance.length + (value.codeHash?.length ?? 0));
    case "storage":
      return 96 + 2 * value.value.length;
    default:
      return 160;
  }
}

const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

function failure(message: string): ExecResponse {
  return { error: { code: -32000, message } };
}

async function readAll(state: StateSource, keys: StateKey[], at: number): Promise<StateValue[]> {
  const batches: Promise<StateValue[]>[] = [];
  for (let i = 0; i < keys.length; i += READ_BATCH) batches.push(state.read(keys.slice(i, i + READ_BATCH), at));
  const values = (await Promise.all(batches)).flat();
  if (values.length !== keys.length) throw new Error("state source answered the wrong number of values");
  return values;
}

/** Answers `missing`: code from the isolate cache, accounts and storage from it too when
 *  `scope` (chain, block hash and block) is known, everything else from `state` in one read;
 *  code of accounts read here comes with them (from the cache, else one more read). */
async function answer(state: StateSource, missing: StateKey[], at: number, scope: string | null): Promise<{ keys: StateKey[]; values: StateValue[] }> {
  const keys: StateKey[] = [];
  const values: StateValue[] = [];
  const toRead: StateKey[] = [];
  const have = new Set<string>();
  for (const key of missing) {
    if (key.kind === "code") {
      const cached = codeCache.get(key.hash);
      if (cached !== undefined) {
        keys.push(key);
        values.push({ kind: "code", code: cached });
        have.add(key.hash);
        continue;
      }
    } else if (scope) {
      const id = stateKeyOf(scope, key);
      const cached = id ? stateCache.get(id) : undefined;
      if (cached !== undefined) {
        keys.push(key);
        values.push(cached);
        continue;
      }
    }
    toRead.push(key);
  }
  const read = toRead.length ? await readAll(state, toRead, at) : [];
  const codes: StateKey[] = [];
  toRead.forEach((key, i) => {
    const value = read[i] ?? null;
    keys.push(key);
    values.push(value);
    if (key.kind === "code" && value?.kind === "code") {
      codeCache.set(key.hash, value.code, value.code.length);
      have.add(key.hash);
    } else if (scope && (key.kind === "account" || key.kind === "storage") && (value === null || value.kind === key.kind)) {
      stateCache.set(stateKeyOf(scope, key)!, value, stateSize(value));
    }
  });
  toRead.forEach((key) => {
    if (key.kind === "code") have.add(key.hash);
  });
  for (const value of values) {
    if (value?.kind !== "account" || !value.codeHash || value.codeHash === EMPTY_CODE_HASH || have.has(value.codeHash)) continue;
    have.add(value.codeHash);
    const cached = codeCache.get(value.codeHash);
    if (cached !== undefined) {
      keys.push({ kind: "code", hash: value.codeHash });
      values.push({ kind: "code", code: cached });
    } else codes.push({ kind: "code", hash: value.codeHash });
  }
  if (codes.length) {
    const code = await readAll(state, codes, at);
    codes.forEach((key, i) => {
      const value = code[i] ?? null;
      if (value?.kind === "code" && key.kind === "code") codeCache.set(key.hash, value.code, value.code.length);
      keys.push(key);
      values.push(value);
    });
  }
  return { keys, values };
}

function witnessSize(w: Witness | null): number {
  if (!w) return 64;
  let n = w.accounts.length * 200;
  for (const s of w.storage) n += 64 + s.slots.length * 140;
  return n;
}

/** Runs `request` to its response, reading state through `state`. */
export async function execute(
  request: ExecRequest,
  state: StateSource,
  session: (requestJson: string) => WasmSession,
  now: () => number = Date.now,
): Promise<ExecResponse> {
  const started = now();
  const chainId = String((request.chain as { chainId?: unknown })?.chainId ?? "");
  const blockHash = typeof request.block === "string" ? blockHashOf(request.block) : null;
  const wasm = session(JSON.stringify(request));
  try {
    let input = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const out = JSON.parse(wasm.run(input)) as Round;
      if ("done" in out) return out.response;
      if (now() - started > TIMEOUT_MS) return { error: { code: -32005, message: "execution exceeded its time budget (timeout)" } };
      if ("witness" in out) {
        const key = `${chainId}:${out.hash}`;
        let witness = witnessCache.get(key);
        if (witness === undefined) {
          witness = await state.witness(out.witness);
          witnessCache.set(key, witness, witnessSize(witness));
        }
        input = JSON.stringify({ witness });
      } else {
        input = JSON.stringify(await answer(state, out.missing, out.at, blockHash && `${chainId}:${blockHash}:${out.at}`));
      }
    }
    return { error: { code: -32005, message: `execution needs more than ${MAX_ROUNDS} rounds` } };
  } catch (e) {
    console.error("executor state read failed", e instanceof Error ? e.message : String(e));
    return failure("execution unavailable: state could not be read");
  } finally {
    wasm.free?.();
  }
}
