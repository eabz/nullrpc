// The round loop around the WebAssembly executor (crate/): the executor runs as far as the
// values it knows allow and answers the response, the witness it wants, or the state keys it
// is missing; this loop reads them from the caller's StateSource and runs it again.
// Runtime-independent (Workers and Node tests share it); index.ts binds it to the module.
//
// A call-style request (eth_call and friends) also gets, in one wave with the executor's first
// round (its own hints: sender, callee, calldata addresses): the source's hints, the state of
// the keys nearby blocks touched; and the call's profile, the keys earlier calls to the same
// contract and function read, kept per isolate. Most calls then execute in full on the next
// run and never enter a dependent round; a call walking a structure the recent blocks did not
// touch pays its rounds once per isolate.

import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ExecRequest, ExecResponse, Hints, StateKey, StateSource, StateValue, Witness } from "./contract";

/** The WebAssembly session (crate/src/lib.rs `Session`). */
export interface WasmSession {
  run(stateJson: string): string;
  usage(): string;
  free?(): void;
}

/** Makes a session for a request (JSON); `has` says what the module keeps by block hash
 *  (crate/src/cache.rs): a decoded record, or a state snapshot to start from. */
export type SessionFactory = ((requestJson: string) => WasmSession) & { has?: (kind: "block" | "known", hash: string) => boolean };

/** The request as it goes to the module: the record only when the module lacks it, `seed`
 *  when it holds a snapshot of the block. */
interface WireRequest extends Omit<ExecRequest, "block"> {
  block?: string;
  blockHash?: string;
  seed?: string;
}

type Round =
  | { done: true; response: ExecResponse }
  | { witness: number; hash: string }
  | { missing: StateKey[]; at: number };

/** Most keys per StateSource.read call (apps/rpc/src/state-source.ts). */
const READ_BATCH = 256;
/** Rounds a request may take (the executor's own limit is 256 dependent read rounds). */
export const MAX_ROUNDS = 300;
/** Wall-clock budget of one request: a hard stop, every wait of the loop races it. */
export const TIMEOUT_MS = 25_000;
const TIMED_OUT = Symbol("timed out");
/** Methods that run a call on a block's post-state, where the source's hints apply. */
const CALL_METHODS = new Set(["eth_call", "eth_estimateGas", "eth_createAccessList", "debug_traceCall", "trace_call"]);

/**
 * A turn of the event loop. A round is synchronous: nothing else in the isolate runs during it.
 * Between rounds the state reads are awaited (I/O, so other requests proceed), except when the
 * caches answer every key; such a round is followed by an explicit turn, so one request with
 * warm caches and many rounds still lets the isolate's other requests make progress. (The
 * turn is decided by whether the round read anything, not by the clock: a Worker's clock does
 * not move during synchronous code, so a round never looks slow from inside.)
 */
const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

/** Per isolate: bytecode by hash (immutable), witnesses by block hash (immutable), the hints of
 *  a block by its hash (the state at its end for the keys nearby blocks touched: fixed once the
 *  block is), and account and storage values by (chain, block hash, block, key): the state at
 *  the end of a block is fixed once the block is, so entries never need invalidating, only
 *  evicting. Budgets (rough, in UTF-16 string bytes) are sized for sharing the RPC Worker's
 *  128 MB isolate with the module's memory and the archive's own caches. */
const codeCache = new Lru<string>(16 * 1024 * 1024);
const witnessCache = new Lru<Witness | null>(8 * 1024 * 1024);
const hintCache = new Lru<Hints | null>(16 * 1024 * 1024);
const stateCache = new Lru<StateValue>(16 * 1024 * 1024);
/** Keys the executions of calls to (chain, callee, selector) asked for, newest first. */
const profileCache = new Lru<StateKey[]>(8 * 1024 * 1024);
/** Keys a profile keeps (the executor reads at most 1024 per call). */
const MAX_PROFILE_KEYS = 1024;
/** A call with this many read rounds teaches its profile; a call that ran on what it was handed
 *  (a seeded one) does not, and keeps the profile that made it so. */
const PROFILE_AFTER_ROUNDS = 1;
/**
 * A call whose profile holds this many keys or fewer is cheap: its profile is its targeted
 * hints, read with its first round, and the source's broad hints (the witnesses around the
 * block, about a thousand keys at a busy head) are neither read nor waited for. A larger
 * profile still has them read, but its first round does not wait for them: they join the
 * round in which they arrive, if the call needs one.
 */
const CHEAP_PROFILE_KEYS = 32;

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
 * The block of a request: its record is the RLP list [raw_block, …], raw_block the block's RLP
 * [header, …], the hash keccak256 of the header's RLP, and the number the header's ninth
 * field. Null for a record the executor will reject anyway (the request then runs uncached).
 */
export function blockOf(record: string | Uint8Array): { hash: string; number: number; coinbase?: string } | null {
  try {
    const b = typeof record === "string" ? unhex(record) : record;
    const top = rlpItem(b, 0);
    const raw = rlpItem(b, top.start);
    if (!top.list || raw.list) return null;
    const block = rlpItem(b, raw.start);
    const header = rlpItem(b, block.start);
    if (!block.list || !header.list) return null;
    let at = header.start;
    let number = 0;
    let coinbase: string | undefined;
    for (let field = 0; field < 9; field++) {
      if (at >= header.end) return null;
      const item = rlpItem(b, at);
      if (field === 2 && !item.list && item.end - item.start === 20) coinbase = "0x" + toHex(b.subarray(item.start, item.end));
      if (field === 8) {
        if (item.list || item.end - item.start > 6) return null;
        for (let i = item.start; i < item.end; i++) number = number * 256 + b[i]!;
      }
      at = item.end;
    }
    return { hash: "0x" + toHex(keccak_256(b.subarray(block.start, header.end))), number, coinbase };
  } catch {
    return null;
  }
}

/** The hash of the block of a request (see `blockOf`). */
export function blockHashOf(record: string | Uint8Array): string | null {
  return blockOf(record)?.hash ?? null;
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

/**
 * Why a state read failed, from the error's message, so the answer (and the benchmark reading
 * it) tells a Durable Object refusing the read apart from a reorg, a missing object or a
 * timeout: "overloaded", "stale", "missing", "timeout" or "error".
 */
export function readFailureCause(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (m.includes("overloaded") || m.includes("queued for too long")) return "overloaded";
  if (m.includes("stale") || m.includes("reorg")) return "stale";
  if (m.includes("missing") || m.includes("not found") || m.includes("does not exist")) return "missing";
  if (m.includes("timeout") || m.includes("timed out") || m.includes("time budget")) return "timeout";
  return "error";
}

const timedOut = (): ExecResponse => ({ error: { code: -32005, message: "execution exceeded its time budget (timeout)" } });

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
async function answer(state: StateSource, missing: StateKey[], at: number, scope: string | null): Promise<Answered> {
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
  return { keys, values, read: toRead.length > 0 || codes.length > 0 };
}

/** A round's answers, and whether any came from the source (I/O) rather than the isolate's caches. */
interface Answered extends Hints {
  read: boolean;
}

function witnessSize(w: Witness | null): number {
  if (!w) return 64;
  let n = w.accounts.length * 200;
  for (const s of w.storage) n += 64 + s.slots.length * 140;
  return n;
}

function hintsSize(h: Hints | null): number {
  if (!h) return 64;
  let n = 0;
  for (const v of h.values) n += 120 + stateSize(v);
  return n;
}

/** Hint reads in flight, by scope: simultaneous requests at one block share the one read. */
const pendingHints = new Set<string>();
/** How often a request sharing another's hint read looks for its result (its own timer). */
const HINTS_POLL_MS = 5;

/**
 * The source's hints for the block of a call, shared per isolate by the block's hash. One
 * request reads them; another at the same block meanwhile waits for the cached value with its
 * own timer rather than on the reader's promise: a Worker cancels a request whose only pending
 * work is a promise another request created once that request has finished.
 */
function hintsFor(state: StateSource, scope: string | null, at: number): Promise<Hints | null> | null {
  if (!state.hints || scope === null) return null;
  const cached = hintCache.get(scope);
  if (cached !== undefined) return Promise.resolve(cached);
  if (pendingHints.has(scope)) {
    return (async () => {
      while (pendingHints.has(scope)) await new Promise((r) => setTimeout(r, HINTS_POLL_MS));
      return hintCache.get(scope) ?? null;
    })();
  }
  let p: Promise<Hints | null>;
  try {
    p = Promise.resolve(state.hints(at));
  } catch {
    return null;
  }
  pendingHints.add(scope);
  return p
    .then(
      (h) => {
        if (h && (!Array.isArray(h.keys) || !Array.isArray(h.values) || h.keys.length !== h.values.length)) h = null;
        hintCache.set(scope, h, hintsSize(h));
        return h;
      },
      () => null,
    )
    .finally(() => pendingHints.delete(scope));
}

/** `hints` without the keys in `ids` (what earlier rounds answered exactly: those stand). */
function withoutIds(hints: Hints | null, ids: Set<string>): Hints | null {
  if (!hints || ids.size === 0) return hints;
  const keys: StateKey[] = [];
  const values: StateValue[] = [];
  hints.keys.forEach((key, i) => {
    if (ids.has(keyId(key))) return;
    keys.push(key);
    values.push(hints.values[i]!);
  });
  return { keys, values };
}

/** A promise's value once it has settled, read without waiting (a rejection reads as null). */
function settled<T>(p: Promise<T>): { get: () => { value: T | null } | null } {
  let state: { value: T | null } | null = null;
  p.then(
    (value) => (state = { value }),
    () => (state = { value: null }),
  );
  return { get: () => state };
}

/**
 * The first round's input: the hints (the code of their contracts from the cache, when it is
 * there; the rest the executor asks for next), the profile's answers, and then the round's own
 * answers; a later set wins on a key two name.
 */
function withHints(hints: Hints | null, profile: Hints | null, round: Hints): Hints {
  if ((!hints || hints.keys.length === 0) && !profile) return round;
  const keys: StateKey[] = [];
  const values: StateValue[] = [];
  const have = new Set<string>();
  for (const key of round.keys) if (key.kind === "code") have.add(key.hash);
  if (hints) {
    keys.push(...hints.keys);
    values.push(...hints.values);
    for (const [i, value] of hints.values.entries()) {
      // Code the source sent with its hints is cached like code read for an account.
      if (value?.kind === "code") {
        const key = hints.keys[i];
        if (key?.kind === "code") {
          have.add(key.hash);
          if (codeCache.get(key.hash) === undefined) codeCache.set(key.hash, value.code, value.code.length);
        }
        continue;
      }
      if (value?.kind !== "account" || !value.codeHash || value.codeHash === EMPTY_CODE_HASH || have.has(value.codeHash)) continue;
      const cached = codeCache.get(value.codeHash);
      if (cached === undefined) continue;
      have.add(value.codeHash);
      keys.push({ kind: "code", hash: value.codeHash });
      values.push({ kind: "code", code: cached });
    }
  }
  if (profile) {
    keys.push(...profile.keys);
    values.push(...profile.values);
  }
  keys.push(...round.keys);
  values.push(...round.values);
  return { keys, values };
}

/** The identity of a key for a profile (addresses and slots in any spelling). */
function keyId(key: StateKey): string {
  switch (key.kind) {
    case "account":
      return `a:${key.address.toLowerCase()}`;
    case "storage":
      return `s:${key.address.toLowerCase()}:${BigInt(key.slot).toString(16)}`;
    case "code":
      return `c:${key.hash.toLowerCase()}`;
    case "blockHash":
      return `b:${key.number}`;
  }
}

/** The profile a call belongs to: its chain, callee and function selector; null for a create. */
function profileOf(request: ExecRequest, chainId: string): string | null {
  if (!CALL_METHODS.has(request.method)) return null;
  const call = request.params?.[0] as { to?: unknown; data?: unknown; input?: unknown } | undefined;
  if (!call || typeof call !== "object" || typeof call.to !== "string") return null;
  const data = typeof call.data === "string" ? call.data : typeof call.input === "string" ? call.input : "";
  return `${chainId}:${call.to.toLowerCase()}:${data.length >= 10 ? data.slice(0, 10).toLowerCase() : "0x"}`;
}

/** The accounts a call names itself (sender, callee, the addresses in its calldata) and the
 *  block's coinbase: asked by every call and different from call to call or block to block, so
 *  not what a profile should carry. */
function ownKeysOf(request: ExecRequest, coinbase: string | undefined): Set<string> {
  const own = new Set<string>();
  const account = (address: unknown) => {
    if (typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) own.add(`a:${address.toLowerCase()}`);
  };
  const call = request.params?.[0] as { from?: unknown; to?: unknown; data?: unknown; input?: unknown } | undefined;
  if (call && typeof call === "object") {
    account(call.from);
    account(call.to);
    const data = typeof call.data === "string" ? call.data : typeof call.input === "string" ? call.input : "";
    // 32-byte words that are a left-padded address, as the module reads them.
    for (let i = 10; i + 64 <= data.length; i += 64) {
      const word = data.slice(i, i + 64);
      if (/^0{24}[0-9a-fA-F]{40}$/.test(word)) own.add(`a:0x${word.slice(24).toLowerCase()}`);
    }
  }
  account(coinbase);
  return own;
}

/** Records what a call's dependent rounds asked for beyond the call's own accounts: the newest
 *  keys first, then what the profile already held. A call that needed none still leaves a
 *  profile (an empty one): the isolate then knows its calls are cheap. */
function learn(profile: string, asked: StateKey[], own: Set<string>): void {
  const seen = new Set<string>();
  const keys: StateKey[] = [];
  for (const key of [...asked, ...(profileCache.get(profile) ?? [])]) {
    if (key.kind === "blockHash") continue;
    const id = keyId(key);
    if (seen.has(id) || own.has(id)) continue;
    seen.add(id);
    keys.push(key);
    if (keys.length >= MAX_PROFILE_KEYS) break;
  }
  profileCache.set(profile, keys, 64 + keys.length * 160);
}

/**
 * Runs `request` to its response, reading state through `state`. The budget is a hard stop:
 * every wait (a state wave, a witness, a turn of the event loop) races a timer, so a stalled
 * read answers the time-budget error when the timer fires, whatever the reads do afterwards.
 * Between rounds the clock is checked too; inside the module, the executed-gas budget of the
 * crate bounds CPU, since a Worker's clock does not move during synchronous code.
 */
export async function execute(
  request: ExecRequest,
  state: StateSource,
  session: SessionFactory,
  now: () => number = Date.now,
  budgetMs: number = TIMEOUT_MS,
): Promise<ExecResponse> {
  const started = now();
  let expire: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    expire = setTimeout(() => resolve(TIMED_OUT), budgetMs);
  });
  const within = <T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => Promise.race([p, expired]);
  const chainId = String((request.chain as { chainId?: unknown })?.chainId ?? "");
  const decoded = request.block != null ? blockOf(request.block) : null;
  const block =
    typeof request.blockHash === "string" && Number.isSafeInteger(request.blockNumber) && request.blockNumber! >= 0
      ? { hash: request.blockHash.toLowerCase(), number: request.blockNumber!, coinbase: decoded?.coinbase }
      : decoded;
  const blockHash = block?.hash ?? null;
  const isCall = CALL_METHODS.has(request.method);
  // A block the module has a state snapshot of needs no hints or profile: it starts from it.
  const seeded = !!(blockHash && isCall && session.has?.("known", blockHash));
  const profile = block ? profileOf(request, chainId) : null;
  const known = profile && !seeded ? profileCache.get(profile) : undefined;
  // A call whose profile the isolate knows has its targeted hints (read with its first round);
  // a cheap one (a profile of few keys, or none beyond what the module asks for itself) does
  // without the source's broad wave altogether.
  const cheap = !!known && known.length <= CHEAP_PROFILE_KEYS;
  // The source's hints are read while the executor's first round is: one wave. A call without
  // a profile waits for them (its first round would otherwise miss most of what it needs); a
  // profiled call does not wait, and takes them in whichever round they have arrived for.
  const hinting = block && isCall && !seeded && !cheap ? hintsFor(state, `${chainId}:${blockHash}:${block.number}`, block.number) : null;
  const arrived = hinting ? settled(hinting) : null;
  const waitForHints = !!hinting && !known;
  let hintsTaken = !hinting;
  /** Keys earlier rounds answered exactly: hints arriving later do not restate them. */
  const answeredIds = new Set<string>();
  const asked: StateKey[] = [];
  let reads = 0;
  // The record goes as hex, and only when the module does not hold the block already.
  const wire: WireRequest = { ...request, block: undefined };
  if (blockHash) {
    wire.blockHash = blockHash;
    if (seeded) wire.seed = blockHash;
  }
  // (`instanceof Uint8Array` is not relied on: the bytes may come from another realm's buffer.)
  if (!blockHash || !session.has?.("block", blockHash)) wire.block = typeof request.block === "string" ? request.block : "0x" + toHex(request.block);
  const wasm = session(JSON.stringify(wire));
  try {
    let input = "";
    let turn = false;
    let first = true;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (turn && (await within(yieldNow())) === TIMED_OUT) return timedOut();
      turn = false;
      const out = JSON.parse(wasm.run(input)) as Round;
      if ("done" in out) return out.response;
      if (now() - started > budgetMs) return timedOut();
      if ("witness" in out) {
        const key = `${chainId}:${out.hash}`;
        let witness = witnessCache.get(key);
        if (witness === undefined) {
          const got = await within(state.witness(out.witness));
          if (got === TIMED_OUT) return timedOut();
          witness = got;
          witnessCache.set(key, witness, witnessSize(witness));
        }
        input = JSON.stringify({ witness });
      } else {
        const scope = blockHash && `${chainId}:${blockHash}:${out.at}`;
        // The first round's keys are the module's own (sender, callee, coinbase, the calldata's
        // addresses), asked by every call: a profile is what the dependent rounds then needed.
        if (profile && !first) asked.push(...out.missing);
        reads++;
        const atBlock = !!block && out.at === block.number;
        const answered = answer(state, out.missing, out.at, scope);
        // The profile's keys the first round did not ask for, read with it.
        let prefetching: Promise<Answered | null> | null = null;
        if (first && atBlock && known?.length) {
          const missing = new Set(out.missing.map(keyId));
          const want = known.filter((k) => !missing.has(keyId(k)));
          if (want.length) prefetching = answer(state, want, out.at, scope).catch(() => null);
        }
        const wave = await within(Promise.all([answered, prefetching, first && atBlock && waitForHints ? hinting : null]));
        if (wave === TIMED_OUT) return timedOut();
        const [round, prefetched, waited] = wave;
        // The source's hints join the first round they have arrived for (at once when waited for).
        let hints: Hints | null | undefined;
        if (!hintsTaken && atBlock) {
          const got = first && waitForHints ? { value: waited } : arrived!.get();
          if (got) {
            hints = withoutIds(got.value, answeredIds);
            hintsTaken = true;
          }
        }
        for (const key of round.keys) answeredIds.add(keyId(key));
        for (const key of prefetched?.keys ?? []) answeredIds.add(keyId(key));
        // What a call has been handed once the hints are in (or when the source has none) is the
        // state at the end of its block: the module keeps it for the next request there (unless
        // it started from such a snapshot already). A cheap call's own few keys are not that.
        const snapshot = atBlock && isCall && !seeded && session.has && (hints !== undefined || (first && !hinting && !cheap)) ? { snapshot: blockHash } : {};
        const merged = withHints(hints ?? null, first ? prefetched : null, round);
        input = JSON.stringify({ keys: merged.keys, values: merged.values, ...snapshot });
        // A round the caches answered awaited no I/O: give the isolate's other requests a turn.
        turn = !round.read && !prefetched?.read;
        first = false;
      }
    }
    return { error: { code: -32005, message: `execution needs more than ${MAX_ROUNDS} rounds` } };
  } catch (e) {
    // A trap in the module is the caller's to handle (index.ts drops the instance).
    if (e instanceof WebAssembly.RuntimeError) throw e;
    // A source may refuse a request (its read budget): that is the answer.
    const refusal = e as { rpcCode?: unknown; message?: unknown };
    if (typeof refusal?.rpcCode === "number" && typeof refusal.message === "string") return { error: { code: refusal.rpcCode, message: refusal.message } };
    console.error("executor state read failed", e instanceof Error ? e.message : String(e));
    return failure(`execution unavailable: state could not be read (${readFailureCause(e)})`);
  } finally {
    if (expire !== undefined) clearTimeout(expire);
    wasm.free?.();
    if (profile && reads >= PROFILE_AFTER_ROUNDS) learn(profile, asked, ownKeysOf(request, block?.coinbase));
  }
}
