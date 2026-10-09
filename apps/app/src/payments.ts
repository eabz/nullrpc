// On-chain payments in USDC or ETH.
//
// An invoice fixes the USD amount, the network, the asset and the amount in base units
// (ETH is quoted from the Chainlink ETH/USD feed on Ethereum). The user pays from the
// wallet they signed in with; the app then verifies the transaction through the
// network's RPC: success, sender = account, recipient = treasury, amount >= invoice,
// mined after the invoice, enough confirmations. Each transaction pays one invoice.

import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  type Hex,
  type PublicClient,
} from "viem";

export interface Network {
  chainId: number;
  name: string;
  rpc: string;
  /** USDC contract; without it only ETH is accepted. */
  usdc?: string;
  confirmations: number;
  explorer?: string;
}

export type Asset = "USDC" | "ETH";

export const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const ETH_INVOICE_MS = 30 * 60 * 1000;
export const USDC_INVOICE_MS = 24 * 3600 * 1000;
/** A transaction may be mined up to this long before the invoice (clock skew). */
const EARLY_MS = 5 * 60 * 1000;

/** Ethereum mainnet RPC: payments, the ETH/USD feed, sanctions screening, the free-plan gate. */
export const ETH_RPC_URL = "https://ethereum-rpc.publicnode.com";

/** Address receiving payments. Set it before taking payments. */
export const TREASURY_ADDRESS = "";

/** Networks that accept payments. */
export const NETWORKS: Network[] = [
  {
    chainId: 1,
    name: "Ethereum",
    rpc: ETH_RPC_URL,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    confirmations: 12,
    explorer: "https://etherscan.io",
  },
];

/**
 * Networks as shown to users (no RPC URLs). New payments are USDC only, so a network without
 * a USDC contract is not offered; ETH remains verifiable for invoices created before.
 */
export function publicNetworks(networks: Network[]) {
  return networks.filter((n) => n.usdc).map((n) => ({
    chain_id: n.chainId,
    name: n.name,
    assets: ["USDC"],
    confirmations: n.confirmations,
    explorer: n.explorer ?? null,
  }));
}

function client(rpc: string): PublicClient {
  return createPublicClient({ transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
}

/** ETH/USD with 8 decimals from Chainlink, refusing a stale answer. */
export async function ethUsd(priceRpc: string, now: number, feed = ETH_USD_FEED): Promise<bigint> {
  const [, answer, , updatedAt] = await client(priceRpc).readContract({
    address: getAddress(feed),
    abi: FEED_ABI,
    functionName: "latestRoundData",
  });
  if (answer <= 0n) throw new Error("invalid ETH/USD answer");
  if (now / 1000 - Number(updatedAt) > 6 * 3600) throw new Error("stale ETH/USD answer");
  return answer;
}

/** Base units for `usdCents`: USDC has 6 decimals; ETH is rounded up to 1e-6 ETH. */
export function amountFor(asset: Asset, usdCents: number, ethUsd8?: bigint): bigint {
  if (asset === "USDC") return BigInt(usdCents) * 10_000n;
  if (!ethUsd8 || ethUsd8 <= 0n) throw new Error("ETH price required");
  const wei = (BigInt(usdCents) * 10n ** 24n + ethUsd8 - 1n) / ethUsd8;
  const step = 10n ** 12n;
  return ((wei + step - 1n) / step) * step;
}

export interface InvoiceRow {
  id: string;
  address: string;
  chain_id: number;
  asset: string;
  amount: string;
  created_at: number;
  expires_at: number;
  tx_hash: string | null;
}

/** The transaction the wallet sends (EIP-1193 `eth_sendTransaction` parameters). */
export function txRequest(invoice: InvoiceRow, network: Network, treasury: string) {
  const amount = BigInt(invoice.amount);
  const base = { chainId: `0x${network.chainId.toString(16)}`, from: invoice.address };
  if (invoice.asset === "USDC" && network.usdc) {
    return {
      ...base,
      to: getAddress(network.usdc),
      value: "0x0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(treasury), amount] }),
    };
  }
  return { ...base, to: getAddress(treasury), value: `0x${amount.toString(16)}`, data: "0x" };
}

export type Verification = { status: "paid"; block: number } | { status: "pending"; reason: string } | { status: "failed"; reason: string };

/** Checks `invoice.tx_hash` against the invoice on its network. */
export async function verifyPayment(invoice: InvoiceRow, network: Network, treasury: string, rpc?: PublicClient): Promise<Verification> {
  if (!invoice.tx_hash) return { status: "pending", reason: "no transaction submitted" };
  const c = rpc ?? client(network.rpc);
  const hash = invoice.tx_hash as Hex;
  const tx = await c.getTransaction({ hash }).catch(() => null);
  if (!tx) return { status: "pending", reason: "transaction not found yet" };
  if (tx.chainId !== undefined && tx.chainId !== network.chainId) return { status: "failed", reason: "wrong network" };
  if (tx.from.toLowerCase() !== invoice.address) return { status: "failed", reason: "sent from a different wallet" };
  if (tx.blockNumber === null) return { status: "pending", reason: "waiting to be mined" };
  const receipt = await c.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) return { status: "pending", reason: "waiting to be mined" };
  if (receipt.status !== "success") return { status: "failed", reason: "transaction reverted" };
  const head = await c.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber) + 1;
  if (confirmations < network.confirmations) {
    return { status: "pending", reason: `${confirmations}/${network.confirmations} confirmations` };
  }
  const block = await c.getBlock({ blockNumber: receipt.blockNumber });
  const minedAt = Number(block.timestamp) * 1000;
  if (minedAt < invoice.created_at - EARLY_MS) return { status: "failed", reason: "transaction predates the invoice" };
  // The ETH quote holds until the invoice expires; USDC has no price risk.
  if (invoice.asset === "ETH" && minedAt > invoice.expires_at + EARLY_MS) return { status: "failed", reason: "mined after the ETH quote expired" };

  const amount = BigInt(invoice.amount);
  const to = treasury.toLowerCase();
  if (invoice.asset === "ETH") {
    if (tx.to?.toLowerCase() !== to) return { status: "failed", reason: "not sent to the nullrpc treasury" };
    if (tx.value < amount) return { status: "failed", reason: "amount is lower than the invoice" };
    return { status: "paid", block: Number(receipt.blockNumber) };
  }
  if (!network.usdc) return { status: "failed", reason: "USDC is not accepted on this network" };
  const usdc = network.usdc.toLowerCase();
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (event.eventName !== "Transfer") continue;
      if (event.args.from.toLowerCase() === invoice.address && event.args.to.toLowerCase() === to) paid += event.args.value;
    } catch {
      // not a Transfer
    }
  }
  if (paid === 0n) return { status: "failed", reason: "no USDC transfer to the nullrpc treasury" };
  if (paid < amount) return { status: "failed", reason: "amount is lower than the invoice" };
  return { status: "paid", block: Number(receipt.blockNumber) };
}
