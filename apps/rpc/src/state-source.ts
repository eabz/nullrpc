// The StateSource the executor reads through (src/executor.ts) over this request's pinned chain
// view, so every executor read sees the same archive generation and head. An RpcTarget, so the
// same object serves the executor Worker over a service binding when EXECUTOR is bound.

import { RpcTarget } from "cloudflare:workers";
import { decodeAccount, type Domain } from "./archive/state";
import { decodeWitness } from "./archive/witness";
import type { Chain } from "./chain";
import { concat, data, parseData } from "./eth/hex";
import type { StateKey, StateSource, StateValue, Witness } from "./executor";

/** Most keys per read call; the executor batches below this. */
const MAX_KEYS = 256;

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
      switch (k.kind) {
        case "account": {
          const a = decodeAccount(v);
          if (!a) break;
          const codeHash = a.codeHash ? data(a.codeHash) : null;
          out[i] = { kind: "account", nonce: a.nonce, balance: "0x" + a.balance.toString(16), codeHash: codeHash === EMPTY_CODE_HASH ? null : codeHash };
          break;
        }
        case "storage":
          out[i] = { kind: "storage", value: big(v) };
          break;
        case "code":
          out[i] = { kind: "code", code: data(v) };
          break;
      }
    });
    return out;
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
