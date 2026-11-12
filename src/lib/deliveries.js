// Sending notifications, once per submission per channel.
// Claim-then-send: a row is claimed with a conditional UPDATE (status
// pending/retry -> sending) and only the caller whose UPDATE changed it
// sends. Afterwards the row is finished with another conditional UPDATE that
// matches only its own claim, so a stale claim released by someone else is
// never overwritten. A failed send releases its claim (status retry).
import { getSender, canAutoReply } from "./senders/index.js";
import { ownerEmail, webhookRequest, webhookFormat, autoReplyEmail } from "./notify.js";
import { signedFileUrl, linkSecretOk } from "./links.js";
import { settings } from "./settings.js";
import { hmacHex } from "./crypto.js";
import { sqlTime, utcDay } from "./http.js";
import { spend, left, COST } from "./budget.js";

export const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
export const WINDOW_MS = 24 * 3600_000;
export const STALE_MS = 2 * 60_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** Loads a submission with parsed JSON columns and its files. */
export async function loadSubmission(env, id) {
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id = ?1").bind(id).first();
  if (!row) return null;
  const { results: files } = await env.DB.prepare(
    "SELECT id, field, name, content_type, size, sha256, r2_key, created_at FROM files WHERE submission_id = ?1 ORDER BY created_at, id",
  ).bind(id).all();
  return {
    ...row,
    data: JSON.parse(row.data),
    extra: row.extra ? JSON.parse(row.extra) : null,
    spam_reasons: row.spam_reasons ? JSON.parse(row.spam_reasons) : null,
    files,
  };
}

async function claim(env, id, now) {
  const r = await env.DB.prepare(
    `UPDATE deliveries SET status = 'sending', claimed_at = ?2, attempts = attempts + 1
     WHERE id = ?1 AND status IN ('pending', 'retry') AND next_attempt_at <= ?2`,
  ).bind(id, now).run();
  return r.meta.changes === 1;
}

async function finish(env, id, claimedAt, { status, nextAt = 0, error = null, sent = false }) {
  await env.DB.prepare(
    `UPDATE deliveries SET status = ?3, next_attempt_at = ?4, last_error = ?5, claimed_at = NULL,
       sent_at = CASE WHEN ?6 THEN ?7 ELSE sent_at END
     WHERE id = ?1 AND status = 'sending' AND claimed_at = ?2`,
  ).bind(id, claimedAt, status, nextAt, error ? String(error).slice(0, 500) : null, sent ? 1 : 0, sqlTime()).run();
}

/** When to try again, or null if that would be past the 24-hour window. */
export function nextAttempt(attempts, windowStart, now) {
  const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
  const at = now + minutes * 60_000;
  return at > windowStart + WINDOW_MS ? null : at;
}

export async function sendWebhook(env, name, configured, form, sub, files) {
  const url = String(env[`WEBHOOK_${name.toUpperCase()}_URL`] ?? "");
  if (!/^https:\/\//.test(url)) return { status: "config", error: `Set the secret WEBHOOK_${name.toUpperCase()}_URL (an https URL).` };
  const req = await webhookRequest(env, webhookFormat(url, configured), form, sub, files);
  if ("error" in req) return { status: "config", error: req.error };
  try {
    const res = await fetch(url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
    if (res.ok) return { status: "sent" };
    const error = `the webhook answered HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) return { status: "retry", error };
    return { status: "config", error: `${error}; check the URL in WEBHOOK_${name.toUpperCase()}_URL` };
  } catch (err) {
    return { status: "retry", error: `webhook unreachable: ${errText(err)}` };
  }
}

async function fileList(app, form, sub) {
  const s = settings(app.env);
  const withLinks = form.notify.fileLinks && linkSecretOk(app.env);
  const list = [];
  let expires = null;
  for (const f of sub.files) {
    if (withLinks) {
      const link = await signedFileUrl(app.env, app.base, f.id, s.fileLinkHours * 3600);
      expires = link.expiresAt;
      list.push({ name: f.name, size: f.size, url: link.url });
    } else list.push({ name: f.name, size: f.size });
  }
  return { list, expires };
}

/** Claims and sends an auto-reply's caps, releasing them if nothing was sent. */
async function sendAutoReply(app, form, sub, delivery, now) {
  const { env } = app;
  if (!form.autoReply) return { status: "skipped", error: "auto-reply is off for this form" };
  if (!canAutoReply(env)) return { status: "skipped", error: "auto-reply needs MAIL_PROVIDER set to an email service" };
  if (sub.status === "spam") return { status: "skipped", error: "never sent for spam" };
  if (sub.turnstile !== "passed") return { status: "skipped", error: "sent only when Turnstile passed" };
  if (!sub.reply_email) return { status: "skipped", error: "no reply address" };
  const got = getSender(env);
  if ("error" in got) return { status: "config", error: got.error };

  // At most one per address per 24 hours, by a keyed hash of the address.
  const emailHash = await hmacHex(env.IP_SALT, `autoreply:${sub.reply_email}`);
  const perAddress = await env.DB.prepare(
    `INSERT INTO autoreply_sent (email_hash, sent_ms) VALUES (?1, ?2)
     ON CONFLICT(email_hash) DO UPDATE SET sent_ms = excluded.sent_ms WHERE autoreply_sent.sent_ms < ?3
     RETURNING sent_ms`,
  ).bind(emailHash, now, now - WINDOW_MS).first();
  if (!perAddress) return { status: "skipped", error: "already sent one to this address in the last 24 hours" };
  const day = utcDay(now);
  const perDay = await env.DB.prepare(
    `INSERT INTO daily_counts (day, form_id, kind, count) VALUES (?1, ?2, 'autoreply', 1)
     ON CONFLICT(day, form_id, kind) DO UPDATE SET count = count + 1 WHERE daily_counts.count < ?3
     RETURNING count`,
  ).bind(day, form.id, form.autoReply.dailyCap).first();
  const release = async (all) => {
    const stmts = [env.DB.prepare("DELETE FROM autoreply_sent WHERE email_hash = ?1 AND sent_ms = ?2").bind(emailHash, now)];
    if (all) {
      stmts.push(
        env.DB.prepare("UPDATE daily_counts SET count = count - 1 WHERE day = ?1 AND form_id = ?2 AND kind = 'autoreply' AND count > 0").bind(day, form.id),
      );
    }
    await env.DB.batch(stmts);
  };
  if (!perDay) {
    await release(false);
    return { status: "skipped", error: `daily auto-reply cap (${form.autoReply.dailyCap}) reached` };
  }

  const msg = autoReplyEmail(form);
  let result;
  try {
    result = await got.sender.send({ to: sub.reply_email, ...msg, headers: {} }, { idempotencyKey: delivery.id });
  } catch (err) {
    result = { status: "unknown", error: errText(err) };
  }
  if (result.status === "sent") return { status: "sent" };
  // Never retried on an unknown outcome: a visitor must not get two.
  if (result.status === "unknown" || result.status === "conflict") return { status: "unknown", error: result.error };
  await release(true);
  return result;
}

/** Sends one claimed delivery and returns what happened. */
async function attempt(app, delivery, sub, now) {
  const form = app.forms.get(sub.form_id)?.form;
  if (!form) return { status: "config", error: `form "${sub.form_id}" isn't in forms.json (or is switched off)` };
  if (sub.status === "spam") return { status: "skipped" };
  if (delivery.channel === "autoreply") return sendAutoReply(app, form, sub, delivery, now);

  const { list, expires } = await fileList(app, form, sub);
  if (delivery.channel.startsWith("webhook:")) {
    const name = delivery.channel.slice("webhook:".length);
    const configured = form.notify.webhooks.find((w) => w.name === name)?.format ?? null;
    return sendWebhook(app.env, name, configured, form, sub, list);
  }
  if (delivery.channel.startsWith("email:")) {
    const got = getSender(app.env);
    if ("error" in got) return { status: "config", error: got.error };
    const email = ownerEmail(form, sub, list, { linkExpires: expires });
    try {
      const r = await got.sender.send(
        { to: delivery.channel.slice("email:".length), subject: email.subject, text: email.text, html: email.html, headers: email.replyTo ? { "Reply-To": email.replyTo } : {} },
        { idempotencyKey: delivery.id },
      );
      // A duplicate in your own inbox is better than none: unknown is retried
      // (Resend's idempotency key, the delivery id, stops duplicates there).
      return r;
    } catch (err) {
      return { status: "retry", error: errText(err) };
    }
  }
  return { status: "config", error: `unknown channel ${delivery.channel}` };
}

/** Claims, sends and records one delivery row. Returns its new status, or null if someone else had it. */
export async function deliver(app, delivery, now = Date.now(), subCache = new Map()) {
  const { env } = app;
  // A D1 error while claiming means nobody holds the row: just leave it for later.
  try {
    if (!(await claim(env, delivery.id, now))) return null;
  } catch (err) {
    console.error(`claim ${delivery.id}: ${errText(err)}`);
    return null;
  }
  let r;
  try {
    let sub = subCache.get(delivery.submission_id);
    if (sub === undefined) {
      sub = await loadSubmission(env, delivery.submission_id);
      subCache.set(delivery.submission_id, sub);
    }
    if (!sub) return null; // deleted meanwhile; its deliveries went with it
    r = await attempt(app, delivery, sub, now);
  } catch (err) {
    r = { status: "retry", error: errText(err) };
  }
  let outcome;
  switch (r.status) {
    case "sent":
      outcome = { status: "sent", sent: true };
      break;
    case "skipped":
      outcome = { status: "skipped", error: r.error ?? null };
      break;
    case "unknown":
    case "conflict":
      if (delivery.channel === "autoreply") {
        outcome = { status: "unknown", error: r.error };
        break;
      }
    // falls through: notifications to you are retried
    case "retry":
    case "throttled": {
      const attempts = (delivery.attempts ?? 0) + 1;
      const at = nextAttempt(attempts, delivery.created_ms, now);
      outcome = at === null ? { status: "failed", error: `gave up after 24 hours: ${r.error}` } : { status: "retry", nextAt: at, error: r.error };
      break;
    }
    default: // config, rejected: a setup problem; not retried every few minutes
      outcome = { status: "failed", error: r.error };
  }
  try {
    await finish(env, delivery.id, now, outcome);
  } catch (err) {
    // The claim stays; it's released as stale after 2 minutes (auto-replies become "unknown").
    console.error(`finish ${delivery.id}: ${errText(err)}`);
  }
  return outcome.status;
}

/** What one delivery costs from the budget: loading its submission is
 *  charged only for the first delivery of that submission in a run. */
function deliveryCost(d, cache) {
  return COST.delivery + (d.channel === "autoreply" ? COST.autoreply : 0) + (cache.has(d.submission_id) ? 0 : COST.load);
}

/** Sends one submission's due deliveries (right after the reply). */
export async function deliverSubmission(app, submissionId, now = Date.now()) {
  if (!spend(app.budget, COST.deliverySelect)) return [];
  const { results } = await app.env.DB.prepare(
    "SELECT * FROM deliveries WHERE submission_id = ?1 AND status IN ('pending', 'retry') AND next_attempt_at <= ?2",
  ).bind(submissionId, now).all();
  const cache = new Map();
  const out = [];
  for (const d of results) {
    // Out of budget: the rest are sent by the next housekeeping run.
    if (!spend(app.budget, deliveryCost(d, cache))) break;
    out.push(await deliver(app, d, now, cache));
  }
  return out;
}

/** Sends up to `limit` due deliveries, oldest first. */
export async function deliverDue(app, limit, now = Date.now()) {
  // Not worth a select without room for at least one delivery after it.
  if (left(app.budget) < COST.deliverySelect + COST.delivery + COST.load) return { tried: 0, sent: 0 };
  spend(app.budget, COST.deliverySelect);
  const { results } = await app.env.DB.prepare(
    "SELECT * FROM deliveries WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT ?2",
  ).bind(now, limit).all();
  const cache = new Map();
  let sent = 0;
  let tried = 0;
  for (const d of results) {
    if (!spend(app.budget, deliveryCost(d, cache))) break;
    tried++;
    if ((await deliver(app, d, now, cache)) === "sent") sent++;
  }
  return { tried, sent };
}

/** Claims older than 2 minutes belong to a run that died. Auto-replies
 *  become "unknown" (never sent twice); everything else is tried again. */
export async function releaseStale(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE deliveries SET status = 'unknown', claimed_at = NULL,
         last_error = 'the send was interrupted; it may or may not have gone out'
       WHERE status = 'sending' AND claimed_at < ?1 AND channel = 'autoreply'`,
    ).bind(now - STALE_MS),
    env.DB.prepare(
      `UPDATE deliveries SET status = 'retry', claimed_at = NULL, next_attempt_at = ?2
       WHERE status = 'sending' AND claimed_at < ?1`,
    ).bind(now - STALE_MS, now),
  ]);
}

/**
 * Deliveries skipped because their submission was spam, whose submission
 * isn't spam any more (marked "not spam" in the API, or "Back to inbox" in
 * the desktop app): send them now, with a fresh 24-hour window.
 */
export async function reviveSkipped(env, now = Date.now(), limit = 50) {
  const r = await env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', next_attempt_at = ?1, attempts = 0, created_ms = ?1, last_error = NULL
     WHERE rowid IN (
       SELECT d.rowid FROM deliveries d JOIN submissions s ON s.id = d.submission_id
       WHERE d.status = 'skipped' AND d.channel != 'autoreply' AND d.last_error IS NULL AND s.status != 'spam'
       LIMIT ?2)`,
  ).bind(now, limit).run();
  return r.meta.changes;
}

/** releaseStale + reviveSkipped in one D1 batch (one call). Returns how many were revived. */
export async function releaseAndRevive(env, now = Date.now(), limit = 50) {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE deliveries SET status = 'unknown', claimed_at = NULL,
         last_error = 'the send was interrupted; it may or may not have gone out'
       WHERE status = 'sending' AND claimed_at < ?1 AND channel = 'autoreply'`,
    ).bind(now - STALE_MS),
    env.DB.prepare(
      `UPDATE deliveries SET status = 'retry', claimed_at = NULL, next_attempt_at = ?2
       WHERE status = 'sending' AND claimed_at < ?1`,
    ).bind(now - STALE_MS, now),
    env.DB.prepare(
      `UPDATE deliveries SET status = 'pending', next_attempt_at = ?1, attempts = 0, created_ms = ?1, last_error = NULL
       WHERE rowid IN (
         SELECT d.rowid FROM deliveries d JOIN submissions s ON s.id = d.submission_id
         WHERE d.status = 'skipped' AND d.channel != 'autoreply' AND d.last_error IS NULL AND s.status != 'spam'
         LIMIT ?2)`,
    ).bind(now, limit),
  ]);
  return results[2].meta.changes;
}
