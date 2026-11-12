// Regression tests for the second review (2026-11-10).
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { call, api, postJson, fakeEmail, mockFetch, resetAll, rows, makeApp, pdfBytes, SITE, TOKEN } from "./helpers.js";
import { COST, MIN_UNIT, SUBREQUEST_BUDGET, deliveryReserve } from "../src/lib/budget.js";
import { MAX_CHANNELS, MAX_FILES } from "../src/lib/forms.js";
import { runHousekeeping } from "../src/lib/housekeeping.js";

beforeEach(resetAll);
const DAY = 86400_000;

function busyPost(i, emailBinding) {
  const fd = new FormData();
  fd.set("email", `v${i}@example.org`);
  fd.set("message", `post ${i}`);
  for (let k = 0; k < 5; k++) fd.append("cv", new File([pdfBytes(100 + i * 10 + k)], `cv${k}.pdf`));
  return call("/f/busy", { method: "POST", headers: { Origin: SITE, Accept: "application/json", "CF-Connecting-IP": `192.0.2.${i}` }, body: fd }, { EMAIL: emailBinding });
}

async function insertOld(id, status, ageDays) {
  await env.DB.prepare(
    "INSERT INTO submissions (id, form_id, created_at, created_ms, status, data, content_hash) VALUES (?1, 'busy', '2025-01-01 00:00:00', ?2, ?3, '{}', ?1)",
  ).bind(id, Date.now() - ageDays * DAY, status).run();
}

describe("1. housekeeping from posts alone, on a 4-channel form with 5 files", () => {
  it("the worst-case post still leaves room for a useful housekeeping run", () => {
    const post = COST.post + MAX_FILES * COST.file + deliveryReserve(MAX_CHANNELS, true);
    expect(SUBREQUEST_BUDGET - post).toBeGreaterThanOrEqual(COST.housekeepingBase + MIN_UNIT);
  });

  it("retries and the 365-day retention eventually run with no admin calls or /tick", async () => {
    mockFetch();
    // An old post whose notifications failed and are now due again.
    const failing = await busyPost(0, fakeEmail({ fail: true }).binding);
    const oldId = (await failing.json()).id;
    await env.DB.prepare("UPDATE deliveries SET next_attempt_at = 0 WHERE submission_id = ?1").bind(oldId).run();
    // Things retention must delete.
    await insertOld("sub_aaaaaaaaaaaaaaaa", "new", 400);
    await insertOld("sub_bbbbbbbbbbbbbbbb", "spam", 40);
    // An hour has passed since the last retention run: it's due again.
    await env.DB.prepare("UPDATE state SET value = '0' WHERE key IN ('last_retention', 'retention_step')").run();

    const email = fakeEmail();
    let i = 1;
    for (; i <= 6; i++) {
      // 5 minutes pass between posts.
      await env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'last_run'").run();
      const res = await busyPost(i, email.binding);
      expect(res.status).toBe(200);
      const left = await rows("SELECT id FROM submissions WHERE id IN ('sub_aaaaaaaaaaaaaaaa', 'sub_bbbbbbbbbbbbbbbb')");
      const oldEmails = await rows("SELECT status FROM deliveries WHERE submission_id = ?1 AND channel LIKE 'email:%'", oldId);
      if (!left.length && oldEmails.some((d) => d.status === "sent")) break;
    }
    expect(i).toBeLessThanOrEqual(4);
    expect(await rows("SELECT id FROM submissions WHERE id IN ('sub_aaaaaaaaaaaaaaaa', 'sub_bbbbbbbbbbbbbbbb')")).toHaveLength(0);
  });

  it("doesn't claim the slot when there's no budget for real work", async () => {
    const r = await runHousekeeping({ ...makeApp(), budget: { left: COST.housekeepingBase + MIN_UNIT - 1 } });
    expect(r).toEqual({ ran: false, budget: true });
    expect((await rows("SELECT value FROM state WHERE key = 'last_run'"))[0].value).toBe("0");
  });

  it("retention runs in steps across runs and saves where it got to", async () => {
    await insertOld("sub_aaaaaaaaaaaaaaaa", "new", 400);
    const app = () => ({ ...makeApp(), budget: { left: COST.housekeepingBase + COST.pending + COST.stateSave + COST.retentionFolder } });
    const a = await runHousekeeping(app(), { force: true });
    expect(a.retention).toMatchObject({ steps: ["inbox"], complete: false, inbox: 1 });
    expect((await rows("SELECT value FROM state WHERE key = 'retention_step'"))[0].value).toBe("1");
    const b = await runHousekeeping(app(), { force: true });
    expect(b.retention.steps).toEqual(["spam"]);
    await runHousekeeping({ ...makeApp() }, { force: true });
    expect((await rows("SELECT value FROM state WHERE key = 'retention_step'"))[0].value).toBe("0");
  });
});

describe("2. erasure reports files R2 couldn't delete, and retries them", () => {
  it("returns filesPending and finishes on the next housekeeping run", async () => {
    const fd = new FormData();
    fd.set("name", "Ada");
    fd.set("email", "ada@example.org");
    fd.set("cv", new File([pdfBytes()], "cv.pdf"));
    const posted = await (await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { EMAIL: fakeEmail().binding })).json();
    const realFiles = env.FILES;
    const brokenR2 = { delete: async () => { throw new Error("R2 down"); }, list: (o) => realFiles.list(o), get: (k) => realFiles.get(k), put: (...a) => realFiles.put(...a) };
    const del = await api("DELETE", `submissions/${posted.id}`, undefined, { FILES: brokenR2 });
    expect(del.data).toMatchObject({ ok: true, deleted: 1, filesPending: 1 });
    expect(del.data.warning).toContain("couldn't be deleted from R2 yet");
    expect(await rows("SELECT r2_key FROM pending_deletes")).toHaveLength(1);
    expect((await api("GET", "forms")).data.filesPendingDelete).toBe(1);

    const r = await runHousekeeping(makeApp(), { force: true });
    expect(r.pendingDeleted).toBe(1);
    expect(await rows("SELECT r2_key FROM pending_deletes")).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("delete by email reports filesPending too", async () => {
    const fd = new FormData();
    fd.set("name", "Ada");
    fd.set("email", "ada@example.org");
    fd.set("cv", new File([pdfBytes()], "cv.pdf"));
    await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { EMAIL: fakeEmail().binding });
    const brokenR2 = { delete: async () => { throw new Error("R2 down"); } };
    const del = await api("DELETE", "submissions?email=ada@example.org", undefined, { FILES: brokenR2 });
    expect(del.data).toMatchObject({ deleted: 1, filesPending: 1 });
  });
});

describe("3. exports are paged, never silently cut", () => {
  async function seed(n) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      const id = `sub_${[...i.toString(32).padStart(16, "0")].map((c) => "abcdefghijkmnpqrstuvwxyz23456789"[parseInt(c, 32)]).join("")}`;
      stmts.push(
        env.DB.prepare("INSERT INTO submissions (id, form_id, created_at, created_ms, data, content_hash) VALUES (?1, 'contact', 'x', ?2, ?3, 'h')").bind(
          id,
          Date.now() - 100_000 + i, // recent: retention mustn't delete them mid-test
          JSON.stringify({ name: `n${i}` }),
        ),
      );
    }
    await env.DB.batch(stmts);
  }
  const get = (qs) => call(`/api/export?${qs}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  it("follows X-Next-Cursor to the end, every row once", async () => {
    await seed(103);
    const ids = [];
    let qs = "format=json&limit=50";
    let pages = 0;
    for (;;) {
      const res = await get(qs);
      const page = await res.json();
      ids.push(...page.map((r) => r.id));
      pages++;
      const next = res.headers.get("X-Next-Cursor");
      if (!next) break;
      expect(res.headers.get("Link")).toContain("rel=\"next\"");
      qs = `format=json&limit=50&cursor=${encodeURIComponent(next)}`;
    }
    expect(pages).toBe(3);
    expect(ids).toHaveLength(103);
    expect(new Set(ids).size).toBe(103);
  });

  it("caps a page at 1,000 rows and says there's more", async () => {
    await seed(1001);
    const res = await get("format=csv&form=contact&limit=5000");
    const text = await res.text();
    expect(text.trim().split("\r\n")).toHaveLength(1001); // header + 1,000 rows
    expect(res.headers.get("X-Next-Cursor")).toBeTruthy();
  });

  it("a database error mid-stream aborts the download instead of ending it cleanly", async () => {
    await seed(5);
    const realDb = env.DB;
    let calls = 0;
    const flaky = {
      prepare: (sql) => {
        calls++;
        if (sql.startsWith("SELECT * FROM submissions")) throw new Error("D1 went away");
        return realDb.prepare(sql);
      },
      batch: (s) => realDb.batch(s),
    };
    const res = await call("/api/export?format=json", { headers: { Authorization: `Bearer ${TOKEN}` } }, { DB: flaky });
    await expect(res.text()).rejects.toThrow();
    expect(calls).toBeGreaterThan(0);
  });
});

describe("4-6. counts", () => {
  it("4. /api/forms says which counts are approximate", async () => {
    const { data } = await api("GET", "forms");
    expect(data.countsNote).toContain("approximate");
  });

  it("6. an R2 failure is counted", async () => {
    const files = { put: async () => { throw new Error("R2 unavailable"); }, delete: async () => {} };
    const fd = new FormData();
    fd.set("name", "Ada");
    fd.set("email", "ada@example.org");
    fd.set("cv", new File([pdfBytes()], "cv.pdf"));
    await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { FILES: files });
    expect(await rows("SELECT count FROM daily_counts WHERE kind = 'file_failed'")).toEqual([{ count: 1 }]);
  });

  it("5. the sweep's cost covers two IN (...) chunks for 100 keys", () => {
    expect(COST.retentionSweep).toBe(6);
  });
});
