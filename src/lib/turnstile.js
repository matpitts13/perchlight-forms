// Cloudflare Turnstile, checked server-side with siteverify.
// Adapted from perchlight-list src/lib/turnstile.js: also returns the token's
// hostname (checked against the form's origins by the spam scoring), and
// "unverified" instead of silently passing when Cloudflare can't be reached.
const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * @returns {Promise<{ result: "passed", hostname: string | null, action: string | null }
 *   | { result: "failed", codes: string[] } | { result: "unverified", error: string }>}
 */
export async function verifyTurnstile(env, token, ip) {
  // Tokens are at most 2,048 characters; missing or longer is a failure, not a call.
  if (!token || token.length > 2048) return { result: "failed", codes: ["missing-input-response"] };
  try {
    const body = new FormData();
    body.set("secret", env.TURNSTILE_SECRET_KEY);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const res = await fetch(VERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { result: "unverified", error: `siteverify answered HTTP ${res.status}` };
    const data = await res.json();
    if (data.success === true) {
      return {
        result: "passed",
        hostname: typeof data.hostname === "string" ? data.hostname : null,
        action: typeof data.action === "string" ? data.action : null,
      };
    }
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].map(String) : [];
    // A bad secret is our setup problem, not the visitor's: let it through as unverified.
    if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret")) {
      console.error(`turnstile: setup problem (${codes.join(", ")}); check TURNSTILE_SECRET_KEY`);
      return { result: "unverified", error: codes.join(", ") };
    }
    return { result: "failed", codes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`turnstile: unreachable: ${error}`);
    return { result: "unverified", error };
  }
}
