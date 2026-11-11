// Global settings from wrangler.jsonc "vars", read in one place with defaults
// (same shape as perchlight-list src/lib/config.js). Secrets are read where used.

/** @param {Record<string, unknown>} env */
export function settings(env) {
  return {
    mailFrom: str(env.MAIL_FROM),
    retentionDays: int(env.RETENTION_DAYS, 365, 0), // 0 = keep until deleted
    spamRetentionDays: int(env.SPAM_RETENTION_DAYS, 30, 1),
    spamDailyCap: int(env.SPAM_DAILY_CAP, 1000, 0),
    fileLinkHours: int(env.FILE_LINK_HOURS, 168, 1),
    fallbackContact: str(env.FALLBACK_CONTACT),
    housekeepingMinutes: int(env.HOUSEKEEPING_MINUTES, 5, 1),
    publicUrl: str(env.PUBLIC_URL).replace(/\/+$/, ""),
  };
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** A whole number >= min from a setting, or the fallback if it isn't one. */
function int(v, fallback, min) {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return n >= min ? n : fallback;
}
