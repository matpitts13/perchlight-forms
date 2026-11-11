// POST /f/:form and OPTIONS /f/:form: receiving a submission.
// Plain HTML forms get a 303 to the thank-you or problem page; JSON (or
// Accept: application/json) gets JSON. Checks run cheapest first and nothing
// is written until the submission is stored (store first, then notify).
import { json, redirect, escapeHtml, sqlTime, utcDay } from "../lib/http.js";
import { readLimited, parseBody, bodyKind, checkSubmission, problemMessage } from "../lib/parse.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { scoreSpam, rateKey, contentHash } from "../lib/spam.js";
import { randomId, sha256Hex } from "../lib/crypto.js";
import { deliverSubmission } from "../lib/deliveries.js";
import { maybeHousekeep } from "../lib/housekeeping.js";
import { getSender } from "../lib/senders/index.js";
import { ownerEmail } from "../lib/notify.js";
import { settings } from "../lib/settings.js";

const DUPLICATE_WINDOW_MS = 10 * 60_000;

/** CORS headers only for the form's own origins. */
export function corsHeaders(form, origin) {
  if (!form || !origin || !form.origins.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflight(request, app, formId) {
  const entry = app.forms.get(formId);
  if (!entry) return new Response(null, { status: 404, headers: { Vary: "Origin" } });
  return new Response(null, { status: 204, headers: corsHeaders(entry.form, request.headers.get("Origin")) });
}

/** "SALT missing" is the deployment's problem; refuse rather than store a guessable hash. */
export function saltOk(env) {
  return String(env.IP_SALT ?? "").length >= 16;
}

function summaryOf(form, data) {
  const parts = [];
  for (const type of ["textarea", "text"]) {
    for (const f of Object.values(form.fields)) if (f.type === type && typeof data[f.name] === "string") parts.push(data[f.name]);
  }
  return [...parts.join(" · ").replace(/\s+/g, " ")].slice(0, 200).join("");
}

function bump(env, formId, kind, now = Date.now()) {
  return env.DB.prepare(
    `INSERT INTO daily_counts (day, form_id, kind, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(day, form_id, kind) DO UPDATE SET count = count + 1`,
  ).bind(utcDay(now), formId, kind);
}

function quietly(ctx, promise) {
  ctx.waitUntil(promise.catch((err) => console.error(`counter: ${err instanceof Error ? err.message : String(err)}`)));
}

/** The 503 page shown when a submission couldn't be saved or emailed. */
function cantSavePage(fallbackContact) {
  const contact = fallbackContact
    ? ` or email <a href="mailto:${escapeHtml(fallbackContact)}">${escapeHtml(fallbackContact)}</a>`
    : "";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not sent</title><link rel="stylesheet" href="/styles.css"></head><body><main>
<h1>We couldn't save your message</h1><p>Nothing was sent. Please try again later${contact}.</p>
<p>Use your browser's Back button to return to the form; what you typed may still be there.</p></main></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "3600" } },
  );
}

export async function submit(request, app, ctx, formId) {
  const { env, forms } = app;
  const url = new URL(request.url);
  const entry = forms.get(formId);
  const originHeader = request.headers.get("Origin");
  const contentType = request.headers.get("Content-Type") ?? "";
  const wantsJson = bodyKind(contentType) === "json" || (request.headers.get("Accept") ?? "").includes("application/json");
  const cors = corsHeaders(entry?.form, originHeader);

  if (!entry) {
    return wantsJson
      ? json({ ok: false, errors: { _form: "There's no form here." } }, 404, cors)
      : new Response("There's no form here.\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (!entry.ok || !saltOk(env)) {
    if (!saltOk(env)) console.error("Set the IP_SALT secret (16+ characters): npx wrangler secret put IP_SALT");
    const msg = "This form isn't set up correctly. Please let the site owner know.";
    return wantsJson
      ? json({ ok: false, errors: { _form: msg } }, 503, cors)
      : new Response(`${msg}\n`, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const form = entry.form;
  const now = Date.now();

  /** errors: field -> code ("_" = the whole form) */
  const problem = (status, errors) => {
    if (wantsJson) {
      const messages = {};
      for (const [k, code] of Object.entries(errors)) messages[k === "_" ? "_form" : k] = problemMessage(form.fields[k], code);
      return json({ ok: false, errors: messages }, status, cors);
    }
    const target = new URL(form.errorRedirect ?? `${url.origin}/problem/`);
    target.searchParams.set("form", form.id);
    target.searchParams.set("e", Object.entries(errors).map(([k, c]) => `${k}:${c}`).join(","));
    return redirect(target.toString(), 303, cors);
  };
  const success = (id) => {
    maybeHousekeep(app, ctx);
    return wantsJson ? json({ ok: true, id }, 200, cors) : redirect(form.redirect ?? `${url.origin}/thanks/?form=${form.id}`, 303, cors);
  };

  // 2. Body size, counted while reading.
  const bytes = await readLimited(request, form.maxBodyBytes);
  if (!bytes) return problem(413, { _: "too_big" });

  // 3. Parse and check every field.
  const parsed = await parseBody(bytes, contentType, request.url);
  if ("error" in parsed) return problem(parsed.error === "unsupported" ? 415 : 422, { _: parsed.error });
  const sub = await checkSubmission(form, parsed.entries, bodyKind(contentType) === "json");
  if (Object.keys(sub.errors).length) {
    quietly(ctx, bump(env, form.id, "invalid").run());
    return problem(422, sub.errors);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  let dbOk = true;
  const dbFailed = (err) => {
    dbOk = false;
    console.error(`D1: ${err instanceof Error ? err.message : String(err)}`);
  };

  // 4. Rate limit: one D1 upsert, keyed by a hash that changes every day.
  if (form.spam.perHour > 0 && !sub.honeypot) {
    try {
      const key = await rateKey(env.IP_SALT, utcDay(now), form.id, ip);
      const row = await env.DB.prepare(
        `INSERT INTO rate_counters (key, hour, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key, hour) DO UPDATE SET count = count + 1 RETURNING count`,
      ).bind(key, new Date(now).toISOString().slice(0, 13)).first();
      if (row && row.count > form.spam.perHour) {
        quietly(ctx, bump(env, form.id, "rate_limited").run());
        return problem(429, { _: "rate" });
      }
    } catch (err) {
      dbFailed(err);
    }
  }

  // 5. Turnstile.
  let turnstile = null;
  let turnstileState = "off";
  if (form.spam.turnstile && !sub.honeypot) {
    turnstile = await verifyTurnstile(env, sub.turnstileToken, ip);
    if (turnstile.result === "failed") return problem(422, { _: "turnstile" });
    turnstileState = turnstile.result;
  }

  // 6. Spam scoring (no network) and duplicates.
  const score = scoreSpam(form, sub, { origin: originHeader, turnstile });
  const hash = await contentHash(form.id, sub.data, sub.extra);
  if (dbOk) {
    try {
      const dup = await env.DB.prepare(
        `UPDATE submissions SET duplicate_count = duplicate_count + 1
         WHERE id = (SELECT id FROM submissions WHERE content_hash = ?1 AND created_ms > ?2 ORDER BY created_ms DESC LIMIT 1)
         RETURNING id`,
      ).bind(hash, now - DUPLICATE_WINDOW_MS).first();
      if (dup) {
        quietly(ctx, bump(env, form.id, "duplicate").run());
        return success(dup.id);
      }
    } catch (err) {
      dbFailed(err);
    }
  }

  // Spam flood: stored spam is capped per UTC day; past the cap it's only counted.
  if (score.spam && dbOk) {
    try {
      const slot = await env.DB.prepare(
        `INSERT INTO daily_counts (day, form_id, kind, count) SELECT ?1, '*', 'spam_cap', 1 WHERE ?2 > 0
         ON CONFLICT(day, form_id, kind) DO UPDATE SET count = count + 1 WHERE daily_counts.count < ?2
         RETURNING count`,
      ).bind(utcDay(now), settings(env).spamDailyCap).first();
      if (!slot) {
        quietly(ctx, bump(env, form.id, "spam_dropped").run());
        return success(randomId("sub")); // the same answer as a real submission
      }
    } catch (err) {
      dbFailed(err);
    }
  }

  // A bot that filled the honeypot gets the normal answer whatever happens next.
  if (!dbOk && sub.honeypot) return success(randomId("sub"));
  if (!dbOk) return fallback(app, form, sub, score, wantsJson, cors, success, now);

  // 7. Files to R2 first, then the rows in one transaction.
  const id = randomId("sub");
  const created = sqlTime(now);
  const fileRows = [];
  try {
    for (const f of sub.files) {
      const fid = randomId("fil");
      const key = `f/${form.id}/${id}/${fid}`;
      await env.FILES.put(key, f.bytes, { httpMetadata: { contentType: f.contentType }, customMetadata: { submission: id } });
      fileRows.push({ id: fid, field: f.field, name: f.name, contentType: f.contentType, size: f.bytes.byteLength, sha256: await sha256Hex(f.bytes), key });
    }
  } catch (err) {
    console.error(`R2: ${err instanceof Error ? err.message : String(err)}`);
    await deleteObjects(env, fileRows);
    return fallback(app, form, sub, score, wantsJson, cors, success, now);
  }

  const replyEmail = form.replyTo && typeof sub.data[form.replyTo] === "string" ? sub.data[form.replyTo].toLowerCase() : null;
  const channels = [...form.notify.email.map((e) => `email:${e.toLowerCase()}`), ...form.notify.webhooks.map((w) => `webhook:${w.name}`)];
  if (form.autoReply && !score.spam && turnstileState === "passed" && replyEmail) channels.push("autoreply");
  const stmts = [
    env.DB.prepare(
      `INSERT INTO submissions (id, form_id, created_at, created_ms, status, spam_reasons, data, extra, summary, reply_email,
         content_hash, origin, turnstile, seconds_on_page, consent_at, consent_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
    ).bind(
      id,
      form.id,
      created,
      now,
      score.spam ? "spam" : "new",
      score.reasons.length ? JSON.stringify(score.reasons) : null,
      JSON.stringify(sub.data),
      sub.extra ? JSON.stringify(sub.extra) : null,
      summaryOf(form, sub.data),
      replyEmail,
      hash,
      originHeader && form.origins.includes(originHeader) ? originHeader : null,
      turnstileState,
      sub.elapsedMs === null ? null : Math.round(sub.elapsedMs / 100) / 10,
      sub.consent ? created : null,
      sub.consent ? sub.consent.version : null,
    ),
    ...fileRows.map((f) =>
      env.DB.prepare(
        `INSERT INTO files (id, submission_id, field, name, content_type, size, sha256, r2_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(f.id, id, f.field, f.name, f.contentType, f.size, f.sha256, f.key, created),
    ),
    ...channels.map((ch) =>
      env.DB.prepare(
        `INSERT INTO deliveries (id, submission_id, channel, status, next_attempt_at, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(randomId("dlv"), id, ch, score.spam ? "skipped" : "pending", now),
    ),
    bump(env, form.id, score.spam ? "spam" : "ok", now),
  ];
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    dbFailed(err);
    await deleteObjects(env, fileRows);
    return fallback(app, form, sub, score, wantsJson, cors, success, now);
  }

  // 8. Reply; notifications go out after it.
  if (!score.spam && channels.length) {
    ctx.waitUntil(
      deliverSubmission(app, id, now).catch((err) => console.error(`notify ${id}: ${err instanceof Error ? err.stack : String(err)}`)),
    );
  }
  return success(id);
}

async function deleteObjects(env, fileRows) {
  if (!fileRows.length) return;
  try {
    await env.FILES.delete(fileRows.map((f) => f.key));
  } catch {
    // Left for the housekeeping's orphan sweep.
  }
}

/**
 * D1 can't be written (an outage, or the free daily write limit). Email the
 * submission straight to the form's addresses; only if that works is the
 * visitor told "thanks". Otherwise a 503 that says so.
 */
async function fallback(app, form, sub, score, wantsJson, cors, success, now) {
  const { env } = app;
  const s = settings(env);
  let sent = false;
  const got = getSender(env);
  if (form.notify.email.length && "sender" in got) {
    const email = ownerEmail(
      form,
      { id: "", created_at: sqlTime(now), data: sub.data, extra: sub.extra, spam_reasons: score.spam ? score.reasons : null },
      sub.files.map((f) => ({ name: f.name, size: f.bytes.byteLength })),
      { notSaved: true },
    );
    for (const to of form.notify.email) {
      try {
        const r = await got.sender.send({
          to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.replyTo ? { "Reply-To": email.replyTo } : {},
        });
        if (r.status === "sent") sent = true;
        else console.error(`fallback email: ${r.error}`);
      } catch (err) {
        console.error(`fallback email: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (sent) return wantsJson ? json({ ok: true, id: null, saved: false }, 200, cors) : success(null);
  const message = `We couldn't save your message. Please try again later${s.fallbackContact ? ` or email ${s.fallbackContact}` : ""}.`;
  return wantsJson ? json({ ok: false, errors: { _form: message } }, 503, { ...cors, "Retry-After": "3600" }) : cantSavePage(s.fallbackContact);
}
