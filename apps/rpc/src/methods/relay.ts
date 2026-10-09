// eth_sendRawTransaction through the chain's configured relay (RELAY_URL): a private relay such
// as Flashbots Protect on mainnet. The relay's chain ID is checked before any signed bytes are
// sent, there is exactly one submission attempt (a retry could duplicate it), and upstream
// error text is never passed through (it may echo the transaction or credentials).

import { keccak } from "../eth/block";
import { data, parseData } from "../eth/hex";
import { invalidParams, RpcError } from "../rpc";

const MAX_RAW_BYTES = 128 * 1024;
const TIMEOUT_MS = 10_000;

// Node rejections clients rely on, passed through in canonical form.
const KNOWN = [
  "nonce too low",
  "nonce too high",
  "already known",
  "replacement transaction underpriced",
  "insufficient funds for gas * price + value",
  "intrinsic gas too low",
  "exceeds block gas limit",
  "max fee per gas less than block base fee",
  "transaction underpriced",
  "invalid sender",
];

// Verified relay chain IDs, per isolate.
const verified = new Map<string, number>();

async function rpc(url: string, method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code?: number; message?: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
  return res.json();
}

export async function sendRawTransaction(relayUrl: string | undefined, chainId: number, params: unknown[]): Promise<string> {
  const raw = parseData(params[0]);
  if (!raw || raw.length === 0 || raw.length > MAX_RAW_BYTES) throw invalidParams("transaction must be non-empty hex, at most 128 KiB");
  if (!relayUrl || !relayUrl.startsWith("https://")) throw new RpcError(-32601, "the method eth_sendRawTransaction does not exist/is not available");
  if (verified.get(relayUrl) !== chainId) {
    let id: number;
    try {
      const r = await rpc(relayUrl, "eth_chainId", []);
      id = typeof r.result === "string" ? parseInt(r.result, 16) : NaN;
    } catch {
      throw new RpcError(-32603, "transaction relay unavailable");
    }
    if (id !== chainId) throw new RpcError(-32603, "transaction relay is on another chain");
    verified.set(relayUrl, chainId);
  }
  let r: Awaited<ReturnType<typeof rpc>>;
  try {
    r = await rpc(relayUrl, "eth_sendRawTransaction", [data(raw)]);
  } catch {
    // Sent, but acceptance unknown: the client must check before resubmitting.
    throw new RpcError(-32603, "transaction submission status unknown; check the transaction hash before resending", { hash: data(keccak(raw)) });
  }
  if (r.error) {
    const message = (r.error.message ?? "").toLowerCase();
    const known = KNOWN.find((k) => message.includes(k));
    throw new RpcError(typeof r.error.code === "number" ? r.error.code : -32000, known ?? "transaction rejected by the relay");
  }
  return data(keccak(raw));
}
