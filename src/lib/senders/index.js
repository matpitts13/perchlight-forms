// Email senders. Adapted from perchlight-list src/lib/senders/index.js:
// standard mode only, plus "cloudflare-routing" (the free send_email route to
// your own verified addresses), which is the default for notifications.
import { EmailMessage } from "cloudflare:email";
import { mime, addressOnly } from "../mime.js";
import { redactAddresses } from "./common.js";
import { resendSender } from "./resend.js";
import { sesSender } from "./ses.js";
import { mailgunSender } from "./mailgun.js";
import { postmarkSender } from "./postmark.js";
import { cloudflareSender } from "./cloudflare.js";

/**
 * @typedef {object} Message
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} html
 * @property {Record<string, string>} [headers]   only Reply-To is ever set
 */

/**
 * What happened to one message (same meanings as perchlight-list):
 * sent | rejected (this address only, don't retry) | retry | throttled
 * (nothing sent, try later) | config (setup problem) | unknown (may have
 * been sent) | conflict (idempotency key reused: treated as unknown).
 * @typedef {{ status: "sent", id: string | null }
 *   | { status: "rejected" | "retry" | "throttled" | "config" | "unknown" | "conflict", error: string }} SendResult
 */

/**
 * @typedef {object} EmailSender
 * @property {string} name
 * @property {boolean} idempotent
 * @property {(message: Message, options?: { idempotencyKey?: string }) => Promise<SendResult>} send
 */

export const PROVIDERS = ["cloudflare-routing", "resend", "ses", "mailgun", "postmark", "cloudflare"];

export function providerName(env) {
  return (String(env.MAIL_PROVIDER ?? "").trim() || "cloudflare-routing").toLowerCase();
}

/** The free send_email route: only reaches addresses verified in Email Routing. */
export function routingSender(binding, from) {
  return {
    name: "cloudflare-routing",
    idempotent: false,
    async send(m) {
      try {
        const raw = mime({ from, to: m.to, replyTo: m.headers?.["Reply-To"], subject: m.subject, text: m.text, html: m.html });
        await binding.send(new EmailMessage(addressOnly(from), addressOnly(m.to), raw));
        return { status: "sent", id: null };
      } catch (err) {
        const msg = redactAddresses(err instanceof Error ? err.message : String(err));
        // Unverified destination, or a from address off the Email Routing domain.
        if (/not allowed|not verified|verified|destination|E_RECIPIENT|E_SENDER|domain/i.test(msg)) {
          return {
            status: "config",
            error: `send_email: ${msg}. Check the address is a verified destination in Email Routing and MAIL_FROM is on that domain.`,
          };
        }
        return { status: "retry", error: `send_email: ${msg}` };
      }
    },
  };
}

/**
 * The configured sender, or { error } explaining what's missing.
 * @returns {{ sender: EmailSender } | { error: string }}
 */
export function getSender(env) {
  const from = String(env.MAIL_FROM ?? "").trim();
  if (!from) return { error: "MAIL_FROM isn't set in wrangler.jsonc." };
  const provider = providerName(env);
  const missing = (what) => ({ error: `MAIL_PROVIDER is "${provider}" but ${what} isn't set.` });
  switch (provider) {
    case "cloudflare-routing":
      return env.EMAIL && typeof env.EMAIL.send === "function"
        ? { sender: routingSender(env.EMAIL, from) }
        : { error: 'The "EMAIL" send_email binding is missing from wrangler.jsonc.' };
    case "resend":
      return env.RESEND_API_KEY ? { sender: resendSender(env.RESEND_API_KEY, from) } : missing("RESEND_API_KEY");
    case "ses":
      return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
        ? {
            sender: sesSender(
              {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
                region: env.AWS_REGION,
                configurationSet: env.SES_CONFIGURATION_SET || "",
              },
              from,
            ),
          }
        : missing("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY or AWS_REGION");
    case "mailgun":
      return env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN
        ? { sender: mailgunSender({ apiKey: env.MAILGUN_API_KEY, domain: env.MAILGUN_DOMAIN, region: env.MAILGUN_REGION || "us" }, from) }
        : missing("MAILGUN_API_KEY or MAILGUN_DOMAIN");
    case "postmark":
      return env.POSTMARK_SERVER_TOKEN ? { sender: postmarkSender({ serverToken: env.POSTMARK_SERVER_TOKEN }, from) } : missing("POSTMARK_SERVER_TOKEN");
    case "cloudflare":
      return env.EMAIL ? { sender: cloudflareSender(env.EMAIL, from) } : missing('the "EMAIL" send_email binding');
    default:
      return { error: `MAIL_PROVIDER "${provider}" isn't supported. Use ${PROVIDERS.join(", ")}.` };
  }
}

/** Auto-replies go to visitors' addresses, which send_email can't reach for free. */
export function canAutoReply(env) {
  return providerName(env) !== "cloudflare-routing";
}
