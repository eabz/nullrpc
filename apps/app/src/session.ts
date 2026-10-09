// Signed tokens for the sign-in nonce and the session cookie.
// A token is base64url(JSON payload) "." base64url(HMAC-SHA256(SESSION_SECRET, payload)).

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function sign(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret, "sign"), enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The payload of a valid, unexpired token (`exp` in ms), else null. */
export async function verify<T extends { exp: number }>(secret: string, token: string, now: number): Promise<T | null> {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const macBytes = unb64url(mac);
  if (!macBytes) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(secret, "verify"), macBytes, enc.encode(body));
  if (!ok) return null;
  try {
    const bytes = unb64url(body);
    if (!bytes) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as T;
    return typeof payload.exp === "number" && payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "__Host-nullrpc";
export const SESSION_MS = 7 * 24 * 3600 * 1000;

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
