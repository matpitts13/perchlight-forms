// Lazy housekeeping: notification retries and retention clean-up, with no
// cron trigger (the free plan's 5 per account are mostly used by the rest of
// the family; see docs/adr/0001-lazy-housekeeping-no-cron.md).
//
// Every form post, admin API call and GET /tick may start a run after the
// reply (ctx.waitUntil). A run starts only if the last one was at least
// HOUSEKEEPING_MINUTES ago, decided by one conditional UPDATE on the state
// table, so two requests at once can't both run it. Work per run is bounded
// to stay well inside the free plan's 10 ms CPU and 50 subrequests:
//   - up to DELIVERIES_PER_RUN due notifications, or
//   - once an hour, instead, retention: up to RETENTION_BATCH expired
//     submissions per folder (with their R2 files), old counters, and a
//     100-object sweep of R2 for files whose row is gone.
import { deliverDue, releaseStale, reviveSkipped } from "./deliveries.js";
import { settings } from "./settings.js";
import { utcDay } from "./http.js";
import { spend, COST } from "./budget.js";

export const DELIVERIES_PER_RUN = 4;
export const RETENTION_BATCH = 40;
const RETENTION_EVERY_MS = 3600_000;
const LOCAL_THROTTLE_MS = 15_000;
const ORPHAN_AGE_MS = 3600_000;
const IN_CHUNK = 90; // D1 allows 100 bound parameters per statement

let lastLocal = 0;
/** Tests only: forget this isolate's last check. */
export function resetLocalThrottle() {
  lastLocal = 0;
}

/** Starts a run after the reply, if one is due. Never throws. */
export function maybeHousekeep(app, ctx, now = Date.now()) {
  // Skip even the D1 check if this isolate looked a moment ago.
  if (now - lastLocal < LOCAL_THROTTLE_MS) return;
  lastLocal = now;
  ctx.waitUntil(
    runHousekeeping(app, { now }).catch((err) => console.error(`housekeeping: ${err instanceof Error ? err.stack : String(err)}`)),
  );
}

/** Claims a timestamp row if it's older than intervalMs. */
async function claimSlot(env, key, intervalMs, now) {
  const r = await env.DB.prepare(
    "UPDATE state SET value = CAST(?2 AS TEXT) WHERE key = ?1 AND CAST(value AS INTEGER) <= ?3",
  ).bind(key, now, now - intervalMs).run();
  return r.meta.changes === 1;
}

/**
 * One housekeeping run. force: ignore the throttle (POST /api/housekeeping).
 * @returns {Promise<{ ran: boolean, deliveries?: object, revived?: number, retention?: object | null }>}
 */
export async function runHousekeeping(app, { now = Date.now(), force = false } = {}) {
  const { env } = app;
  const s = settings(env);
  // Not enough left of this request's budget (a post's own notifications
  // came first): the next request runs it.
  if (!spend(app.budget, COST.housekeepingBase)) return { ran: false, budget: true };
  if (force) {
    await env.DB.prepare("UPDATE state SET value = CAST(?1 AS TEXT) WHERE key = 'last_run'").bind(now).run();
  } else if (!(await claimSlot(env, "last_run", s.housekeepingMinutes * 60_000, now))) {
    return { ran: false };
  }
  await releaseStale(env, now);
  const revived = await reviveSkipped(env, now);
  // Retention (hourly) and deliveries take turns, so one run stays at about
  // 25 D1 queries or fewer, even on top of a form post's own work.
  let retention = null;
  let deliveries = null;
  if ((app.budget?.left ?? Infinity) >= COST.retention && (force || (await claimSlot(env, "last_retention", RETENTION_EVERY_MS, now)))) {
    spend(app.budget, COST.retention);
    retention = await runRetention(app, now);
  }
  if (force || !retention) deliveries = await deliverDue(app, DELIVERIES_PER_RUN, now);
  return { ran: true, deliveries, revived, retention };
}

/** Deletes R2 objects; a failure is logged, not thrown, so the rest of the
 *  clean-up goes on. Anything left is found again by the orphan sweep. */
async function deleteObjects(env, keys) {
  try {
    await env.FILES.delete(keys);
  } catch (err) {
    console.error(`R2 delete of ${keys.length} object(s): ${err instanceof Error ? err.message : String(err)}; the orphan sweep will retry`);
  }
}

/** Deletes submissions (R2 files first, then rows; files and deliveries cascade). */
export async function deleteSubmissions(env, ids) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(", ");
    const { results } = await env.DB.prepare(`SELECT r2_key FROM files WHERE submission_id IN (${marks})`).bind(...chunk).all();
    if (results.length && env.FILES) await deleteObjects(env, results.map((r) => r.r2_key));
    // RETURNING, not meta.changes: changes also counts the cascaded file and delivery rows.
    const r = await env.DB.prepare(`DELETE FROM submissions WHERE id IN (${marks}) RETURNING id`).bind(...chunk).all();
    deleted += r.results.length;
  }
  return deleted;
}

export async function runRetention(app, now = Date.now()) {
  const { env } = app;
  const s = settings(env);
  const DAY = 86400_000;
  const out = { inbox: 0, spam: 0, orphans: 0 };

  if (s.retentionDays > 0) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM submissions WHERE status != 'spam' AND created_ms < ?1 ORDER BY created_ms LIMIT ?2",
    ).bind(now - s.retentionDays * DAY, RETENTION_BATCH).all();
    out.inbox = await deleteSubmissions(env, results.map((r) => r.id));
  }
  const { results: spam } = await env.DB.prepare(
    "SELECT id FROM submissions WHERE status = 'spam' AND created_ms < ?1 ORDER BY created_ms LIMIT ?2",
  ).bind(now - s.spamRetentionDays * DAY, RETENTION_BATCH).all();
  out.spam = await deleteSubmissions(env, spam.map((r) => r.id));

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

  if (env.FILES) out.orphans = await sweepOrphans(env, now);
  return out;
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
  if (orphans.length) await deleteObjects(env, orphans);
  await env.DB.prepare("UPDATE state SET value = ?1 WHERE key = 'r2_cursor'").bind(listed.truncated ? listed.cursor : "").run();
  return orphans.length;
}
