// Copied from perchlight-list src/lib/senders/mailgun.js, standard mode only
// (no recipient-variables bulk). Carry fixes across.
// Mailgun. POST /v3/<domain>/messages (multipart form), Basic auth api:<key>.
// US: api.mailgun.net, EU: api.eu.mailgun.net (use the domain's region).
// No idempotency keys.
import { classifyHttp, describe, request, safeJson } from "./common.js";

/** @returns {import("./index.js").EmailSender} */
export function mailgunSender({ apiKey, domain, region }, from) {
  const host = String(region).toLowerCase() === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const url = `${host}/v3/${encodeURIComponent(domain)}/messages`;
  const auth = `Basic ${btoa(`api:${apiKey}`)}`;

  return {
    name: "mailgun",
    idempotent: false,

    async send(m) {
      const form = new FormData();
      form.set("from", from);
      form.set("to", m.to);
      form.set("subject", m.subject);
      form.set("text", m.text);
      form.set("html", m.html);
      for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
      const r = await request(url, { method: "POST", headers: { Authorization: auth }, body: form });
      if (r.networkError) return { status: "unknown", error: `Mailgun unreachable: ${r.networkError}` };
      if (r.res.ok) return { status: "sent", id: String(safeJson(r.text)?.id ?? "").replace(/^<|>$/g, "") || null };
      const error = describe("Mailgun", r.res.status, safeJson(r.text)?.message ?? r.text);
      // A 400 about the domain or sender is a setup problem, not one bad address.
      if (r.res.status === 400 && /domain|from|sender|not allowed|sandbox|authoriz/i.test(r.text)) return { status: "config", error };
      if (r.res.status === 404) return { status: "config", error }; // unknown domain or wrong region
      return { status: classifyHttp(r.res.status) ?? "rejected", error };
    },
  };
}
