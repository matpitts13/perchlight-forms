// Signed download links: the R2 Workers binding has no presigned URLs, so the
// Worker signs its own. /file/<id>?exp=<unix seconds>&sig=<HMAC(LINK_SECRET, "id.exp")>
import { hmacHex, isId, safeEqual } from "./crypto.js";

export function linkSecretOk(env) {
  return String(env.LINK_SECRET ?? "").length >= 16;
}

/** An absolute signed link to a file, valid for `seconds`. */
export async function signedFileUrl(env, base, fileId, seconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + Math.max(1, Math.floor(seconds));
  const sig = await hmacHex(env.LINK_SECRET, `${fileId}.${exp}`);
  return { url: `${base}/file/${fileId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** True only for an unexpired link whose signature matches (constant-time). */
export async function verifyFileLink(env, fileId, exp, sig, now = Date.now()) {
  if (!linkSecretOk(env) || !isId("fil", fileId)) return false;
  if (!/^\d{1,12}$/.test(String(exp ?? "")) || !/^[0-9a-f]{64}$/.test(String(sig ?? ""))) return false;
  const expected = await hmacHex(env.LINK_SECRET, `${fileId}.${exp}`);
  const ok = await safeEqual(expected, sig);
  return ok && Number(exp) * 1000 > now;
}

/** Headers that make a stored file download, never run as a page. */
export function downloadHeaders(file) {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return {
    "Content-Type": file.content_type,
    "Content-Length": String(file.size),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
}
