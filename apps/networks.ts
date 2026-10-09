// The RPC networks nullrpc lists, loaded at runtime by the landing page, the status dashboard
// and the account app, so adding or stopping a network needs no redeploy:
//
//   1. edit apps/networks.json
//   2. bun run networks:push        (writes it to the CONFIG KV namespace, key "networks")
//
// Every Worker re-reads the KV value at most once a minute per isolate, and falls back to the
// copy of networks.json bundled at deploy time when the binding or the value is missing or
// malformed.

import BUNDLED from "./networks.json";

export interface Network {
  chain_id: number;
  name: string;
  label: string;
  url: string;
  testnet: boolean;
  enabled: boolean;
  explorer?: string;
  currency?: { name: string; symbol: string; decimals: number };
}

const KV_KEY = "networks";
const TTL_MS = 60_000;

let cached: { at: number; list: Network[] } | null = null;

function valid(value: unknown): Network[] | null {
  const list = (value as { networks?: unknown } | null)?.networks;
  if (!Array.isArray(list)) return null;
  const ok = list.every(
    (n) =>
      n && typeof n === "object" && Number.isSafeInteger(n.chain_id) && typeof n.name === "string" && typeof n.label === "string" &&
      typeof n.url === "string" && n.url.startsWith("https://") && typeof n.testnet === "boolean" && typeof n.enabled === "boolean",
  );
  return ok ? (list as Network[]) : null;
}

/** Every listed network (enabled or not), from KV when available, else the bundled file. */
export async function allNetworks(config: KVNamespace | undefined, now = Date.now()): Promise<Network[]> {
  if (cached && now - cached.at < TTL_MS) return cached.list;
  let list: Network[] | null = null;
  if (config) {
    try {
      list = valid(await config.get(KV_KEY, "json"));
      if (!list) console.error(JSON.stringify({ event: "networks_kv_invalid" }));
    } catch (e) {
      console.error(JSON.stringify({ event: "networks_kv_error", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  list ??= valid(BUNDLED) ?? [];
  cached = { at: now, list };
  return list;
}

/** The networks shown publicly. */
export async function networks(config: KVNamespace | undefined, now = Date.now()): Promise<Network[]> {
  return (await allNetworks(config, now)).filter((n) => n.enabled);
}
