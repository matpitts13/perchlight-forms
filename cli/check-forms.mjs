#!/usr/bin/env node
// Checks forms.json without deploying: `npm run check` (or `node cli/check-forms.mjs [file]`).
// No dependencies. Bindings and secrets (R2, Turnstile, webhooks) can only be
// checked by the deployed Worker; GET /api/forms shows those problems.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkForms } from "../src/lib/forms.js";

const file = resolve(process.argv[2] ?? "forms.json");
let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
} catch (err) {
  console.error(`Can't read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const results = checkForms(raw, null);
if (!results.size) {
  console.error(`${file}: no forms found. It should be an object of { "<form id>": { ... } }.`);
  process.exit(1);
}
let bad = 0;
for (const r of results.values()) {
  if (r.ok) {
    const f = r.form;
    const channels = [...f.notify.email.map((e) => `email ${e}`), ...f.notify.webhooks.map((w) => `webhook ${w.name}`)];
    console.log(`ok   ${r.id}: ${Object.keys(f.fields).length} fields, ${channels.length ? channels.join(", ") : "no notifications"}${f.hasFiles ? ", needs R2 + LINK_SECRET" : ""}${f.spam.turnstile ? ", needs TURNSTILE_SECRET_KEY" : ""}`);
  } else {
    bad++;
    console.log(`OFF  ${r.id}: ${r.error}`);
  }
}
process.exit(bad ? 1 : 0);
