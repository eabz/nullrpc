// API key format, shared with the RPC Worker:
//
//   key = "nr_" + base64url(id ‖ tag)      id: 16 random bytes
//   tag = HMAC-SHA256(KEY_SECRET, "nullrpc-key-v1" ‖ id)[0..16]
//
// The RPC Worker verifies the tag without any lookup, so forged keys cost no I/O; only
// the key id (32 hex chars) is stored. The key itself can be re-derived for display.

const DOMAIN = new TextEncoder().encode("nullrpc-key-v1");

async function hmac(secret: string, id: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new Uint8Array(DOMAIN.length + id.length);
  message.set(DOMAIN);
  message.set(id, DOMAIN.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newKeyId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** The API key for key id `idHex`. */
export async function deriveKey(secret: string, idHex: string): Promise<string> {
  const id = fromHex(idHex);
  const tag = (await hmac(secret, id)).slice(0, 16);
  const raw = new Uint8Array(32);
  raw.set(id);
  raw.set(tag, 16);
  return `nr_${base64url(raw)}`;
}
