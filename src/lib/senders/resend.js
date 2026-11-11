// Copied from perchlight-list src/lib/senders/resend.js, standard mode only
// (no batch sends). Carry fixes across.
// Resend (resend.com). POST /emails with an Idempotency-Key, so a retry can't
// deliver twice (keys last 24 hours; 409 concurrent_idempotent_requests =
// still in progress, 409 invalid_idempotent_request = key reused for
// different content). Rate limit: 10 requests/second per team by default.
import { classifyHttp, describe, request, safeJson } from "./common.js";

const API = "https://api.resend.com";

/** @returns {import("./index.js").EmailSender} */
export function resendSender(apiKey, from) {
  return {
    name: "resend",
    idempotent: true,

    async send(m, options = {}) {
      const r = await request(`${API}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html, headers: m.headers }),
      });
      if (r.networkError) return { status: "unknown", error: `Resend unreachable: ${r.networkError}` };
      const data = safeJson(r.text);
      if (r.res.ok) return { status: "sent", id: data?.id ?? null };
      const error = describe("Resend", r.res.status, r.text);
      if (r.res.status === 409) {
        return data?.name === "concurrent_idempotent_requests" ? { status: "unknown", error } : { status: "conflict", error };
      }
      return { status: requestFailure(r.res.status, data?.name) ?? "rejected", error };
    },
  };
}

/** Resend error names that mean a setup problem, not one bad message. */
const CONFIG_ERRORS = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_from_address",
  "invalid_access",
  "not_found",
  "method_not_allowed",
]);

function requestFailure(status, name) {
  if (name === "rate_limit_exceeded" || name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return "throttled";
  if (CONFIG_ERRORS.has(name)) return "config";
  return classifyHttp(status);
}
