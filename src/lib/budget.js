// A per-request budget of binding calls and outbound requests.
//
// Workers Free allows 50 subrequests per request, and D1 documents 50
// queries per invocation. Whether D1, R2 and send_email binding calls count
// toward the 50 subrequests is NOT confirmed (Cloudflare's docs aren't
// explicit), so this assumes they all do, and keeps one request (a form
// post, its own notifications and a housekeeping run) under 45 calls.
// Work that doesn't fit is left for the next request's housekeeping run.

export const SUBREQUEST_BUDGET = 45;

/** Worst cases, counted by hand from the code. */
export const COST = {
  // a form post: rate limit, duplicate check, spam-cap slot, the batch, a counters flush
  post: 6,
  // per file: R2 put
  file: 1,
  // sending: the select of due rows; loading a submission (row + files, once
  // per submission); per delivery: claim, the send, finish; an auto-reply
  // adds its two caps and a possible release
  deliverySelect: 1,
  load: 2,
  delivery: 3,
  autoreply: 3,
  // housekeeping: throttle claim, stale release + revive (one batch), state read
  housekeepingBase: 3,
  // pending R2 deletes: select, R2 delete, delete rows
  pending: 3,
  // one retention folder (inbox or spam): select ids, select file keys, R2
  // delete, delete rows, and on an R2 failure the pending-delete insert
  retentionFolder: 5,
  // old counters, hashes and delivery rows: one batch
  retentionCounters: 1,
  // R2 orphan sweep: state read, list, two IN (...) selects for 100 keys, R2 delete, cursor update
  retentionSweep: 6,
  // saving retention progress
  stateSave: 1,
};

/** The smallest piece of useful work a housekeeping run can do (one
 *  delivery, or one retention folder). A run doesn't even claim its slot
 *  with less than base + this left. */
export const MIN_UNIT = Math.max(COST.delivery + COST.load, COST.retentionFolder);

/** A post's own notifications: what submit.js reserves before replying. */
export function deliveryReserve(channels, autoReply) {
  return COST.deliverySelect + COST.load + channels * COST.delivery + (autoReply ? COST.autoreply : 0);
}

export function newBudget(total = SUBREQUEST_BUDGET) {
  return { left: total };
}

export function left(budget) {
  return budget ? budget.left : Infinity;
}

/** Takes n from the budget if it's there. */
export function spend(budget, n) {
  if (!budget) return true;
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}
