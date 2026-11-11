// Hashes, random ids and constant-time comparison.
// sha256Hex / safeEqual copied from perchlight-updates src/lib/crypto.js.

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

export async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(String(message))));
}

/** Constant-time comparison of two strings (hashes both first, so lengths
 *  don't leak either). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 symbols: no 0/o, 1/l

/** "<prefix>_" + 16 random characters (80 bits): not guessable. */
export function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

export function isId(prefix, s) {
  return typeof s === "string" && new RegExp(`^${prefix}_[${ALPHABET}]{16}$`).test(s);
}
