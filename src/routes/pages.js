// GET /problem/?form=contact&e=email:required,name:too_long
// The built-in problem page, filled in by the Worker so it works without
// JavaScript. Messages come only from the config (labels, limits) and fixed
// text, never from what the visitor typed; unknown fields or codes are ignored.
import { escapeHtml } from "../lib/http.js";
import { problemMessage } from "../lib/parse.js";

const CODES = new Set([
  "required", "email", "url", "number", "tel", "too_long", "option", "text_only", "too_many", "file_big", "file_type",
  "too_big", "rate", "turnstile", "encoding", "unsupported", "malformed", "json_files",
]);

export async function problemPage(request, app) {
  const url = new URL(request.url);
  const form = app.forms.get(url.searchParams.get("form") ?? "")?.form ?? null;
  const items = [];
  for (const pair of (url.searchParams.get("e") ?? "").split(",").slice(0, 60)) {
    const [field, code] = pair.split(":");
    if (!CODES.has(code)) continue;
    if (field === "_") items.push(problemMessage(null, code));
    else if (form?.fields[field]) items.push(problemMessage(form.fields[field], code));
  }
  if (!items.length) items.push("Something in the form needs fixing.");

  // A link back, only to one of the form's own sites (never anywhere a URL says).
  let back = null;
  const referer = request.headers.get("Referer");
  if (form && referer) {
    try {
      const r = new URL(referer);
      if (form.origins.includes(r.origin)) back = r.toString();
    } catch {
      back = null;
    }
  }

  const page = await app.env.ASSETS.fetch(new URL("/problem/", request.url));
  return new HTMLRewriter()
    .on("#problems", {
      element(el) {
        el.setInnerContent(items.map((m) => `<li>${escapeHtml(m)}</li>`).join(""), { html: true });
      },
    })
    .on("#back", {
      element(el) {
        if (back) el.setAttribute("href", back);
        else el.remove();
      },
    })
    .transform(
      new Response(page.body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      }),
    );
}
