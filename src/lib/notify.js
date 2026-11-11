// What a notification says: the email to you, and webhook bodies.
// Values from visitors are always escaped for where they're shown, and never
// put in a header raw (the subject's name is cut, stripped of line breaks,
// and RFC 2047 encoded by mime.js or by the email service).
import { escapeHtml } from "./http.js";
import { isEmail } from "./forms.js";
import { formatBytes } from "./parse.js";
import { hmacHex } from "./crypto.js";

const WEBHOOK_VALUE_MAX = 1000;

function shown(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (v === true) return "yes";
  if (v === false) return "no";
  return String(v ?? "");
}

/** The visitor's name for the subject: one line, at most 60 characters. */
export function subjectName(form, data) {
  const raw = typeof data.name === "string" ? data.name : form.replyTo && typeof data[form.replyTo] === "string" ? data[form.replyTo] : "";
  return [...raw.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").trim()].slice(0, 60).join("");
}

/** Reply-To only when it's exactly one valid address with no line breaks. */
export function replyToOf(form, data) {
  const v = form.replyTo ? data[form.replyTo] : null;
  return typeof v === "string" && isEmail(v) && !/[\r\n,;]/.test(v) ? v : null;
}

/**
 * The email to you about a submission.
 * @param {object} form
 * @param {{ id: string, created_at: string, data: object, extra: object | null, duplicate_count?: number, spam_reasons?: string[] | null }} sub
 * @param {Array<{ name: string, size: number, url?: string }>} files
 */
export function ownerEmail(form, sub, files, { linkExpires, notSaved = false } = {}) {
  const name = subjectName(form, sub.data);
  const subject = `${notSaved ? "[NOT SAVED] " : ""}[${form.name}] New message${name ? ` from ${name}` : ""}`;
  const lines = [];
  const html = [];
  if (notSaved) {
    const warn = "The database couldn't be written, so this message is ONLY in this email. Keep it.";
    lines.push(warn, "");
    html.push(`<p><strong>${escapeHtml(warn)}</strong></p>`);
  }
  lines.push(`New message on ${form.name}, ${sub.created_at} UTC.`, "");
  html.push(`<p>New message on ${escapeHtml(form.name)}, ${escapeHtml(sub.created_at)} UTC.</p>`, "<table cellpadding=\"4\">");
  for (const field of Object.values(form.fields)) {
    if (field.type === "file" || !(field.name in sub.data)) continue;
    const value = shown(sub.data[field.name]);
    lines.push(field.type === "textarea" ? `${field.label}:\n${value}\n` : `${field.label}: ${value}`);
    html.push(
      `<tr><td valign="top"><b>${escapeHtml(field.label)}</b></td><td style="white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
    );
  }
  html.push("</table>");
  if (sub.extra && Object.keys(sub.extra).length) {
    lines.push("", "Fields not in your forms.json (kept and flagged):");
    html.push("<p><b>Fields not in your forms.json</b> (kept and flagged):</p><ul>");
    for (const [k, v] of Object.entries(sub.extra)) {
      lines.push(`  ${k}: ${v}`);
      html.push(`<li>${escapeHtml(k)}: ${escapeHtml(v)}</li>`);
    }
    html.push("</ul>");
  }
  if (files.length) {
    const linked = files.some((f) => f.url);
    const head = notSaved
      ? `${files.length} attached file(s) couldn't be kept; ask the sender to send them again:`
      : linked
        ? `Files (anyone with this email can download them until ${linkExpires}):`
        : "Files (open them through the admin API; links are off for this form):";
    lines.push("", head);
    html.push(`<p><b>${escapeHtml(head)}</b></p><ul>`);
    for (const f of files) {
      lines.push(`  ${f.name} (${formatBytes(f.size)})${f.url ? `: ${f.url}` : ""}`);
      html.push(`<li>${f.url ? `<a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a>` : escapeHtml(f.name)} (${formatBytes(f.size)})</li>`);
    }
    html.push("</ul>");
  }
  if (sub.spam_reasons?.length) {
    lines.push("", `Flagged as possible spam: ${sub.spam_reasons.join("; ")}`);
    html.push(`<p>Flagged as possible spam: ${escapeHtml(sub.spam_reasons.join("; "))}</p>`);
  }
  if (sub.duplicate_count) lines.push("", `Sent ${sub.duplicate_count + 1} times (collapsed into one).`);
  if (!notSaved) {
    lines.push("", `Id: ${sub.id}`);
    html.push(`<p style="color:#666">Id: ${escapeHtml(sub.id)}</p>`);
  }
  return { subject, text: lines.join("\n"), html: html.join("\n"), replyTo: replyToOf(form, sub.data) };
}

/** Which format a webhook URL wants, unless the config says. */
export function webhookFormat(url, configured) {
  if (configured) return configured;
  let host = "";
  let path = "";
  try {
    ({ hostname: host, pathname: path } = new URL(url));
  } catch {
    return "json";
  }
  if (/(^|\.)discord(app)?\.com$/.test(host) && path.startsWith("/api/webhooks")) return "discord";
  if (host === "hooks.slack.com") return "slack";
  if (/(^|\.)ntfy\./.test(host) || host === "ntfy.sh") return "ntfy";
  return "json";
}

const discordEscape = (s) => s.replace(/([\\*_~`|>[\]()#-])/g, "\\$1");
const slackEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lines of "Label: value" for chat webhooks, each value cut to 1,000 characters. */
function chatLines(form, sub, esc) {
  const out = [];
  for (const field of Object.values(form.fields)) {
    if (field.type === "file" || !(field.name in sub.data)) continue;
    out.push(`${esc(field.label)}: ${esc(shown(sub.data[field.name]).slice(0, WEBHOOK_VALUE_MAX))}`);
  }
  if (sub.extra) for (const [k, v] of Object.entries(sub.extra)) out.push(`${esc(k)} (not in config): ${esc(String(v).slice(0, WEBHOOK_VALUE_MAX))}`);
  return out;
}

/**
 * The request for one webhook.
 * @returns {Promise<{ body: string, headers: Record<string, string> } | { error: string }>}
 */
export async function webhookRequest(env, format, form, sub, files, now = Date.now()) {
  const summary = form.notify.content === "summary";
  const title = `New message on ${form.name}`;
  const fileNote = files.length ? `${files.length} file(s) attached` : "";
  switch (format) {
    case "discord": {
      const body = summary ? [`**${discordEscape(title)}**`, sub.created_at] : [`**${discordEscape(title)}**`, ...chatLines(form, sub, discordEscape)];
      if (fileNote) body.push(fileNote);
      // allowed_mentions: a visitor can't ping @everyone or anyone else.
      return { body: JSON.stringify({ content: body.join("\n").slice(0, 2000), allowed_mentions: { parse: [] } }), headers: { "Content-Type": "application/json" } };
    }
    case "slack": {
      const body = summary ? [`*${slackEscape(title)}*`, sub.created_at] : [`*${slackEscape(title)}*`, ...chatLines(form, sub, slackEscape)];
      if (fileNote) body.push(fileNote);
      return { body: JSON.stringify({ text: body.join("\n").slice(0, 39000) }), headers: { "Content-Type": "application/json" } };
    }
    case "ntfy": {
      let body = summary ? sub.created_at : chatLines(form, sub, (s) => s).join("\n");
      if (fileNote) body += `\n${fileNote}`;
      // ntfy turns bodies over 4,096 bytes into attachments; headers must be Latin-1.
      if (new TextEncoder().encode(body).length > 4000) body = `${body.slice(0, 3900)}\n...`;
      return {
        body,
        headers: { "Content-Type": "text/plain; charset=utf-8", Title: title.replace(/[^\x20-\x7e]/g, "?").slice(0, 120), Tags: "envelope" },
      };
    }
    default: {
      if (!env.WEBHOOK_SECRET) return { error: "Set the WEBHOOK_SECRET secret: JSON webhooks are signed with it." };
      const payload = {
        form: form.id,
        formName: form.name,
        id: sub.id,
        createdAt: sub.created_at,
        ...(summary
          ? {}
          : {
              data: Object.fromEntries(Object.entries(sub.data).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, WEBHOOK_VALUE_MAX) : v])),
              extra: sub.extra,
              files: files.map((f) => ({ name: f.name, size: f.size })),
            }),
      };
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(now / 1000));
      return {
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Perchlight-Timestamp": ts,
          "X-Perchlight-Signature": `sha256=${await hmacHex(env.WEBHOOK_SECRET, `${ts}.${body}`)}`,
        },
      };
    }
  }
}

/** The fixed auto-reply. Nothing the visitor typed goes in it. */
export function autoReplyEmail(form) {
  return {
    subject: form.autoReply.subject,
    text: form.autoReply.text,
    html: `<p style="white-space:pre-wrap">${escapeHtml(form.autoReply.text)}</p>`,
  };
}
