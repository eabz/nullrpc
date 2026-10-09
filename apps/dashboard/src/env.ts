// Bindings of the dashboard Worker `nullrpc-dashboard`.

export interface Env {
  /** Secret: API token with "Account Analytics: Read". Unset → usage analytics are disabled. */
  CF_ANALYTICS_TOKEN?: string;
  /** Static assets (public/); served before the Worker for every path except /api/*. */
  ASSETS?: Fetcher;
  /** Runtime configuration (KV): the `networks` list, see apps/networks.ts. */
  CONFIG?: KVNamespace;
}

/** The Cloudflare account of the RPC Worker (GraphQL accountTag). */
export const CF_ACCOUNT_ID = "60401d41768f5312f816303569019bb5";

export interface Chain {
  id: string;
  name: string;
  live: boolean;
  testnet: boolean;
  /** The public RPC endpoint origin. */
  endpoint: string;
}

import { networks } from "../../networks";

/** The `LIVE_{id}` service binding of a chain, if configured. */
export function liveBinding(env: Env, id: string): Fetcher | null {
  const b = (env as unknown as Record<string, unknown>)[`LIVE_${id}`];
  return b && typeof (b as Fetcher).fetch === "function" ? (b as Fetcher) : null;
}

/**
 * The chains shown by the status page. Every listed chain has live status: from its live
 * pipeline (`LIVE_{id}` binding) when bound, else from its RPC endpoint's /status.json.
 */
export async function chains(env: Env): Promise<Chain[]> {
  // apps/networks.ts: the CONFIG KV list (re-read at most once a minute), else the bundled file.
  return (await networks(env.CONFIG)).map((n) => ({ id: String(n.chain_id), name: n.name, live: true, testnet: n.testnet, endpoint: n.url }));
}

/** The public RPC endpoint origin of a chain. */
export function endpoint(_env: Env, chain: Chain): string | null {
  return chain.endpoint ?? null;
}
