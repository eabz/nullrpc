import type { ChainDO } from "./chain";
import type { StateShard } from "./shard";

export interface Env {
  CHAIN: DurableObjectNamespace<ChainDO>;
  SHARD: DurableObjectNamespace<StateShard>;
  /** The chain this deployment serves (decimal chain ID). */
  CHAIN_ID: string;
  /** Number of StateShard objects (docs/storage.md, "Parameters"). */
  SHARDS: string;
  /** Secret: bearer token of the daemon's ingest route. */
  INGEST_TOKEN?: string;
}
