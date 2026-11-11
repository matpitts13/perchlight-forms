// Copied from perchlight-list src/lib/senders/postmark.js, standard mode only
// (transactional "outbound" stream, no batch). Carry fixes across.
// Postmark. Header X-Postmark-Server-Token; JSON in and out. POST /email.
// No idempotency keys, no hard rate limit.
import { classifyHttp, describe, request, safeJson } from "./common.js";

const API = "https://api.postmarkapp.com";

// Error codes: https://postmarkapp.com/developer/api/overview#error-codes
const REJECTED_CODES = new Set([300, 406]);
const REJECTED_TEXT = /inactive|suppress|invalid .*(to|email|address|recipient)|recipient/i;
const CONFIG_TEXT = /token|sender signature|not allowed|pending approval|account|stream|domain|unauthori|forbidden/i;

/** @returns {import("./index.js").EmailSender} */
export function postmarkSender({ serverToken }, from) {
  const headers = { "X-Postmark-Server-Token": serverToken, "Content-Type": "application/json", Accept: "application/json" };

  return {
    name: "postmark",
    idempotent: false,

    async send(m) {
      const r = await request(`${API}/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          From: from,
          To: m.to,
          Subject: m.subject,
          TextBody: m.text,
          HtmlBody: m.html,
          Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
          MessageStream: "outbound",
        }),
      });
      if (r.networkError) return { status: "unknown", error: `Postmark unreachable: ${r.networkError}` };
      const data = safeJson(r.text);
      if (r.res.ok && (data?.ErrorCode ?? 0) === 0) return { status: "sent", id: data?.MessageID ?? null };
      if (typeof data?.ErrorCode === "number" && data.ErrorCode !== 0) {
        const text = String(data.Message ?? "");
        const error = describe("Postmark", data.ErrorCode, text);
        if (REJECTED_CODES.has(data.ErrorCode)) return { status: "rejected", error };
        if (CONFIG_TEXT.test(text)) return { status: "config", error };
        if (REJECTED_TEXT.test(text)) return { status: "rejected", error };
        return { status: classifyHttp(r.res.status) ?? "rejected", error };
      }
      return { status: classifyHttp(r.res.status) ?? "rejected", error: describe("Postmark", r.res.status, r.text) };
    },
  };
}
