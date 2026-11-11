// The Worker, built around a forms config (forms.json in production; tests
// pass their own).
import { checkForms, envInfo } from "./lib/forms.js";
import { canAutoReply } from "./lib/senders/index.js";
import { settings } from "./lib/settings.js";
import { json, text } from "./lib/http.js";
import { submit, preflight } from "./routes/submit.js";
import { problemPage } from "./routes/pages.js";
import { fileDownload } from "./routes/files.js";
import { handleAdmin } from "./routes/admin.js";
import { maybeHousekeep } from "./lib/housekeeping.js";

export function makeWorker(rawForms) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      const app = {
        env,
        forms: checkForms(rawForms, envInfo(env, canAutoReply(env))),
        base: settings(env).publicUrl || url.origin,
      };
      try {
        if (path === "/api" || path.startsWith("/api/")) return await handleAdmin(request, app, ctx, path.slice(5));

        const f = /^\/f\/([a-z0-9][a-z0-9-]{0,39})\/?$/.exec(path);
        if (f) {
          if (request.method === "POST") return await submit(request, app, ctx, f[1]);
          if (request.method === "OPTIONS") return preflight(request, app, f[1]);
          return text("Send this form with POST.\n", 405, { Allow: "POST, OPTIONS" });
        }
        const file = /^\/file\/([a-z0-9_]{1,40})$/.exec(path);
        if (file && request.method === "GET") return await fileDownload(request, app, file[1]);
        if ((path === "/problem" || path === "/problem/") && request.method === "GET") return await problemPage(request, app);
        if (path === "/tick") {
          // For an uptime monitor or your own site: lets a quiet deployment
          // retry notifications and clean up (throttled; does nothing else).
          maybeHousekeep(app, ctx);
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        }
        return env.ASSETS ? env.ASSETS.fetch(request) : text("Not found\n", 404);
      } catch (err) {
        console.error(`${request.method} ${path}: ${err instanceof Error ? err.stack : String(err)}`);
        return path.startsWith("/api/")
          ? json({ ok: false, error: "Something went wrong on the server. Check the Worker's logs." }, 500)
          : text("Something went wrong. Please try again.\n", 500);
      }
    },
  };
}
