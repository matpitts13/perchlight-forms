import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import shipped from "../forms.json";
import { checkForms } from "../src/lib/forms.js";
import { sniff, checkFileType, cleanFileName } from "../src/lib/filetypes.js";
import { rateKey, networkOf, contentHash, scoreSpam } from "../src/lib/spam.js";
import { csvCell } from "../src/routes/admin.js";
import { mime, encodeHeader } from "../src/lib/mime.js";
import { signedFileUrl, verifyFileLink } from "../src/lib/links.js";
import { ownerEmail, webhookFormat, subjectName, replyToOf } from "../src/lib/notify.js";
import { TEST_FORMS } from "./helpers.js";

const info = { r2: true, turnstile: true, autoReply: true, linkSecret: true, webhook: () => true };
const base = { origins: ["https://example.com"], fields: { email: { type: "email", required: true } } };
const errorOf = (def, i = info) => checkForms({ f: def }, i).get("f").error;

describe("forms config", () => {
  it("the shipped forms.json is valid", () => {
    const r = checkForms(shipped, { ...info, webhook: () => false });
    expect([...r.values()].map((x) => [x.id, x.ok, x.error])).toEqual([["contact", true, null]]);
  });

  it("switches off a form with each kind of mistake, naming it", () => {
    expect(errorOf({ ...base, redirect: "https://evil.test/thanks" })).toContain('"redirect" must be on one of "origins"');
    expect(errorOf({ ...base, errorRedirect: "javascript:alert(1)" })).toContain("errorRedirect");
    expect(errorOf({ ...base, origins: ["https://example.com/"] })).toContain("isn't an origin");
    expect(errorOf({ ...base, origins: ["http://example.com"] })).toContain("isn't an origin");
    expect(errorOf({ ...base, fields: { x: { type: "colour" } } })).toContain('unknown type "colour"');
    expect(errorOf({ ...base, fields: { cv: { type: "file" } } }, { ...info, r2: false })).toContain("FILES R2 binding");
    expect(errorOf({ ...base, fields: { cv: { type: "file" } } }, { ...info, linkSecret: false })).toContain("LINK_SECRET");
    expect(errorOf({ ...base, fields: { cv: { type: "file", types: ["exe"] } } })).toContain('"exe" isn\'t allowed');
    expect(errorOf({ ...base, notify: { webhooks: ["slack"] } }, { ...info, webhook: () => false })).toContain("WEBHOOK_SLACK_URL");
    expect(errorOf({ ...base, spam: { turnstile: true } }, { ...info, turnstile: false })).toContain("TURNSTILE_SECRET_KEY");
    expect(errorOf({ ...base, fields: { "cf-turnstile-response": { type: "text" } } })).toContain("reserved");
    expect(errorOf({ ...base, fields: { "1x": { type: "text" } } })).toContain("names are");
    expect(errorOf({ ...base, fields: { website: { type: "text" } } })).toContain("reserved");
    expect(errorOf({ ...base, replyTo: "name" })).toContain('"replyTo"');
    expect(errorOf({ ...base, fields: { t: { type: "select" } } })).toContain("options");
    expect(errorOf({ ...base, fields: { c: { type: "consent" } } })).toContain("version");
    expect(errorOf({ ...base, maxBodyMB: 200 })).toContain("maxBodyMB");
  });

  it("auto-reply needs Turnstile, a reply field and an email service", () => {
    const a = { subject: "Thanks", text: "Got it" };
    expect(errorOf({ ...base, autoReply: a })).toContain("needs \"spam.turnstile\" on");
    expect(errorOf({ ...base, spam: { turnstile: true }, autoReply: a }, { ...info, autoReply: false })).toContain("MAIL_PROVIDER");
    expect(errorOf({ origins: base.origins, fields: { name: { type: "text" } }, spam: { turnstile: true }, autoReply: a })).toContain("replyTo");
    expect(errorOf({ ...base, spam: { turnstile: true }, autoReply: a })).toBeNull();
  });

  it("applies the defaults from the SDD", () => {
    const f = checkForms({ f: { ...base, fields: { a: { type: "text" }, b: { type: "textarea" }, cv: { type: "file" } } } }, info).get("f").form;
    expect(f.fields.a.max).toBe(500);
    expect(f.fields.b.max).toBe(5000);
    expect(f.maxBodyBytes).toBe(10 * 1024 * 1024);
    expect(f.spam).toMatchObject({ honeypot: "website", minSeconds: 3, maxLinks: 2, perHour: 5, turnstile: false });
    expect(f.extraFields).toBe("keep");
    const small = checkForms({ f: base }, info).get("f").form;
    expect(small.maxBodyBytes).toBe(64 * 1024);
  });

  it("one bad form leaves the others working", () => {
    const r = checkForms(TEST_FORMS, info);
    expect(r.get("broken").ok).toBe(false);
    expect(r.get("contact").ok).toBe(true);
  });
});

describe("file types by first bytes", () => {
  const enc = (s) => new TextEncoder().encode(s);
  it("detects common types and refuses HTML, SVG and executables", () => {
    expect(sniff(enc("%PDF-1.4 ..."))).toBe("pdf");
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniff(enc("GIF89a..."))).toBe("gif");
    expect(sniff(enc("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(sniff(enc("plain text, ünïcode"))).toBe("text");
    expect(sniff(enc("  <!DOCTYPE html><script>"))).toBeNull();
    expect(sniff(enc("<svg xmlns=...>"))).toBeNull();
    expect(sniff(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBeNull();
    expect(sniff(new Uint8Array([0xc3, 0x28]))).toBeNull(); // not UTF-8
  });

  it("needs the content and the extension to agree", () => {
    expect(checkFileType("cv.pdf", enc("%PDF-1.4"), ["pdf"])).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(checkFileType("cv.docx", new Uint8Array([0x50, 0x4b, 3, 4]), ["pdf", "docx"]).ok).toBe(true);
    expect(checkFileType("cv.pdf", new Uint8Array([0x50, 0x4b, 3, 4]), ["pdf", "docx"]).ok).toBe(false);
    expect(checkFileType("photo.JPEG", new Uint8Array([0xff, 0xd8, 0xff]), ["jpg"]).ok).toBe(true);
    expect(checkFileType("cv", enc("%PDF-"), ["pdf"]).ok).toBe(false);
  });

  it("cleans names: no paths, no control characters, at most 200 characters", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\x\\a\r\nb.pdf")).toBe("ab.pdf");
    expect(cleanFileName("")).toBe("file");
    const long = cleanFileName(`${"n".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("rate-limit keys and hashes", () => {
  it("the same IP gives different keys on different days and for different forms", async () => {
    const a = await rateKey("salt", "2026-11-10", "contact", "203.0.113.5");
    expect(await rateKey("salt", "2026-11-10", "contact", "203.0.113.5")).toBe(a);
    expect(await rateKey("salt", "2026-11-11", "contact", "203.0.113.5")).not.toBe(a);
    expect(await rateKey("salt", "2026-11-10", "jobs", "203.0.113.5")).not.toBe(a);
    expect(await rateKey("other-salt", "2026-11-10", "contact", "203.0.113.5")).not.toBe(a);
    expect(a).not.toContain("203");
  });

  it("groups IPv6 by /64", () => {
    expect(networkOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0");
    expect(networkOf("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2");
    expect(networkOf("192.0.2.1")).toBe("192.0.2.1");
  });

  it("content hashes ignore field order", async () => {
    expect(await contentHash("f", { a: "1", b: "2" }, null)).toBe(await contentHash("f", { b: "2", a: "1" }, null));
    expect(await contentHash("f", { a: "1" }, null)).not.toBe(await contentHash("g", { a: "1" }, null));
  });

  it("scores hard and soft reasons", () => {
    const form = checkForms({ f: base }, info).get("f").form;
    const sub = { data: { email: "a@b.co" }, extra: null, honeypot: "", elapsedMs: null };
    expect(scoreSpam(form, sub, { origin: "https://example.com", turnstile: null })).toEqual({ spam: false, reasons: [] });
    expect(scoreSpam(form, { ...sub, honeypot: "x" }, { origin: "https://example.com", turnstile: null }).spam).toBe(true);
    expect(scoreSpam(form, sub, { origin: "null", turnstile: { result: "unverified" } })).toEqual({ spam: true, reasons: ["no origin", "turnstile unverified"] });
    expect(scoreSpam(form, { ...sub, data: { m: "[url=x] href=y www.z" } }, { origin: "https://example.com", turnstile: null }).reasons).toEqual(["3 links"]);
  });
});

describe("CSV", () => {
  it("prefixes formula characters and quotes what needs quoting", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(["a", "b"])).toBe("a; b");
  });
});

describe("email safety", () => {
  it("visitor text can't add headers or MIME parts", () => {
    const raw = mime({
      from: "Forms <forms@example.com>",
      to: "me@example.com",
      replyTo: "x@example.com\r\nBcc: victim@example.com",
      subject: "Hi\r\nBcc: victim@example.com",
      text: "body\r\n--boundary\r\nContent-Type: text/html",
      html: "<b>x</b>",
    });
    const headers = raw.split("\r\n\r\n")[0];
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toContain("Subject: Hi Bcc: victim@example.com");
    expect(raw).not.toContain("Content-Type: text/html\r\n\r\n<b>"); // bodies are base64
    expect(raw).toContain("Content-Transfer-Encoding: base64");
  });

  it("encodes non-ASCII subjects as RFC 2047 words under 76 characters", () => {
    const enc = encodeHeader("Nouveau message de Zoë Ångström — ".repeat(3));
    for (const word of enc.split("\r\n ")) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it("the subject's name is one line of at most 60 characters; Reply-To only for one clean address", () => {
    const form = checkForms(TEST_FORMS, info).get("contact").form;
    expect(subjectName(form, { name: `Eve\r\nBcc: x@y.z ${"a".repeat(100)}` })).toHaveLength(60);
    expect(subjectName(form, { name: "Eve\r\nBcc" })).toBe("Eve Bcc");
    expect(replyToOf(form, { email: "a@b.co" })).toBe("a@b.co");
    expect(replyToOf(form, { email: "a@b.co, c@d.co" })).toBeNull();
    expect(replyToOf(form, { email: "a@b.co\r\nBcc: c@d.co" })).toBeNull();
  });

  it("escapes HTML in the notification body", () => {
    const form = checkForms(TEST_FORMS, info).get("contact").form;
    const e = ownerEmail(form, { id: "sub_x", created_at: "2026-11-10 12:00:00", data: { name: "<img src=x onerror=alert(1)>", email: "a@b.co", message: "<script>x</script>" }, extra: { "<k>": "<v>" } }, []);
    expect(e.html).not.toContain("<img");
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).toContain("&lt;k&gt;: &lt;v&gt;");
    expect(e.subject).toBe("[Contact form] New message from <img src=x onerror=alert(1)>"); // header-encoded later, never HTML
  });

  it("picks the webhook format from the URL", () => {
    expect(webhookFormat("https://discord.com/api/webhooks/1/x")).toBe("discord");
    expect(webhookFormat("https://hooks.slack.com/services/x")).toBe("slack");
    expect(webhookFormat("https://ntfy.sh/topic")).toBe("ntfy");
    expect(webhookFormat("https://example.com/hook")).toBe("json");
    expect(webhookFormat("https://example.com/hook", "slack")).toBe("slack");
  });
});

describe("signed links", () => {
  const id = "fil_abcdefghijkmnpqr";
  it("work until they expire and fail if anything is changed", async () => {
    const now = Date.now();
    const { url } = await signedFileUrl(env, "https://forms.test", id, 900, now);
    const u = new URL(url);
    const exp = u.searchParams.get("exp");
    const sig = u.searchParams.get("sig");
    expect(await verifyFileLink(env, id, exp, sig, now)).toBe(true);
    expect(await verifyFileLink(env, id, exp, sig, now + 901_000)).toBe(false);
    expect(await verifyFileLink(env, id, String(Number(exp) + 60), sig, now)).toBe(false);
    expect(await verifyFileLink(env, "fil_abcdefghijkmnpqs", exp, sig, now)).toBe(false);
    expect(await verifyFileLink(env, id, exp, sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now)).toBe(false);
    expect(await verifyFileLink({ ...env, LINK_SECRET: "another-secret-0123456789" }, id, exp, sig, now)).toBe(false);
    expect(await verifyFileLink({ ...env, LINK_SECRET: "short" }, id, exp, sig, now)).toBe(false);
  });
});
