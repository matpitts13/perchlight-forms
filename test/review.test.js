// Regression tests for the independent review's findings (2026-11-10), one block per item.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { call, postForm, postJson, fakeEmail, brokenDb, mockFetch, resetAll, rows, good, makeApp, pdfBytes, SITE, TEST_FORMS } from "./helpers.js";
import { checkForms, MAX_CHANNELS } from "../src/lib/forms.js";
import { checkSubmission } from "../src/lib/parse.js";
import { scoreSpam } from "../src/lib/spam.js";
import { truncateBytes, webhookRequest } from "../src/lib/notify.js";
import { deliver, deliverSubmission } from "../src/lib/deliveries.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { countLater, flushCounters } from "../src/lib/counters.js";
import { FALLBACK_MAX_PER_HOUR } from "../src/routes/submit.js";
import { formsFor } from "../src/app.js";

beforeEach(resetAll);

const info = { r2: true, turnstile: true, autoReply: true, linkSecret: true, webhook: () => true };
const base = { origins: [SITE], fields: { email: { type: "email", required: true } } };
const errorOf = (def) => checkForms({ f: def }, info).get("f").error;

function cvForm(bytes, name = "cv.pdf") {
  const fd = new FormData();
  fd.set("name", "Ada");
  fd.set("email", "ada@example.org");
  fd.set("cv", new File([bytes], name));
  return fd;
}

describe("1. duplicate channels and constraint errors", () => {
  it("refuses a repeated notify address (any case) or webhook name", () => {
    expect(errorOf({ ...base, notify: { email: ["me@example.com", "ME@Example.com"] } })).toContain("listed twice");
    expect(errorOf({ ...base, notify: { webhooks: ["discord", "Discord"] } })).toContain("listed twice");
  });

  it("a constraint error is retried with fresh ids, not treated as D1 being down", async () => {
    mockFetch();
    const email = fakeEmail();
    const realDb = env.DB;
    let failed = false;
    const flaky = {
      prepare: (...a) => realDb.prepare(...a),
      batch: async (stmts) => {
        if (!failed) {
          failed = true;
          throw new Error("D1_ERROR: UNIQUE constraint failed: submissions.id: SQLITE_CONSTRAINT");
        }
        return realDb.batch(stmts);
      },
    };
    const errors = vi.spyOn(console, "error");
    const { status, data } = await postJson("contact", good, { env: { DB: flaky, EMAIL: email.binding } });
    expect(status).toBe(200);
    expect(data.saved).toBeUndefined();
    expect(await rows("SELECT id FROM submissions")).toEqual([{ id: data.id }]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("not an outage"))).toBe(true);
  });
});

describe("2. duplicates include attachments", () => {
  it("a resubmission with a corrected file is stored; the same file collapses", async () => {
    const send = (bytes) => call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: cvForm(bytes) }, { EMAIL: fakeEmail().binding });
    const a = await (await send(pdfBytes(200))).json();
    const b = await (await send(pdfBytes(300))).json();
    const c = await (await send(pdfBytes(300))).json();
    expect(b.id).not.toBe(a.id);
    expect(c.id).toBe(b.id);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(2);
  });
});

describe("3. fallback while D1 is down", () => {
  it("never emails a spam-flagged post", async () => {
    const email = fakeEmail();
    const res = await postJson("contact", good, { origin: "https://other.test", env: { DB: brokenDb(), EMAIL: email.binding } });
    expect(res.status).toBe(503);
    expect(email.sent).toHaveLength(0);
  });

  it(`sends at most ${FALLBACK_MAX_PER_HOUR} fallback emails an hour per isolate, then answers 503`, async () => {
    const email = fakeEmail();
    const statuses = [];
    for (let i = 0; i <= FALLBACK_MAX_PER_HOUR; i++) {
      statuses.push((await postJson("contact", { ...good, message: `m${i}` }, { env: { DB: brokenDb(), EMAIL: email.binding } })).status);
    }
    expect(email.sent).toHaveLength(FALLBACK_MAX_PER_HOUR);
    expect(statuses.filter((s) => s === 200)).toHaveLength(FALLBACK_MAX_PER_HOUR);
    expect(statuses.at(-1)).toBe(503);
  });
});

describe("4. subrequest budget", () => {
  it("caps channels and files per form so one post fits", () => {
    expect(errorOf({ ...base, notify: { email: ["a@x.co", "b@x.co", "c@x.co", "d@x.co", "e@x.co"] } })).toContain(`at most ${MAX_CHANNELS} notification channels`);
    expect(errorOf({ ...base, fields: { a: { type: "file", maxCount: 3 }, b: { type: "file", maxCount: 3 } } })).toContain("at most 5 files");
  });

  it("stops at the budget and leaves the rest for the next run", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: true }).binding } });
    await env.DB.prepare("UPDATE deliveries SET next_attempt_at = 0, status = 'pending'").run();
    const [sub] = await rows("SELECT id FROM submissions");
    const email = fakeEmail();
    const app = { ...makeApp({ EMAIL: email.binding }), budget: { left: 6 } }; // the select + one delivery (3 + loading the submission 2)
    const out = await deliverSubmission(app, sub.id);
    expect(out).toHaveLength(1);
    expect((await rows("SELECT status FROM deliveries WHERE status = 'pending'"))).toHaveLength(1);
  });

  it("a housekeeping run with too little budget doesn't start", async () => {
    const r = await runHousekeeping({ ...makeApp(), budget: { left: 2 } });
    expect(r).toEqual({ ran: false, budget: true });
  });

  it("a D1 error while claiming or finishing doesn't throw", async () => {
    const app = makeApp({ DB: brokenDb() });
    await expect(deliver(app, { id: "dlv_x", submission_id: "sub_x", channel: "email:a@b.co", attempts: 0, created_ms: 0 })).resolves.toBeNull();
  });
});

describe("5. R2 failing", () => {
  it("tells the visitor the file wasn't saved, and stores nothing", async () => {
    const files = { put: async () => { throw new Error("R2 unavailable"); }, delete: async () => {}, get: async () => null, list: async () => ({ objects: [] }) };
    const res = await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: cvForm(pdfBytes()) }, { FILES: files, EMAIL: fakeEmail().binding });
    expect(res.status).toBe(503);
    expect((await res.json()).errors._form).toContain("couldn't save your attached file");
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);
    const html = await call("/f/jobs", { method: "POST", redirect: "manual", headers: { Origin: SITE }, body: cvForm(pdfBytes(), "b.pdf") }, { FILES: files });
    expect(html.status).toBe(503);
  });
});

describe("6. fewer writes in a flood", () => {
  it("refused-post counters are held in memory and written in one batch", async () => {
    const ctx = createExecutionContext();
    const slow = { ...env, COUNTER_FLUSH_SECONDS: "60" };
    for (let i = 0; i < 5; i++) countLater(slow, ctx, "contact", "invalid");
    await waitOnExecutionContext(ctx);
    expect(await rows("SELECT count FROM daily_counts WHERE kind = 'invalid'")).toEqual([{ count: 1 }]); // first one flushed at once
    await flushCounters(slow);
    expect(await rows("SELECT count FROM daily_counts WHERE kind = 'invalid'")).toEqual([{ count: 5 }]);
  });

  it("a network over its hourly limit is refused from memory, without a D1 write", async () => {
    mockFetch();
    const headers = { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < 7; i++) {
      await call("/f/contact", { method: "POST", headers, body: JSON.stringify({ ...good, message: `n${i}` }) }, { EMAIL: fakeEmail().binding });
    }
    const [counter] = await rows("SELECT count FROM rate_counters");
    expect(counter.count).toBe(6); // the 7th never reached D1
  });
});

describe("7. R2 delete failing during clean-up", () => {
  it("logs and carries on; the expired rows wait for a run where R2 works (changed after the final check)", async () => {
    await env.DB.prepare(
      "INSERT INTO submissions (id, form_id, created_at, created_ms, status, data, content_hash) VALUES ('sub_aaaaaaaaaaaaaaaa', 'contact', '2026-01-01 00:00:00', 0, 'spam', '{}', 'h')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO files (id, submission_id, field, name, content_type, size, sha256, r2_key, created_at) VALUES ('fil_aaaaaaaaaaaaaaaa', 'sub_aaaaaaaaaaaaaaaa', 'cv', 'cv.pdf', 'application/pdf', 1, 'x', 'f/k', 'x')",
    ).run();
    const files = { delete: async () => { throw new Error("R2 down"); }, list: async () => ({ objects: [], truncated: false }) };
    const r = await runHousekeeping(makeApp({ FILES: files }), { force: true });
    expect(r.ran).toBe(true);
    expect(r.retention.complete).toBe(true);
    expect(r.retention.spam).toBe(0);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(1);
  });
});

describe("8-13. smaller fixes", () => {
  it("8. refuses numbers too long to store", async () => {
    const form = checkForms({ f: { ...base, fields: { n: { type: "number" } } } }, info).get("f").form;
    const r = await checkSubmission(form, [["n", "9".repeat(400)]], false);
    expect(r.errors.n).toBe("number");
    expect((await checkSubmission(form, [["n", "12.5"]], false)).data.n).toBe(12.5);
  });

  it("9. checks the Turnstile action when the form names one", () => {
    expect(errorOf({ ...base, spam: { turnstileAction: "contact" } })).toContain("needs \"spam.turnstile\" on");
    const form = checkForms({ f: { ...base, spam: { turnstile: true, turnstileAction: "contact" } } }, info).get("f").form;
    const sub = { data: {}, extra: null, honeypot: "", elapsedMs: null };
    const ok = scoreSpam(form, sub, { origin: SITE, turnstile: { result: "passed", hostname: "example.com", action: "contact" } });
    expect(ok.spam).toBe(false);
    const other = scoreSpam(form, sub, { origin: SITE, turnstile: { result: "passed", hostname: "example.com", action: "login" } });
    expect(other).toEqual({ spam: true, reasons: ["turnstile action login"] });
  });

  it("10. ntfy bodies are cut by UTF-8 bytes, never inside a character", () => {
    const cut = truncateBytes("é😀".repeat(1000), 3900);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(3900);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(cut.endsWith("😀") || cut.endsWith("é")).toBe(true);
  });

  it("11. a switched-off form still answers its own origins with CORS", async () => {
    const pre = await call("/f/broken", { method: "OPTIONS", headers: { Origin: SITE } });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    const { res, status } = await postJson("broken", { name: "x" });
    expect(status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("12. JSON webhooks need a WEBHOOK_SECRET of 16+ characters", async () => {
    const form = checkForms(TEST_FORMS, info).get("guarded").form;
    const sub = { id: "sub_x", created_at: "x", data: {}, extra: null };
    expect((await webhookRequest({ WEBHOOK_SECRET: "short" }, "json", form, sub, [])).error).toContain("16+");
    expect((await webhookRequest({ WEBHOOK_SECRET: "x".repeat(16) }, "json", form, sub, [])).body).toBeTruthy();
  });

  it("13. the config is checked once per isolate env", () => {
    const e = { ...env };
    expect(formsFor(TEST_FORMS, e)).toBe(formsFor(TEST_FORMS, e));
    expect(formsFor(TEST_FORMS, { ...env })).not.toBe(formsFor(TEST_FORMS, e));
  });
});
