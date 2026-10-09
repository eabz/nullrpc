// The StateSource the executor reads through (src/executor.ts) over this request's pinned chain
// view, so every executor read sees the same archive generation and head. An RpcTarget, so the
// same object serves the executor Worker over a service binding when EXECUTOR is bound.
//
// `hints` answers a call's keys before it asks for them, from witnesses (storage.md,
// "Witnesses"): the pre-state of block n+1 is the state at the end of n for every key that
// block touched, exact as it is; the witnesses of n and n-1 name the keys those blocks touched
// with values from before them, and one live read at n says which of those changed since (and
// to what). A call at n mostly touches what the blocks around n touched (the same contracts,
// pools and tokens), so most of its dependent rounds are answered in that one wave.

import { RpcTarget } from "cloudflare:workers";
import { decodeAccount, type Domain } from "./archive/state";
import { decodeWitness } from "./archive/witness";
import type { Chain } from "./chain";
import { concat, data, parseData } from "./eth/hex";
import type { Hints, StateKey, StateSource, StateValue, Witness } from "./executor";

/** Most keys per read call; the executor batches below this. */
const MAX_KEYS = 256;
/** Most hinted keys per request: a busy block's witness runs to thousands. */
export const MAX_HINTS = 4096;
/** Most contracts whose code is read with the hints (the executor asks for the rest). */
const MAX_HINT_CODES = 48;

const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

function hex(v: unknown, bytes: number): Uint8Array {
  const b = parseData(v, bytes);
  if (!b) throw new Error(`expected ${bytes}-byte hex`);
  return b;
}

const big = (b: Uint8Array) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return "0x" + x.toString(16);
};

/** An archive value as the executor takes it. */
function stateValue(kind: "account" | "storage" | "code", v: Uint8Array): StateValue {
  switch (kind) {
    case "account": {
      const a = decodeAccount(v);
      if (!a) return null;
      const codeHash = a.codeHash ? data(a.codeHash) : null;
      return { kind: "account", nonce: a.nonce, balance: "0x" + a.balance.toString(16), codeHash: codeHash === EMPTY_CODE_HASH ? null : codeHash };
    }
    case "storage":
      return { kind: "storage", value: big(v) };
    case "code":
      return { kind: "code", code: data(v) };
  }
}

interface Entry {
  key: StateKey;
  value: StateValue;
  domain: Domain;
  raw: Uint8Array;
}

/** A witness's keys and values as entries, keyed canonically (an address or address:slot). */
function witnessEntries(w: Witness): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const a of w.accounts) {
    const address = a.address.toLowerCase();
    const codeHash = a.codeHash ? a.codeHash.toLowerCase() : null;
    out.set(`a:${address}`, {
      key: { kind: "account", address },
      value: a.exists ? { kind: "account", nonce: a.nonce, balance: a.balance, codeHash: codeHash === EMPTY_CODE_HASH ? null : codeHash } : null,
      domain: "accounts",
      raw: hex(address, 20),
    });
  }
  for (const s of w.storage) {
    const address = s.address.toLowerCase();
    const addr = hex(address, 20);
    for (const slot of s.slots) {
      const key = hex(slot.slot, 32);
      out.set(`s:${address}:${data(key)}`, { key: { kind: "storage", address, slot: data(key) }, value: { kind: "storage", value: slot.value }, domain: "storage", raw: concat(addr, key) });
    }
  }
  return out;
}

export class ChainStateSource extends RpcTarget implements StateSource {
  constructor(private readonly chain: Chain) {
    super();
  }

  /**
   * One round's keys: every account, storage and code key goes to the chain in one batch (one
   * call to the live window above P, the archive in parallel for the rest); block hashes come
   * from the block records.
   */
  async read(keys: StateKey[], at: number): Promise<StateValue[]> {
    if (!Array.isArray(keys) || keys.length > MAX_KEYS) throw new Error(`at most ${MAX_KEYS} keys per read`);
    if (!Number.isSafeInteger(at) || at < 0 || at > this.chain.pointers().latest) throw new Error("block out of range");
    this.chain.exec.rounds++;
    this.chain.exec.keys += keys.length;
    const state: { domain: Domain; key: Uint8Array }[] = [];
    const index: number[] = [];
    const out: StateValue[] = new Array(keys.length).fill(null);
    const blocks: Promise<void>[] = [];
    keys.forEach((k, i) => {
      switch (k.kind) {
        case "account":
          state.push({ domain: "accounts", key: hex(k.address, 20) });
          index.push(i);
          break;
        case "storage":
          state.push({ domain: "storage", key: concat(hex(k.address, 20), hex("0x" + String(k.slot).replace(/^0x/, "").padStart(64, "0"), 32)) });
          index.push(i);
          break;
        case "code":
          state.push({ domain: "code", key: hex(k.hash, 32) });
          index.push(i);
          break;
        case "blockHash":
          blocks.push(
            (k.number <= at ? this.chain.block(k.number) : Promise.resolve(null)).then((rec) => {
              out[i] = rec ? { kind: "blockHash", hash: data(rec.block.header.hash) } : null;
            }),
          );
          break;
        default:
          throw new Error("unknown state key");
      }
    });
    const [values] = await Promise.all([this.chain.stateValues(state, at), ...blocks]);
    values.forEach((v, j) => {
      const i = index[j]!;
      const k = keys[i]!;
      if (k.kind === "account" || k.kind === "storage" || k.kind === "code") out[i] = stateValue(k.kind, v);
    });
    return out;
  }

  /**
   * The state at the end of block `at` for the keys the witnesses of at+1 (exact), `at` and
   * at-1 (checked against the live window) hold; null when `at` is out of range or no witness
   * is there. Witnesses of blocks at or below P are used only as the exact kind, since a value
   * from before such a block can only be checked by the archive read the hint is meant to save.
   */
  async hints(at: number): Promise<Hints | null> {
    if (!Number.isSafeInteger(at) || at < 0) return null;
    const { latest, archived } = this.chain.pointers();
    if (at > latest) return null;
    const witness = (n: number) => this.chain.witness(n).catch(() => null);
    const touchedAt = [at, at - 1].filter((n) => n >= 1 && n > archived);
    const [exact, ...touched] = await Promise.all([at + 1 <= latest ? witness(at + 1) : null, ...touchedAt.map(witness)]);
    const entries = new Map<string, Entry>();
    for (const w of touched) {
      if (!w) continue;
      for (const [id, e] of witnessEntries(decodeWitness(w))) {
        if (entries.size >= MAX_HINTS) break;
        if (!entries.has(id)) entries.set(id, e);
      }
    }
    const exactEntries = exact ? witnessEntries(decodeWitness(exact)) : null;
    // The code of the contracts the hints name, read in the same wave as the window check: the
    // executor would otherwise spend a round asking for it (a witness lists code by hash only).
    const hashes = new Set<string>();
    for (const e of [...entries.values(), ...(exactEntries?.values() ?? [])]) {
      if (e.value?.kind === "account" && e.value.codeHash && hashes.size < MAX_HINT_CODES) hashes.add(e.value.codeHash);
    }
    const codes = this.chain.stateValues([...hashes].map((h) => ({ domain: "code" as const, key: hex(h, 32) })), at).catch(() => null);
    if (entries.size) {
      // Values from before `at` hold unless the window wrote the key since; then the window's.
      const list = [...entries.values()];
      const live = await this.chain.liveValues(list.map((e) => ({ domain: e.domain, key: e.raw })), at);
      live.forEach((v, i) => {
        if (v !== null) list[i]!.value = stateValue(list[i]!.domain === "accounts" ? "account" : "storage", v);
      });
    }
    if (exactEntries) {
      for (const [id, e] of exactEntries) {
        if (!entries.has(id) && entries.size >= MAX_HINTS) break;
        entries.set(id, e);
      }
    }
    if (entries.size === 0) return null;
    const keys: StateKey[] = [];
    const values: StateValue[] = [];
    for (const e of entries.values()) {
      keys.push(e.key);
      values.push(e.value);
    }
    const code = await codes;
    [...hashes].forEach((hash, i) => {
      const bytes = code?.[i];
      if (bytes?.length) {
        keys.push({ kind: "code", hash });
        values.push({ kind: "code", code: data(bytes) });
      }
    });
    this.chain.exec.hints += keys.length;
    return { keys, values };
  }

  async witness(n: number): Promise<Witness | null> {
    const w = await this.chain.witness(n);
    return w ? decodeWitness(w) : null;
  }

  async block(n: number): Promise<string | null> {
    const rec = await this.chain.block(n);
    return rec ? data(rec.frame) : null;
  }
}
