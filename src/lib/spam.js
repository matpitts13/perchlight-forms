// Spam scoring (no network) and the rate-limit key.
// Any hard reason makes a submission spam; two or more soft reasons do.
import { hmacHex, sha256Hex } from "./crypto.js";

const LINK = /(https?:\/\/|www\.|href\s*=|\[url[=\]])/gi;

/**
 * @param {object} form
 * @param {{ data: Record<string, any>, extra: Record<string, string> | null, honeypot: string, elapsedMs: number | null }} sub
 * @param {{ origin: string | null, turnstile: { result: string, hostname?: string | null } | null }} ctx
 * @returns {{ spam: boolean, reasons: string[] }}
 */
export function scoreSpam(form, sub, { origin, turnstile }) {
  const hard = [];
  const soft = [];

  if (sub.honeypot) hard.push("honeypot");

  if (origin && origin !== "null") {
    if (!form.origins.includes(origin)) hard.push(`sent from ${origin.slice(0, 100)}`);
  } else soft.push("no origin");

  if (turnstile?.result === "passed" && turnstile.hostname) {
    const hosts = form.origins.map((o) => new URL(o).hostname);
    if (!hosts.includes(turnstile.hostname)) hard.push(`turnstile token from ${turnstile.hostname.slice(0, 100)}`);
  }
  // The widget's data-action, if the form names one: a token minted for another form or page.
  if (turnstile?.result === "passed" && form.spam.turnstileAction && turnstile.action !== form.spam.turnstileAction) {
    hard.push(`turnstile action ${String(turnstile.action ?? "none").slice(0, 40)}`);
  }
  if (turnstile?.result === "unverified") soft.push("turnstile unverified");

  if (sub.elapsedMs !== null && form.spam.minSeconds > 0 && sub.elapsedMs < form.spam.minSeconds * 1000) {
    soft.push(`sent ${Math.round(sub.elapsedMs / 100) / 10}s after the page opened`);
  }

  const texts = [...Object.values(sub.data), ...Object.values(sub.extra ?? {})].filter((v) => typeof v === "string");
  const joined = texts.join("\n");
  const links = (joined.match(LINK) ?? []).length;
  if (links > form.spam.maxLinks) soft.push(`${links} links`);

  const lower = joined.toLowerCase();
  const word = form.spam.blockedWords.find((w) => lower.includes(w));
  if (word) soft.push(`blocked word: ${word}`);

  const reasons = [...hard, ...soft];
  return { spam: hard.length > 0 || soft.length >= 2, reasons };
}

/** IPv4 address, or the IPv6 /64 (each IPv6 user gets a whole /64). */
export function networkOf(ip) {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // Expand "::" so the first four groups are really the /64.
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

/**
 * SHA-256 of HMAC(IP_SALT, UTC date) : form : network. The day is in the
 * key, so one visitor's hashes can't be linked across days, and with
 * IP_SALT secret they can't be reversed by trying every IPv4 address.
 */
export async function rateKey(salt, day, formId, ip) {
  const dayKey = await hmacHex(salt, day);
  return sha256Hex(`${dayKey}:${formId}:${networkOf(ip)}`);
}

/** Same content sent to the same form: a double click or a refresh. */
/** Attachments count too (field, size and SHA-256), so a resent corrected file isn't collapsed. */
export async function contentHash(formId, data, extra, files = []) {
  const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const fileKey = files.map((f) => `${f.field}:${f.bytes?.byteLength ?? f.size}:${f.sha256}`).join(",");
  return sha256Hex(`${formId}\n${JSON.stringify(sorted(data))}\n${JSON.stringify(sorted(extra))}\n${fileKey}`);
}
