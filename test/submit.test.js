import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { call, postForm, postJson, fakeEmail, brokenDb, mockFetch, resetAll, rows, good, pdfBytes, ORIGIN, SITE, RESEND } from "./helpers.js";

beforeEach(resetAll);

describe("plain HTML form posts", () => {
  it("stores the submission and sends the browser to the configured thank-you page", async () => {
    mockFetch();
    const email = fakeEmail();
    const res = await postForm("contact", good, { env: { EMAIL: email.binding } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://example.com/thanks/");
    const [sub] = await rows("SELECT * FROM submissions");
    expect(sub.status).toBe("new");
    expect(JSON.parse(sub.data)).toEqual(good);
    expect(sub.reply_email).toBe("ada@example.org");
    expect(sub.summary).toContain("Hello there");
    expect(sub.origin).toBe(SITE);
    expect(email.sent).toHaveLength(1); // after the reply, once
  });

  it("uses the built-in thank-you page when no redirect is configured", async () => {
    const res = await postForm("strict", { email: "a@b.co", consent: "on" }, { env: { EMAIL: fakeEmail().binding } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/thanks/?form=strict`);
  });

  it("sends a missing required field to the problem page, which names it, and stores nothing", async () => {
    const res = await postForm("contact", { ...good, email: "" });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("Location"));
    expect(loc.pathname).toBe("/problem/");
    expect(loc.searchParams.get("e")).toBe("email:required");
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);

    const page = await call(`${loc.pathname}${loc.search}`, { headers: { Referer: "https://example.com/contact/" } });
    const html = await page.text();
    expect(html).toContain("<li>Email is required</li>");
    expect(html).toContain('href="https://example.com/contact/"');
  });

  it("the problem page never shows visitor text or links to other sites", async () => {
    const page = await call("/problem/?form=contact&e=<script>:required,name:<b>x</b>,message:too_long", { headers: { Referer: "https://evil.test/" } });
    const html = await page.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x");
    expect(html).toContain("Message is too long (at most 5000 characters)");
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain('id="back"');
  });

  it("refuses a field over its maximum length and an option not in the list", async () => {
    const res = await postForm("contact", { ...good, name: "x".repeat(201), topic: "Hacking" });
    const e = new URL(res.headers.get("Location")).searchParams.get("e");
    expect(e).toContain("name:too_long");
    expect(e).toContain("topic:option");
  });

  it("refuses bodies that aren't valid UTF-8", async () => {
    const res = await call("/f/contact", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: SITE },
      body: "name=%FF%FE&email=a%40b.co&message=hi",
    });
    expect(new URL(res.headers.get("Location")).searchParams.get("e")).toBe("_:encoding");
  });

  it("never redirects anywhere the request asks (no _next)", async () => {
    mockFetch();
    const res = await postForm("contact", { ...good, _next: "https://evil.test/" }, { env: { EMAIL: fakeEmail().binding } });
    expect(res.headers.get("Location")).toBe("https://example.com/thanks/");
  });

  it("answers 404 for an unknown form and 503 for one with a config mistake", async () => {
    expect((await postForm("nope", good)).status).toBe(404);
    const res = await postForm("broken", { name: "x" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("isn't set up correctly");
  });

  it("answers 503 until IP_SALT is set, rather than storing a guessable hash", async () => {
    const res = await postForm("contact", good, { env: { IP_SALT: "" } });
    expect(res.status).toBe(503);
  });
});

describe("JSON and CORS", () => {
  it("answers JSON with CORS for an allowed origin", async () => {
    mockFetch();
    const { res, status, data } = await postJson("contact", good, { env: { EMAIL: fakeEmail().binding } });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.id).toMatch(/^sub_/);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("gives field errors as JSON with 422", async () => {
    const { status, data, res } = await postJson("contact", { name: "Ada" });
    expect(status).toBe(422);
    expect(data).toEqual({ ok: false, errors: { email: "Email is required", message: "Message is required" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("answers a form body with Accept: application/json in JSON", async () => {
    mockFetch();
    const res = await call(
      "/f/contact",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Origin: SITE }, body: new URLSearchParams(good).toString() },
      { EMAIL: fakeEmail().binding },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("answers preflights with CORS only for the form's origins", async () => {
    const ok = await call("/f/contact", { method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(ok.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Accept");
    const other = await call("/f/contact", { method: "OPTIONS", headers: { Origin: "https://other.test" } });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sends no CORS header to another origin, and files what it sent as spam", async () => {
    const { res, data } = await postJson("contact", good, { origin: "https://other.test" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(data.ok).toBe(true);
    const [sub] = await rows("SELECT status, spam_reasons, origin FROM submissions");
    expect(sub.status).toBe("spam");
    expect(JSON.parse(sub.spam_reasons)).toContain("sent from https://other.test");
    expect(sub.origin).toBeNull();
  });

  it("refuses unsupported content types", async () => {
    const res = await call("/f/contact", { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: "hi" });
    expect(res.status).toBe(415);
  });
});

describe("limits", () => {
  it("refuses a body over the form's limit with 413, counted while reading", async () => {
    const { status, data } = await postJson("contact", { ...good, message: "x".repeat(70 * 1024) });
    expect(status).toBe(413);
    expect(data.errors._form).toContain("too big");
  });

  it("rate limits the 6th submission an hour from one network with a visible 429, storing no IP", async () => {
    mockFetch();
    const email = fakeEmail();
    const ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) {
      const r = await call(
        "/f/contact",
        { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": ip }, body: JSON.stringify({ ...good, message: `message number ${i}` }) },
        { EMAIL: email.binding },
      );
      expect(r.status).toBe(200);
    }
    const sixth = await call(
      "/f/contact",
      { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": ip }, body: JSON.stringify({ ...good, message: "one more" }) },
      { EMAIL: email.binding },
    );
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).errors._form).toContain("try again in an hour");
    // Another network is unaffected.
    const other = await call(
      "/f/contact",
      { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": "198.51.100.1" }, body: JSON.stringify({ ...good, message: "different network" }) },
      { EMAIL: email.binding },
    );
    expect(other.status).toBe(200);
    // No IP address anywhere in D1.
    for (const table of ["submissions", "rate_counters", "daily_counts", "deliveries", "state"]) {
      const dump = JSON.stringify(await rows(`SELECT * FROM ${table}`));
      expect(dump).not.toContain(ip);
      expect(dump).not.toContain("198.51.100.1");
    }
    const [counted] = await rows("SELECT count FROM daily_counts WHERE kind = 'rate_limited'");
    expect(counted.count).toBe(1);
  });
});

describe("spam checks and the spam folder", () => {
  it("a filled honeypot gets the normal thank-you, is stored as spam and notifies no one", async () => {
    const email = fakeEmail();
    const res = await postForm("contact", { ...good, website: "http://spam.test" }, { env: { EMAIL: email.binding } });
    expect(res.headers.get("Location")).toBe("https://example.com/thanks/");
    const [sub] = await rows("SELECT id, status, spam_reasons FROM submissions");
    expect(sub.status).toBe("spam");
    expect(JSON.parse(sub.spam_reasons)).toContain("honeypot");
    expect(email.sent).toHaveLength(0);
    const deliveries = await rows("SELECT status FROM deliveries WHERE submission_id = ?1", sub.id);
    expect(deliveries.map((d) => d.status)).toEqual(["skipped", "skipped"]);
  });

  it("two soft reasons make spam; one doesn't", async () => {
    mockFetch();
    const email = fakeEmail();
    // Too fast + links.
    await postForm("contact", { ...good, message: "see https://a.test https://b.test https://c.test", _elapsed: "800" }, { env: { EMAIL: email.binding } });
    // Only a blocked word.
    await postForm("contact", { ...good, message: "Do you sell cheap pills?" }, { env: { EMAIL: email.binding } });
    // No origin + blocked word (default list).
    await postForm("contact", { ...good, message: "We offer SEO services" }, { origin: null, env: { EMAIL: email.binding } });
    const subs = await rows("SELECT status, spam_reasons FROM submissions ORDER BY created_ms, rowid");
    expect(subs.map((s) => s.status)).toEqual(["spam", "new", "spam"]);
    expect(JSON.parse(subs[0].spam_reasons)).toEqual(["sent 0.8s after the page opened", "3 links"]);
    expect(JSON.parse(subs[1].spam_reasons)).toEqual(["blocked word: cheap pills"]);
    expect(JSON.parse(subs[2].spam_reasons)).toEqual(["no origin", "blocked word: seo services"]);
  });

  it("skips the time check without the snippet's _elapsed", async () => {
    mockFetch();
    await postForm("contact", { ...good, message: "see https://a.test https://b.test https://c.test" }, { env: { EMAIL: fakeEmail().binding } });
    const [sub] = await rows("SELECT status, spam_reasons FROM submissions");
    expect(sub.status).toBe("new");
    expect(JSON.parse(sub.spam_reasons)).toEqual(["3 links"]);
  });

  it("collapses the same content within 10 minutes into one submission, notified once", async () => {
    mockFetch();
    const email = fakeEmail();
    const a = await postJson("contact", good, { env: { EMAIL: email.binding } });
    const b = await postJson("contact", good, { env: { EMAIL: email.binding } });
    expect(b.data.id).toBe(a.data.id);
    const subs = await rows("SELECT duplicate_count FROM submissions");
    expect(subs).toEqual([{ duplicate_count: 1 }]);
    expect(email.sent).toHaveLength(1);
  });

  it("past the daily spam cap, spam is only counted, not stored; real messages are never capped", async () => {
    mockFetch();
    const capped = { SPAM_DAILY_CAP: "2", EMAIL: fakeEmail().binding };
    for (let i = 0; i < 4; i++) {
      const r = await postForm("contact", { ...good, message: `spam ${i}`, website: "x" }, { env: capped });
      expect(r.headers.get("Location")).toBe("https://example.com/thanks/"); // the bot learns nothing
    }
    const ok = await postForm("contact", { ...good, message: "a real one" }, { env: capped });
    expect(ok.status).toBe(303);
    const counts = await rows("SELECT status, COUNT(*) AS n FROM submissions GROUP BY status ORDER BY status");
    expect(counts).toEqual([{ status: "new", n: 1 }, { status: "spam", n: 2 }]);
    const [dropped] = await rows("SELECT count FROM daily_counts WHERE kind = 'spam_dropped'");
    expect(dropped.count).toBe(2);
  });

  it("uses the 1,000 a day default cap", async () => {
    await env.DB.prepare("INSERT INTO daily_counts (day, form_id, kind, count) VALUES (?1, '*', 'spam_cap', 999)").bind(new Date().toISOString().slice(0, 10)).run();
    await postForm("contact", { ...good, message: "spam a", website: "x" });
    await postForm("contact", { ...good, message: "spam b", website: "x" });
    expect(await rows("SELECT id FROM submissions")).toHaveLength(1);
    const [dropped] = await rows("SELECT count FROM daily_counts WHERE kind = 'spam_dropped'");
    expect(dropped.count).toBe(1);
  });

  it("keeps fields not in the config, cut short and flagged; a form can drop them instead", async () => {
    mockFetch();
    await postForm("contact", { ...good, company: "y".repeat(1500), phone: "123" }, { env: { EMAIL: fakeEmail().binding } });
    const [sub] = await rows("SELECT extra FROM submissions");
    const extra = JSON.parse(sub.extra);
    expect(extra.company).toHaveLength(1000);
    expect(extra.phone).toBe("123");
    await postForm("strict", { email: "a@b.co", consent: "on", company: "z" }, { env: { EMAIL: fakeEmail().binding } });
    const [strict] = await rows("SELECT extra, consent_version, consent_at FROM submissions WHERE form_id = 'strict'");
    expect(strict.extra).toBeNull();
    expect(strict.consent_version).toBe("2026-11");
    expect(strict.consent_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("requires a required consent box to be ticked", async () => {
    const { status, data } = await postJson("strict", { email: "a@b.co" });
    expect(status).toBe(422);
    expect(data.errors.consent).toBe('Please tick "Consent"');
  });
});

describe("Turnstile", () => {
  it("shows a failed, expired or reused token as a problem to fix, and stores nothing", async () => {
    mockFetch({ turnstile: "fail" });
    const { status, data } = await postJson("guarded", { email: "a@b.co", "cf-turnstile-response": "used-token" }, { env: RESEND });
    expect(status).toBe(422);
    expect(data.errors._form).toBe("Please complete the check and send again.");
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);
  });

  it("a missing token fails without calling Cloudflare", async () => {
    const calls = mockFetch();
    const { status } = await postJson("guarded", { email: "a@b.co" }, { env: RESEND });
    expect(status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("records passed, and files a token from someone else's site as spam", async () => {
    mockFetch({ turnstile: { hostname: "example.com" } });
    await postJson("guarded", { email: "a@b.co", "cf-turnstile-response": "tok" }, { env: RESEND });
    mockFetch({ turnstile: { hostname: "evil.test" } });
    await postJson("guarded", { email: "c@d.co", "cf-turnstile-response": "tok" }, { env: RESEND });
    const subs = await rows("SELECT status, turnstile, spam_reasons FROM submissions ORDER BY created_ms, rowid");
    expect(subs[0]).toMatchObject({ status: "new", turnstile: "passed" });
    expect(subs[1].status).toBe("spam");
    expect(JSON.parse(subs[1].spam_reasons)).toContain("turnstile token from evil.test");
  });

  it("goes on as unverified (a soft reason) when Cloudflare can't be reached", async () => {
    mockFetch({ turnstile: "down" });
    const { status } = await postJson("guarded", { email: "a@b.co", "cf-turnstile-response": "tok" }, { env: RESEND });
    expect(status).toBe(200);
    const [sub] = await rows("SELECT status, turnstile, spam_reasons FROM submissions");
    expect(sub).toMatchObject({ status: "new", turnstile: "unverified" });
    expect(JSON.parse(sub.spam_reasons)).toEqual(["turnstile unverified"]);
  });
});

describe("file uploads", () => {
  function multipart(fields, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    if (file) fd.set("cv", new File([file.bytes], file.name, { type: file.type ?? "application/octet-stream" }));
    return fd;
  }

  it("stores a PDF in R2 (never public) with its row, and links it in the email", async () => {
    const email = fakeEmail();
    const res = await call(
      "/f/jobs",
      { method: "POST", redirect: "manual", headers: { Origin: SITE }, body: multipart({ name: "Ada", email: "ada@example.org" }, { bytes: pdfBytes(), name: "C:\\Users\\ada\\My CV.pdf" }) },
      { EMAIL: email.binding },
    );
    expect(res.status).toBe(303);
    const [file] = await rows("SELECT * FROM files");
    expect(file.name).toBe("My CV.pdf");
    expect(file.content_type).toBe("application/pdf");
    expect(file.size).toBe(200);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.r2_key).toMatch(/^f\/jobs\/sub_[a-z0-9]+\/fil_[a-z0-9]+$/);
    const obj = await env.FILES.get(file.r2_key);
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(pdfBytes());
    expect(email.sent).toHaveLength(1);
  });

  it("refuses a renamed .exe, a wrong extension and a file over the size limit, with a message", async () => {
    const exe = new Uint8Array(100);
    exe.set([0x4d, 0x5a]);
    const cases = [
      [{ bytes: exe, name: "cv.pdf" }, "cv:file_type"],
      [{ bytes: pdfBytes(), name: "cv.exe" }, "cv:file_type"],
      [{ bytes: new TextEncoder().encode("<svg onload=alert(1)>"), name: "cv.pdf" }, "cv:file_type"],
      [{ bytes: pdfBytes(110 * 1024), name: "cv.pdf" }, "cv:file_big"],
    ];
    for (const [file, code] of cases) {
      const res = await call("/f/jobs", { method: "POST", redirect: "manual", headers: { Origin: SITE }, body: multipart({ name: "Ada", email: "a@b.co" }, file) });
      expect(new URL(res.headers.get("Location")).searchParams.get("e")).toBe(code);
    }
    expect(await rows("SELECT id FROM files")).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("requires a required file and switches off a file form without R2", async () => {
    const res = await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: multipart({ name: "Ada", email: "a@b.co" }) });
    expect((await res.json()).errors.cv).toBe("Cv: please attach a file");
    const off = await call("/f/jobs", { method: "POST", headers: { Origin: SITE }, body: multipart({ name: "Ada", email: "a@b.co" }) }, { FILES: undefined });
    expect(off.status).toBe(503);
  });
});

describe("when D1 can't be written", () => {
  it("emails the submission straight to you and only then says thanks", async () => {
    const email = fakeEmail();
    const res = await postForm("contact", good, { env: { DB: brokenDb(), EMAIL: email.binding } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://example.com/thanks/");
    expect(email.sent).toHaveLength(1);
  });

  it("answers 503 naming FALLBACK_CONTACT if the email can't go either", async () => {
    const email = fakeEmail({ fail: true });
    const res = await postForm("contact", good, { env: { DB: brokenDb(), EMAIL: email.binding } });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("save your message");
    expect(html).toContain("help@example.com");
    const j = await postJson("contact", good, { env: { DB: brokenDb(), EMAIL: email.binding } });
    expect(j.status).toBe(503);
    expect(j.data.errors._form).toContain("help@example.com");
  });

  it("falls back when only the final write fails", async () => {
    const email = fakeEmail();
    const realDb = env.DB;
    const flaky = { prepare: (...a) => realDb.prepare(...a), batch: async () => { throw new Error("D1_ERROR: write failed"); } };
    const { status, data } = await postJson("contact", good, { env: { DB: flaky, EMAIL: email.binding } });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, id: null, saved: false });
    expect(email.sent).toHaveLength(1);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);
  });

  it("deletes files already written to R2 when the rows can't be", async () => {
    const realDb = env.DB;
    const flaky = { prepare: (...a) => realDb.prepare(...a), batch: async () => { throw new Error("D1_ERROR: write failed"); } };
    const fd = new FormData();
    fd.set("name", "Ada");
    fd.set("email", "a@b.co");
    fd.set("cv", new File([pdfBytes()], "cv.pdf"));
    const res = await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { DB: flaky, EMAIL: fakeEmail({ fail: true }).binding });
    expect(res.status).toBe(503);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });
});
