// Regression tests for the last review round (2026-11-10).
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { api, resetAll, rows, makeApp } from "./helpers.js";
import { runHousekeeping, RETENTION_BATCH } from "../src/lib/housekeeping.js";

beforeEach(resetAll);
const DAY = 86400_000;
const ALPHA = "abcdefghijkmnpqrstuvwxyz23456789";
const idOf = (prefix, i) => `${prefix}_${[...i.toString(32).padStart(16, "0")].map((c) => ALPHA[parseInt(c, 32)]).join("")}`;

/** n expired inbox submissions, each with one file; the oldest first. */
async function seedExpired(n, { ageDays = 400, start = 0 } = {}) {
  const stmts = [];
  for (let i = start; i < start + n; i++) {
    const id = idOf("sub", i);
    stmts.push(
      env.DB.prepare("INSERT INTO submissions (id, form_id, created_at, created_ms, data, content_hash) VALUES (?1, 'contact', 'x', ?2, '{}', ?1)").bind(
        id,
        Date.now() - ageDays * DAY + i,
      ),
      env.DB.prepare(
        "INSERT INTO files (id, submission_id, field, name, content_type, size, sha256, r2_key, created_at) VALUES (?1, ?2, 'cv', 'cv.pdf', 'application/pdf', 1, 'x', ?3, 'x')",
      ).bind(idOf("fil", i), id, `f/contact/${id}/k`),
    );
  }
  await env.DB.batch(stmts);
}

/** An R2 stand-in that refuses any delete that includes the bad key. */
function r2Refusing(badKey) {
  const deleted = [];
  return {
    deleted,
    binding: {
      async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.includes(badKey)) throw new Error("R2: internal error");
        deleted.push(...list);
      },
      list: async () => ({ objects: [], truncated: false }),
    },
  };
}

describe("1. one bad file doesn't stall retention", () => {
  it("parks the batch, retries one by one, cleans newer rows past the bad one, and shows it", async () => {
    await seedExpired(RETENTION_BATCH + 5); // 45 expired; the oldest has a file R2 refuses
    const bad = `f/contact/${idOf("sub", 0)}/k`;
    const r2 = r2Refusing(bad);
    const app = () => makeApp({ FILES: r2.binding });

    const first = await runHousekeeping(app(), { force: true });
    expect(first.retention.parked).toBe(RETENTION_BATCH); // the batch with the bad file waits
    for (let i = 0; i < 25; i++) await runHousekeeping(app(), { force: true });

    // Only the bad one is left; everything newer was deleted.
    expect(await rows("SELECT id FROM submissions")).toEqual([{ id: idOf("sub", 0) }]);
    const [w] = await rows("SELECT submission_id, attempts FROM retention_waiting");
    expect(w.submission_id).toBe(idOf("sub", 0));
    expect(w.attempts).toBeGreaterThanOrEqual(1);

    const { data } = await api("GET", "forms", undefined, { FILES: r2.binding });
    expect(data.retention).toMatchObject({ retentionSkipped: 1, expiredNotYetDeleted: 1 });
    expect(data.retention.oldestExpired).toMatch(/^\d{4}-/);
    const forced = await api("POST", "housekeeping", undefined, { FILES: r2.binding });
    expect(forced.data.retentionStatus.retentionSkipped).toBe(1);
  });

  it("a parked submission is deleted once R2 works again", async () => {
    await seedExpired(1);
    const bad = `f/contact/${idOf("sub", 0)}/k`;
    await runHousekeeping(makeApp({ FILES: r2Refusing(bad).binding }), { force: true });
    expect(await rows("SELECT submission_id FROM retention_waiting")).toHaveLength(1);
    await env.DB.prepare("UPDATE retention_waiting SET retry_after = 0").run(); // an hour later
    const ok = r2Refusing("none");
    const r = await runHousekeeping(makeApp({ FILES: ok.binding }), { force: true });
    expect(r.retention.unparked).toBe(1);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);
    expect(await rows("SELECT * FROM retention_waiting")).toHaveLength(0);
  });
});

describe("2. retention problems are kept and shown; a failing sweep page isn't retried forever", () => {
  it("records the failed step's error and clears it when the step next succeeds", async () => {
    const broken = { list: async () => { throw new Error("R2 list failed"); }, delete: async () => {} };
    await runHousekeeping(makeApp({ FILES: broken }), { force: true });
    let { data } = await api("GET", "forms", undefined, { FILES: broken });
    expect(data.retention.problems.sweep.error).toBe("R2 list failed");
    await runHousekeeping(makeApp(), { force: true });
    ({ data } = await api("GET", "forms"));
    expect(data.retention.problems.sweep).toBeUndefined();
  });

  it("keeps the sweep's place for 3 tries, then starts over", async () => {
    await env.DB.prepare("UPDATE state SET value = 'page-7' WHERE key = 'r2_cursor'").run();
    const broken = { list: async () => { throw new Error("bad cursor"); }, delete: async () => {} };
    for (let i = 1; i <= 2; i++) {
      await runHousekeeping(makeApp({ FILES: broken }), { force: true });
      expect((await rows("SELECT value FROM state WHERE key = 'r2_cursor'"))[0].value).toBe("page-7");
    }
    await runHousekeeping(makeApp({ FILES: broken }), { force: true });
    expect((await rows("SELECT value FROM state WHERE key = 'r2_cursor'"))[0].value).toBe("");
    expect((await rows("SELECT value FROM state WHERE key = 'r2_failures'"))[0].value).toBe("0");
  });
});

describe("3. delete by email: 40 per call, then more", () => {
  it("says more: true until everything is gone (what npm run forget loops on)", async () => {
    const stmts = [];
    for (let i = 0; i < 45; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO submissions (id, form_id, created_at, created_ms, data, content_hash, reply_email) VALUES (?1, 'contact', 'x', ?2, '{}', 'h', 'p@example.org')",
        ).bind(idOf("sub", i), Date.now() - 1000 + i),
      );
    }
    await env.DB.batch(stmts);
    const a = await api("DELETE", "submissions?email=p@example.org");
    expect(a.data).toMatchObject({ deleted: 40, more: true });
    const b = await api("DELETE", "submissions?email=p@example.org");
    expect(b.data).toMatchObject({ deleted: 5, more: false });
  });
});
