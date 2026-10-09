// Bindings of the dashboard Worker `nullrpc-dashboard`.

export interface Env {
  /** Secret: API token with "Account Analytics: Read". Unset → usage analytics are disabled. */
  CF_ANALYTICS_TOKEN?: string;
  /** Static assets (public/); served before the Worker for every path except /api/*. */
  ASSETS?: Fetcher;
}

/** The Cloudflare account of the RPC Worker (GraphQL accountTag). */
export const CF_ACCOUNT_ID = "60401d41768f5312f816303569019bb5";

export interface Chain {
  id: string;
  name: string;
  live: boolean;
}

import NETWORK_LIST from "../../networks.json";

/** The chains the status page shows and their public RPC endpoints (apps/networks.json, enabled ones). */
const CHAINS = NETWORK_LIST.networks.filter((n) => n.enabled).map((n) => ({ id: String(n.chain_id), name: n.name, endpoint: n.url }));

/** The `LIVE_{id}` service binding of a chain, if configured. */
export function liveBinding(env: Env, id: string): Fetcher | null {
  const b = (env as unknown as Record<string, unknown>)[`LIVE_${id}`];
  return b && typeof (b as Fetcher).fetch === "function" ? (b as Fetcher) : null;
}

/**
 * The chains shown by the status page. Every listed chain has live status: from its live
 * pipeline (`LIVE_{id}` binding) when bound, else from its RPC endpoint's /status.json.
 */
export function chains(_env: Env): Chain[] {
  return CHAINS.map((c) => ({ id: c.id, name: c.name, live: true }));
}

/** The public RPC endpoint origin of a chain. */
export function endpoint(_env: Env, chain: Chain): string | null {
  return CHAINS.find((c) => c.id === chain.id)?.endpoint ?? null;
}
