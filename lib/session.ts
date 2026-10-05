import { cookies } from "next/headers";

export const SESSION_COOKIE = "inkwell_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export type Session = { userId: string };

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) throw new Error("SESSION_SECRET is not set (or shorter than 16 chars)");
  return value;
}

function hmacKey(value: string): Promise<CryptoKey> {
  let key = keyCache.get(value);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(value), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(value, key);
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Token format: base64url(JSON {u, e}) "." base64url(HMAC-SHA256(payload)). */
export async function signSession(userId: string, now = Date.now()): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ u: userId, e: Math.floor(now / 1000) + SESSION_MAX_AGE })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret()), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(token: string | undefined | null, now = Date.now()): Promise<Session | null> {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret()),
      fromBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { u?: unknown; e?: unknown };
    if (typeof data.u !== "string" || typeof data.e !== "number") return null;
    if (data.e * 1000 <= now) return null;
    return { userId: data.u };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/** Reads the session from a Request's Cookie header (route handlers, proxy, tests). */
export async function readSessionFromRequest(req: Request): Promise<Session | null> {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return verifySession(decodeURIComponent(part.slice(index + 1).trim()));
    }
  }
  return null;
}

/** For Server Functions / Route Handlers running inside a Next request scope. */
export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await signSession(userId), sessionCookieOptions());
}

/** For Server Components / Server Functions running inside a Next request scope. */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", sessionCookieOptions(0));
}
