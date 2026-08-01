/**
 * Optional password gate. One HMAC cookie, no session store, no database — the same
 * constraints the rest of this app runs under.
 *
 * Active only when SHIPWRIGHT_PASSWORD is set, so the public demo deployment is untouched and
 * a reviewer still lands straight in the recorded session with no login. Web Crypto rather
 * than node:crypto because the check runs in middleware, on the edge runtime.
 */

export const GATE_COOKIE = "sw_gate";
const CLAIM = "shipwright-gate-v1";

/** The cookie's value is derived from the password, so it cannot be forged without it, and it
 * is not the password itself, so the cookie never carries the secret. */
export async function gateToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(CLAIM));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent compare, so a wrong cookie cannot be narrowed down by timing it. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
