// Regression tests for the final check (2026-11-10).
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { call, api, postForm, fakeEmail, mockFetch, resetAll, rows, good, makeApp, pdfBytes, SITE, TOKEN } from "./helpers.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";
import { handleAdmin } from "../src/routes/admin.js";
import { COST, newBudget } from "../src/lib/budget.js";

beforeEach(resetAll);
const DAY = 86400_000;

async function failedDelivery() {
  mockFetch();
  await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: true }).binding } });
  await env.DB.prepare("UPDATE deliveries SET next_attempt_at = 0").run();
}

async function insertOldWithFile(id) {
  await env.DB.prepare(
    "INSERT INTO submissions (id, form_id, created_at, created_ms, status, data, content_hash) VALUES (?1, 'contact', 'x', ?2, 'new', '{}', ?1)",
  ).bind(id, Date.now() - 400 * DAY).run();
  await env.DB.prepare(
    "INSERT INTO files (id, submission_id, field, name, content_type, size, sha256, r2_key, created_at) VALUES (?1, ?2, 'cv', 'cv.pdf', 'application/pdf', 1, 'x', ?3, 'x')",
  ).bind(id.replace("sub_", "fil_"), id, `f/contact/${id}/k`).run();
}

describe("1. a failing retention step never blocks retries", () => {
  it("a sweep that always throws: retention still completes, retries go out, and the next run is fine (the cursor is kept for 3 tries, see review4)", async () => {
    await failedDelivery();
    await env.DB.prepare("UPDATE state SET value = 'poisoned-cursor' WHERE key = 'r2_cursor'").run();
    const files = { list: async () => { throw new Error("bad cursor"); }, delete: async () => {}, put: async () => {}, get: async () => null };
    const email = fakeEmail();
    const r = await runHousekeeping(makeApp({ FILES: files, EMAIL: email.binding }), { force: true });
    expect(r.retention.failed).toEqual(["sweep"]);
    expect(r.retention.complete).toBe(true);
    expect((await rows("SELECT value FROM state WHERE key = 'retention_step'"))[0].value).toBe("0");
    expect((await rows("SELECT value FROM state WHERE key = 'r2_failures'"))[0].value).toBe("1");
    expect(r.deliveries.tried).toBeGreaterThan(0);
    expect(email.sent).toHaveLength(1);
    await expect(runHousekeeping(makeApp({ FILES: files, EMAIL: email.binding }), { force: true })).resolves.toMatchObject({ ran: true });
  });

  it("deliveries still run when the retention bookkeeping itself fails", async () => {
    await failedDelivery();
    const realDb = env.DB;
    const db = {
      // Saving retention progress fails; everything else works.
      prepare: (sql) => {
        if (sql.startsWith("UPDATE state") && sql.includes("retention_step")) throw new Error("D1 write failed");
        return realDb.prepare(sql);
      },
      batch: (stmts) => realDb.batch(stmts),
    };
    const files = { list: async () => { throw new Error("R2 down"); }, delete: async () => { throw new Error("R2 down"); } };
    const email = fakeEmail();
    const r = await runHousekeeping(makeApp({ DB: db, FILES: files, EMAIL: email.binding }), { force: true });
    expect(r.deliveries.sent).toBe(1);
  });
});

describe("2. admin calls are charged to the budget", () => {
  it("leaves less for the housekeeping run it starts", async () => {
    const app = { ...makeApp(), budget: newBudget() };
    const ctx = createExecutionContext();
    const req = new Request("https://forms.test/api/submissions?email=x@example.org", { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
    await handleAdmin(req, app, ctx, "submissions");
    await waitOnExecutionContext(ctx);
    expect(app.budget.left).toBeLessThanOrEqual(45 - COST.admin - COST.adminDeleteByEmail);
  });
});

describe("3. retention never needs pending-delete writes", () => {
  it("if R2 can't delete, the expired rows wait for a later run", async () => {
    await insertOldWithFile("sub_aaaaaaaaaaaaaaaa");
    const files = { delete: async () => { throw new Error("R2 down"); }, list: async () => ({ objects: [], truncated: false }) };
    const r = await runHousekeeping(makeApp({ FILES: files }), { force: true });
    expect(r.retention.inbox).toBe(0);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(1);
    expect(await rows("SELECT * FROM pending_deletes")).toHaveLength(0);
    expect(COST.retentionFolder).toBe(5); // 4 + the insert that parks a batch (review4)
  });
});

describe("4. a part-done retention doesn't hold retries back", () => {
  it("keeps one delivery's budget for due notifications", async () => {
    await failedDelivery();
    await env.DB.prepare("UPDATE state SET value = '1' WHERE key = 'retention_step'").run(); // part-done
    const email = fakeEmail();
    const budget = { left: COST.housekeepingBase + COST.stateSave + COST.retentionFolder + COST.deliverySelect + COST.delivery + COST.load };
    const r = await runHousekeeping({ ...makeApp({ EMAIL: email.binding }), budget }, { force: true });
    expect(r.retention.steps).toEqual(["spam"]);
    expect(r.deliveries.tried).toBe(1);
    expect(email.sent).toHaveLength(1);
  });
});

describe("5. no R2 binding: nothing is queued as pending", () => {
  it("deleting a submission whose files can't be reached reports none pending", async () => {
    await insertOldWithFile("sub_bbbbbbbbbbbbbbbb");
    const del = await api("DELETE", "submissions/sub_bbbbbbbbbbbbbbbb", undefined, { FILES: undefined });
    expect(del.data).toMatchObject({ deleted: 1, filesPending: 0 });
    expect(await rows("SELECT * FROM pending_deletes")).toHaveLength(0);
  });
});
