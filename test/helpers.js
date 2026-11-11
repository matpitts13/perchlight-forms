import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import { makeWorker } from "../src/app.js";
import { checkForms, envInfo } from "../src/lib/forms.js";
import { canAutoReply } from "../src/lib/senders/index.js";
import { resetLocalThrottle } from "../src/lib/housekeeping.js";

export const ORIGIN = "https://forms.test";
export const SITE = "https://example.com";
export const TOKEN = "test-admin-token-0123456789";

export const TEST_FORMS = {
  contact: {
    name: "Contact form",
    origins: [SITE, "https://www.example.com"],
    fields: {
      name: { type: "text", required: true, max: 200 },
      email: { type: "email", required: true },
      message: { type: "textarea", required: true, max: 5000 },
      topic: { type: "select", options: ["Sales", "Support", "Other"] },
    },
    replyTo: "email",
    redirect: "https://example.com/thanks/",
    notify: { email: ["me@example.com"], webhooks: ["discord"] },
    spam: { honeypot: "website", minSeconds: 3, maxLinks: 2, perHour: 5, blockedWords: ["cheap pills"] },
  },
  strict: {
    name: "Strict",
    origins: [SITE],
    fields: { name: { type: "text" }, email: { type: "email", required: true }, consent: { type: "consent", required: true, version: "2026-11" } },
    extraFields: "drop",
    notify: { email: ["me@example.com"] },
    spam: { perHour: 0 },
  },
  jobs: {
    name: "Job applications",
    origins: [SITE],
    maxBodyMB: 1,
    fields: {
      name: { type: "text", required: true },
      email: { type: "email", required: true },
      cv: { type: "file", required: true, maxMB: 0.1, types: ["pdf", "docx"], maxCount: 1 },
    },
    notify: { email: ["hiring@example.com"], fileLinks: true },
    spam: { perHour: 0 },
  },
  guarded: {
    name: "Guarded",
    origins: [SITE],
    fields: { email: { type: "email", required: true }, message: { type: "textarea" } },
    notify: { email: ["me@example.com"], webhooks: [{ name: "hook", format: "json" }] },
    spam: { turnstile: true, perHour: 0 },
    autoReply: { subject: "Thanks, we got your message", text: "We'll reply within two working days.", dailyCap: 2 },
  },
  broken: {
    name: "Broken",
    origins: [SITE],
    fields: { name: { type: "colour" } },
  },
};

export const worker = makeWorker(TEST_FORMS);

/** A fake send_email binding that records messages (or fails). */
export function fakeEmail({ fail = false, error = "send failed" } = {}) {
  const sent = [];
  return {
    sent,
    binding: {
      async send(message) {
        if (fail) throw new Error(typeof fail === "string" ? fail : error);
        sent.push(message);
      },
    },
  };
}

/** A D1 stand-in where every call fails, as when writes are blocked. */
export function brokenDb() {
  const boom = async () => {
    throw new Error("D1_ERROR: writes are blocked until 00:00 UTC");
  };
  const stmt = { bind: () => stmt, first: boom, run: boom, all: boom, raw: boom };
  return { prepare: () => stmt, batch: boom, exec: boom };
}

/**
 * Fake outbound network: Turnstile, webhooks and Resend.
 * opts.turnstile: "pass" | "fail" | "down" | { hostname }; opts.webhookStatus; opts.resendStatus.
 */
export function mockFetch(opts = {}) {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body;
    calls.push({ url, init, body: typeof body === "string" ? body : null });
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      const t = opts.turnstile ?? "pass";
      if (t === "down") throw new DOMException("The operation timed out.", "TimeoutError");
      if (t === "fail") return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      return Response.json({ success: true, hostname: typeof t === "object" ? t.hostname : "example.com" });
    }
    if (url.startsWith("https://discord.com/") || url.startsWith("https://hooks.test/")) {
      return new Response("ok", { status: opts.webhookStatus ?? 204 });
    }
    if (url.startsWith("https://api.resend.com/")) {
      if (opts.resendStatus) return Response.json({ name: "error", message: "refused" }, { status: opts.resendStatus });
      return Response.json({ id: `msg_${calls.length}` });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return calls;
}

/** Sends a request through the Worker and waits for its background work. */
export async function call(path, init = {}, envOverrides = {}) {
  resetLocalThrottle();
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A plain HTML form post (urlencoded), as a browser sends it. */
export function postForm(form, fields, { origin = SITE, headers = {}, env: envOverrides = {} } = {}) {
  return call(
    `/f/${form}`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(origin ? { Origin: origin } : {}), ...headers },
      body: new URLSearchParams(fields).toString(),
    },
    envOverrides,
  );
}

/** A fetch() JSON post. */
export async function postJson(form, fields, { origin = SITE, env: envOverrides = {} } = {}) {
  const res = await call(
    `/f/${form}`,
    { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(fields) },
    envOverrides,
  );
  return { res, status: res.status, data: await res.json() };
}

/** Admin API call. */
export async function api(method, path, body, envOverrides = {}, token = TOKEN) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, envOverrides);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, res };
}

/** The app object the libraries take, for calling them directly. */
export function makeApp(envOverrides = {}) {
  const e = { ...env, ...envOverrides };
  return { env: e, forms: checkForms(TEST_FORMS, envInfo(e, canAutoReply(e))), base: ORIGIN };
}

export const good = { name: "Ada Lovelace", email: "ada@example.org", message: "Hello there, I have a question.", topic: "Support" };

export async function rows(sql, ...params) {
  return (await env.DB.prepare(sql).bind(...params).all()).results;
}

export async function resetAll() {
  vi.restoreAllMocks();
  resetLocalThrottle();
  await env.DB.batch(
    ["files", "deliveries", "submissions", "rate_counters", "daily_counts", "autoreply_sent"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare("UPDATE state SET value = CASE key WHEN 'r2_cursor' THEN '' ELSE '0' END").run();
  let cursor;
  do {
    const listed = await env.FILES.list({ cursor, limit: 1000 });
    if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** A minimal valid PDF's first bytes. */
export function pdfBytes(size = 200) {
  const b = new Uint8Array(size).fill(0x20);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  return b;
}

/** An email service set up, which auto-replies need. */
export const RESEND = { MAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_key" };