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

/** The chain the status page shows, and its public RPC endpoint. */
const CHAIN = { id: "1", name: "Ethereum", endpoint: "https://eth.nullrpc.dev" };

/** The `LIVE_{id}` service binding of a chain, if configured. */
export function liveBinding(env: Env, id: string): Fetcher | null {
  const b = (env as unknown as Record<string, unknown>)[`LIVE_${id}`];
  return b && typeof (b as Fetcher).fetch === "function" ? (b as Fetcher) : null;
}

/** The chains shown by the status page. A chain has live status when its `LIVE_{id}` binding exists. */
export function chains(env: Env): Chain[] {
  return [{ id: CHAIN.id, name: CHAIN.name, live: liveBinding(env, CHAIN.id) !== null }];
}

/** The public RPC endpoint origin of a chain. */
export function endpoint(_env: Env, chain: Chain): string | null {
  return chain.id === CHAIN.id ? CHAIN.endpoint : null;
}
