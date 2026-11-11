import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { call, api, postForm, fakeEmail, mockFetch, resetAll, rows, good, makeApp, pdfBytes, SITE } from "./helpers.js";
import { runHousekeeping, maybeHousekeep, resetLocalThrottle, DELIVERIES_PER_RUN } from "../src/lib/housekeeping.js";

beforeEach(resetAll);
const MIN = 60_000;
const DAY = 86400_000;

async function insertSub(id, { status = "new", ageDays = 0 } = {}) {
  const ms = Date.now() - ageDays * DAY;
  await env.DB.prepare(
    "INSERT INTO submissions (id, form_id, created_at, created_ms, status, data, content_hash) VALUES (?1, 'contact', '2026-01-01 00:00:00', ?2, ?3, '{}', ?1)",
  ).bind(id, ms, status).run();
}

describe("lazy housekeeping (no cron)", () => {
  it("runs at most once per HOUSEKEEPING_MINUTES, decided in D1", async () => {
    const app = makeApp();
    const now = Date.now();
    expect((await runHousekeeping(app, { now })).ran).toBe(true);
    expect((await runHousekeeping(app, { now: now + 4 * MIN })).ran).toBe(false);
    expect((await runHousekeeping(app, { now: now + 5 * MIN })).ran).toBe(true);
    // Two at once: only one runs.
    const both = await Promise.all([runHousekeeping(app, { now: now + 20 * MIN }), runHousekeeping(app, { now: now + 20 * MIN })]);
    expect(both.filter((r) => r.ran)).toHaveLength(1);
    // The interval is a setting.
    const quick = makeApp({ HOUSEKEEPING_MINUTES: "1" });
    expect((await runHousekeeping(quick, { now: now + 21 * MIN })).ran).toBe(true);
  });

  it("form posts, admin calls and /tick start it after the reply; a quiet site still retries", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: true }).binding } });
    // Pretend the retry is due and the last run was long ago.
    await env.DB.batch([
      env.DB.prepare("UPDATE deliveries SET next_attempt_at = 0"),
      env.DB.prepare("UPDATE state SET value = '0' WHERE key IN ('last_run', 'last_retention')"),
    ]);
    const email = fakeEmail();
    const tick = await call("/tick", {}, { EMAIL: email.binding });
    expect(tick.status).toBe(204);
    // That run did retention (hourly); the next due run sends.
    await env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'last_run'").run();
    await api("GET", "forms", undefined, { EMAIL: email.binding });
    expect(email.sent).toHaveLength(1);
  });

  it("checks D1 at most every 15 seconds per isolate", async () => {
    const app = makeApp();
    resetLocalThrottle();
    const ctx1 = createExecutionContext();
    maybeHousekeep(app, ctx1);
    await waitOnExecutionContext(ctx1);
    const before = (await rows("SELECT value FROM state WHERE key = 'last_run'"))[0].value;
    await env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'last_run'").run();
    const ctx2 = createExecutionContext();
    maybeHousekeep(app, ctx2); // within 15 s of the first: skipped without a query
    await waitOnExecutionContext(ctx2);
    expect(Number(before)).toBeGreaterThan(0);
    expect((await rows("SELECT value FROM state WHERE key = 'last_run'"))[0].value).toBe("0");
  });

  it(`sends at most ${DELIVERIES_PER_RUN} notifications per run`, async () => {
    mockFetch();
    for (let i = 0; i < 4; i++) await postForm("contact", { ...good, message: `m${i}` }, { env: { EMAIL: fakeEmail({ fail: true }).binding } });
    await env.DB.batch([
      env.DB.prepare("UPDATE deliveries SET next_attempt_at = 0"), // 8 due (email + webhook each)
      env.DB.prepare("UPDATE state SET value = '0' WHERE key IN ('last_run', 'last_retention')"),
    ]);
    const r = await runHousekeeping(makeApp({ EMAIL: fakeEmail().binding }), { now: Date.now() + MIN });
    expect(r.ran).toBe(true);
    // First run of the hour does retention instead; the next one sends.
    expect(r.deliveries).toBeNull();
    const r2 = await runHousekeeping(makeApp({ EMAIL: fakeEmail().binding }), { now: Date.now() + 10 * MIN });
    expect(r2.deliveries.tried).toBe(DELIVERIES_PER_RUN);
  });
});

describe("retention", () => {
  it("deletes inbox after 365 days and spam after 30, with files, keeping the rest", async () => {
    await insertSub("sub_aaaaaaaaaaaaaaaa", { ageDays: 366 });
    await insertSub("sub_bbbbbbbbbbbbbbbb", { ageDays: 364 });
    await insertSub("sub_cccccccccccccccc", { status: "spam", ageDays: 31 });
    await insertSub("sub_dddddddddddddddd", { status: "spam", ageDays: 29 });
    await env.FILES.put("f/contact/sub_aaaaaaaaaaaaaaaa/fil_aaaaaaaaaaaaaaaa", pdfBytes());
    await env.DB.prepare(
      "INSERT INTO files (id, submission_id, field, name, content_type, size, sha256, r2_key, created_at) VALUES ('fil_aaaaaaaaaaaaaaaa', 'sub_aaaaaaaaaaaaaaaa', 'cv', 'cv.pdf', 'application/pdf', 200, 'x', 'f/contact/sub_aaaaaaaaaaaaaaaa/fil_aaaaaaaaaaaaaaaa', '2026-01-01 00:00:00')",
    ).run();
    const r = await runHousekeeping(makeApp(), { force: true });
    expect(r.retention).toMatchObject({ inbox: 1, spam: 1 });
    expect((await rows("SELECT id FROM submissions ORDER BY id")).map((x) => x.id)).toEqual(["sub_bbbbbbbbbbbbbbbb", "sub_dddddddddddddddd"]);
    expect(await rows("SELECT id FROM files")).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("RETENTION_DAYS=0 keeps the inbox until deleted", async () => {
    await insertSub("sub_aaaaaaaaaaaaaaaa", { ageDays: 4000 });
    await runHousekeeping(makeApp({ RETENTION_DAYS: "0" }), { force: true });
    expect(await rows("SELECT id FROM submissions")).toHaveLength(1);
  });

  it("deletes old rate counters and auto-reply hashes", async () => {
    const old = new Date(Date.now() - 49 * 3600_000).toISOString().slice(0, 13);
    const fresh = new Date().toISOString().slice(0, 13);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rate_counters (key, hour, count) VALUES ('a', ?1, 1), ('b', ?2, 1)").bind(old, fresh),
      env.DB.prepare("INSERT INTO autoreply_sent (email_hash, sent_ms) VALUES ('old', ?1), ('new', ?2)").bind(Date.now() - 3 * DAY, Date.now()),
    ]);
    await runHousekeeping(makeApp(), { force: true });
    expect(await rows("SELECT key FROM rate_counters")).toEqual([{ key: "b" }]);
    expect(await rows("SELECT email_hash FROM autoreply_sent")).toEqual([{ email_hash: "new" }]);
  });

  it("sweeps R2 files whose row is gone (over an hour old), leaving ones with rows", async () => {
    const fd = new FormData();
    fd.set("name", "Ada");
    fd.set("email", "a@b.co");
    fd.set("cv", new File([pdfBytes()], "cv.pdf"));
    await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { EMAIL: fakeEmail().binding });
    await env.FILES.put("f/jobs/sub_zzzzzzzzzzzzzzzz/fil_zzzzzzzzzzzzzzzz", pdfBytes());
    const r = await runHousekeeping(makeApp(), { now: Date.now() + 2 * 3600_000, force: true });
    expect(r.retention.orphans).toBe(1);
    const keys = (await env.FILES.list()).objects.map((o) => o.key);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("zzzz");
  });
});
