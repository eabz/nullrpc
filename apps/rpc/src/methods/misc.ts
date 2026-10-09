// Node identity and utility methods, transaction submission, and the endpoint's capabilities.

import { keccak } from "../eth/block";
import { data, parseData } from "../eth/hex";
import { invalidParams, type Handler } from "../rpc";
import { sendRawTransaction } from "./relay";

export const MISC_METHODS: Record<string, Handler> = {
  net_listening: async () => true,
  eth_accounts: async () => [],
  rpc_modules: async () => ({ eth: "1.0", net: "1.0", web3: "1.0", debug: "1.0", trace: "1.0" }),
  web3_sha3: async (_chain, [input]) => {
    const b = parseData(input);
    if (!b) throw invalidParams("data must be hex");
    return data(keccak(b));
  },
  debug_chainConfig: async (chain) => chain.config(),
  eth_sendRawTransaction: async (_chain, params, env) => sendRawTransaction(env.relayUrl, env.chainId, params),
  nullrpc_getCapabilities: async (chain, _params, env) => {
    const p = chain.pointers();
    return {
      chain_id: env.chainId,
      archive: { first_block: p.earliest, archived_through: p.archived, generation: chain.pin.generation },
      live: { head: p.latest, finalized: p.finalized, safe: p.safe, window: p.latest - p.archived },
      execution: Boolean(env.executor),
      transactions: Boolean(env.relayUrl),
      limits: { batch: 32, body_bytes: 256 * 1024, get_logs_blocks: 10_000 },
    };
  },
};
