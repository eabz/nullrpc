// The StateSource the executor reads through (src/executor.ts): a Workers RPC target over this
// request's pinned chain view, so every executor read sees the same archive generation and head.

import { RpcTarget } from "cloudflare:workers";
import { decodeAccount } from "./archive/state";
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

  async read(keys: StateKey[], at: number): Promise<StateValue[]> {
    if (!Array.isArray(keys) || keys.length > MAX_KEYS) throw new Error(`at most ${MAX_KEYS} keys per read`);
    if (!Number.isSafeInteger(at) || at < 0 || at > this.chain.pointers().latest) throw new Error("block out of range");
    return Promise.all(keys.map((k) => this.one(k, at)));
  }

  private async one(k: StateKey, at: number): Promise<StateValue> {
    switch (k.kind) {
      case "account": {
        const a = decodeAccount(await this.chain.stateValue("accounts", hex(k.address, 20), at));
        if (!a) return null;
        const codeHash = a.codeHash ? data(a.codeHash) : null;
        return { kind: "account", nonce: a.nonce, balance: "0x" + a.balance.toString(16), codeHash: codeHash === EMPTY_CODE_HASH ? null : codeHash };
      }
      case "storage": {
        const slot = hex("0x" + String(k.slot).replace(/^0x/, "").padStart(64, "0"), 32);
        return { kind: "storage", value: big(await this.chain.stateValue("storage", concat(hex(k.address, 20), slot), at)) };
      }
      case "code":
        return { kind: "code", code: data(await this.chain.code(hex(k.hash, 32))) };
      case "blockHash": {
        const rec = k.number <= at ? await this.chain.block(k.number) : null;
        return rec ? { kind: "blockHash", hash: data(rec.block.header.hash) } : null;
      }
      default:
        throw new Error("unknown state key");
    }
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
