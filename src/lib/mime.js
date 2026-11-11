// Raw MIME for the send_email binding. Adapted from perchlight-guard
// src/lib/channels.js (plain text only there); here text + HTML, and Reply-To.
// Header safety: every header value has CR/LF removed, non-ASCII header text
// is RFC 2047 encoded, and bodies are base64, so nothing a visitor typed can
// start a new header or a new MIME part.

const enc = new TextEncoder();

function b64(s) {
  let bin = "";
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Removes line breaks and other control characters from a header value. */
export function headerSafe(s) {
  return String(s ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/** RFC 2047 encoded-words, only when the text isn't plain ASCII. Each word
 *  stays under the 75-character limit; characters are never split. */
export function encodeHeader(s) {
  const clean = headerSafe(s);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words = [];
  let chunk = "";
  for (const ch of clean) {
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/** "Name <a@b>" or "a@b" -> "a@b". */
export function addressOnly(a) {
  const m = /<([^>]+)>/.exec(String(a));
  return (m ? m[1] : String(a)).trim();
}

/** An address header value with an optional display name, made safe. */
function addressHeader(a) {
  const s = headerSafe(a);
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(s);
  if (!m) return s;
  const name = m[1].replace(/^"|"$/g, "").trim();
  if (!name) return `<${m[2]}>`;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeHeader(name);
  return `${shown} <${m[2]}>`;
}

function part(type, text) {
  return [
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(text.replace(/\r?\n/g, "\r\n")).replace(/.{76}(?=.)/g, "$&\r\n"),
  ].join("\r\n");
}

/** A text + HTML email as raw MIME. */
export function mime({ from, to, replyTo, subject, text, html }) {
  const domain = addressOnly(from).split("@")[1] ?? "localhost";
  const boundary = `=_pl_${crypto.randomUUID().replace(/-/g, "")}`;
  const headers = [
    `From: ${addressHeader(from)}`,
    `To: ${addressHeader(to)}`,
    ...(replyTo ? [`Reply-To: ${addressHeader(replyTo)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${headerSafe(domain)}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    "",
    `--${boundary}`,
    part("text/plain", text),
    `--${boundary}`,
    part("text/html", html ?? ""),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
