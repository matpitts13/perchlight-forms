import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { postForm, postJson, fakeEmail, mockFetch, resetAll, rows, good, makeApp, api, RESEND } from "./helpers.js";
import { deliverDue, deliverSubmission, releaseStale, nextAttempt, WINDOW_MS } from "../src/lib/deliveries.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { hmacHex } from "../src/lib/crypto.js";

beforeEach(resetAll);
const MIN = 60_000;

async function emailDelivery() {
  const [d] = await rows("SELECT * FROM deliveries WHERE channel LIKE 'email:%'");
  return d;
}

describe("retries", () => {
  it("retries a failing email on schedule, gives up after 24 hours, and 'Try again' sends it once", async () => {
    mockFetch();
    const failing = fakeEmail({ fail: "temporary failure" });
    await postForm("contact", good, { env: { EMAIL: failing.binding } });
    let d = await emailDelivery();
    expect(d.status).toBe("retry");
    expect(d.attempts).toBe(1);
    expect(d.last_error).toContain("temporary failure");
    const t0 = d.created_ms;
    expect(d.next_attempt_at - t0).toBeGreaterThanOrEqual(1 * MIN);
    expect(d.next_attempt_at - t0).toBeLessThan(2 * MIN);

    // Not due yet: nothing happens.
    const app = makeApp({ EMAIL: failing.binding });
    expect((await deliverDue(app, 10, t0 + 30_000)).tried).toBe(0);

    // Attempts 2..5 back off 5 min, 30 min, 2 h, 12 h.
    const gaps = [];
    let now = d.next_attempt_at;
    for (let i = 0; i < 4; i++) {
      await deliverDue(app, 10, now);
      d = await emailDelivery();
      expect(d.status).toBe("retry");
      gaps.push((d.next_attempt_at - now) / MIN);
      now = d.next_attempt_at;
    }
    expect(gaps).toEqual([5, 30, 120, 720]);
    // The next failure would land past 24 hours: failed, with the last error.
    await deliverDue(app, 10, now);
    d = await emailDelivery();
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(6);
    expect(d.last_error).toMatch(/^gave up after 24 hours: send_email: temporary failure/);

    // It shows in the failed list; "Try again" (the desktop app sets pending + 0) sends once.
    const listed = await api("GET", "deliveries?status=failed");
    expect(listed.data.deliveries.map((x) => x.id)).toContain(d.id);
    await env.DB.prepare("UPDATE deliveries SET status = 'pending', next_attempt_at = 0 WHERE id = ?1").bind(d.id).run();
    const working = fakeEmail();
    await runHousekeeping(makeApp({ EMAIL: working.binding }), { force: true });
    await runHousekeeping(makeApp({ EMAIL: working.binding }), { force: true });
    expect(working.sent).toHaveLength(1);
    expect((await emailDelivery()).status).toBe("sent");
  });

  it("nextAttempt follows 1, 5, 30, 120, 720 minutes inside the 24-hour window", () => {
    expect([1, 2, 3, 4, 5].map((a) => (nextAttempt(a, 0, 0) ?? 0) / MIN)).toEqual([1, 5, 30, 120, 720]);
    expect(nextAttempt(6, 0, WINDOW_MS - MIN)).toBeNull();
  });

  it("marks a setup problem failed at once with a plain explanation, not retried", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: "E_RECIPIENT_NOT_ALLOWED: destination address not verified" }).binding } });
    const d = await emailDelivery();
    expect(d.status).toBe("failed");
    expect(d.last_error).toContain("verified destination in Email Routing");
  });

  it("explains a missing MAIL_FROM", async () => {
    mockFetch();
    await postForm("contact", good, { env: { MAIL_FROM: "", EMAIL: fakeEmail().binding } });
    expect((await emailDelivery()).last_error).toBe("MAIL_FROM isn't set in wrangler.jsonc.");
  });
});

describe("once per submission", () => {
  it("two overlapping runs never send the same notification twice", async () => {
    mockFetch();
    const failing = fakeEmail({ fail: true });
    await postForm("contact", { ...good, message: "one" }, { env: { EMAIL: failing.binding } });
    await postForm("contact", { ...good, message: "two" }, { env: { EMAIL: failing.binding } });
    const email = fakeEmail();
    const app = makeApp({ EMAIL: email.binding });
    const later = Date.now() + 10 * MIN;
    const [subA] = await rows("SELECT id FROM submissions ORDER BY created_ms LIMIT 1");
    await Promise.all([deliverDue(app, 10, later), deliverDue(app, 10, later), deliverSubmission(app, subA.id, later), deliverDue(app, 10, later)]);
    expect(email.sent).toHaveLength(2);
    const statuses = await rows("SELECT status FROM deliveries WHERE channel LIKE 'email:%'");
    expect(statuses.every((s) => s.status === "sent")).toBe(true);
  });

  it("releases claims left by a run that died; auto-replies become unknown, never resent", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail().binding } });
    const [sub] = await rows("SELECT id FROM submissions");
    const old = Date.now() - 3 * MIN;
    await env.DB.prepare("UPDATE deliveries SET status = 'sending', claimed_at = ?1").bind(old).run();
    await env.DB.prepare(
      "INSERT INTO deliveries (id, submission_id, channel, status, claimed_at, created_ms) VALUES ('dlv_aaaaaaaaaaaaaaaa', ?1, 'autoreply', 'sending', ?2, ?2)",
    ).bind(sub.id, old).run();
    await releaseStale(env);
    const r = await rows("SELECT channel, status FROM deliveries ORDER BY channel");
    expect(r).toEqual([
      { channel: "autoreply", status: "unknown" },
      { channel: "email:me@example.com", status: "retry" },
      { channel: "webhook:discord", status: "retry" },
    ]);
  });
});

describe("spam and 'not spam'", () => {
  it("'not spam' moves it to the inbox and sends the skipped notifications once", async () => {
    const calls = mockFetch();
    const email = fakeEmail();
    await postForm("contact", { ...good, website: "filled" }, { env: { EMAIL: email.binding } });
    const [sub] = await rows("SELECT id FROM submissions");
    expect(email.sent).toHaveLength(0);
    const r = await api("PATCH", `submissions/${sub.id}`, { status: "ok" }, { EMAIL: email.binding });
    expect(r.data).toMatchObject({ ok: true, status: "new", changed: true, notificationsQueued: 2 });
    expect(email.sent).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith("https://discord.com/"))).toHaveLength(1);
    // Doing it again sends nothing more.
    await api("PATCH", `submissions/${sub.id}`, { status: "ok" }, { EMAIL: email.binding });
    await runHousekeeping(makeApp({ EMAIL: email.binding }), { force: true });
    expect(email.sent).toHaveLength(1);
  });

  it("'Back to inbox' from the desktop app (a plain status change) also sends them, on the next housekeeping run", async () => {
    mockFetch();
    const email = fakeEmail();
    await postForm("contact", { ...good, website: "filled" }, { env: { EMAIL: email.binding } });
    await env.DB.prepare("UPDATE submissions SET status = 'new'").run();
    const result = await runHousekeeping(makeApp({ EMAIL: email.binding }), { force: true });
    expect(result.revived).toBe(2);
    expect(email.sent).toHaveLength(1);
  });

  it("marking spam stops notifications that haven't gone out", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: true }).binding } });
    const [sub] = await rows("SELECT id FROM submissions");
    await api("PATCH", `submissions/${sub.id}`, { status: "spam" });
    const email = fakeEmail();
    await runHousekeeping(makeApp({ EMAIL: email.binding }), { now: Date.now() + 10 * MIN, force: true });
    expect(email.sent).toHaveLength(0);
    expect((await emailDelivery()).status).toBe("skipped");
  });
});

describe("webhooks", () => {
  it("Discord can't be made to ping anyone; values are escaped", async () => {
    const calls = mockFetch();
    await postForm("contact", { ...good, message: "@everyone [click](https://evil.test)" }, { env: { EMAIL: fakeEmail().binding } });
    const hook = calls.find((c) => c.url.startsWith("https://discord.com/"));
    const body = JSON.parse(hook.body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain("\\[click\\]\\(https://evil.test\\)");
  });

  it("signs JSON webhooks with HMAC(WEBHOOK_SECRET, timestamp.body)", async () => {
    const calls = mockFetch();
    await postJson("guarded", { email: "a@b.co", message: "hi", "cf-turnstile-response": "tok" }, { env: RESEND });
    const hook = calls.find((c) => c.url === "https://hooks.test/json");
    const h = new Headers(hook.init.headers);
    const ts = h.get("X-Perchlight-Timestamp");
    expect(h.get("X-Perchlight-Signature")).toBe(`sha256=${await hmacHex("test-webhook-secret", `${ts}.${hook.body}`)}`);
    expect(JSON.parse(hook.body)).toMatchObject({ form: "guarded", data: { email: "a@b.co", message: "hi" } });
  });

  it("retries a 500 and fails a 404 with a hint", async () => {
    mockFetch({ webhookStatus: 500 });
    await postForm("contact", { ...good, message: "a" }, { env: { EMAIL: fakeEmail().binding } });
    mockFetch({ webhookStatus: 404 });
    await postForm("contact", { ...good, message: "b" }, { env: { EMAIL: fakeEmail().binding } });
    const r = await rows("SELECT status, last_error FROM deliveries WHERE channel = 'webhook:discord' ORDER BY created_ms, rowid");
    expect(r[0]).toEqual({ status: "retry", last_error: "the webhook answered HTTP 500" });
    expect(r[1].status).toBe("failed");
    expect(r[1].last_error).toContain("check the URL in WEBHOOK_DISCORD_URL");
  });
});

describe("auto-reply", () => {
  const resendSends = (calls) => calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body));

  it("sends the fixed text once, never echoing what the visitor typed", async () => {
    const calls = mockFetch();
    await postJson("guarded", { email: "visitor@example.org", message: "BUY CHEAP STUFF http://spam.test", "cf-turnstile-response": "tok" }, { env: RESEND });
    const sends = resendSends(calls);
    const reply = sends.find((s) => s.to[0] === "visitor@example.org");
    expect(reply.subject).toBe("Thanks, we got your message");
    expect(reply.text).toBe("We'll reply within two working days.");
    expect(JSON.stringify(reply)).not.toContain("CHEAP");
    expect(sends.filter((s) => s.to[0] === "me@example.com")).toHaveLength(1);
  });

  it("at most one per address per 24 hours, and the form's daily cap", async () => {
    const calls = mockFetch();
    await postJson("guarded", { email: "v@example.org", message: "1", "cf-turnstile-response": "t" }, { env: RESEND });
    await postJson("guarded", { email: "v@example.org", message: "2", "cf-turnstile-response": "t" }, { env: RESEND });
    await postJson("guarded", { email: "w@example.org", message: "3", "cf-turnstile-response": "t" }, { env: RESEND });
    await postJson("guarded", { email: "x@example.org", message: "4", "cf-turnstile-response": "t" }, { env: RESEND }); // cap is 2
    const replies = resendSends(calls).filter((s) => s.to[0] !== "me@example.com");
    expect(replies.map((s) => s.to[0])).toEqual(["v@example.org", "w@example.org"]);
    const skipped = await rows("SELECT last_error FROM deliveries WHERE channel = 'autoreply' AND status = 'skipped' ORDER BY created_ms, rowid");
    expect(skipped.map((s) => s.last_error)).toEqual(["already sent one to this address in the last 24 hours", "daily auto-reply cap (2) reached"]);
    // The address is stored only as a keyed hash.
    expect(JSON.stringify(await rows("SELECT * FROM autoreply_sent"))).not.toContain("example.org");
  });

  it("never for spam, nor when Turnstile was unverified", async () => {
    const calls = mockFetch({ turnstile: { hostname: "evil.test" } });
    await postJson("guarded", { email: "v@example.org", "cf-turnstile-response": "t" }, { env: RESEND });
    mockFetch({ turnstile: "down" });
    await postJson("guarded", { email: "w@example.org", "cf-turnstile-response": "t" }, { env: RESEND });
    expect(resendSends(calls).filter((s) => s.to[0] !== "me@example.com")).toHaveLength(0);
    expect(await rows("SELECT id FROM deliveries WHERE channel = 'autoreply'")).toHaveLength(0);
  });

  it("isn't retried on an unknown outcome; a refused one releases its caps", async () => {
    mockFetch({ resendStatus: 502 });
    await postJson("guarded", { email: "v@example.org", "cf-turnstile-response": "t" }, { env: RESEND });
    const [d] = await rows("SELECT status FROM deliveries WHERE channel = 'autoreply'");
    expect(d.status).toBe("unknown");
    expect(await rows("SELECT * FROM autoreply_sent")).toHaveLength(1);

    await resetAll();
    mockFetch({ resendStatus: 422 });
    await postJson("guarded", { email: "v@example.org", "cf-turnstile-response": "t" }, { env: RESEND });
    const [d2] = await rows("SELECT status FROM deliveries WHERE channel = 'autoreply'");
    expect(d2.status).toBe("failed");
    expect(await rows("SELECT * FROM autoreply_sent")).toHaveLength(0);
    expect(await rows("SELECT count FROM daily_counts WHERE kind = 'autoreply'")).toEqual([{ count: 0 }]);
  });
});
