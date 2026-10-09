// Sanctions screening.
//
//   - Wallets: the Chainalysis sanctions oracle on Ethereum (`isSanctioned(address)`), which
//     follows the OFAC SDN list and other government lists. Checked at sign-in, when a
//     payment is created, and again daily for accounts with keys or a paid plan.
//   - Places: src/sanctioned.json, from Cloudflare's request.cf (country and region).
//     A zone WAF rule blocks the same places for the whole zone; this check
//     also covers the app when the zone's plan cannot match regions.

import { createPublicClient, getAddress, http } from "viem";
import SANCTIONED from "./sanctioned.json";

export const SANCTIONS_ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";
const ORACLE_ABI = [
  { type: "function", name: "isSanctioned", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export type Screening = "clear" | "sanctioned" | "unavailable";

/** The oracle's answer for `address`; "unavailable" when the RPC fails (callers fail closed). */
export async function screenAddress(rpcUrl: string, address: string): Promise<Screening> {
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) });
    const listed = await client.readContract({ address: SANCTIONS_ORACLE, abi: ORACLE_ABI, functionName: "isSanctioned", args: [getAddress(address)] });
    return listed ? "sanctioned" : "clear";
  } catch {
    return "unavailable";
  }
}

const COUNTRIES = new Set<string>(SANCTIONED.countries);
const REGIONS = new Set<string>(SANCTIONED.regions);

/** Whether a request comes from a sanctioned country or region (request.cf). */
export function sanctionedPlace(properties: unknown): boolean {
  const cf = properties as { country?: unknown; regionCode?: unknown } | undefined;
  const country = typeof cf?.country === "string" ? cf.country.toUpperCase() : "";
  if (!country) return false;
  if (COUNTRIES.has(country)) return true;
  const region = typeof cf?.regionCode === "string" ? `${country}-${cf.regionCode.toUpperCase()}` : "";
  return REGIONS.has(region);
}
