// Who is calling (exe docs/rpc-worker.md, "Access"; apps/app/src/keys.ts):
//
//   API key: "nr_" + base64url(id16 ‖ tag16), tag = HMAC-SHA256(KEY_SECRET, "nullrpc-key-v1" ‖ id)[0..16].
//            Verified without any lookup, so a forged key costs no I/O. Subject `key:<hex id>`.
//   keyless: the client network (IPv4 address or IPv6 /64) as a keyed hash; subject `anon:<hash>`.
//            Also the /24 (IPv6 /48) block hash and the ASN, for the keyless caps.
//
// No IP address is kept: only keyed hashes leave this module.

const enc = new TextEncoder();
// Imported keys per isolate: settled values, never an import in flight (src/shared.ts).
const keys = new Map<string, CryptoKey>();

async function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keys.set(secret, k);
  }
  return k;
}

async function hmac(secret: string, domain: string, message: Uint8Array): Promise<Uint8Array> {
  const d = enc.encode(domain);
  const input = new Uint8Array(d.length + message.length);
  input.set(d);
  input.set(message, d.length);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), input));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The key from the path (`/nr_…`, preferred) or the `x-api-key` header, or null. */
export function keyFrom(request: Request): string | null {
  const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
  if (path.startsWith("nr_")) return path;
  const header = request.headers.get("x-api-key")?.trim();
  return header ? header : null;
}

function base64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The key id (32 hex) of a valid key, or null. Constant time over the tag. */
export async function verifyKey(secret: string, key: string): Promise<string | null> {
  if (key.length !== 46 || !key.startsWith("nr_")) return null;
  const raw = base64urlDecode(key.slice(3));
  if (!raw || raw.length !== 32) return null;
  const id = raw.subarray(0, 16);
  const tag = (await hmac(secret, "nullrpc-key-v1", id)).subarray(0, 16);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i]! ^ raw[16 + i]!;
  if (diff !== 0) return null;
  // Re-encode to reject non-canonical spellings of the same bytes.
  const canonical = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return canonical === key.slice(3) ? hex(id) : null;
}

function ipv6Groups(ip: string): number[] | null {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  if (ip.split("::").length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const a = parse(head);
  const b = tail === undefined ? [] : parse(tail);
  const groups = tail === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The client network: the IPv4 address, or the IPv6 /64 (`a:b:c:d::/64`). */
export function clientNet(ip: string): string {
  if (ip.includes(":")) {
    const g = ipv6Groups(ip);
    return g ? g.slice(0, 4).map((x) => x.toString(16)).join(":") + "::/64" : ip.trim();
  }
  return ip.trim();
}

/** The client block: IPv4 /24 (`a.b.c.0/24`) or IPv6 /48. */
export function clientBlock(ip: string): string {
  if (ip.includes(":")) {
    const g = ipv6Groups(ip);
    return g ? g.slice(0, 3).map((x) => x.toString(16)).join(":") + "::/48" : ip.trim();
  }
  const parts = ip.trim().split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip.trim();
}

export interface Caller {
  /** `key:<id>` or `anon:<net>`. */
  subject: string;
  keyed: boolean;
  /** Keyed hash of the client network (sent with keys too, for the Free plan's network cap). */
  net: string;
  /** The raw client network, used only as the in-memory rate-limit key; never sent or logged. */
  rateKey: string;
  block?: string;
  asn?: number;
}

export async function caller(secret: string, request: Request, keyId: string | null): Promise<Caller> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const network = clientNet(ip);
  const net = hex((await hmac(secret, "nullrpc-anon-v1", enc.encode(network))).subarray(0, 16));
  if (keyId) return { subject: `key:${keyId}`, keyed: true, net, rateKey: network };
  const block = hex((await hmac(secret, "nullrpc-block-v1", enc.encode(clientBlock(ip)))).subarray(0, 16));
  const asn = (request.cf as { asn?: unknown } | undefined)?.asn;
  return { subject: `anon:${net}`, keyed: false, net, rateKey: network, block, asn: typeof asn === "number" ? asn : undefined };
}
