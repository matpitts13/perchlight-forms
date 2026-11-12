#!/usr/bin/env node
// Exports every page of submissions to one file, following X-Next-Cursor.
// No dependencies.
//   ADMIN_TOKEN=... node cli/export.mjs https://forms.example.com "form=contact&format=csv" > contact.csv
// The Worker returns at most 1,000 rows per request (to stay inside the
// free plan's per-request limits); this joins the pages. A page that fails
// or arrives cut short stops the export with an error, never a short file.
const [base, query = "format=csv"] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !token) {
  console.error('Usage: ADMIN_TOKEN=... node cli/export.mjs https://<your worker> "form=contact&format=csv" > out.csv');
  process.exit(1);
}
const params = new URLSearchParams(query);
const json = params.get("format") === "json";
let cursor = null;
let page = 0;
const rows = [];
do {
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/export?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.text(); // throws if the stream was aborted
  cursor = res.headers.get("X-Next-Cursor");
  if (json) rows.push(...JSON.parse(body));
  else {
    // Each page is a whole CSV: keep the BOM and header from the first only.
    const text = page === 0 ? body : body.replace(/^﻿?[^\r\n]*\r\n/, "");
    process.stdout.write(text);
  }
  page++;
} while (cursor);
if (json) process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
console.error(`${page} page(s) exported.`);
