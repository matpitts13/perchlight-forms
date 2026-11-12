# perchlight-forms

[![CI](https://github.com/matpitts13/perchlight-forms/actions/workflows/ci.yml/badge.svg)](https://github.com/matpitts13/perchlight-forms/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matpitts13/perchlight-forms)

**A form backend for static sites, on your own Cloudflare account.** Point a contact, feedback, bug-report, waitlist or job-application form at `https://<your worker>/f/<form id>`. Every submission is stored in your D1 database, checked for spam, and sent to you by email and/or webhook. It works from a plain HTML form with no JavaScript (the visitor lands on your thank-you page) and from `fetch()` with JSON, with CORS only for your own sites.

It replaces paid form services for small sites. Formspree's free plan, for example, allows 50 submissions a month and no file uploads; its paid plans are $15, $30 and $90 a month (formspree.io/plans, checked 2026-11-10). Here your visitors' messages stay in your account, for as long as you choose.

Part of [Perchlight](https://github.com/matpitts13/perchlight), a free toolkit for running a product on Cloudflare.

## What it does

- **Plain HTML works.** On success the browser gets a 303 to your thank-you page (or a built-in one). On a problem it gets a built-in page that says exactly what to fix ("Email is required") and links back to your form.
- **`fetch()` works too.** JSON in, JSON out: `{ "ok": true, "id": "sub_..." }` or `{ "ok": false, "errors": { "email": "Email is required" } }` with 422 (413 too big, 429 rate limited, 503 couldn't save).
- **Store first, then notify.** A submission is written to D1 before the visitor is told "thanks". If D1 can't be written, it's emailed straight to you, and only if that works is the visitor thanked; otherwise they see a 503 that says so and gives `FALLBACK_CONTACT`. Spam-flagged posts are never emailed this way, and each Worker instance sends at most 20 such emails an hour (a D1 outage caused by a flood mustn't become an email flood); past that, visitors get the 503. If an attachment can't be written to R2, the visitor gets a 503 saying the file wasn't saved, and nothing is stored.
- **Nothing is lost silently.** Each submission is either shown back to the sender as an error they can fix, put in the inbox, or put in the spam folder with its reasons. The one exception: past `SPAM_DAILY_CAP` (1,000 a day) further spam is only counted, not stored. A flood still costs some writes: see [What it costs](#what-it-costs).
- **Spam checks**, each optional per form: a honeypot field, Cloudflare Turnstile (checked server-side), a too-fast check (with the snippet), a per-network rate limit (5 an hour by default) that never stores an IP address, link-count and blocked-word checks, and an origin check. One hard reason (honeypot, wrong origin, a Turnstile token from another site) or two soft ones make a submission spam.
- **Notifications, once each:** email to your own verified addresses through the free `send_email` binding, or through Resend, Amazon SES, Mailgun, Postmark or Cloudflare Email Service; webhooks to Discord, Slack, ntfy or signed JSON. Retried after 1, 5, 30 minutes, 2 hours and 12 hours; after 24 hours a notification shows as failed, with its error, and can be tried again.
- **File uploads to R2** (optional): per-field type and size limits, type checked by the file's first bytes, never public, opened through expiring signed links.
- **Duplicates collapse:** the same content to the same form within 10 minutes (a double click, a refresh) is stored once with a counter and notified once.
- **Auto-reply** to the sender (off by default; see [Auto-reply](#auto-reply)).
- **Export** as CSV (opens in Excel with accents intact; no cell runs as a formula) or JSON, and **delete everything from one address** in one call.
- **Perchlight desktop app** screens for the inbox, failed notifications, attachments and daily counts.

## Set up

### 1. Email (recommended)

Turn on Email Routing for one of your domains (dashboard → your domain → **Email** → **Email Routing**), and add and verify your own address under **Destination addresses**. Notifications are sent from an address on that domain to your verified addresses, free.

### 2. Your forms

Edit [`forms.json`](forms.json): one entry per form. Check it with `npm run check`. See [Forms](#forms) for every setting.

### 3. Deploy

**One click:** click **Deploy to Cloudflare** above. Fill in `ADMIN_TOKEN` and `IP_SALT` when asked (`LINK_SECRET` only for file uploads; the others only if you use them). Then, in your copy, set `MAIL_FROM` in `wrangler.jsonc` and edit `forms.json`; a push redeploys.

**By hand:**

```sh
git clone https://github.com/matpitts13/perchlight-forms
cd perchlight-forms
npm install
npx wrangler login
npx wrangler d1 create perchlight-forms     # paste the database_id into wrangler.jsonc if asked
# edit wrangler.jsonc (MAIL_FROM) and forms.json
npm run deploy                               # applies D1 migrations, then deploys
npx wrangler secret put ADMIN_TOKEN          # 16+ random characters
npx wrangler secret put IP_SALT              # 16+ random characters
```

Forms answer 503 until `IP_SALT` is set; the admin API answers 503 until `ADMIN_TOKEN` is 16+ characters.

### 4. Your HTML

```html
<form action="https://perchlight-forms.<you>.workers.dev/f/contact" method="post" accept-charset="UTF-8">
  <label>Name <input name="name" required maxlength="200"></label>
  <label>Email <input name="email" type="email" required></label>
  <label>Message <textarea name="message" required maxlength="5000"></textarea></label>
  <!-- the honeypot: hidden from people, filled in by bots -->
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button>Send</button>
</form>
```

That's all a no-JavaScript form needs. Optionally add the 1 KB snippet, which sends with `fetch`, shows errors next to fields and fills in the time-on-page for the too-fast check:

```html
<form data-perchlight data-thanks="/thanks/" action="..." method="post">
  ... <span data-error-for="email"></span> ... <p data-form-status></p>
</form>
<script src="https://perchlight-forms.<you>.workers.dev/forms.js" defer></script>
```

Turnstile: add the widget to the form (it sends `cf-turnstile-response`), set `"turnstile": true` and the `TURNSTILE_SECRET_KEY` secret. The widget needs JavaScript, so a form with Turnstile on doesn't work with JavaScript off; no-JS forms rely on the honeypot, rate limit, origin and content checks.

### 5. Check it works

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://perchlight-forms.<you>.workers.dev/api/test-notify?form=contact"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://perchlight-forms.<you>.workers.dev/api/forms"
```

The first sends a sample notification through every channel of the form and reports exact errors. The second lists each form, whether it's switched on, any config mistake, and today's counts.

## Forms

```jsonc
{
  "contact": {
    "name": "Contact form",
    "origins": ["https://example.com", "https://www.example.com"],  // exact origins, no path
    "fields": {
      "name":    { "type": "text",     "required": true, "max": 200 },
      "email":   { "type": "email",    "required": true },
      "message": { "type": "textarea", "required": true, "max": 5000 },
      "topic":   { "type": "select",   "options": ["Sales", "Support", "Other"] },
      "consent": { "type": "consent",  "required": true, "version": "2026-11" }
    },
    "replyTo": "email",                        // this field becomes Reply-To in your notification
    "redirect": "https://example.com/thanks/", // must be on one of "origins"; null = built-in page
    "errorRedirect": null,                     // null = the built-in problem page
    "notify": {
      "email": ["me@example.com"],             // verified in Email Routing
      "webhooks": ["discord"],                 // secret WEBHOOK_DISCORD_URL; or { "name": "x", "format": "ntfy" }
      "content": "full",                       // or "summary": form name and time only
      "fileLinks": true
    },
    "spam": { "turnstile": false, "honeypot": "website", "minSeconds": 3, "maxLinks": 2, "perHour": 5, "blockedWords": [] },
    "extraFields": "keep",                     // or "drop"
    "autoReply": null
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
    "notify": { "email": ["hiring@example.com"] }
  }
}
```

- **Field types:** `text` (default max 500), `textarea` (5,000), `email`, `url`, `number`, `tel`, `select`, `checkbox` (with `options`: several choices), `consent` (records the time and `version`), `hidden`, `file`. At most 50 fields. `"label"` sets the name shown in error messages and emails.
- **Body size:** 64 KB without files, 10 MB with files by default (`maxBodyMB`, at most 95, under Workers' 100 MB limit).
- **File types:** pdf, png, jpg, gif, webp, docx, xlsx, pptx, odt, ods, txt, csv. Never executables, HTML or SVG. The name's extension and the first bytes must agree, so a renamed `.exe` is refused. (Office files are ZIPs underneath; a ZIP renamed `.docx` passes. It's stored and served as a download only.)
- **Fields not in the config** are kept (up to 10, each cut to 1,000 characters) and flagged "not in config", so a field you add to your HTML and forget here isn't lost. `"extraFields": "drop"` drops them.
- **Redirects come only from this file** and must be on one of the form's origins; there's no `_next` field (that would be an open redirect).
- **A form with a mistake is switched off** (its endpoint answers 503) with the reason in `GET /api/forms`; the other forms keep working. Mistakes include a redirect off its origins, a file field without R2 or `LINK_SECRET`, an unknown type, a webhook with no secret, Turnstile on without its secret.
- **Limits per form:** at most 4 notification channels (email addresses + webhooks + auto-reply) and 5 files per submission, so one post and its notifications fit in one request's subrequest budget. Each address or webhook may be listed only once.
- **Turnstile action:** `"spam": { "turnstile": true, "turnstileAction": "contact" }` also requires the token's `action` (the widget's `data-action`) to match; a token minted for another form or page is spam.
- **Blocked words:** your `blockedWords` plus a short built-in list ("seo services", "backlinks", "crypto investment" and a few more; `"defaultBlockedWords": false` turns it off). No language or alphabet rules: they'd flag real people.

### Settings

`vars` in `wrangler.jsonc`:

| Setting | Default | |
|---|---|---|
| `MAIL_FROM` | | an address on your Email Routing domain |
| `MAIL_PROVIDER` | `cloudflare-routing` | or `resend`, `ses`, `mailgun`, `postmark`, `cloudflare` (all notifications then go through it; the secrets are as in perchlight-list) |
| `RETENTION_DAYS` | `365` | inbox; `0` = keep until deleted |
| `SPAM_RETENTION_DAYS` | `30` | spam folder |
| `SPAM_DAILY_CAP` | `1000` | spam stored per UTC day, all forms |
| `FILE_LINK_HOURS` | `168` | how long file links in notification emails work |
| `FALLBACK_CONTACT` | | shown to visitors if a message couldn't be saved or emailed |
| `HOUSEKEEPING_MINUTES` | `5` | at most one retry/clean-up run per this many minutes |
| `PUBLIC_URL` | | your Worker's URL for links in emails (empty = the request's) |

Secrets: `ADMIN_TOKEN`, `IP_SALT`, `LINK_SECRET` (uploads), `TURNSTILE_SECRET_KEY`, `WEBHOOK_<NAME>_URL`, `WEBHOOK_SECRET` (JSON webhooks), and your email service's keys.

**Counts:** today's `ok`, `spam` and `autoreply` counts are exact. `invalid`, `rate_limited`, `spam_dropped`, `duplicate` and `file_failed` are **approximate**: each Worker instance holds them in memory and writes them once a minute, so an instance that's shut down loses its last minute. `GET /api/forms` says so too.

## No cron trigger: how retries and clean-up run

Cloudflare's free plan allows 5 cron triggers per account, and perchlight-guard, perchlight-list and perchlight-updates use 4. So perchlight-forms uses none ([ADR 0001](docs/adr/0001-lazy-housekeeping-no-cron.md)):

- A submission's notifications go out straight after the visitor's reply.
- Retries and clean-up run **lazily**: after a form post, an admin API call or a request to `GET /tick`, at most once every `HOUSEKEEPING_MINUTES`. Within one request's budget, a run starts only if the request has budget left for real work (so a busy post never burns the slot), then: retries R2 deletes that failed; if retention is due (hourly) or part-done, runs its next steps (inbox folder, spam folder, old counters, R2 orphan sweep) as far as the budget allows and saves where it got to, so it continues on the next run and can't be starved; then sends due notifications (up to 4) with what's left. Tested: on a form with 4 channels and 5 files, posts alone (no admin calls, no `/tick`) finish retention and the retries within 3 posts 5 minutes apart.
- **The trade-off, plainly:** on a quiet site, a failed notification waits for the next request before it's retried, and old submissions wait to be deleted. Nothing is lost (the submission is in D1 from the start), but an alert can be late. **The Perchlight desktop app doesn't wake the Worker**: it reads and writes D1 directly. Its "Try again" and "Back to inbox" take effect at the Worker's next run.
- **For a quiet site, free:** point an uptime monitor (or your own site's pages) at `https://<your worker>/tick`. It answers 204 and does only the throttled run. Every 5 minutes is 288 requests a day, 0.3% of the free limit, and still no cron trigger.

## Auto-reply

An email to the sender ("Thanks, we got your message"). Off by default, because it lets anyone make your domain email any address: a spammer can type a victim's address thousands of times. To turn it on, a form needs:

- `MAIL_PROVIDER` set to an email service (the free `send_email` route only reaches your own verified addresses; Cloudflare Email Service needs Workers Paid for other addresses),
- `"turnstile": true` (and it's sent only when Turnstile actually passed, never for spam),
- `"autoReply": { "subject": "...", "text": "...", "dailyCap": 50 }`. The text is fixed: nothing the visitor typed goes in it, not even their name.

At most one per address per 24 hours (by keyed hash of the address) and `dailyCap` per form a day. A timeout after the request went out is marked "unknown" and never retried, so nobody gets two.

## Admin API

All under `/api/`, with `Authorization: Bearer <ADMIN_TOKEN>`.

| Endpoint | |
|---|---|
| `GET /api/forms` | forms, whether they're on, config mistakes, counts, setup problems |
| `GET /api/submissions?form=&status=&since=&limit=&cursor=` | newest first, up to 200 a page (`status`: new, read, archived, spam or inbox) |
| `GET /api/submissions/:id` | one, with files and notifications |
| `PATCH /api/submissions/:id` | `{ "status": "read" \| "new" \| "archived" \| "spam" \| "ok" }`; `ok` (or any inbox status) on a spam one moves it to the inbox and sends the notifications it skipped, once |
| `DELETE /api/submissions/:id` | with its files and notifications; `filesPending` > 0 means R2 couldn't delete some files yet (they're queued and retried by every housekeeping run) |
| `DELETE /api/submissions?email=` | every submission from that address, across forms (logs only counts and time); `filesPending` as above. Erasure is finished when `filesPendingDelete` in `GET /api/forms` is 0 |
| `GET /api/export?form=&format=csv\|json&status=&since=&email=&limit=&cursor=` | streamed, at most 1,000 rows per request; `X-Next-Cursor` (and `Link: rel="next"`) gives the next page. `npm run export -- https://<your worker> "form=contact&format=csv" > contact.csv` (with `ADMIN_TOKEN` set) joins every page. A failure mid-stream aborts the download rather than ending it short |
| `GET /api/files/:id` · `POST /api/files/:id/link` | download, or a 15-minute signed link |
| `GET /api/deliveries?status=failed` · `POST /api/deliveries/:id/retry` | failed notifications |
| `POST /api/test-notify?form=` | a sample through every channel |
| `POST /api/housekeeping` | run retries and clean-up now |

## Perchlight desktop app

[`perchlight/perchlight.json`](perchlight/perchlight.json) adds screens for the **inbox** (Mark read, Archive, Spam, Back to inbox, Delete), **failed notifications** (Try again), **attachments** and **daily counts**. Replace `YOUR-D1-DATABASE-ID` and import it. Gaps of the generic screens, until a perchlight-forms preset exists in the app: opening an attachment needs a signed link from the API (`POST /api/files/:id/link`); deleting a row there leaves its R2 file until the hourly clean-up removes it; and buttons take effect on the Worker's next run (see above).

## Privacy

- **Stored:** the fields you configured (and flagged extras), time, form, status, spam reasons, the allowed origin it came from, Turnstile result, seconds on page (if sent), consent time and version, attachments.
- **Not stored:** IP addresses (only a hash whose key changes every day, deleted after 48 hours), user agents, cookies, countries, Turnstile tokens. The Worker sets no cookies.
- **Retention:** inbox 365 days, spam 30 days, notification records 90 days, counters 48 hours, by default.
- **Third parties that receive data:** Cloudflare (Turnstile, and hosting), your email service, your webhook targets. A webhook to a chat service sends visitors' messages to that company: use `"content": "summary"` if that matters. List them in your privacy notice. **You** are responsible for your privacy notice and lawful basis.
- **Ask only for what you need.** Don't ask for dates of birth, ID numbers or health details in a contact form.
- **File links in emails** work for `FILE_LINK_HOURS` (7 days): anyone who has the email can download until then. `"fileLinks": false` leaves them out.

## What it costs

Nothing inside the free plans, measured on the local test run and from the code (not yet on a real account):

| | Idle | Per submission | 1,000 submissions a day |
|---|---|---|---|
| Worker requests (free: 100,000/day) | 0 (no cron); 288 if you ping `/tick` every 5 minutes | 1 (+1 preflight for a JSON `fetch` from another site) | about 2,000 (2%) |
| D1 rows written (free: 100,000/day) | 0; with `/tick`, at most 1 per run when there's no work | about 10 to 15 (submission, notifications and their updates, counters, indexes) | about 15,000 (15%) |
| D1 rows read (free: 5,000,000/day) | 1 per housekeeping check | about 20 | about 20,000 (0.4%) |
| Subrequests per request (free: 50) | at most about 25 per housekeeping run | about 6 D1 calls + 1 per file + 1 Turnstile, then 3 per notification channel + 2 to load the submission (+3 for an auto-reply) | |
| R2, if used (free: 10 GB, 1M Class A/month) | 0 | 1 write per file | 20 CVs a day of 1 MB: 0.6 GB a month |

Writes would bind first, at roughly 6,000 submissions a day.

**Subrequests:** whether D1, R2 and `send_email` binding calls count toward the free plan's 50 subrequests per request isn't confirmed in Cloudflare's docs, so the Worker assumes they all do and keeps each request under 45: a post's own notifications are reserved first (that's why forms are limited to 4 channels and 5 files), and the housekeeping run gets what's left, deferring the rest to the next request.

**In a flood:** stored spam stops at `SPAM_DAILY_CAP`, but each post still reaches D1: a post from a new network writes 1 rate-counter row (2 with its index), and one that's past the cap or invalid writes nothing else at once (those counts are kept in memory and written in one batch per minute per Worker instance). A network over its hourly limit is then refused from memory, with no D1 write, by that instance. So a flood from many networks costs roughly 1 to 2 rows written per request, about as many as the Workers free plan's own 100,000 requests a day would allow; it can use up D1's daily writes, but it can't fill your database with spam. No cron trigger is used (the free plan allows 5 per account). Turnstile is free (unlimited verifications, 20 widgets). Email to your own verified addresses through `send_email` is free on all plans.

**R2 asks for a payment method on file** before you can turn it on, even though staying inside its free tier costs nothing. Forms without file fields don't need R2. Auto-replies need an email service (most have a free tier).

## Tested, and not tested

- `npm test`: 122 tests with vitest and the Workers pool (local D1 and R2), against a fake `send_email`, a fake Turnstile, a fake Resend and fake webhooks. They cover:
  - plain HTML posts → 303 to the configured or built-in thank-you page; the problem page naming fields, never showing visitor text, linking back only to the form's own site; no `_next` redirect
  - JSON → JSON, CORS only for allowed origins, preflights, 413 / 415 / 422 / 429
  - multipart uploads stored in R2 with their rows; a renamed `.exe`, a wrong extension, SVG and oversize files refused; files never readable without a valid unexpired signed link or the admin token
  - every spam check (honeypot, origin, Turnstile hostname, too fast, links, blocked words, missing origin, Turnstile unverified), the spam folder, "not spam" sending the skipped notifications once, duplicate collapsing, the 1,000-a-day spam cap
  - rate limiting with no IP address anywhere in D1; keys that change every day
  - D1 failing → email fallback → thanks; email failing too → 503 naming `FALLBACK_CONTACT`; R2 files removed when the rows can't be written; spam never emailed in the fallback; the fallback's hourly cap; R2 failing → a 503 that says the file wasn't saved; a constraint error retried rather than treated as an outage
  - the per-request subrequest budget, channel and file caps, duplicate channels refused, attachments in the duplicate hash, in-memory counters and rate blocks, Turnstile action, non-finite numbers, ntfy byte truncation
  - retries on the 1/5/30/120/720-minute schedule, failed after 24 hours, "Try again" sending once, setup errors failed at once, two overlapping runs sending once, stale claims released
  - lazy housekeeping: the D1 throttle, two runs at once, `/tick`, budget-gated slot claims, retention in steps that continue across runs, retries and retention from posts alone on a 4-channel, 5-file form, pending R2 deletes after a failed erasure, paged exports that abort rather than truncate, orphaned R2 files
  - auto-reply: fixed text only, once per address per 24 hours, daily cap, never for spam or unverified Turnstile, unknown not retried, caps released on refusal
  - webhooks (Discord can't ping anyone, JSON signature), email header injection (CRLF, RFC 2047), HTML escaping, CSV formula escaping, export CSV/JSON, delete by email, admin auth
- **Locally with `wrangler dev`, on 2026-11-10** (free, no account): a real `curl` post with `application/x-www-form-urlencoded` UTF-8 (`Zoë Ångström`) got a 303 to `/thanks/?form=contact`, was stored, and produced a notification email through the local `send_email` binding with a correct RFC 2047 subject and `Reply-To`; a `fetch`-style JSON post got `200 {"ok":true,"id":...}` with `Access-Control-Allow-Origin: https://example.com`; a preflight from another origin got no CORS headers; a missing field landed on the problem page reading "Email is required"; a filled honeypot got the normal thank-you and was stored as spam; the CSV export had its BOM; the API refused a request without the token. (Windows `curl --data-urlencode` with non-UTF-8 console arguments was refused as "encoding", which is the UTF-8 check working.)
- **Not tested on a real Cloudflare account yet** (free, but needs you): delivery to a verified Email Routing address, a real Discord webhook, a real Turnstile widget (Cloudflare's test keys cover pass/fail), and the measured footprint above.
- **Not tested, because it costs money or needs a card:**
  - real sends through Resend, SES, Mailgun and Postmark (only against fakes built from their docs, as in perchlight-list), so auto-replies through them are unverified
  - Cloudflare Email Service to arbitrary addresses (needs Workers Paid)
  - R2 on a real account (needs a payment method on file): signed-link downloads and large uploads on the real network
  - the largest upload that fits in the free plan's 10 ms of CPU; until someone with R2 measures it, keep `maxBodyMB` at a few MB

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare.
