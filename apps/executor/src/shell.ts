// The round loop around the WebAssembly executor (crate/): the executor runs as far as the
// values it knows allow and answers the response, the witness it wants, or the state keys it
// is missing; this loop reads them from the RPC Worker's StateSource and runs it again.
// Runtime-independent (Workers and Node tests share it).

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

/** Per isolate: bytecode by hash (immutable), witnesses by block hash (immutable). */
const codeCache = new Lru<string>(32 * 1024 * 1024);
const witnessCache = new Lru<Witness | null>(16 * 1024 * 1024);

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

/** Answers `missing`: code from the isolate cache, everything else from `state`; code of
 *  accounts read here comes with them (from the cache, else one more read). */
async function answer(state: StateSource, missing: StateKey[], at: number): Promise<{ keys: StateKey[]; values: StateValue[] }> {
  const keys: StateKey[] = [];
  const values: StateValue[] = [];
  const toRead: StateKey[] = [];
  const have = new Set<string>();
  for (const key of missing) {
    const cached = key.kind === "code" ? codeCache.get(key.hash) : undefined;
    if (cached !== undefined) {
      keys.push(key);
      values.push({ kind: "code", code: cached });
      have.add(key.kind === "code" ? key.hash : "");
    } else toRead.push(key);
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
    }
  });
  toRead.forEach((key) => {
    if (key.kind === "code") have.add(key.hash);
  });
  for (const value of read) {
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
        input = JSON.stringify(await answer(state, out.missing, out.at));
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
