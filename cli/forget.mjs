#!/usr/bin/env node
// Deletes every submission from one email address (a GDPR erasure request),
// calling DELETE /api/submissions?email= until nothing is left. No dependencies.
//   ADMIN_TOKEN=... npm run forget -- https://forms.example.com someone@example.com
// The Worker deletes 40 submissions per call ("more": true means call again).
// If R2 couldn't delete some attachments yet, they're queued and retried by
// the Worker's housekeeping; this says how many, and how to check.
const [base, email] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !email || !token) {
  console.error("Usage: ADMIN_TOKEN=... npm run forget -- https://<your worker> someone@example.com");
  process.exit(1);
}
const url = `${base.replace(/\/+$/, "")}/api/submissions?email=${encodeURIComponent(email)}`;
let deleted = 0;
let filesPending = 0;
for (let call = 0; call < 1000; call++) {
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    console.error(`HTTP ${res.status}: ${data?.error ?? "unexpected answer"} (deleted ${deleted} so far)`);
    process.exit(1);
  }
  deleted += data.deleted;
  filesPending += data.filesPending ?? 0;
  if (!data.more) break;
}
console.log(`Deleted ${deleted} submission(s) from that address.`);
if (filesPending) {
  console.log(`${filesPending} attached file(s) couldn't be deleted from R2 yet. They're queued and retried by every housekeeping run;`);
  console.log(`the erasure is complete when "filesPendingDelete" in GET /api/forms is 0 (POST /api/housekeeping retries now).`);
}
