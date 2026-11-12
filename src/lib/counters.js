// Daily counters for refused or dropped posts (invalid, rate_limited,
// spam_dropped, duplicate), kept in memory per isolate and written to D1 at
// most once a minute in one batch. A flood therefore costs one D1 write per
// kind per minute per isolate for these, not one per request. Counts held by
// an isolate that's evicted before its next flush are lost: they're
// statistics, not submissions.
import { utcDay } from "./http.js";

const pending = new Map(); // "day|form|kind" -> n
let lastFlush = 0;

function flushMs(env) {
  const s = String(env.COUNTER_FLUSH_SECONDS ?? "60").trim();
  return /^\d+$/.test(s) ? Number(s) * 1000 : 60_000;
}

/** Counts one event; flushes after the reply if a minute has passed. */
export function countLater(env, ctx, formId, kind, now = Date.now()) {
  const key = `${utcDay(now)}|${formId}|${kind}`;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  if (now - lastFlush >= flushMs(env)) {
    lastFlush = now;
    ctx.waitUntil(flushCounters(env).catch((err) => console.error(`counters: ${err instanceof Error ? err.message : String(err)}`)));
  }
}

/** Writes what's held in memory; on failure it's kept for the next flush. */
export async function flushCounters(env) {
  if (!pending.size) return 0;
  const items = [...pending.entries()].slice(0, 40);
  for (const [k] of items) pending.delete(k);
  try {
    await env.DB.batch(
      items.map(([k, n]) => {
        const [day, form, kind] = k.split("|");
        return env.DB.prepare(
          `INSERT INTO daily_counts (day, form_id, kind, count) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(day, form_id, kind) DO UPDATE SET count = count + excluded.count`,
        ).bind(day, form, kind, n);
      }),
    );
  } catch (err) {
    for (const [k, n] of items) pending.set(k, (pending.get(k) ?? 0) + n);
    throw err;
  }
  return items.length;
}

/** Tests only. */
export function resetCounters() {
  pending.clear();
  lastFlush = 0;
}

// Networks already over their hourly limit, refused from memory without a
// D1 write. Cleared when the hour changes.
const blocked = new Set();
let blockedHour = "";

export function isBlocked(key, hour) {
  if (hour !== blockedHour) {
    blocked.clear();
    blockedHour = hour;
  }
  return blocked.has(key);
}

export function block(key, hour) {
  if (hour !== blockedHour) {
    blocked.clear();
    blockedHour = hour;
  }
  if (blocked.size > 10000) blocked.clear();
  blocked.add(key);
}

export function resetBlocked() {
  blocked.clear();
  blockedHour = "";
}
