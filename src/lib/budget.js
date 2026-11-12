// A per-request budget of binding calls and outbound requests.
//
// Workers Free allows 50 subrequests per request, and D1 documents 50
// queries per invocation. Whether D1, R2 and send_email binding calls count
// toward the 50 subrequests is NOT confirmed (Cloudflare's docs aren't
// explicit), so this assumes they all do, and keeps one request (a form
// post, its own notifications and a housekeeping run) under 45 calls.
// Work that doesn't fit is left for the next request's housekeeping run.

export const SUBREQUEST_BUDGET = 45;

/** Upper estimates, counted by hand from the code. */
export const COST = {
  // rate limit, duplicate check, spam-cap slot, the batch, counters flush
  post: 6,
  // per file: R2 put
  file: 1,
  // deliverSubmission's own select
  deliverySelect: 1,
  // claim, load submission (2), finish, the send; an auto-reply adds 3
  delivery: 8,
  // throttle claim, stale release, revive, retention claim, due select
  housekeepingBase: 5,
  // two folders x (select + files select + R2 delete + delete), counters batch, R2 sweep (state, list, select, delete, update)
  retention: 14,
};

export function newBudget(total = SUBREQUEST_BUDGET) {
  return { left: total };
}

/** Takes n from the budget if it's there. */
export function spend(budget, n) {
  if (!budget) return true;
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}
