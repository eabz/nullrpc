// Sign-In with Ethereum (EIP-4361).
//
// The server writes the exact message (so the client needs no library) and a signed
// token binding its nonce, address and expiry. On verify the message must equal the one
// the token describes; the signature is checked locally for EOAs and, failing that,
// through the verification RPC for smart-contract wallets (EIP-1271 / EIP-6492).

import { createPublicClient, getAddress, http, isAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { sign, verify } from "./session";

export const MESSAGE_MS = 10 * 60 * 1000;
const STATEMENT = "Sign in to nullrpc. This request does not trigger a transaction or cost any gas.";

interface NonceToken {
  n: string;
  a: string;
  iat: number;
  exp: number;
}

export async function challenge(secret: string, origin: URL, address: string, now: number) {
  if (!isAddress(address, { strict: false })) return null;
  const checksummed = getAddress(address);
  const nonce = generateSiweNonce();
  const message = createSiweMessage({
    domain: origin.host,
    address: checksummed,
    statement: STATEMENT,
    uri: origin.origin,
    version: "1",
    chainId: 1,
    nonce,
    issuedAt: new Date(now),
    expirationTime: new Date(now + MESSAGE_MS),
  });
  const token = await sign(secret, { n: nonce, a: checksummed.toLowerCase(), iat: now, exp: now + MESSAGE_MS });
  return { message, token };
}

export type VerifyResult = { address: string; nonce: string; exp: number } | { error: string };

export async function verifySignIn(
  secret: string,
  origin: URL,
  input: { message?: unknown; signature?: unknown; token?: unknown },
  now: number,
  rpcUrl: string | undefined,
): Promise<VerifyResult> {
  if (typeof input.message !== "string" || typeof input.signature !== "string" || typeof input.token !== "string") {
    return { error: "message, signature and token are required" };
  }
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature) || input.signature.length > 20_000) return { error: "invalid signature" };
  const token = await verify<NonceToken>(secret, input.token, now);
  if (!token) return { error: "sign-in request expired; try again" };
  const fields = parseSiweMessage(input.message);
  if (
    fields.domain !== origin.host ||
    fields.uri !== origin.origin ||
    fields.nonce !== token.n ||
    fields.chainId !== 1 ||
    fields.address?.toLowerCase() !== token.a ||
    fields.issuedAt?.getTime() !== token.iat
  ) {
    return { error: "message does not match the sign-in request" };
  }
  const address = getAddress(token.a);
  const signature = input.signature as Hex;
  let valid = false;
  try {
    valid = (await recoverMessageAddress({ message: input.message, signature })).toLowerCase() === token.a;
  } catch {
    valid = false;
  }
  if (!valid && rpcUrl) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
      valid = await client.verifyMessage({ address, message: input.message, signature });
    } catch {
      valid = false;
    }
  }
  if (!valid) return { error: "signature does not match the address" };
  return { address: token.a, nonce: token.n, exp: token.exp };
}
