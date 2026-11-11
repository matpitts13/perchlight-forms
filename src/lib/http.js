// Small HTTP helpers, as in perchlight-list and perchlight-updates.

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** An admin API error: { ok: false, error }. */
export function fail(status, error) {
  return json({ ok: false, error }, status);
}

export function redirect(url, status = 303, extraHeaders = {}) {
  return new Response(null, { status, headers: { Location: url, "Cache-Control": "no-store", ...extraHeaders } });
}

export function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Reads a JSON object body of at most maxBytes, or null. */
export async function readJson(request, maxBytes = 64 * 1024) {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) return null;
  const t = await request.text();
  if (t.length > maxBytes) return null;
  try {
    const v = JSON.parse(t || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD HH:MM:SS" (UTC), the format D1's datetime('now') uses. */
export function sqlTime(ms = Date.now()) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}
