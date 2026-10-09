// Emulates a Worker: a request of many rounds whose state the isolate's caches already hold,
// each round 20 ms of synchronous work, while a 1 ms ticker measures how long the event loop
// is held. The clock handed to the loop is frozen, as a Worker's Date.now() is during
// synchronous code. Old shell (main a02f9a7) vs new.
import { execute as executeNew } from "./src/shell";
import { execute as executeOld } from "./src/shell.old";
import type { ExecRequest, StateKey, StateSource, StateValue } from "./src/contract";
import { keccak_256 } from "@noble/hashes/sha3.js";

const A = "0x" + "aa".repeat(20);
const ROUNDS = 40;
const WORK_MS = 20;
// Keys answered from the isolate's cache after the first execution: one storage slot per round.
const keys: StateKey[] = Array.from({ length: ROUNDS }, (_, i) => ({ kind: "storage", address: A, slot: "0x" + (i + 1).toString(16) }));
const state: StateSource = {
  async read(ks: StateKey[]): Promise<StateValue[]> {
    await new Promise((r) => setTimeout(r, 1));
    return ks.map(() => ({ kind: "storage", value: "0x1" }));
  },
  async witness() { return null; },
  async block() { return null; },
};
const burn = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) {} };
const session = () => {
  let round = 0;
  return {
    run(input: string) {
      burn(WORK_MS);
      if (round < ROUNDS) return JSON.stringify({ missing: [keys[round++]], at: 100 });
      return JSON.stringify({ done: true, response: { result: "ok" } });
    },
    usage: () => "",
  };
};
// A block record whose header is 16 fields, the 9th the block number (as the shell tests build one).
const bytes = (b: number[] | Uint8Array): Uint8Array => (b.length === 1 && b[0]! < 0x80 ? Uint8Array.from(b) : cat(prefix(b.length, 0x80), b));
const list = (items: Uint8Array[]): Uint8Array => { const body = cat(...items); return cat(prefix(body.length, 0xc0), body); };
function prefix(len: number, short: number): number[] { if (len < 56) return [short + len]; const be: number[] = []; for (let n = len; n > 0; n = Math.floor(n / 256)) be.unshift(n % 256); return [short + 55 + be.length, ...be]; }
const cat = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const header = list(Array.from({ length: 16 }, (_, i) => bytes(i === 8 ? [100] : i === 6 ? new Uint8Array(256) : new Uint8Array(32).fill(i))));
void keccak_256;
const record = hex(list([bytes(list([header, list([]), list([])])), bytes([]), list([]), bytes([])]));
const request: ExecRequest = { method: "eth_call", params: [{ to: A, data: "0x" }], chain: { chainId: 777 }, block: record } as ExecRequest;
async function measure(name: string, exec: typeof executeNew) {
  await exec(request, state, session, () => 0); // cold: reads, fills the caches
  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 1);
  const t0 = performance.now();
  await exec(request, state, session, () => 0); // warm: every round from the cache, clock frozen
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 5)); // let the ticker register the hold that just ended
  clearInterval(ticker);
  console.log(`${name}: warm request ${total.toFixed(0)} ms over ${ROUNDS} rounds of ${WORK_MS} ms; longest hold of the event loop ${maxGap.toFixed(0)} ms`);
}
await measure("old shell (main a02f9a7)", executeOld);
await measure("new shell", executeNew);
