// The admin API: everything under /api/, behind Authorization: Bearer <ADMIN_TOKEN>
// (constant-time compare; refused while the token is under 16 characters),
// as in perchlight-updates src/routes/admin.js.
import { json, fail, readJson, sqlTime, utcDay } from "../lib/http.js";
import { safeEqual, isId, randomId } from "../lib/crypto.js";
import { loadSubmission, deliverSubmission, deliver, sendWebhook } from "../lib/deliveries.js";
import { deleteSubmissions, maybeHousekeep, runHousekeeping } from "../lib/housekeeping.js";
import { signedFileUrl, linkSecretOk } from "../lib/links.js";
import { getSender, canAutoReply, providerName } from "../lib/senders/index.js";
import { ownerEmail } from "../lib/notify.js";
import { streamFile } from "./files.js";
import { saltOk } from "./submit.js";
import { settings } from "../lib/settings.js";

const PAGE_MAX = 200;
const EXPORT_PAGE = 90; // file names are fetched with one IN (...) per page: under D1's 100 parameters
const STATUSES = ["new", "read", "archived", "spam"];
const MIN_TOKEN = 16;

async function authorised(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return Boolean(m) && (await safeEqual(m[1], env.ADMIN_TOKEN));
}

export async function handleAdmin(request, app, ctx, path) {
  const { env } = app;
  if (!env.ADMIN_TOKEN || String(env.ADMIN_TOKEN).length < MIN_TOKEN) {
    return fail(503, `Set ADMIN_TOKEN (${MIN_TOKEN}+ characters): npx wrangler secret put ADMIN_TOKEN`);
  }
  if (!(await authorised(request, env))) return json({ ok: false, error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

  const url = new URL(request.url);
  const q = url.searchParams;
  const m = request.method;
  const parts = path.split("/").filter(Boolean);
  let res;
  if (m === "GET" && path === "forms") res = await listForms(app);
  else if (m === "GET" && path === "submissions") res = await listSubmissions(env, q);
  else if (m === "DELETE" && path === "submissions") res = await deleteByEmail(env, q);
  else if (parts[0] === "submissions" && parts.length === 2) {
    if (!isId("sub", parts[1])) res = fail(404, "No such submission.");
    else if (m === "GET") res = await getSubmission(env, parts[1]);
    else if (m === "PATCH") res = await patchSubmission(request, app, ctx, parts[1]);
    else if (m === "DELETE") res = await deleteOne(env, parts[1]);
  } else if (m === "GET" && path === "export") res = exportSubmissions(app, q);
  else if (parts[0] === "files" && isId("fil", parts[1] ?? "")) {
    if (m === "GET" && parts.length === 2) res = env.FILES ? await streamFile(env, parts[1], () => fail(404, "No such file.")) : fail(404, "No such file.");
    else if (m === "POST" && parts[2] === "link" && parts.length === 3) res = await makeLink(app, parts[1]);
  } else if (m === "GET" && path === "deliveries") res = await listDeliveries(env, q);
  else if (m === "POST" && parts[0] === "deliveries" && parts[2] === "retry" && parts.length === 3) res = await retryDelivery(app, ctx, parts[1]);
  else if (m === "POST" && path === "test-notify") res = await testNotify(app, q);
  else if (m === "POST" && path === "housekeeping") res = json({ ok: true, ...(await runHousekeeping(app, { force: true })) });

  // Admin calls keep a quiet site's retries and clean-up moving.
  if (path !== "housekeeping") maybeHousekeep(app, ctx);
  return res ?? fail(404, "Not found.");
}

async function listForms(app) {
  const { env, forms } = app;
  const day = utcDay();
  const [{ results: today }, { results: totals }, last] = await Promise.all([
    env.DB.prepare("SELECT form_id, kind, count FROM daily_counts WHERE day = ?1").bind(day).all(),
    env.DB.prepare("SELECT form_id, status, COUNT(*) AS n FROM submissions GROUP BY form_id, status").all(),
    env.DB.prepare("SELECT key, value FROM state WHERE key IN ('last_run', 'last_retention')").all(),
  ]);
  const problems = [];
  if (!saltOk(env)) problems.push("IP_SALT isn't set (16+ characters): every form answers 503 until it is.");
  const mail = getSender(env);
  if ("error" in mail) problems.push(`Email notifications can't be sent: ${mail.error}`);
  if (!env.FILES) problems.push("No FILES R2 binding: forms with file fields are switched off.");
  if (!linkSecretOk(env)) problems.push("LINK_SECRET isn't set (16+ characters): no signed file links.");
  const out = [];
  for (const [id, entry] of forms) {
    const t = {};
    for (const r of today) if (r.form_id === id) t[r.kind] = r.count;
    const total = {};
    for (const r of totals) if (r.form_id === id) total[r.status] = r.n;
    out.push({ id, name: entry.form?.name ?? id, enabled: entry.ok, error: entry.error, today: t, total });
  }
  const state = Object.fromEntries(last.results.map((r) => [r.key, Number(r.value) ? new Date(Number(r.value)).toISOString() : null]));
  const spamCap = today.find((r) => r.form_id === "*" && r.kind === "spam_cap")?.count ?? 0;
  return json({
    ok: true,
    forms: out,
    problems,
    mailProvider: providerName(env),
    spamStoredToday: spamCap,
    spamDailyCap: settings(env).spamDailyCap,
    housekeeping: { lastRun: state.last_run ?? null, lastRetention: state.last_retention ?? null },
  });
}

function parseSince(s) {
  if (!s) return null;
  if (/^\d{10,15}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function encodeCursor(row) {
  return btoa(`${row.created_ms}|${row.id}`).replace(/=+$/, "");
}
function decodeCursor(c) {
  try {
    const [ms, id] = atob(c).split("|");
    return /^\d+$/.test(ms) && isId("sub", id) ? { ms: Number(ms), id } : null;
  } catch {
    return null;
  }
}

/** WHERE clause and parameters for list and export filters. */
function filters(q) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `?${params.length}`));
  };
  const form = q.get("form");
  if (form) add("form_id = ?", form);
  const status = q.get("status");
  if (status === "inbox") where.push("status != 'spam'");
  else if (status) {
    if (!STATUSES.includes(status)) return { error: `status must be one of ${STATUSES.join(", ")} or inbox` };
    add("status = ?", status);
  }
  const since = parseSince(q.get("since"));
  if (since === undefined) return { error: "since must be a date (2026-11-10) or Unix milliseconds" };
  if (since !== null) add("created_ms >= ?", since);
  const email = q.get("email");
  if (email) add("reply_email = ?", email.trim().toLowerCase());
  return { where, params };
}

function rowOut(r) {
  return {
    ...r,
    data: JSON.parse(r.data),
    extra: r.extra ? JSON.parse(r.extra) : null,
    spam_reasons: r.spam_reasons ? JSON.parse(r.spam_reasons) : null,
  };
}

async function listSubmissions(env, q) {
  const f = filters(q);
  if (f.error) return fail(400, f.error);
  const limit = Math.min(Math.max(Number.parseInt(q.get("limit") ?? "50", 10) || 50, 1), PAGE_MAX);
  const { where, params } = f;
  const cursor = q.get("cursor");
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return fail(400, "That cursor isn't valid.");
    params.push(c.ms, c.id);
    where.push(`(created_ms < ?${params.length - 1} OR (created_ms = ?${params.length - 1} AND id < ?${params.length}))`);
  }
  params.push(limit + 1);
  const sql = `SELECT * FROM submissions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_ms DESC, id DESC LIMIT ?${params.length}`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  const page = results.slice(0, limit);
  return json({
    ok: true,
    submissions: page.map(rowOut),
    cursor: results.length > limit ? encodeCursor(page[page.length - 1]) : null,
  });
}

async function getSubmission(env, id) {
  const sub = await loadSubmission(env, id);
  if (!sub) return fail(404, "No such submission.");
  const { results: deliveries } = await env.DB.prepare(
    "SELECT id, channel, status, attempts, next_attempt_at, sent_at, last_error FROM deliveries WHERE submission_id = ?1 ORDER BY channel",
  ).bind(id).all();
  return json({ ok: true, submission: { ...sub, files: sub.files.map(({ r2_key, ...f }) => f), deliveries } });
}

async function patchSubmission(request, app, ctx, id) {
  const { env } = app;
  const body = await readJson(request);
  const target = body?.status;
  if (!["read", "new", "archived", "spam", "ok"].includes(target)) return fail(400, 'status must be "read", "new", "archived", "spam" or "ok" (not spam).');
  const exists = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?1").bind(id).first();
  if (!exists) return fail(404, "No such submission.");
  const now = Date.now();
  if (target === "spam") {
    const [r] = await env.DB.batch([
      env.DB.prepare("UPDATE submissions SET status = 'spam' WHERE id = ?1 AND status != 'spam'").bind(id),
      env.DB.prepare(
        `UPDATE deliveries SET status = 'skipped', last_error = NULL WHERE submission_id = ?1 AND status IN ('pending', 'retry')
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ?1 AND status = 'spam')`,
      ).bind(id),
    ]);
    return json({ ok: true, status: "spam", changed: r.meta.changes === 1 });
  }
  const status = target === "ok" ? "new" : target;
  // Leaving the spam folder sends the notifications that were skipped, once,
  // with a fresh 24-hour retry window. Auto-replies are never sent for it.
  const [r, revived] = await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET status = ?2 WHERE id = ?1 AND status != ?2").bind(id, status),
    env.DB.prepare(
      `UPDATE deliveries SET status = 'pending', next_attempt_at = ?2, attempts = 0, created_ms = ?2, last_error = NULL
       WHERE submission_id = ?1 AND status = 'skipped' AND channel != 'autoreply' AND last_error IS NULL
       AND EXISTS (SELECT 1 FROM submissions WHERE id = ?1 AND status != 'spam')`,
    ).bind(id, now),
  ]);
  if (revived.meta.changes) {
    ctx.waitUntil(deliverSubmission(app, id, now).catch((err) => console.error(`notify ${id}: ${err instanceof Error ? err.message : String(err)}`)));
  }
  return json({ ok: true, status, changed: r.meta.changes === 1, notificationsQueued: revived.meta.changes });
}

async function deleteOne(env, id) {
  const n = await deleteSubmissions(env, [id]);
  return n ? json({ ok: true, deleted: n }) : fail(404, "No such submission.");
}

/** Delete on request (GDPR Art. 17): every submission whose reply address matches. */
async function deleteByEmail(env, q) {
  const email = (q.get("email") ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes("@")) return fail(400, "Give ?email=someone@example.com");
  const LIMIT = 450;
  const { results } = await env.DB.prepare("SELECT id FROM submissions WHERE reply_email = ?1 LIMIT ?2").bind(email, LIMIT + 1).all();
  const ids = results.slice(0, LIMIT).map((r) => r.id);
  const deleted = await deleteSubmissions(env, ids);
  console.log(`delete on request: ${deleted} submission(s) at ${sqlTime()}`); // a count and time only
  return json({ ok: true, deleted, more: results.length > LIMIT });
}

/** Spreadsheets run cells starting with these as formulas. */
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportSubmissions(app, q) {
  const { env, forms } = app;
  const format = q.get("format") ?? "csv";
  if (!["csv", "json"].includes(format)) return fail(400, 'format must be "csv" or "json"');
  const f = filters(q);
  if (f.error) return fail(400, f.error);
  const form = q.get("form") ? forms.get(q.get("form"))?.form : null;
  if (q.get("form") && !form) return fail(404, "No such form in forms.json.");
  const fields = form ? Object.values(form.fields).filter((x) => x.type !== "file") : [];
  const header = form
    ? ["id", "created_at", "status", "spam_reasons", ...fields.map((x) => x.name), "files", "extra"]
    : ["id", "created_at", "form", "status", "spam_reasons", "data", "files", "extra"];

  const enc = new TextEncoder();
  let cursor = null;
  let first = true;
  let done = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (done) return;
      if (first) controller.enqueue(enc.encode(format === "csv" ? `﻿${header.map(csvCell).join(",")}\r\n` : "["));
      const where = [...f.where];
      const params = [...f.params];
      if (cursor) {
        params.push(cursor.ms, cursor.id);
        where.push(`(created_ms < ?${params.length - 1} OR (created_ms = ?${params.length - 1} AND id < ?${params.length}))`);
      }
      params.push(EXPORT_PAGE);
      const { results } = await env.DB.prepare(
        `SELECT * FROM submissions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_ms DESC, id DESC LIMIT ?${params.length}`,
      ).bind(...params).all();
      const names = new Map();
      if (results.length) {
        const { results: files } = await env.DB.prepare(
          `SELECT submission_id, name FROM files WHERE submission_id IN (${results.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY created_at`,
        ).bind(...results.map((r) => r.id)).all();
        for (const x of files) names.set(x.submission_id, [...(names.get(x.submission_id) ?? []), x.name]);
      }
      let chunk = "";
      for (const raw of results) {
        const r = rowOut(raw);
        const fileNames = names.get(r.id) ?? [];
        if (format === "json") {
          chunk += `${first ? "" : ","}\n${JSON.stringify({ ...r, files: fileNames })}`;
        } else {
          const cells = form
            ? [r.id, r.created_at, r.status, r.spam_reasons, ...fields.map((x) => r.data[x.name]), fileNames, r.extra]
            : [r.id, r.created_at, r.form_id, r.status, r.spam_reasons, r.data, fileNames, r.extra];
          chunk += `${cells.map(csvCell).join(",")}\r\n`;
        }
        first = false;
      }
      first = false;
      if (results.length < EXPORT_PAGE) {
        if (format === "json") chunk += "\n]\n";
        done = true;
      } else cursor = { ms: results[results.length - 1].created_ms, id: results[results.length - 1].id };
      if (chunk) controller.enqueue(enc.encode(chunk));
      if (done) controller.close();
    },
  });
  const name = `${form ? form.id : "submissions"}-${utcDay()}.${format}`;
  return new Response(stream, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function makeLink(app, fileId) {
  const { env } = app;
  if (!linkSecretOk(env)) return fail(503, "Set LINK_SECRET (16+ characters) to make signed links.");
  const row = await env.DB.prepare("SELECT id FROM files WHERE id = ?1").bind(fileId).first();
  if (!row) return fail(404, "No such file.");
  const link = await signedFileUrl(env, app.base, fileId, 15 * 60);
  return json({ ok: true, ...link });
}

async function listDeliveries(env, q) {
  const status = q.get("status") ?? "failed";
  const allowed = ["pending", "sending", "retry", "sent", "failed", "unknown", "skipped"];
  if (!allowed.includes(status)) return fail(400, `status must be one of ${allowed.join(", ")}`);
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.submission_id, s.form_id, d.channel, d.status, d.attempts, d.next_attempt_at, d.sent_at, d.last_error
     FROM deliveries d JOIN submissions s ON s.id = d.submission_id WHERE d.status = ?1 ORDER BY d.created_ms DESC LIMIT 200`,
  ).bind(status).all();
  return json({ ok: true, deliveries: results });
}

async function retryDelivery(app, ctx, id) {
  const { env } = app;
  if (!isId("dlv", id)) return fail(404, "No such delivery.");
  const now = Date.now();
  const row = await env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', next_attempt_at = ?2, last_error = NULL
     WHERE id = ?1 AND status IN ('failed', 'unknown', 'retry') RETURNING *`,
  ).bind(id, now).first();
  if (!row) {
    const exists = await env.DB.prepare("SELECT status FROM deliveries WHERE id = ?1").bind(id).first();
    return exists ? fail(409, `It's ${exists.status}; only failed, unknown or retrying notifications can be tried again.`) : fail(404, "No such delivery.");
  }
  const status = await deliver(app, row, now);
  return json({ ok: status === "sent", status });
}

function sampleValue(field) {
  switch (field.type) {
    case "email":
      return "visitor@example.com";
    case "url":
      return "https://example.com/";
    case "number":
      return 42;
    case "tel":
      return "+44 20 7946 0000";
    case "select":
      return field.options[0];
    case "checkbox":
    case "consent":
      return field.options ? [field.options[0]] : true;
    case "textarea":
      return "This is a test message from perchlight-forms. If you can read it, notifications reach you here.";
    default:
      return field.name === "name" ? "Test Visitor" : "Example";
  }
}

/** A sample notification through every channel of a form, with exact errors. Nothing is stored. */
async function testNotify(app, q) {
  const { env, forms } = app;
  const entry = forms.get(q.get("form") ?? "");
  if (!entry) return fail(404, "Give ?form=<id> of a form in forms.json.");
  if (!entry.ok) return json({ ok: false, error: `This form is switched off: ${entry.error}` }, 400);
  const form = entry.form;
  const data = {};
  for (const field of Object.values(form.fields)) if (field.type !== "file") data[field.name] = sampleValue(field);
  const sub = { id: randomId("sub"), created_at: sqlTime(), data, extra: null, files: [] };
  const results = [];
  for (const to of form.notify.email) {
    const got = getSender(env);
    if ("error" in got) {
      results.push({ channel: `email:${to}`, ok: false, status: "config", error: got.error });
      continue;
    }
    const email = ownerEmail(form, sub, []);
    const r = await got.sender.send({ to, subject: `[Test] ${email.subject}`, text: email.text, html: email.html, headers: { "Reply-To": "visitor@example.com" } });
    results.push({ channel: `email:${to}`, ok: r.status === "sent", status: r.status, ...(r.error ? { error: r.error } : {}) });
  }
  for (const w of form.notify.webhooks) {
    const r = await sendWebhook(env, w.name, w.format, form, sub, []);
    results.push({ channel: `webhook:${w.name}`, ok: r.status === "sent", status: r.status, ...(r.error ? { error: r.error } : {}) });
  }
  if (form.autoReply) {
    results.push({
      channel: "autoreply",
      ok: canAutoReply(env),
      status: "not sent",
      error: canAutoReply(env) ? "Not sent by the test (auto-replies go to visitors). Send yourself a real submission to check it." : "MAIL_PROVIDER must be an email service for auto-replies.",
    });
  }
  if (!results.length) return json({ ok: false, error: "This form has no notification channels (notify.email or notify.webhooks)." }, 400);
  const ok = results.every((r) => r.ok);
  return json({ ok, results }, ok ? 200 : 502);
}
