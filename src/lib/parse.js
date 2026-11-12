// Reading and checking a submission: body size (counted while reading),
// parsing (urlencoded, multipart or JSON), and every field rule in the config.
import { isEmail, RESERVED } from "./forms.js";
import { checkFileType, cleanFileName } from "./filetypes.js";

const MAX_EXTRA = 10;
const EXTRA_MAX_CHARS = 1000;

/**
 * Reads the body, stopping as soon as it passes maxBytes (so a huge upload is
 * cut off early, whatever Content-Length says).
 * @returns {Promise<Uint8Array | null>} null if too big
 */
export async function readLimited(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Which kind of body this is, from Content-Type. */
export function bodyKind(contentType) {
  const t = String(contentType ?? "").toLowerCase();
  if (t.startsWith("application/json")) return "json";
  if (t.startsWith("application/x-www-form-urlencoded")) return "urlencoded";
  if (t.startsWith("multipart/form-data")) return "multipart";
  return null;
}

/**
 * Parses the body into [name, value] pairs. value is a string, a File
 * (multipart), or for JSON a string/number/boolean/array.
 * @returns {Promise<{ entries: Array<[string, any]> } | { error: "encoding" | "unsupported" | "malformed" }>}
 */
export async function parseBody(bytes, contentType, url) {
  const kind = bodyKind(contentType);
  if (!kind) return { error: "unsupported" };
  if (kind === "multipart") {
    let form;
    try {
      form = await new Request(url, { method: "POST", headers: { "Content-Type": contentType }, body: bytes }).formData();
    } catch {
      return { error: "malformed" };
    }
    const entries = [...form.entries()];
    // Bytes that aren't UTF-8 come out of the parser as U+FFFD.
    if (entries.some(([k, v]) => k.includes("�") || (typeof v === "string" && v.includes("�")))) return { error: "encoding" };
    return { entries };
  }
  let textBody;
  try {
    textBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: "encoding" };
  }
  if (kind === "json") {
    let v;
    try {
      v = JSON.parse(textBody);
    } catch {
      return { error: "malformed" };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "malformed" };
    return { entries: Object.entries(v) };
  }
  const entries = [];
  for (const pair of textBody.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const rawK = i < 0 ? pair : pair.slice(0, i);
    const rawV = i < 0 ? "" : pair.slice(i + 1);
    try {
      entries.push([decodeURIComponent(rawK.replace(/\+/g, " ")), decodeURIComponent(rawV.replace(/\+/g, " "))]);
    } catch {
      return { error: "encoding" }; // percent-escapes that aren't UTF-8
    }
  }
  return { entries };
}

/** Plain words for each problem. Only config text (labels, limits) is used, never visitor text. */
export function problemMessage(field, code) {
  const label = field?.label ?? "This field";
  switch (code) {
    case "required":
      return field?.type === "consent" ? `Please tick "${label}"` : field?.type === "file" ? `${label}: please attach a file` : `${label} is required`;
    case "email":
      return `${label} isn't a valid email address`;
    case "url":
      return `${label} isn't a valid web address (it should start with https://)`;
    case "number":
      return `${label} must be a number`;
    case "tel":
      return `${label} isn't a valid phone number`;
    case "too_long":
      return `${label} is too long (at most ${field?.max} characters)`;
    case "option":
      return `${label}: please choose one of the options`;
    case "text_only":
      return `${label} must be text, not a file`;
    case "too_many":
      return `${label}: at most ${field?.maxCount} file${field?.maxCount === 1 ? "" : "s"}`;
    case "file_big":
      return `${label}: each file can be at most ${formatBytes(field?.maxBytes ?? 0)}`;
    case "file_type":
      return `${label}: that type of file isn't accepted (accepted: ${(field?.types ?? []).join(", ")})`;
    case "too_big":
      return "That was too big to send. Please send less, or smaller files.";
    case "rate":
      return "Too many messages from your connection; try again in an hour.";
    case "turnstile":
      return "Please complete the check and send again.";
    case "encoding":
      return "Your browser sent text in an encoding we can't read. Please try again from an up-to-date browser.";
    case "unsupported":
      return "That wasn't sent as a form. Please use the form on the site.";
    case "malformed":
      return "That form couldn't be read. Please try again.";
    case "json_files":
      return "Files have to be sent as a multipart form, not JSON.";
    default:
      return "Something in the form needs fixing.";
  }
}

export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${Math.round((n / 1048576) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const TRUTHY = new Set(["on", "true", "1", "yes"]);
const isTruthy = (v) => v === true || v === 1 || (typeof v === "string" && TRUTHY.has(v.trim().toLowerCase()));
const isFile = (v) => typeof File !== "undefined" && v instanceof File;

function asText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // arrays, objects, files
}

/**
 * Checks the parsed entries against the form.
 * @returns {Promise<{ errors: Record<string, string>, data: Record<string, any>, extra: Record<string, string> | null,
 *   files: Array<{ field: string, name: string, bytes: Uint8Array, contentType: string }>,
 *   honeypot: string, turnstileToken: string, elapsedMs: number | null, consent: { version: string } | null }>}
 *   errors: field name ("_" for the whole form) -> problem code
 */
export async function checkSubmission(form, entries, isJson) {
  const byName = new Map();
  for (const [k, v] of entries) {
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(v);
  }
  const first = (k) => byName.get(k)?.[0];
  const errors = {};
  const data = {};
  const files = [];
  let consent = null;

  for (const field of Object.values(form.fields)) {
    const values = byName.get(field.name) ?? [];
    if (field.type === "file") {
      if (isJson && values.length) {
        errors[field.name] = "json_files";
        continue;
      }
      const chosen = values.filter((v) => isFile(v) && v.size > 0); // browsers send an empty part when no file is picked
      if (values.some((v) => !isFile(v) && v !== "")) {
        errors[field.name] = "file_type";
        continue;
      }
      if (!chosen.length) {
        if (field.required) errors[field.name] = "required";
        continue;
      }
      if (chosen.length > field.maxCount) {
        errors[field.name] = "too_many";
        continue;
      }
      for (const f of chosen) {
        if (f.size > field.maxBytes) {
          errors[field.name] = "file_big";
          break;
        }
        const bytes = new Uint8Array(await f.arrayBuffer());
        const name = cleanFileName(f.name);
        const type = checkFileType(name, bytes, field.types);
        if (!type.ok) {
          errors[field.name] = "file_type";
          break;
        }
        files.push({ field: field.name, name, bytes, contentType: type.contentType });
      }
      continue;
    }

    if (values.some(isFile)) {
      errors[field.name] = "text_only";
      continue;
    }

    if (field.type === "checkbox" && field.options) {
      const picked = values.flatMap((v) => (Array.isArray(v) ? v : [v])).map(asText).filter((v) => v);
      if (picked.some((v) => v === null || !field.options.includes(v))) errors[field.name] = "option";
      else if (field.required && !picked.length) errors[field.name] = "required";
      else data[field.name] = [...new Set(picked)];
      continue;
    }
    if (field.type === "checkbox" || field.type === "consent") {
      const on = values.some(isTruthy);
      if (field.required && !on) errors[field.name] = "required";
      else if (field.type === "consent") {
        data[field.name] = on;
        if (on) consent = { version: field.version };
      } else data[field.name] = on;
      continue;
    }

    const raw = asText(values[0]);
    if (raw === null) {
      errors[field.name] = "option";
      continue;
    }
    let v = field.type === "textarea" ? raw.replace(/\r\n?/g, "\n").trim() : raw.replace(/[\r\n\t]+/g, " ").trim();
    if (!v) {
      if (field.required) errors[field.name] = "required";
      continue;
    }
    if ([...v].length > field.max) {
      errors[field.name] = "too_long";
      continue;
    }
    if (field.type === "email" && !isEmail(v)) errors[field.name] = "email";
    else if (field.type === "url" && !isWebUrl(v)) errors[field.name] = "url";
    // Long digit strings parse to Infinity, which JSON stores as null: refuse them.
    else if (field.type === "number" && (!/^-?\d+(\.\d+)?$/.test(v) || !Number.isFinite(Number(v)))) errors[field.name] = "number";
    else if (field.type === "tel" && !/^[0-9+()\-.\s]{3,40}$/.test(v)) errors[field.name] = "tel";
    else if (field.type === "select" && !field.options.includes(v)) errors[field.name] = "option";
    else data[field.name] = field.type === "number" ? Number(v) : v;
  }

  // Fields not in the config: kept (cut short) and flagged, unless the form drops them.
  const known = new Set([...Object.keys(form.fields), ...RESERVED, form.spam.honeypot || ""]);
  let extra = null;
  if (form.extraFields === "keep") {
    for (const [k, vals] of byName) {
      if (known.has(k) || k.startsWith("_")) continue;
      extra ??= {};
      if (Object.keys(extra).length >= MAX_EXTRA) break;
      const shown = vals.map((v) => (isFile(v) ? `[file not kept: ${cleanFileName(v.name)}]` : (asText(v) ?? JSON.stringify(v)))).join(", ");
      extra[k.slice(0, 64)] = shown.slice(0, EXTRA_MAX_CHARS);
    }
  }

  const elapsedRaw = asText(first("_elapsed"));
  const elapsedMs = elapsedRaw && /^\d{1,10}$/.test(elapsedRaw.trim()) ? Number(elapsedRaw.trim()) : null;
  return {
    errors,
    data,
    extra,
    files,
    honeypot: form.spam.honeypot ? (asText(first(form.spam.honeypot)) ?? "x").trim() : "",
    turnstileToken: asText(first("cf-turnstile-response")) ?? "",
    elapsedMs,
    consent,
  };
}

function isWebUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
