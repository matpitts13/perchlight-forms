import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          r2Buckets: ["FILES"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token-0123456789",
            IP_SALT: "test-ip-salt-0123456789",
            LINK_SECRET: "test-link-secret-0123456789",
            TURNSTILE_SECRET_KEY: "test-turnstile-secret",
            WEBHOOK_SECRET: "test-webhook-secret",
            WEBHOOK_DISCORD_URL: "https://discord.com/api/webhooks/1/abc",
            WEBHOOK_HOOK_URL: "https://hooks.test/json",
            MAIL_FROM: "Forms <forms@example.com>",
            FALLBACK_CONTACT: "help@example.com",
            // Write refused-post counters at once (production batches them per minute).
            COUNTER_FLUSH_SECONDS: "0",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      include: ["test/**/*.test.js"],
    },
  };
});
