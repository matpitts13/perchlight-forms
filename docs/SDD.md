# SDD: perchlight-forms

**Version:** 0.1
**Date:** 2026-11-10
**Status:** Approved (2026-11-10)

## Summary

A free, self-hosted form backend for static websites, running on your own Cloudflare account (Workers + D1, plus R2 if you want file uploads). Point a contact, feedback, bug-report, waitlist or job-application form at `https://<your worker>/f/<form-id>` and every submission is stored in your D1 database, checked for spam, and sent to you by email and/or webhook. It works from a plain HTML form with no JavaScript (the visitor lands on your thank-you page) and from `fetch()` with JSON, with CORS limited to your own sites. It replaces paid form services for small sites. Part of the Perchlight family: the Perchlight desktop app gets an inbox screen (mark read, spam, archive, delete) and failed-notification screen.

## Why

- Static sites (Cloudflare Pages, GitHub Pages, Hugo, Astro) have no server to receive a form. The usual fix is a paid service. Formspree's free plan, for example, allows 50 submissions a month and no file uploads; its paid plans are $15, $30 and $90 a month ([formspree.io/plans](https://formspree.io/plans), checked 2026-11-10). Basin, Getform and Netlify Forms are similar in shape; their current prices weren't checked (see "Couldn't confirm").
- Those services hold your visitors' messages on someone else's servers. Here they stay in your Cloudflare account, and you decide how long they're kept.
- Cloudflare's free plan is more than enough for a small site's forms (numbers under "Footprint").

## Requirements

### Must have

- **Plain HTML works, no JavaScript needed.** `<form action="https://forms.example.com/f/contact" method="post">` with `application/x-www-form-urlencoded` or `multipart/form-data`. On success the browser is sent (303) to the form's thank-you URL, or to a built-in thank-you page. On a problem the visitor sees a built-in page saying exactly what to fix (for example "Email is required"), with a link back.
- **`fetch()` / JSON works too.** `Content-Type: application/json`, or any form body with `Accept: application/json`, gets a JSON answer: `{ "ok": true, "id": "..." }` or `{ "ok": false, "errors": { "email": "Email is required" } }` with status 422. CORS headers are sent only for the form's allowed origins, and `OPTIONS` preflights are answered the same way.
- **Several forms per deployment**, each with its own:
  - fields (name, type, required, max length, allowed options),
  - maximum body size and file limits,
  - allowed origins,
  - notification recipients and webhooks,
  - thank-you and error URLs,
  - spam settings (Turnstile on or off, link limit, blocked words, rate limit),
  - optional consent checkbox,
  - optional auto-reply to the submitter (off by default; see "Auto-reply").
- **Store first, then notify.** A submission is written to D1 before the visitor is told "thanks" and before any notification goes out. If the write fails, the visitor is not told "thanks" (see "When D1 can't be written").
- **Never lose a real submission silently.** Every submission ends up in exactly one of three places:
  1. **Shown back to the sender as an error** they can fix (a missing required field, too big, rate limited, the Turnstile check failed). Nothing is stored, but the sender knows.
  2. **The inbox** (status `new`).
  3. **The spam folder** (status `spam`), with the reasons it was flagged, for 30 days by default. You can mark it "not spam", which moves it to the inbox and sends the notifications it skipped.

  Nothing a person could have sent goes nowhere without them being told. The one exception is spoken out loud: after a daily cap of stored spam (default 1,000 a day), further spam is only counted, not stored (see "Spam flood").
- **Spam protection**, each part optional per form:
  - a honeypot field (hidden from people, filled in by bots),
  - Cloudflare Turnstile, checked server-side with `siteverify`,
  - a time-to-submit check (too fast to be a person),
  - a per-network rate limit that never stores an IP address, only a hash whose key changes every day,
  - link-count and blocked-word checks,
  - an origin check.
- **Notifications, once per submission:**
  - **Email to you** through the Workers `send_email` binding, to addresses you've verified in Email Routing. Cloudflare says this is free on all plans.
  - **Email through your own email service** (Resend, Amazon SES, Mailgun, Postmark or Cloudflare Email Service), the same senders perchlight-list uses. Needed only for auto-replies, or to email addresses you can't verify in Email Routing.
  - **Webhooks:** Discord, Slack, ntfy, or signed JSON.
  - Retried with back-off when they fail. Every attempt and its error is recorded and shown in the desktop app. The submission itself is safe in D1 whatever happens to its notifications.
- **File uploads to R2** (optional): per-field type and size limits, checked by content, not only by name. Files are never public. You open them through short-lived signed links or the admin API.
- **Privacy:** only the fields you list are kept as normal fields; no IP addresses, user agents or cookies are stored; retention limits for the inbox and spam folder; delete everything from one email address in one call; an optional consent checkbox whose time and wording version are recorded.
- **Export** of any form's submissions as CSV or JSON.
- **Admin API** behind one bearer token (`ADMIN_TOKEN`), like perchlight-updates'.
- **Desktop app screens** in `perchlight/perchlight.json`.
- **Its own footprint is stated in numbers** (see "Footprint").
- **Deploy to Cloudflare button**, `npm test` (vitest with the Workers pool), README, MIT licence, no runtime dependencies, v0.1.0 release, graphify on creation, GitHub Actions CI on the free tier.

### Should have

- `POST /api/test-notify?form=contact` sends a sample notification through every channel of a form, so you know alerts arrive before a real visitor needs them (same idea as perchlight-guard's test command).
- A small copy-paste JavaScript snippet (optional, about 1 KB, no dependencies) that sends the form with `fetch`, shows errors next to fields, and fills in the time-to-submit field. Forms still work without it.
- Duplicate collapsing: the same content sent to the same form within 10 minutes (a double click, a refresh after posting) is stored once, with a counter, and notified once.

### Out of scope (v0.1)

- A form builder or hosted form pages. You write the HTML; examples are in the README.
- Payments, multi-page forms, conditional fields, and file uploads larger than the per-request limit (no resumable uploads).
- Editing forms from the desktop app. Forms live in a file in your repo (see open question 1).
- CAPTCHAs other than Turnstile, and paid spam-scoring services (Akismet and similar).
- Several Cloudflare accounts from one deployment.

## Technical design

### Pieces

```
Your static site                         Your Cloudflare account
────────────────                         ───────────────────────────────────────────────
<form action=".../f/contact">  ──POST──▶  Worker  ──siteverify──▶ challenges.cloudflare.com
fetch(".../f/contact", JSON)   ──POST──▶    │
                                            ├──▶ D1: forms' submissions, files, deliveries,
                                            │        rate counters, daily counts
                                            ├──▶ R2 (optional, private): attachments
                                            │
                                            │  after the reply (waitUntil); retries run lazily:
                                            ├──▶ send_email binding ──▶ your verified addresses
                                            ├──▶ Resend / SES / Mailgun / Postmark (optional)
                                            └──▶ webhooks: Discord / Slack / ntfy / signed JSON

Perchlight desktop app ──▶ D1 (inbox screens)      You / scripts ──▶ /api/* (ADMIN_TOKEN)
```

- **Worker** (`src/`): `POST /f/:form`, `OPTIONS /f/:form`, signed file links, the admin API, and `GET /tick`. **No cron trigger** (open question 6): retries and retention run lazily after form posts, admin API calls and `/tick`, throttled by a timestamp row in D1 (see "Lazy housekeeping").
- **Static pages** (`public/`): the built-in thank-you and problem pages, plain HTML you can restyle, served by Workers static assets as perchlight-list does. The problem page is filled in by the Worker (HTMLRewriter) so it works without JavaScript.
- **D1 binding** `DB`. **R2 binding** `FILES`, only if a form has file fields.

### What's shared with the rest of the family

Copied (not imported, to keep zero runtime dependencies), with a comment naming the source file so changes can be carried across:

| From | What | Changes for forms |
|---|---|---|
| perchlight-list `src/lib/senders/*` | Resend, SES, Mailgun, Postmark and Cloudflare Email senders and their result types (`sent`, `retry`, `throttled`, `config`, `unknown`...) | standard mode only; no bulk, no unsubscribe headers |
| perchlight-list `src/lib/turnstile.js` | `siteverify` call with a 5-second timeout | also checks `hostname` against the form's allowed origins; records "unverified" instead of silently passing when Cloudflare can't be reached |
| perchlight-list `subscribe.js` | honeypot, body size measured on the body itself (not `Content-Length`), IPv6 /64 grouping, salted IP hash in an hourly D1 counter, form-or-JSON reply | daily-rotating key; per form |
| perchlight-list `tokens.js`, perchlight-updates `crypto.js` | `sha256Hex`, random tokens, constant-time compare | — |
| perchlight-guard `channels.js` | Discord / Slack / ntfy / JSON webhook formats | adds an HMAC signature header to JSON |
| perchlight-updates `admin.js` | `Authorization: Bearer <ADMIN_TOKEN>`, refuse tokens under 16 characters | — |

### Forms config

Forms are defined in `forms.json` in your copy of the repo, imported by the Worker at build time (a push redeploys it). It is checked by `npm test` and again when the Worker starts; a form with a mistake is switched off (its endpoint answers 503 with "this form isn't set up correctly") and `GET /api/forms` names the mistake. The other forms keep working.

```jsonc
{
  "contact": {
    "name": "Contact form",
    "origins": ["https://example.com", "https://www.example.com"],
    "fields": {
      "name":    { "type": "text",     "required": true, "max": 200 },
      "email":   { "type": "email",    "required": true },
      "message": { "type": "textarea", "required": true, "max": 5000 },
      "topic":   { "type": "select",   "options": ["Sales", "Support", "Other"] },
      "consent": { "type": "consent",  "required": true, "version": "2026-11" }
    },
    "replyTo": "email",                       // which field becomes Reply-To in your notification
    "redirect": "https://example.com/thanks/", // must be on one of "origins"
    "errorRedirect": null,                    // null = the built-in problem page
    "notify": {
      "email": ["me@example.com"],            // send_email: must be verified in Email Routing
      "webhooks": ["discord"]                 // names of secrets WEBHOOK_<NAME>_URL
    },
    "spam": { "turnstile": true, "honeypot": "website", "minSeconds": 3, "maxLinks": 2, "perHour": 5 },
    "autoReply": null                         // see "Auto-reply"
  },
  "jobs": {
    "name": "Job applications",
    "origins": ["https://example.com"],
    "maxBodyMB": 10,
    "fields": {
      "name":  { "type": "text",  "required": true },
      "email": { "type": "email", "required": true },
      "cv":    { "type": "file",  "required": true, "maxMB": 5, "types": ["pdf", "docx"], "maxCount": 1 }
    },
    "notify": { "email": ["hiring@example.com"], "fileLinks": true }
  }
}
```

Field types: `text`, `textarea`, `email`, `url`, `number`, `tel`, `select`, `checkbox`, `consent`, `hidden`, `file`. Defaults: text 500 characters, textarea 5,000, at most 50 fields, body 64 KB without files, 10 MB with files (hard ceiling 95 MB, under Workers' 100 MB request body limit).

**Fields not in the config** are kept under `_extra` (each value cut to 1,000 characters, at most 10) and flagged "fields not in config" in the inbox, rather than dropped. Dropping them would lose data silently the day you add a field to your HTML and forget the config. Set `"extraFields": "drop"` on a form to drop them instead (see open question 8).

Global settings, `wrangler.jsonc` `vars`: `MAIL_FROM` (an address on your Email Routing domain), `MAIL_PROVIDER` (`cloudflare-routing` default, or `resend` | `ses` | `mailgun` | `postmark` | `cloudflare`), `RETENTION_DAYS` (365), `SPAM_RETENTION_DAYS` (30), `SPAM_DAILY_CAP` (1000), `FILE_LINK_HOURS` (168), `FALLBACK_CONTACT` (an address shown when saving fails). Secrets: `ADMIN_TOKEN`, `IP_SALT`, `LINK_SECRET`, optional `TURNSTILE_SECRET_KEY`, `WEBHOOK_<NAME>_URL`, `WEBHOOK_SECRET`, and the email-service secrets perchlight-list already documents.

### Request formats

**`POST /f/:form`**

| Sent as | Answer on success | Answer on a problem |
|---|---|---|
| HTML form (urlencoded or multipart), no `Accept: application/json` | `303` to `redirect` (or `/thanks/?form=contact`) | `303` to `errorRedirect` (or `/problem/?form=contact&e=...`, which lists the problems in plain words and links back) |
| JSON body, or `Accept: application/json` | `200 { "ok": true, "id": "sub_..." }` | `422 { "ok": false, "errors": { field: message } }`, `413` too big, `429` rate limited, `503` couldn't save |

Reserved fields (never stored as data): the honeypot (default `website`), `cf-turnstile-response`, `_elapsed` (milliseconds on the page, set by the snippet), `_consent_version`. There is no `_next` field: a redirect URL chosen by the request would be an open redirect, so redirects come only from the config and must be on an allowed origin.

**Order of checks** (cheapest first, nothing written until step 6):

1. Form exists and is enabled. Else 404 / 503.
2. Body size, counted while reading so a huge upload is cut off early. Else 413.
3. Parse; check required fields, types, lengths, options, file types and sizes. Else 422 / the problem page.
4. Rate limit (one D1 upsert). Over the limit: 429 with "Too many messages from your connection; try again in an hour." Shown, not silent.
5. Turnstile, if on: missing, invalid, expired or reused token is shown as "Please complete the check and send again" (Turnstile tokens last 300 seconds and are single-use). If Cloudflare can't be reached within 5 s, the submission goes on, recorded as `turnstile: unverified`.
6. Spam scoring (no network): honeypot, origin, time, links, blocked words, duplicates. Result: `ok` or `spam` with reasons.
7. Write files to R2, then the submission row, its file rows and its delivery rows in one D1 `batch` (a single transaction). Files are written first so a row never points at a missing file; if the batch fails they're deleted at once, and anything left behind (or left by a row deleted from the desktop app) is removed by the housekeeping's R2 sweep: 100 objects per hourly run under `f/`, deleting those over an hour old with no `files` row. (Built: a sweep instead of a `pending/` prefix, since R2 has no rename and the sweep also covers rows deleted elsewhere.)
8. Reply to the visitor. Notifications go out after the reply with `ctx.waitUntil` (Workers allow 30 seconds), and anything unfinished is picked up by the lazy housekeeping.

**CORS.** For `OPTIONS` and `POST`, if the `Origin` header is in the form's `origins`, send `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Content-Type, Accept`. Otherwise send no CORS headers: a JSON `fetch` from another site fails its preflight and never sends. A plain HTML form post needs no CORS, so the origin check below does the job there.

**Origin check.** Browsers send `Origin` on cross-site form posts. A post whose `Origin` is not in `origins` is put in the spam folder with the reason "sent from https://other.site", not refused. Refusing would lose real messages the day you move your site to a new domain and forget the config; the spam folder shows you the mistake. A missing or `null` origin (scripts, some privacy settings) adds a spam point but doesn't decide on its own.

### Spam scoring

Each check adds a reason. Any **hard** reason makes the submission spam; two or more **soft** reasons do.

| Check | Kind | Notes |
|---|---|---|
| Honeypot filled | hard | Same answer as a real submission, so the bot learns nothing (as perchlight-list does). |
| Origin not allowed | hard | See above. |
| Turnstile `hostname` not one of the form's origins | hard | A token from someone else's site. |
| Under `minSeconds` on the page (default 3) | soft | Only when `_elapsed` is present, which needs the snippet. Without JavaScript this check is skipped, not failed. The value comes from the browser and can be faked; it only catches lazy bots. |
| More than `maxLinks` links in text fields (default 2) | soft | URLs, `href=`, `[url=`. |
| A blocked word or phrase | soft | Per-form list plus a short built-in default (for example "SEO services", "backlinks", "crypto investment"), editable. No language or alphabet rules: they'd flag real people. |
| Missing or `null` origin | soft | |
| Turnstile unverified (Cloudflare unreachable) | soft | |
| Same content hash as a submission in the last 10 minutes | — | Not spam: collapsed into that submission (`duplicate_count + 1`), notified once. |

**Rate limit without storing IPs.** Key = SHA-256 of `HMAC(IP_SALT, UTC date) : form : network`, where network is the IPv4 address or the IPv6 /64. Because the day is part of the key, the same visitor's hashes can't be linked from one day to the next, and with `IP_SALT` secret they can't be reversed by trying every IPv4 address. Rows are `(key, hour, count)`, deleted after 48 hours. Default 5 submissions an hour per network per form. Cloudflare's Workers Rate Limiting binding would avoid the D1 write, but whether it's on the Free plan wasn't confirmed; see open question 7.

**Spam flood.** Spam rows are stored until `SPAM_DAILY_CAP` (default 1,000 a UTC day). After that, spam is counted in `daily_counts` (`spam_dropped`) and not stored, so a bot can't use up your daily D1 writes. The inbox screen shows the count. Real (non-spam) submissions are never capped.

### Notifications

Delivery rows are created in the same transaction as the submission: one per channel (`email:<your address>` per address, `webhook:<name>`, `autoreply`), unique on `(submission_id, channel)`. That uniqueness is what makes "once per submission" hold even if the reply-time send and a housekeeping run overlap: a sender first claims the row (`UPDATE ... SET status='sending', claimed_at=now WHERE status IN ('pending','retry') AND ...`), and only the one that changed the row sends.

- **Spam** gets delivery rows with status `skipped` (and no auto-reply row). "Not spam" turns them into `pending` with a fresh 24-hour window. A plain status change out of spam (the desktop app's "Back to inbox") is picked up the same way by the next housekeeping run.
- **Retries:** after 1, 5, 30 minutes, 2 hours and 12 hours. After 24 hours the row is `failed`, with the last error, and shows up in the desktop app's "Failed notifications" screen with a "Try again" button. The submission was always in the inbox.
- **Setup errors** (a recipient not verified in Email Routing, a wrong API key, an unverified sender domain) are `config` results: not retried every few minutes, marked `failed` at once with a plain explanation, and the test command reports them.
- **Unknown outcomes** (a timeout after the request went out): notifications to you are retried, since a duplicate in your own inbox is better than none (Resend's idempotency key, the delivery id, stops duplicates there). Auto-replies to visitors are never retried on an unknown outcome; they're marked `unknown`.
- **Email content:** plain text plus escaped HTML; subject `[Contact form] New message from <name>` with the name cut to 60 characters and stripped of line breaks; `Reply-To` set to the `replyTo` field only if it's one valid address with no line breaks. Values from visitors are always escaped and never put in headers raw.
- **`send_email` rules:** the `from` address must be on a domain with Email Routing on, and each recipient must be a verified destination address; an unverified one fails with a setup error. Messages are capped at 25 MiB and 50 recipients by Cloudflare, so attachments are never put in emails, only signed links.
- **Webhooks:** Discord (with `allowed_mentions: { parse: [] }` so a visitor can't ping `@everyone`), Slack, ntfy, and JSON. JSON carries `X-Perchlight-Timestamp` and `X-Perchlight-Signature: sha256=HMAC(WEBHOOK_SECRET, timestamp + "." + body)`. Each form chooses `"content": "full"` (default, field values cut to 1,000 characters) or `"summary"` (form name and time only), since a webhook sends visitors' messages to another company's servers.

### Lazy housekeeping (no cron trigger)

Decided by open question 6; details in [ADR 0001](adr/0001-lazy-housekeeping-no-cron.md).

- **When:** after the reply to a form post, an admin API call or `GET /tick`, via `ctx.waitUntil`. A run starts only if the last one was at least `HOUSEKEEPING_MINUTES` (default 5) ago, decided by one conditional `UPDATE` of a timestamp row in the `state` table, so concurrent requests can't both run it. Each isolate also skips the D1 check for 15 seconds after looking.
- **What, bounded:** release stale claims; send notifications whose submission left the spam folder; then either up to 4 due notifications or, at most once an hour instead, retention (40 submissions per folder with their R2 files, old counters, a 100-object R2 orphan sweep). About 25 D1 queries at most, so a run on top of a form post stays under the free plan's 50 per invocation; CPU work is small (JSON, HMAC).
- **Trade-off:** a quiet site retries and cleans up only when the Worker is woken. Nothing is lost, but an alert can be late. The desktop app talks to D1, not the Worker, so it doesn't wake it. A free uptime monitor on `/tick` (288 requests a day at 5 minutes, no cron trigger) keeps a quiet site on schedule. `POST /api/housekeeping` runs it now.

### Auto-reply (opt-in)

An email to the submitter ("Thanks, we got your message"). It's off by default because it lets anyone make your domain send an email to any address: a spammer can enter a victim's address thousands of times, hurting your domain's reputation and annoying strangers. When turned on:

- It needs `MAIL_PROVIDER` set to a real email service. The free `send_email` route can't do it: it only reaches your own verified addresses, and Cloudflare's Email Service needs Workers Paid to email arbitrary addresses.
- It needs Turnstile on for that form, and is sent only for `ok` submissions, never spam.
- The text is fixed in the config. Nothing the visitor typed is put in it (not even their name), so it can't carry a spammer's message.
- At most 1 per address per 24 hours (by hashed address) and `autoReply.dailyCap` per form (default 50).

### File uploads

- Only for `multipart/form-data` forms with `file` fields, and only when the `FILES` R2 binding exists. A form with file fields and no R2 binding is switched off with a config error rather than accepting messages and dropping files.
- **Checks:** count, size per file, total body, and type. Type is decided by the file's first bytes (PDF `%PDF-`, PNG, JPEG, GIF, WebP, ZIP-based `docx`/`xlsx`/`odt`, plain text as valid UTF-8), and must also match the allowed extension. A mismatch is a 422 the visitor sees. No executables, HTML or SVG by default (SVG and HTML can carry scripts).
- **Storage:** key `f/<form>/<submission>/<random>`, the original name kept only in D1 (cleaned: no paths, at most 200 characters), size and SHA-256 recorded. The bucket has no public access and no `r2.dev` URL.
- **Opening files:** the R2 Workers binding has no presigned URLs, so the Worker signs its own: `GET /file/<id>?exp=<unix>&sig=<HMAC(LINK_SECRET, id.exp)>`. Served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store`, so a file never runs in the browser as a page. Links in notification emails last `FILE_LINK_HOURS` (default 7 days): anyone who has the email can download until then, which the README says plainly; `"fileLinks": false` leaves them out. `POST /api/files/:id/link` makes a 15-minute link; `GET /api/files/:id` streams with the admin token.
- **Spam's files** are kept with the spam row and deleted with it, so a misjudged job application keeps its CV.
- **CPU:** parsing a large multipart body may not fit in the Free plan's 10 ms of CPU per request; this hasn't been measured. Default limit 10 MB, measured during the build, and the README will state the largest upload that reliably works on Free.

### Privacy and GDPR

The design follows two GDPR principles: keep only what's needed for the purpose (data minimisation, Art. 5(1)(c)) and no longer than needed (storage limitation, Art. 5(1)(e)), and makes the right to erasure (Art. 17) one call.

- **Stored:** the fields you configured (and flagged extras), time received, form, status, spam reasons, the allowed origin it came from, Turnstile result, seconds on page (if sent), consent time and version, attachment files.
- **Not stored:** IP addresses (only the daily-keyed hash, deleted after 48 hours), user agent, cookies, country, Turnstile tokens. The Worker sets no cookies.
- **Retention:** inbox `RETENTION_DAYS` (default 365; `0` = keep until deleted), spam `SPAM_RETENTION_DAYS` (default 30), delivery rows 90 days, counters 48 hours. Files are deleted with their submission. Checked at most hourly by the lazy housekeeping, up to 40 submissions per folder per run.
- **Delete on request:** `DELETE /api/submissions?email=someone@example.com` deletes every submission whose `replyTo` address matches (case-insensitive), across all forms, with their files and deliveries, and returns the count. `GET /api/export?email=` returns the same set first, for a subject access request. Only a count and time are logged.
- **Consent checkbox:** a `consent` field must be ticked if `required`; the stored record is the time and the `version` string from the config (you keep your wording versions in your own site's history).
- **Third parties:** Turnstile (Cloudflare), your email service and webhook targets receive data. The README lists them so you can put them in your privacy notice, and says plainly that you're responsible for your privacy notice and lawful basis.
- **README advice:** ask only for what you need; don't ask for dates of birth, ID numbers or health details in a contact form; use `"content": "summary"` for webhooks to chat services.

### Admin API

Everything under `/api/`, with `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare, refused if under 16 characters).

| Endpoint | What it does |
|---|---|
| `GET /api/forms` | Each form, whether it's enabled, any config error, counts by status today and in total. |
| `GET /api/submissions?form=&status=&since=&limit=&cursor=` | List, newest first, at most 200 per page. |
| `GET /api/submissions/:id` | One submission with its files and deliveries. |
| `PATCH /api/submissions/:id` | `{ "status": "read" | "new" | "archived" | "spam" | "ok" }`. `ok` = not spam: moves to the inbox and sends skipped notifications. |
| `DELETE /api/submissions/:id` | Deletes it, its files and deliveries. |
| `DELETE /api/submissions?email=` | Delete on request (see above). |
| `GET /api/export?form=&format=csv|json&status=&since=&email=` | CSV: UTF-8 with BOM (so Excel reads accents), one column per configured field plus id, time, status, spam reasons, file names; values starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` so spreadsheets don't run them as formulas. JSON: the rows as stored. Streamed, so large exports don't hit memory limits. |
| `GET /api/files/:id` · `POST /api/files/:id/link` | Download, or make a 15-minute signed link. |
| `GET /api/deliveries?status=failed` · `POST /api/deliveries/:id/retry` | Failed notifications. |
| `POST /api/test-notify?form=` | Sample notification through every channel, with exact errors. |

### Data model (D1)

- `submissions`: `id` (random, `sub_` + 16 characters, not guessable), `form_id`, `created_at`, `status` (`new` | `read` | `archived` | `spam`), `spam_reasons` (JSON), `data` (JSON of field values), `extra` (JSON, nullable), `summary` (first 200 characters of the main text fields, for the inbox list), `reply_email` (lower-cased, nullable, indexed for delete-on-request), `content_hash`, `duplicate_count`, `origin`, `turnstile` (`passed` | `off` | `unverified`), `seconds_on_page`, `consent_at`, `consent_version`. Indexes: `(form_id, status, created_at)`, `(reply_email)`, `(content_hash, created_at)`.
- `files`: `id`, `submission_id`, `field`, `name`, `content_type`, `size`, `sha256`, `r2_key`, `created_at`.
- `deliveries`: `id`, `submission_id`, `channel`, `status` (`pending` | `sending` | `retry` | `sent` | `failed` | `unknown` | `skipped`), `attempts`, `next_attempt_at`, `claimed_at`, `sent_at`, `last_error`. Unique on `(submission_id, channel)`; index `(status, next_attempt_at)`.
- `rate_counters`: `key`, `hour`, `count`. Primary key `(key, hour)`.
- `daily_counts`: `day`, `form_id`, `kind` (`ok` | `spam` | `spam_dropped` | `rate_limited` | `invalid`), `count`.
- `autoreply_sent`: `email_hash`, `day`. Deleted after 2 days.

Foreign keys cascade from `submissions` to `files` and `deliveries`; R2 objects are deleted by the Worker before the row.

### Desktop app screens (`perchlight/perchlight.json`)

Built with what the current Perchlight screen format supports (D1 tables, columns, `set` and `delete` actions):

- **Inbox** (`submissions`): received, form, status (enum), summary, reply email, spam reasons, `data` as a JSON column. Actions: *Mark read* (`status: read`), *Archive*, *Spam*, *Back to inbox* (`status: new`), *Delete* (confirm).
- **Failed notifications** (`deliveries`): channel, status, attempts, last error. Action: *Try again* (`status: pending`, `next_attempt_at: 0`).
- **Attachments** (`files`): name, type, size, submission.

Two gaps in the generic format: a *Not spam* button that also re-sends skipped notifications, and opening an attachment (needs a signed link from the Worker). Both work through the admin API for now, and CSV export of a screen with a JSON column may not split fields into columns. A `perchlight-forms` preset in the Perchlight app, like the existing perchlight-list preset, would close those gaps (open question 2). Note: deleting a submission row from the generic screen leaves its R2 files until the hourly R2 sweep removes orphans. The desktop app reads D1 directly, so it doesn't wake the Worker: its buttons take effect at the Worker's next housekeeping run.

### Edge cases

- **When D1 can't be written** (an outage, or the free daily write limit reached, which blocks writes until 00:00 UTC): the visitor is not told "thanks". The Worker tries to email the submission straight to your notify addresses (`send_email`, no D1 needed; without attachments). If that works, the visitor gets the normal thank-you; if not, a 503 page: "We couldn't save your message. Please try again later or email `FALLBACK_CONTACT`." Either way nothing is silently lost.
- **Workers' daily request limit** (100,000 on Free): over it, Cloudflare answers error 1027 and the form visibly fails. perchlight-guard warns before that.
- **Turnstile without JavaScript:** Turnstile's widget needs JavaScript, so a form with Turnstile on doesn't work for visitors with JavaScript off. No-JS forms rely on the honeypot, rate limit, origin and content checks. The README says this.
- **Turnstile token expired** (more than 5 minutes on the page) or reused: shown as "please complete the check again"; the snippet resets the widget.
- **Double click / refresh after posting:** collapsed by content hash, notified once.
- **Encoding:** the README forms use `accept-charset="UTF-8"`; bodies that aren't valid UTF-8 are a 422.
- **Two housekeeping runs at once, or one during a reply-time send:** delivery rows are claimed with a conditional update; stale claims (over 2 minutes) are released (auto-replies become `unknown`, never resent).
- **Cron trigger budget:** Cloudflare allows 5 cron triggers per account on Free, and perchlight-guard, perchlight-list and perchlight-updates use four. perchlight-forms uses none (open question 6).
- **D1 database size:** 500 MB per database on Free. At about 2 KB a submission that's roughly 250,000 submissions; retention keeps a normal site far below it.
- **Config mistakes:** a redirect URL off the allowed origins, a file field without R2, an unknown field type, a webhook name with no secret: that form is switched off with the reason in `GET /api/forms` and the test command; the others keep working.
- **Hostile content:** values are stored as sent and escaped wherever they're shown (emails, webhooks, CSV, built-in pages). The problem page shows field names from the config, never visitor text.

### Footprint

Measured during the build; first estimates:

| | Idle (no submissions) | Per submission | 1,000 submissions a day |
|---|---|---|---|
| Worker requests (limit 100,000/day) | 0 (288 if you ping `/tick` every 5 minutes) | 1 (+1 preflight for JSON `fetch`; the thank-you page is your own site or a static asset) | about 2,300 (2.3%) |
| D1 rows written (limit 100,000/day) | 0 without traffic; at most 1 per housekeeping run with no work | about 15 (submission, deliveries and their updates, counters, indexes) | about 15,000 (15%) |
| D1 rows read (limit 5,000,000/day) | about 1,000 | about 20 | about 21,000 (0.4%) |
| Subrequests (limit 50/request) | — | 1 Turnstile + 1 per channel | — |
| R2 (if used; 10 GB, 1M Class A/month) | 0 | 1 write per file | e.g. 20 CVs a day of 1 MB: 0.6 GB/month, about 0.1% of Class A |

So on Free, writes are the limit that would bind first, at roughly 6,000 submissions a day. Spam is capped (`SPAM_DAILY_CAP`) so a bot flood can't use the writes up.

**What it costs you:** nothing inside the free plans. Workers Free, D1 Free and Turnstile (free, unlimited verifications, up to 20 widgets) are enough. **R2 asks for a payment method on file** before you can turn it on, even though staying inside its free tier costs nothing (the same note as perchlight-updates); forms without file fields don't need R2. Email to your own verified addresses through `send_email` is free on all plans. Auto-replies need an email service (most have a free tier).

## Testing

- **Unit:** config validation (every mistake listed above), field validation, multipart limits, file-type detection by first bytes, spam scoring, rate-limit keys (the same IP gives different keys on different days), duplicate hashing, signed links (expiry, tampering), CSV escaping (formula prefixes, quotes, newlines, BOM), webhook formats and signature, email escaping and header safety.
- **Integration** with vitest and `@cloudflare/vitest-pool-workers` (the Workers pool, local D1 and R2): HTML post → 303 to the right page; JSON post → JSON and correct CORS for allowed and other origins; preflight; honeypot/origin/link cases land in spam with reasons; *not spam* sends skipped notifications; retries and back-off (and the lazy housekeeping throttle) with a fake `send_email`, fake email services (the perchlight-list fakes) and a fake webhook; once-per-submission under two overlapping runs; D1 write failure → email fallback → 503; spam cap; uploads stored, refused by type and size, never readable without a valid link or token; retention clean-up; delete-by-email; export.
- **With your real account (free):** deploy to a test subdomain, verify your address in Email Routing, post the README's example form from a static page, and check the email, a Discord webhook, and a real Turnstile widget. Cloudflare's Turnstile test keys (always pass / always fail / already spent) cover the error paths. This needs you to verify an address and create a Turnstile widget.
- **Not tested** (costs money, or needs a card or paid account the authors won't put down):
  - real sends through Resend, SES, Mailgun, Postmark (tested only against fakes built from their docs, as in perchlight-list);
  - Cloudflare Email Service to arbitrary addresses (needs Workers Paid);
  - R2 on a real account (needs a payment method on file; tested only against local R2), so signed-link downloads and large uploads on the real network are unverified until a user with R2 runs them;
  - the largest upload that fits in 10 ms CPU on the real Free plan, unless R2 is turned on for the test.

## Open questions (resolved 2026-11-10)

The owner approved the design with these answers:

1. **Where forms are defined:** a config file in the repo (`forms.json`), not a D1 table.
2. **Desktop app:** generic Perchlight screens now (`perchlight/perchlight.json`); a dedicated `perchlight-forms` preset later, in the Perchlight repo.
3. **Retention defaults:** inbox 365 days, spam 30 days.
4. **Shared code:** copied from perchlight-list, perchlight-guard and perchlight-updates with source comments; no shared package.
5. **Auto-reply:** included in v0.1, off by default, needs Turnstile and an email service, never echoes visitor input.
6. **Cron budget:** **no cron trigger.** The free plan allows 5 per account and the family already uses 4. Retries (24-hour window) and retention run lazily on incoming requests and admin API calls via `ctx.waitUntil`, throttled by a timestamp row in D1, with bounded work per run (see "Lazy housekeeping" and ADR 0001).
7. **Rate-limit store:** D1 counters, keyed by a daily-rotating salted hash; no Rate Limiting binding; IPs never stored.
8. **Fields not in the config:** keep and flag (`"extraFields": "drop"` to drop).

## Built differently from this document (v0.1)

- Orphaned R2 files are found by an hourly sweep rather than a `pending/` key prefix (see step 7).
- Owner email notifications get one delivery row per address (`email:<address>`), so a failure for one address never re-sends to the others.
- JSON webhooks need `WEBHOOK_SECRET`; without it the delivery fails with a setup error rather than sending unsigned.
- `IP_SALT` (16+ characters) is required: forms answer 503 until it's set, rather than storing a guessable hash.
- When `MAIL_PROVIDER` is an email service, all notifications go through it (not only auto-replies).
- A spam submission that arrives while D1 is down is emailed to you marked as possible spam (honeypot hits get the normal answer and nothing else).
- `GET /tick` and `POST /api/housekeeping` were added for the lazy housekeeping.

## Couldn't confirm (2026-11-10)

- **R2's payment-method requirement** isn't stated on Cloudflare's R2 pricing page; it comes from the family's perchlight-updates README and third-party guides.
- **Basin, Getform and Netlify Forms prices**: Netlify's pricing page no longer lists form limits; Basin and Getform weren't checked. Only Formspree's figures are quoted.
- **CPU time of multipart parsing** for large files on the 10 ms Free limit.
- **Workers Rate Limiting binding** on the Free plan.
- **Daily limits for `send_email` to verified addresses**: Cloudflare's pricing page says it's free on all plans and gives no daily cap; its send-email page mentions rate limits without numbers.
- **CSV export of generic D1 screens** in the Perchlight app (its README mentions CSV export for the mailing-list screen).

## Sources

- Workers limits (100,000 requests/day, 10 ms CPU, 50 subrequests, 100 MB body on Free zones, 30 s `waitUntil`, 5 cron triggers): https://developers.cloudflare.com/workers/platform/limits/
- D1 pricing and limits (5M reads/100k writes a day, 5 GB, reset 00:00 UTC, writes blocked when over; 500 MB per database, 2 MB rows, 50 queries per invocation): https://developers.cloudflare.com/d1/platform/pricing/ · https://developers.cloudflare.com/d1/platform/limits/
- R2 free tier (10 GB-month, 1M Class A, 10M Class B, free egress): https://developers.cloudflare.com/r2/pricing/ · Workers binding (`httpMetadata`, `customMetadata`, no presigned URLs mentioned): https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Turnstile server-side validation (300 s tokens, single use, 2,048-character limit, `hostname`, `action`, error codes): https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ · plans (free, unlimited verifications, 20 widgets, 10 hostnames each): https://developers.cloudflare.com/turnstile/plans/
- `send_email` (25 MiB, 50 recipients, `E_RECIPIENT_NOT_ALLOWED`): https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/ · send bindings (`destination_address`, `allowed_destination_addresses`, verified destinations): https://developers.cloudflare.com/email-service/configuration/send-bindings/ · pricing ("Sending to verified destination addresses in your account is free on all plans"; arbitrary recipients need Workers Paid): https://developers.cloudflare.com/email-service/platform/pricing/
- Formspree plans: https://formspree.io/plans
- GDPR Art. 5 and Art. 17: https://gdpr-info.eu/art-5-gdpr/ · https://gdpr-info.eu/art-17-gdpr/

## Acceptance criteria

- A plain HTML form (Turnstile off) with JavaScript off posts to `/f/contact` and lands on the configured thank-you page; the submission is in the inbox and one email arrives at the verified address.
- The same form missing a required field lands on the problem page naming the field; nothing is stored.
- A JSON `fetch` from an allowed origin gets `{ ok: true }` with the right CORS header; from another origin the preflight fails and nothing is stored.
- A filled honeypot gets the normal thank-you, is stored as spam with reason "honeypot", and sends no notification; marking it "not spam" sends the notification once.
- With the email channel failing, the submission is stored, the delivery is retried on schedule, and after 24 hours shows as failed in the desktop app; "Try again" sends it once.
- Two overlapping housekeeping runs never send the same notification twice.
- With D1 writes failing, the visitor never sees "thanks" unless the fallback email went out.
- A 6th submission in an hour from one network gets a visible 429; no IP address appears anywhere in D1.
- A PDF CV within limits is stored in R2 and opens only through a valid, unexpired signed link or the admin token; a renamed `.exe` is refused with a message.
- `DELETE /api/submissions?email=` removes every matching submission and its files, and returns the count.
- CSV export opens in a spreadsheet with accents intact and no formula runs from a cell starting with `=`.
- With no submissions and no `/tick` pings, it uses no requests and no D1 writes (no cron trigger).
