// Credits per JSON-RPC call. The table is apps/app/src/credits.json, the single source of truth
// the account app also prices with. A batch costs the sum of its items; a request never costs
// less than `invalid` (5).

import table from "../../../app/src/credits.json";
import { parseQuantity } from "../eth/hex";

interface Range {
  base: number;
  base_blocks: number;
  step: number;
  per_step: number;
  max_blocks: number;
}

const METHODS: Record<string, number> = table.methods;
const RANGES: Record<string, Range> = { eth_getLogs: table.ranges.eth_getLogs };
export const INVALID = table.invalid;

/** Blocks a getLogs filter spans, or null when not a numeric range (tags are priced at base). */
function logBlocks(params: unknown): number | null {
  const f = Array.isArray(params) ? (params[0] as Record<string, unknown> | undefined) : undefined;
  if (!f || typeof f !== "object") return null;
  if (f.blockHash !== undefined) return 1;
  const from = parseQuantity(f.fromBlock);
  const to = parseQuantity(f.toBlock);
  return from !== null && to !== null && to >= from ? to - from + 1 : null;
}

function rangeCredits(r: Range, blocks: number | null): number {
  if (blocks === null || blocks > r.max_blocks) return r.base;
  return r.base + Math.ceil(Math.max(0, blocks - r.base_blocks) / r.step) * r.per_step;
}

/** What one call costs once served. `errorCode` charges malformed or unknown calls `invalid`. */
export function credits(method: unknown, params: unknown, errorCode?: number): number {
  if (typeof method !== "string" || errorCode === -32601 || errorCode === -32600 || errorCode === -32700) return INVALID;
  const range = RANGES[method];
  if (range) return rangeCredits(range, logBlocks(params));
  return METHODS[method] ?? table.default;
}

/** The worst case of a request before serving it (getLogs at its largest range). */
export function estimate(items: unknown[]): number {
  let total = 0;
  for (const item of items) {
    const method = (item as { method?: unknown } | null)?.method;
    if (typeof method !== "string") total += INVALID;
    else total += RANGES[method] ? rangeCredits(RANGES[method]!, RANGES[method]!.max_blocks) : METHODS[method] ?? INVALID;
  }
  return Math.max(INVALID, total);
}
