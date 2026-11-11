# ADR 0001: No cron trigger; retries and clean-up run lazily on requests

**Date:** 2026-11-10
**Status:** Accepted

## Context

perchlight-forms has two jobs that aren't tied to one request: retrying notifications that failed (back-off of 1, 5, 30 minutes, 2 hours and 12 hours, then "failed" after 24 hours), and deleting what's past its retention (inbox 365 days, spam 30 days, rate counters 48 hours, auto-reply hashes 2 days, delivery rows 90 days, and R2 files whose row is gone).

The draft design used a cron trigger every 5 minutes. Cloudflare's free plan allows **5 cron triggers per account**, and perchlight-guard, perchlight-list and perchlight-updates already use 4 of them. Taking the last one would leave a user nothing for their own Workers, or for the next Perchlight tool.

Limits that shape any alternative (Workers Free): 10 ms of CPU per request, 50 subrequests per request, 30 seconds of `ctx.waitUntil` after the reply; D1: 50 queries per invocation, 100,000 rows written per day.

## Options considered

1. **One cron trigger every 5 minutes.** Pros: work happens on time whatever the traffic. Cons: the account's 5th and last trigger; 288 Worker requests a day while idle.
2. **No background work at all.** Pros: simplest. Cons: a failed notification is never retried and nothing is ever deleted, which breaks "never lose a submission silently" and the retention promise.
3. **Lazy housekeeping:** after replying to a form post, an admin API call or `GET /tick`, start a run with `ctx.waitUntil` if the last one was at least `HOUSEKEEPING_MINUTES` (default 5) ago; bounded work per run. Pros: no trigger used; no requests at all while idle. Cons: on a site with no traffic, work waits for the next request.

## Decision

Option 3.

- **Throttle:** one conditional `UPDATE state SET value = now WHERE key = 'last_run' AND value <= now - interval`. Only the request whose update changed the row runs, so two requests at once can't both run it. Before that, each isolate skips the D1 check if it looked in the last 15 seconds, so a busy site doesn't pay a D1 query per request.
- **Bounded work:** a run releases stale claims, sends notifications whose submission left the spam folder, and then either sends up to 4 due notifications or, once an hour instead, does retention (up to 40 expired submissions per folder with their R2 files, old counters, and a 100-object sweep of R2 for orphaned files). That is at most about 25 D1 queries and 4 outbound requests, so even on top of a form post's own work (about 17 queries) one request stays under 50. CPU is spent on JSON and HMAC for a handful of rows; the waiting is I/O, which doesn't count toward the 10 ms.
- **The form post's own notifications** go out straight after its reply, not through the throttle, so the first attempt is never delayed.
- **`POST /api/housekeeping`** runs it now, ignoring the throttle.

## Consequences

- Positive: no cron trigger, so the family still uses 4 of 5. Idle cost drops from 288 requests a day to zero.
- Positive: work is spread over real traffic, so it's naturally paced; a busy site retries on schedule (within 5 minutes of each back-off step).
- **Negative, said plainly: a quiet site is late.** If a notification fails and nobody posts a form, calls the admin API or hits `/tick`, the retry waits until someone does. Retention likewise runs only when the Worker is woken. Nothing is lost (the submission is in D1 from the start), but an alert can be late.
- **The Perchlight desktop app does not wake the Worker.** It reads and writes D1 through Cloudflare's API, not through this Worker. Its "Try again" and "Back to inbox" buttons change rows, and the Worker acts on them at its next run. Opening the desktop app is therefore not enough on its own; the README says so.
- Mitigation for quiet sites, free: point any uptime monitor at `GET /tick` (it answers 204 and does nothing but the throttled run), or load it from your own site's pages. One request every 5 minutes is 288 a day, 0.3% of the free 100,000, and still uses no cron trigger.
- The 24-hour retry window is measured from the submission (or from leaving the spam folder); a retry that only gets its chance after 24 hours is marked failed with its last error, and stays in "Failed notifications" for a manual "Try again".
- Follow-up: if Cloudflare raises the free cron limit, a trigger can call the same `runHousekeeping` without other changes.
