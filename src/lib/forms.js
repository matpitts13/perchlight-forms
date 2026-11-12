// Checks forms.json and turns each form into a normalised object.
// Pure JavaScript (no Workers APIs) so `npm run check` can use it in Node.
// A form with a mistake is switched off with the reason; the others work.

export const FIELD_TYPES = ["text", "textarea", "email", "url", "number", "tel", "select", "checkbox", "consent", "hidden", "file"];
export const FILE_TYPES = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "docx", "xlsx", "pptx", "odt", "ods", "txt", "csv"];
export const RESERVED = ["cf-turnstile-response", "_elapsed", "_consent_version", "_extra"];
export const DEFAULT_BLOCKED = ["seo services", "backlinks", "crypto investment", "guest post", "rank your website", "casino", "viagra", "forex signals"];

const KB = 1024;
const MB = 1024 * 1024;
const FORM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WEBHOOK_NAME = /^[A-Za-z0-9_]{1,40}$/;
const EMAIL = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]+$/;
const MAX_FIELDS = 50;
export const MAX_CHANNELS = 4;
export const MAX_FILES = 5;
const HARD_MAX_MB = 95;

export const isEmail = (s) => typeof s === "string" && s.length <= 254 && EMAIL.test(s);

/**
 * @typedef {object} EnvInfo  what the deployment has (null in the CLI: those checks are skipped)
 * @property {boolean} r2               FILES binding
 * @property {boolean} turnstile        TURNSTILE_SECRET_KEY
 * @property {boolean} autoReply        MAIL_PROVIDER is a real email service
 * @property {boolean} linkSecret       LINK_SECRET (16+ characters)
 * @property {(name: string) => boolean} webhook   WEBHOOK_<NAME>_URL is set
 */

/** Reads the deployment's bindings and secrets into an EnvInfo. */
export function envInfo(env, canAutoReply) {
  return {
    r2: Boolean(env.FILES && typeof env.FILES.put === "function"),
    turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
    autoReply: canAutoReply,
    linkSecret: String(env.LINK_SECRET ?? "").length >= 16,
    webhook: (name) => /^https:\/\//.test(String(env[`WEBHOOK_${name.toUpperCase()}_URL`] ?? "")),
  };
}

/**
 * @param {unknown} raw   the parsed forms.json
 * @param {EnvInfo | null} info
 * @returns {Map<string, { id: string, ok: boolean, error: string | null, form: any }>}
 */
export function checkForms(raw, info) {
  const out = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, def] of Object.entries(raw)) {
    if (id.startsWith("$")) continue; // "$comment", "$schema"
    try {
      const form = checkForm(id, def, info);
      out.set(id, { id, ok: true, error: null, form, origins: form.origins });
    } catch (err) {
      // A switched-off form keeps its valid origins, so a browser on those
      // sites can read its 503 (CORS) instead of a bare network error.
      const origins = Array.isArray(def?.origins) ? def.origins.filter((o) => typeof o === "string" && origin(o)) : [];
      out.set(id, { id, ok: false, error: err instanceof Error ? err.message : String(err), form: null, origins });
    }
  }
  return out;
}

class ConfigError extends Error {}
const bad = (msg) => {
  throw new ConfigError(msg);
};

function num(v, what, { min = 0, max = Infinity, fallback }) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) bad(`${what} must be a number from ${min} to ${max}`);
  return v;
}

function strList(v, what, max = 200) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s || s.length > max)) bad(`${what} must be a list of text values`);
  return v;
}

function origin(s) {
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return u.origin === s ? s : null;
  } catch {
    return null;
  }
}

function checkForm(id, def, info) {
  if (!FORM_ID.test(id)) bad(`the form id "${id}" must be lower-case letters, digits and dashes (up to 40)`);
  if (!def || typeof def !== "object" || Array.isArray(def)) bad("the form must be an object");

  const name = def.name ?? id;
  if (typeof name !== "string" || !name.trim() || name.length > 100) bad('"name" must be text of up to 100 characters');

  const origins = strList(def.origins, '"origins"', 300);
  if (!origins.length) bad('"origins" must list at least one site, like "https://example.com"');
  for (const o of origins) if (!origin(o)) bad(`"origins": "${o}" isn't an origin like "https://example.com" (no path or trailing slash; http only for localhost)`);

  if (!def.fields || typeof def.fields !== "object" || Array.isArray(def.fields)) bad('"fields" must be an object of field definitions');
  const entries = Object.entries(def.fields);
  if (!entries.length) bad('"fields" is empty');
  if (entries.length > MAX_FIELDS) bad(`at most ${MAX_FIELDS} fields`);

  const spamIn = def.spam ?? {};
  if (typeof spamIn !== "object" || Array.isArray(spamIn)) bad('"spam" must be an object');
  const honeypot = spamIn.honeypot === undefined ? "website" : spamIn.honeypot;
  if (honeypot !== false && (typeof honeypot !== "string" || !FIELD_NAME.test(honeypot))) bad('"spam.honeypot" must be a field name or false');

  const fields = {};
  let hasFiles = false;
  for (const [fname, f] of entries) {
    if (!FIELD_NAME.test(fname)) bad(`field "${fname}": names are letters, digits, _ and - (starting with a letter)`);
    if (RESERVED.includes(fname) || fname === honeypot) bad(`field "${fname}" is a reserved name`);
    if (!f || typeof f !== "object") bad(`field "${fname}" must be an object`);
    if (!FIELD_TYPES.includes(f.type)) bad(`field "${fname}": unknown type "${f.type}" (use ${FIELD_TYPES.join(", ")})`);
    const label = f.label ?? fname.charAt(0).toUpperCase() + fname.slice(1).replace(/[_-]+/g, " ");
    if (typeof label !== "string" || label.length > 100) bad(`field "${fname}": "label" must be text`);
    const field = { name: fname, type: f.type, label, required: f.required === true };
    if (f.required !== undefined && typeof f.required !== "boolean") bad(`field "${fname}": "required" must be true or false`);
    const defaultMax = f.type === "textarea" ? 5000 : f.type === "url" ? 2000 : 500;
    field.max = num(f.max, `field "${fname}": "max"`, { min: 1, max: 100000, fallback: defaultMax });
    if (f.type === "select" || (f.type === "checkbox" && f.options)) {
      field.options = strList(f.options, `field "${fname}": "options"`);
      if (!field.options.length) bad(`field "${fname}": a select needs "options"`);
    }
    if (f.type === "consent") {
      if (typeof f.version !== "string" || !f.version || f.version.length > 100) bad(`field "${fname}": a consent field needs a "version", like "2026-11"`);
      field.version = f.version;
    }
    if (f.type === "file") {
      hasFiles = true;
      field.maxBytes = Math.round(num(f.maxMB, `field "${fname}": "maxMB"`, { min: 0.01, max: HARD_MAX_MB, fallback: 5 }) * MB);
      field.maxCount = num(f.maxCount, `field "${fname}": "maxCount"`, { min: 1, max: 20, fallback: 1 });
      field.types = strList(f.types ?? ["pdf"], `field "${fname}": "types"`).map((t) => t.toLowerCase());
      for (const t of field.types) if (!FILE_TYPES.includes(t)) bad(`field "${fname}": file type "${t}" isn't allowed (use ${FILE_TYPES.join(", ")})`);
    }
    fields[fname] = field;
  }
  if (Object.values(fields).filter((f) => f.type === "consent").length > 1) bad("only one consent field per form");

  const replyTo = def.replyTo ?? (fields.email?.type === "email" ? "email" : null);
  if (replyTo !== null && (typeof replyTo !== "string" || fields[replyTo]?.type !== "email")) bad(`"replyTo" must name a field of type "email"`);

  const redirect = def.redirect ?? null;
  const errorRedirect = def.errorRedirect ?? null;
  for (const [key, url] of [["redirect", redirect], ["errorRedirect", errorRedirect]]) {
    if (url === null) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      bad(`"${key}" must be a full URL`);
    }
    if (!origins.includes(u.origin)) bad(`"${key}" must be on one of "origins" (${u.origin} isn't)`);
  }

  const notifyIn = def.notify ?? {};
  if (typeof notifyIn !== "object" || Array.isArray(notifyIn)) bad('"notify" must be an object');
  const emails = strList(notifyIn.email, '"notify.email"', 254);
  for (const e of emails) if (!isEmail(e)) bad(`"notify.email": "${e}" isn't an email address`);
  // Each address is its own delivery row, unique per submission: a repeat
  // (in any letter case) would make every submission's write fail.
  const seenEmails = new Set();
  for (const e of emails) {
    if (seenEmails.has(e.toLowerCase())) bad(`"notify.email": "${e}" is listed twice`);
    seenEmails.add(e.toLowerCase());
  }
  const webhooks = [];
  for (const w of Array.isArray(notifyIn.webhooks) ? notifyIn.webhooks : notifyIn.webhooks ? bad('"notify.webhooks" must be a list') : []) {
    const wname = typeof w === "string" ? w : w?.name;
    const format = typeof w === "object" && w ? w.format : undefined;
    if (typeof wname !== "string" || !WEBHOOK_NAME.test(wname)) bad('"notify.webhooks": names are letters, digits and _');
    if (format !== undefined && !["discord", "slack", "ntfy", "json"].includes(format)) bad(`webhook "${wname}": format must be discord, slack, ntfy or json`);
    if (info && !info.webhook(wname)) bad(`webhook "${wname}": set the secret WEBHOOK_${wname.toUpperCase()}_URL (an https URL)`);
    if (webhooks.some((x) => x.name === wname.toLowerCase())) bad(`webhook "${wname}" is listed twice`);
    webhooks.push({ name: wname.toLowerCase(), format: format ?? null });
  }
  const content = notifyIn.content ?? "full";
  if (!["full", "summary"].includes(content)) bad('"notify.content" must be "full" or "summary"');
  const notify = { email: emails, webhooks, content, fileLinks: notifyIn.fileLinks !== false };

  const turnstile = spamIn.turnstile === true;
  if (spamIn.turnstile !== undefined && typeof spamIn.turnstile !== "boolean") bad('"spam.turnstile" must be true or false');
  if (turnstile && info && !info.turnstile) bad('"spam.turnstile" is on but the TURNSTILE_SECRET_KEY secret isn\'t set');
  const turnstileAction = spamIn.turnstileAction ?? null;
  if (turnstileAction !== null && (typeof turnstileAction !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(turnstileAction))) {
    bad('"spam.turnstileAction" must be up to 32 letters, digits, _ or - (the widget\'s data-action)');
  }
  if (turnstileAction && !turnstile) bad('"spam.turnstileAction" needs "spam.turnstile" on');
  const spam = {
    turnstile,
    turnstileAction,
    honeypot,
    minSeconds: num(spamIn.minSeconds, '"spam.minSeconds"', { min: 0, max: 3600, fallback: 3 }),
    maxLinks: num(spamIn.maxLinks, '"spam.maxLinks"', { min: 0, max: 1000, fallback: 2 }),
    perHour: num(spamIn.perHour, '"spam.perHour"', { min: 0, max: 100000, fallback: 5 }), // 0 = no limit
    blockedWords: [
      ...(spamIn.defaultBlockedWords === false ? [] : DEFAULT_BLOCKED),
      ...strList(spamIn.blockedWords, '"spam.blockedWords"').map((w) => w.toLowerCase()),
    ],
  };

  if (hasFiles && info && !info.r2) bad("this form has file fields but the FILES R2 binding isn't set up (see the README)");
  if (hasFiles && info && !info.linkSecret) bad("this form has file fields: set the LINK_SECRET secret (16+ characters) for signed download links");
  const maxBodyBytes = Math.round(
    num(def.maxBodyMB, '"maxBodyMB"', { min: 0.01, max: HARD_MAX_MB, fallback: hasFiles ? 10 : 64 / 1024 }) * MB,
  );

  const extraFields = def.extraFields ?? "keep";
  if (!["keep", "drop"].includes(extraFields)) bad('"extraFields" must be "keep" or "drop"');

  let autoReply = null;
  if (def.autoReply !== undefined && def.autoReply !== null) {
    const a = def.autoReply;
    if (typeof a !== "object" || Array.isArray(a)) bad('"autoReply" must be an object or null');
    if (typeof a.subject !== "string" || !a.subject.trim() || a.subject.length > 150) bad('"autoReply.subject" must be text of up to 150 characters');
    if (typeof a.text !== "string" || !a.text.trim() || a.text.length > 5000) bad('"autoReply.text" must be text of up to 5,000 characters');
    if (!turnstile) bad('"autoReply" needs "spam.turnstile" on, so bots can\'t make you email strangers');
    if (!replyTo) bad('"autoReply" needs a "replyTo" email field to send to');
    if (info && !info.autoReply) bad('"autoReply" needs MAIL_PROVIDER set to an email service (resend, ses, mailgun, postmark or cloudflare); send_email only reaches your own verified addresses');
    autoReply = { subject: a.subject, text: a.text, dailyCap: num(a.dailyCap, '"autoReply.dailyCap"', { min: 1, max: 10000, fallback: 50 }) };
  }

  // One request (a post and its notifications) must fit the per-request
  // subrequest budget; see SUBREQUEST_BUDGET in src/lib/budget.js.
  const channels = emails.length + webhooks.length + (autoReply ? 1 : 0);
  if (channels > MAX_CHANNELS) bad(`at most ${MAX_CHANNELS} notification channels per form (email addresses + webhooks + auto-reply); this has ${channels}`);
  const totalFiles = Object.values(fields).reduce((n, f) => n + (f.type === "file" ? f.maxCount : 0), 0);
  if (totalFiles > MAX_FILES) bad(`at most ${MAX_FILES} files per submission across all file fields; maxCount adds up to ${totalFiles}`);

  return {
    id,
    name: name.trim(),
    origins,
    fields,
    hasFiles,
    replyTo,
    redirect,
    errorRedirect,
    notify,
    spam,
    maxBodyBytes: hasFiles ? maxBodyBytes : Math.min(maxBodyBytes, HARD_MAX_MB * MB),
    extraFields,
    autoReply,
  };
}

export { KB, MB };
