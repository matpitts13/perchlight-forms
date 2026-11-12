// Lazy housekeeping: notification retries and retention clean-up, with no
// cron trigger (the free plan's 5 per account are mostly used by the rest of
// the family; see docs/adr/0001-lazy-housekeeping-no-cron.md).
//
// Every form post, admin API call and GET /tick may start a run after the
// reply (ctx.waitUntil). A run starts only if the last one was at least
// HOUSEKEEPING_MINUTES ago, decided by one conditional UPDATE on the state
// table, so two requests at once can't both run it, and only if the
// request's budget (src/lib/budget.js) has room for real work, so a post
// whose own notifications used most of it never burns the slot for nothing.
//
// Each run, within what's left of the budget:
//   1. releases stale claims and revives notifications whose submission left
//      the spam folder (one batch);
//   2. retries R2 deletes that failed earlier (pending_deletes);
//   3. if retention is due (hourly) or part-done, runs its next steps, in
//      order, as far as the budget allows, and saves where it got to: the
//      inbox folder, the spam folder, old counters, the R2 orphan sweep.
//      Retention goes before notifications, so it can't be starved;
//   4. sends due notifications with what's left (at most DELIVERIES_PER_RUN).
import { deliverDue, releaseAndRevive } from "./deliveries.js";
import { settings } from "./settings.js";
import { utcDay } from "./http.js";
import { spend, left, COST, MIN_UNIT } from "./budget.js";

export const DELIVERIES_PER_RUN = 4;
export const RETENTION_BATCH = 40;
const RETENTION_EVERY_MS = 3600_000;
const LOCAL_THROTTLE_MS = 15_000;
const ORPHAN_AGE_MS = 3600_000;
const IN_CHUNK = 90; // D1 allows 100 bound parameters per statement
const SWEEP_TRIES = 3; // a sweep page that fails this often in a row is given up and the sweep starts over
const WAIT_RETRY_MS = 3600_000; // a parked submission is retried at most hourly
const WAIT_PER_RUN = 2;

let lastLocal = 0;
/** Tests only: forget this isolate's last check. */
export function resetLocalThrottle() {
  lastLocal = 0;
}

/** Starts a run after the reply, if one is due. Never throws. */
export function maybeHousekeep(app, ctx, now = Date.now()) {
  // Skip even the D1 check if this isolate looked a moment ago.
  if (now - lastLocal < LOCAL_THROTTLE_MS) return;
  // Not enough budget left for real work: don't look (and don't burn the slot).
  if (left(app.budget) < COST.housekeepingBase + MIN_UNIT) return;
  lastLocal = now;
  ctx.waitUntil(
    runHousekeeping(app, { now }).catch((err) => console.error(`housekeeping: ${err instanceof Error ? err.stack : String(err)}`)),
  );
}

/** Claims a timestamp row if it's older than intervalMs. */
async function claimSlot(env, key, intervalMs, now) {
  const r = await env.DB.prepare(
    "UPDATE state SET value = ?2 WHERE key = ?1 AND CAST(value AS INTEGER) <= ?3",
  ).bind(key, String(now), now - intervalMs).run();
  return r.meta.changes === 1;
}

/** The retention steps, in order, with their worst-case cost. */
const STEPS = [
  { name: "inbox", cost: COST.retentionFolder, run: (app, now, out) => retentionFolder(app, now, false, out) },
  { name: "spam", cost: COST.retentionFolder, run: (app, now, out) => retentionFolder(app, now, true, out) },
  { name: "waiting", cost: COST.retentionWaiting, run: (app, now, out) => retentionWaiting(app, now, out) },
  { name: "counters", cost: COST.retentionCounters, run: (app, now) => retentionCounters(app.env, now) },
  { name: "sweep", cost: COST.retentionSweep, run: async (app, now, out) => { if (app.env.FILES) out.orphans = await sweepOrphans(app.env, now); } },
];

/**
 * One housekeeping run. force: ignore the throttle and run retention now
 * (POST /api/housekeeping); the budget still applies.
 * @returns {Promise<{ ran: boolean, budget?: true, revived?: number, pendingDeleted?: number,
 *   retention?: { inbox: number, spam: number, orphans: number, steps: string[], complete: boolean } | null,
 *   deliveries?: { tried: number, sent: number } }>}
 */
export async function runHousekeeping(app, { now = Date.now(), force = false } = {}) {
  const { env } = app;
  const s = settings(env);
  if (left(app.budget) < COST.housekeepingBase + MIN_UNIT) return { ran: false, budget: true };
  spend(app.budget, COST.housekeepingBase);
  if (force) {
    await env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'last_run'").bind(String(now)).run();
  } else if (!(await claimSlot(env, "last_run", s.housekeepingMinutes * 60_000, now))) {
    return { ran: false };
  }
  const result = { ran: true, revived: 0, pendingDeleted: 0, retention: null, deliveries: null };
  try {
    result.revived = await releaseAndRevive(env, now);
    // One read: retention state, whether R2 deletes are pending, whether any notification is due.
    const { results: stateRows } = await env.DB.prepare(
      `SELECT key, value FROM state WHERE key IN ('last_retention', 'retention_step', 'retention_errors')
       UNION ALL SELECT 'pending', COUNT(*) FROM (SELECT 1 FROM pending_deletes LIMIT 1)
       UNION ALL SELECT 'due', COUNT(*) FROM (SELECT 1 FROM deliveries WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?1 LIMIT 1)`,
    ).bind(now).all();
    const state = Object.fromEntries(stateRows.map((r) => [r.key, r.value]));

    if (Number(state.pending) > 0 && env.FILES && spend(app.budget, COST.pending)) {
      result.pendingDeleted = await guarded("pending deletes", () => retryPendingDeletes(env), 0);
    }

    // Due notifications keep one delivery's worth of the budget, so a long
    // retention catch-up never holds retries back; retention still advances
    // with whatever is beyond that.
    const keep = Number(state.due) > 0 ? COST.deliverySelect + COST.delivery + COST.load : 0;
    let step = Math.min(Math.max(Number(state.retention_step) || 0, 0), STEPS.length);
    if (step >= STEPS.length) step = 0;
    const due = force || step > 0 || now - (Number(state.last_retention) || 0) >= RETENTION_EVERY_MS;
    if (due && left(app.budget) - keep >= COST.stateSave + STEPS[step].cost) {
      spend(app.budget, COST.stateSave);
      const retention = { inbox: 0, spam: 0, orphans: 0, parked: 0, unparked: 0, steps: [], failed: [], errors: {}, complete: false };
      result.retention = retention;
      try {
        while (step < STEPS.length && left(app.budget) - keep >= STEPS[step].cost) {
          spend(app.budget, STEPS[step].cost);
          // A step that fails (R2 down, a bad cursor) is logged and passed:
          // it's tried again on the next cycle, and never blocks the rest.
          try {
            await STEPS[step].run(app, now, retention);
            retention.steps.push(STEPS[step].name);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`retention step ${STEPS[step].name}: ${msg}`);
            retention.failed.push(STEPS[step].name);
            retention.errors[STEPS[step].name] = { error: msg.slice(0, 300), at: new Date(now).toISOString() };
            if (STEPS[step].name === "sweep") await sweepFailed(env);
          }
          step++;
        }
      } finally {
        retention.complete = step >= STEPS.length;
        // Problems are kept (per step, newest wins) until that step next succeeds.
        const errors = { ...parseJson(state.retention_errors), ...retention.errors };
        for (const name of retention.steps) delete errors[name];
        await guarded("saving retention progress", () =>
          env.DB.batch([
            ...(retention.complete
              ? [
                  env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'retention_step'"),
                  env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'last_retention'").bind(String(now)),
                ]
              : [env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'retention_step'").bind(String(step))]),
            env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'retention_errors'").bind(JSON.stringify(errors)),
          ]),
        );
      }
    }
  } finally {
    // Whatever happened above, due notifications still get their turn.
    result.deliveries = await guarded("deliveries", () => deliverDue(app, DELIVERIES_PER_RUN, now), { tried: 0, sent: 0 });
  }
  return result;
}

function parseJson(s) {
  try {
    const v = JSON.parse(s ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** A sweep page failed: keep the place for two more tries, then start over. */
async function sweepFailed(env) {
  await guarded("sweep failure count", () =>
    env.DB.batch([
      env.DB.prepare("UPDATE state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'r2_failures'"),
      env.DB.prepare(
        "UPDATE state SET value = '' WHERE key = 'r2_cursor' AND (SELECT CAST(value AS INTEGER) FROM state WHERE key = 'r2_failures') >= ?1",
      ).bind(SWEEP_TRIES),
      env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'r2_failures' AND CAST(value AS INTEGER) >= ?1").bind(SWEEP_TRIES),
    ]),
  );
}

async function guarded(what, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    console.error(`housekeeping, ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/**
 * Deletes R2 objects. Returns the keys that couldn't be deleted (R2 down).
 * With no FILES binding there's nothing in R2 this Worker can reach, so
 * nothing is reported as pending.
 */
async function deleteObjects(env, keys) {
  if (!keys.length || !env.FILES) return [];
  try {
    await env.FILES.delete(keys);
    return [];
  } catch (err) {
    console.error(`R2 delete of ${keys.length} object(s): ${err instanceof Error ? err.message : String(err)}`);
    return keys;
  }
}

async function recordPending(env, keys, now = Date.now()) {
  for (let i = 0; i < keys.length; i += 45) {
    const chunk = keys.slice(i, i + 45); // 2 parameters each: under D1's 100
    await env.DB.prepare(
      `INSERT OR IGNORE INTO pending_deletes (r2_key, created_ms) VALUES ${chunk.map((_, j) => `(?${2 * j + 1}, ?${2 * j + 2})`).join(", ")}`,
    ).bind(...chunk.flatMap((k) => [k, now])).run();
  }
}

/** Retries R2 deletes that failed before. Returns how many went through. */
export async function retryPendingDeletes(env) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM pending_deletes ORDER BY created_ms LIMIT ?1").bind(IN_CHUNK).all();
  if (!results.length || !env.FILES) return 0;
  const keys = results.map((r) => r.r2_key);
  if ((await deleteObjects(env, keys)).length) return 0;
  await env.DB.prepare(`DELETE FROM pending_deletes WHERE r2_key IN (${keys.map((_, j) => `?${j + 1}`).join(", ")})`).bind(...keys).run();
  return keys.length;
}

/**
 * Deletes submissions: R2 files first, then rows (files and deliveries
 * cascade). If R2 can't delete their files:
 * - an erasure (the admin API) still deletes the rows and records the files
 *   in pending_deletes, retried every housekeeping run, and reports them;
 * - scheduled retention (keepRowsOnR2Failure) leaves those rows for a later
 *   run instead, so it never needs the pending-delete writes.
 * @returns {Promise<{ deleted: number, filesPending: number }>}
 */
export async function deleteSubmissions(env, ids, { keepRowsOnR2Failure = false } = {}) {
  let deleted = 0;
  let filesPending = 0;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(", ");
    const { results } = await env.DB.prepare(`SELECT r2_key FROM files WHERE submission_id IN (${marks})`).bind(...chunk).all();
    const failed = await deleteObjects(env, results.map((r) => r.r2_key));
    if (failed.length && keepRowsOnR2Failure) continue;
    if (failed.length) {
      await recordPending(env, failed);
      filesPending += failed.length;
    }
    // RETURNING, not meta.changes: changes also counts the cascaded file and delivery rows.
    const r = await env.DB.prepare(`DELETE FROM submissions WHERE id IN (${marks}) RETURNING id`).bind(...chunk).all();
    deleted += r.results.length;
  }
  return { deleted, filesPending };
}

/** Number of R2 objects still waiting to be deleted. */
export async function pendingDeleteCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_deletes").first();
  return row?.n ?? 0;
}

/** The cut-off for each folder, or null for "keep forever". */
export function retentionCutoffs(env, now = Date.now()) {
  const s = settings(env);
  const DAY = 86400_000;
  return { inbox: s.retentionDays > 0 ? now - s.retentionDays * DAY : null, spam: now - s.spamRetentionDays * DAY };
}

/**
 * Deletes up to RETENTION_BATCH expired submissions of one folder, oldest
 * first, skipping ones parked in retention_waiting. If R2 can't delete their
 * files, the whole batch is parked (kept, with its files) and the next run
 * moves on to newer expired submissions; the "waiting" step then retries the
 * parked ones one by one, so only a submission whose files really can't be
 * deleted keeps waiting.
 */
async function retentionFolder(app, now, spam, out) {
  const { env } = app;
  const cut = retentionCutoffs(env, now)[spam ? "spam" : "inbox"];
  if (cut === null) return; // RETENTION_DAYS=0: keep the inbox until deleted
  const { results } = await env.DB.prepare(
    `SELECT id FROM submissions WHERE status ${spam ? "=" : "!="} 'spam' AND created_ms < ?1
       AND id NOT IN (SELECT submission_id FROM retention_waiting)
     ORDER BY created_ms LIMIT ?2`,
  ).bind(cut, RETENTION_BATCH).all();
  if (!results.length) return;
  const ids = results.map((x) => x.id);
  const r = await deleteSubmissions(env, ids, { keepRowsOnR2Failure: true });
  out[spam ? "spam" : "inbox"] += r.deleted;
  if (r.deleted < ids.length) {
    // Parked: retried one by one by the "waiting" step, starting now.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO retention_waiting (submission_id, since_ms, retry_after, last_error)
       SELECT id, ?1, ?1, 'R2 could not delete its files' FROM submissions WHERE id IN (${ids.map((_, i) => `?${i + 2}`).join(", ")})`,
    ).bind(now, ...ids).run();
    out.parked += ids.length - r.deleted;
  }
}

/** Retries parked submissions one at a time; a failure waits another hour. */
async function retentionWaiting(app, now, out) {
  const { env } = app;
  const { results } = await env.DB.prepare(
    "SELECT submission_id FROM retention_waiting WHERE retry_after <= ?1 ORDER BY retry_after LIMIT ?2",
  ).bind(now, WAIT_PER_RUN).all();
  for (const { submission_id: id } of results) {
    const r = await deleteSubmissions(env, [id], { keepRowsOnR2Failure: true });
    if (r.deleted) out.unparked++; // its retention_waiting row goes with it (cascade)
    else {
      await env.DB.prepare(
        "UPDATE retention_waiting SET retry_after = ?2, attempts = attempts + 1, last_error = 'R2 could not delete its files' WHERE submission_id = ?1",
      ).bind(id, now + WAIT_RETRY_MS).run();
    }
  }
}

/** What GET /api/forms and POST /api/housekeeping show about retention. */
export async function retentionStatus(env, now = Date.now()) {
  const cut = retentionCutoffs(env, now);
  const [oldest, waiting, errors] = await env.DB.batch([
    env.DB.prepare(
      `SELECT MIN(created_ms) AS ms, COUNT(*) AS n FROM submissions
       WHERE (status = 'spam' AND created_ms < ?1) OR (?2 IS NOT NULL AND status != 'spam' AND created_ms < ?2)`,
    ).bind(cut.spam, cut.inbox),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(since_ms) AS since FROM retention_waiting"),
    env.DB.prepare("SELECT value FROM state WHERE key = 'retention_errors'"),
  ]);
  const o = oldest.results[0];
  const w = waiting.results[0];
  return {
    expiredNotYetDeleted: o.n,
    oldestExpired: o.ms ? new Date(o.ms).toISOString() : null,
    retentionSkipped: w.n,
    skippedSince: w.since ? new Date(w.since).toISOString() : null,
    problems: parseJson(errors.results[0]?.value),
  };
}

async function retentionCounters(env, now) {
  const DAY = 86400_000;
  const hourCut = new Date(now - 48 * 3600_000).toISOString().slice(0, 13);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_counters WHERE rowid IN (SELECT rowid FROM rate_counters WHERE hour < ?1 LIMIT 1000)").bind(hourCut),
    env.DB.prepare("DELETE FROM autoreply_sent WHERE rowid IN (SELECT rowid FROM autoreply_sent WHERE sent_ms < ?1 LIMIT 1000)").bind(now - 2 * DAY),
    env.DB.prepare(
      `DELETE FROM deliveries WHERE rowid IN (SELECT rowid FROM deliveries
         WHERE created_ms < ?1 AND status IN ('sent', 'failed', 'unknown', 'skipped') LIMIT 1000)`,
    ).bind(now - 90 * DAY),
    env.DB.prepare("DELETE FROM daily_counts WHERE rowid IN (SELECT rowid FROM daily_counts WHERE day < ?1 LIMIT 1000)").bind(utcDay(now - 400 * DAY)),
  ]);
}

/**
 * R2 files whose submission row is gone: a batch that failed after the files
 * were written, or a row deleted from the desktop app's generic screen.
 * 100 objects per run, resuming from a cursor; only files over an hour old.
 */
async function sweepOrphans(env, now) {
  const cursorRow = await env.DB.prepare("SELECT value FROM state WHERE key = 'r2_cursor'").first();
  const listed = await env.FILES.list({ prefix: "f/", limit: 100, cursor: cursorRow?.value || undefined });
  const old = listed.objects.filter((o) => now - new Date(o.uploaded).getTime() > ORPHAN_AGE_MS).map((o) => o.key);
  const orphans = [];
  for (let i = 0; i < old.length; i += IN_CHUNK) {
    const chunk = old.slice(i, i + IN_CHUNK);
    const { results } = await env.DB.prepare(`SELECT r2_key FROM files WHERE r2_key IN (${chunk.map((_, j) => `?${j + 1}`).join(", ")})`)
      .bind(...chunk)
      .all();
    const known = new Set(results.map((r) => r.r2_key));
    orphans.push(...chunk.filter((k) => !known.has(k)));
  }
  // Orphans R2 refuses to delete now are simply found again on a later sweep.
  if (orphans.length) await deleteObjects(env, orphans);
  await env.DB.batch([
    env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'r2_cursor'").bind(listed.truncated ? listed.cursor : ""),
    env.DB.prepare("UPDATE state SET value = '0' WHERE key = 'r2_failures'"),
  ]);
  return orphans.length;
}
