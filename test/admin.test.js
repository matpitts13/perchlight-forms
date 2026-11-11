import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { call, api, postForm, postJson, fakeEmail, mockFetch, resetAll, rows, good, pdfBytes, SITE, ORIGIN } from "./helpers.js";

beforeEach(resetAll);

async function submitMany(n, extra = {}) {
  mockFetch();
  const email = fakeEmail();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await call(
      "/f/contact",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: SITE, "CF-Connecting-IP": `192.0.2.${i}` },
        body: JSON.stringify({ ...good, message: `message ${i}`, ...extra }),
      },
      { EMAIL: email.binding },
    );
    ids.push((await r.json()).id);
  }
  return ids;
}

async function uploadCv(email = "ada@example.org") {
  const fd = new FormData();
  fd.set("name", "Ada");
  fd.set("email", email);
  fd.set("cv", new File([pdfBytes()], "cv.pdf"));
  const r = await call("/f/jobs", { method: "POST", headers: { Origin: SITE, Accept: "application/json" }, body: fd }, { EMAIL: fakeEmail().binding });
  return (await r.json()).id;
}

describe("admin auth", () => {
  it("refuses a missing or wrong token, constant-time", async () => {
    expect((await call("/api/forms")).status).toBe(401);
    expect((await api("GET", "forms", undefined, {}, "wrong-token-0123456789")).status).toBe(401);
    expect((await api("GET", "forms")).status).toBe(200);
  });

  it("is switched off while ADMIN_TOKEN is missing or under 16 characters", async () => {
    const short = await api("GET", "forms", undefined, { ADMIN_TOKEN: "short" }, "short");
    expect(short.status).toBe(503);
    expect(short.data.error).toContain("16+ characters");
    expect((await api("GET", "forms", undefined, { ADMIN_TOKEN: undefined })).status).toBe(503);
  });
});

describe("forms and submissions", () => {
  it("lists forms with their config mistakes and counts", async () => {
    await submitMany(2);
    const { data } = await api("GET", "forms");
    const contact = data.forms.find((f) => f.id === "contact");
    expect(contact).toMatchObject({ enabled: true, error: null, today: { ok: 2 }, total: { new: 2 } });
    const broken = data.forms.find((f) => f.id === "broken");
    expect(broken.enabled).toBe(false);
    expect(broken.error).toContain('unknown type "colour"');
    expect(data.spamDailyCap).toBe(1000);
  });

  it("pages through submissions newest first with a cursor", async () => {
    const ids = await submitMany(5);
    const first = await api("GET", "submissions?form=contact&limit=2");
    expect(first.data.submissions.map((s) => s.id)).toEqual([ids[4], ids[3]]);
    expect(first.data.submissions[0].data.message).toBe("message 4");
    const second = await api("GET", `submissions?form=contact&limit=2&cursor=${first.data.cursor}`);
    expect(second.data.submissions.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    const third = await api("GET", `submissions?form=contact&limit=2&cursor=${second.data.cursor}`);
    expect(third.data.submissions.map((s) => s.id)).toEqual([ids[0]]);
    expect(third.data.cursor).toBeNull();
    expect((await api("GET", "submissions?status=bogus")).status).toBe(400);
  });

  it("shows one submission with its files and deliveries, and changes its status", async () => {
    const [id] = await submitMany(1);
    const one = await api("GET", `submissions/${id}`);
    expect(one.data.submission.deliveries.map((d) => d.channel)).toEqual(["email:me@example.com", "webhook:discord"]);
    expect((await api("PATCH", `submissions/${id}`, { status: "read" })).data).toMatchObject({ status: "read", changed: true });
    expect((await api("PATCH", `submissions/${id}`, { status: "archived" })).data.status).toBe("archived");
    expect((await api("PATCH", `submissions/${id}`, { status: "deleted" })).status).toBe(400);
    expect((await api("GET", "submissions/sub_aaaaaaaaaaaaaaaa")).status).toBe(404);
  });

  it("deletes one submission with its files and deliveries", async () => {
    const id = await uploadCv();
    expect((await env.FILES.list()).objects).toHaveLength(1);
    expect((await api("DELETE", `submissions/${id}`)).data.deleted).toBe(1);
    expect(await rows("SELECT id FROM files")).toHaveLength(0);
    expect(await rows("SELECT id FROM deliveries")).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("deletes everything from one address on request, across forms, and exports it first", async () => {
    await uploadCv("Person@Example.org");
    await submitMany(2, { email: "person@example.org" });
    await submitMany(1, { email: "someone-else@example.org", message: "keep me" });
    const exported = await call("/api/export?email=PERSON@example.org&format=json", { headers: { Authorization: "Bearer test-admin-token-0123456789" } });
    const list = await exported.json();
    expect(list).toHaveLength(3);
    expect(list.find((r) => r.form_id === "jobs").files).toEqual(["cv.pdf"]);
    const del = await api("DELETE", "submissions?email=person@example.org");
    expect(del.data).toEqual({ ok: true, deleted: 3, more: false });
    expect(await rows("SELECT reply_email FROM submissions")).toEqual([{ reply_email: "someone-else@example.org" }]);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });
});

describe("export", () => {
  it("CSV: BOM, one column per field, accents intact, no formulas", async () => {
    mockFetch();
    await postJson("contact", { name: "=HYPERLINK(\"http://evil\")", email: "zoe@example.org", message: "Crème brûlée, \"quoted\"\nnew line", topic: "Sales" }, { env: { EMAIL: fakeEmail().binding } });
    await postJson("contact", { name: "+1 Bob", email: "bob@example.org", message: "@SUM(A1)" }, { env: { EMAIL: fakeEmail().binding } });
    const res = await call("/api/export?form=contact&format=csv", { headers: { Authorization: "Bearer test-admin-token-0123456789" } });
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const [header, ...lines] = text.split("\r\n");
    expect(header).toBe("id,created_at,status,spam_reasons,name,email,message,topic,files,extra");
    expect(text).toContain("'+1 Bob");
    expect(text).toContain("'@SUM(A1)");
    expect(text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(text).toContain('"Crème brûlée, ""quoted""\nnew line"');
    expect(lines.filter(Boolean)).toHaveLength(2); // rows end in CRLF; the bare LF stays inside quotes
  });

  it("JSON: the rows as stored, across pages", async () => {
    await submitMany(3);
    for (let i = 0; i < 100; i++) {
      await env.DB.prepare(
        "INSERT INTO submissions (id, form_id, created_at, created_ms, data, content_hash) VALUES (?1, 'contact', '2026-01-01 00:00:00', ?2, '{}', 'h')",
      ).bind(`sub_${String(i).padStart(16, "a").replace(/\d/g, (d) => "abcdefghjk"[d])}`, 1000 + i).run();
    }
    const res = await call("/api/export?format=json", { headers: { Authorization: "Bearer test-admin-token-0123456789" } });
    const list = await res.json();
    expect(list).toHaveLength(103);
    expect(new Set(list.map((r) => r.id)).size).toBe(103);
    expect(list[0].data.message).toBe("message 2");
  });
});

describe("files", () => {
  it("opens only through a valid, unexpired signed link or the admin token", async () => {
    await uploadCv();
    const [file] = await rows("SELECT id FROM files");
    expect((await call(`/file/${file.id}`)).status).toBe(404);
    const link = await api("POST", `files/${file.id}/link`);
    expect(link.data.url.startsWith(`${ORIGIN}/file/${file.id}?exp=`)).toBe(true);
    const ok = await call(new URL(link.data.url).pathname + new URL(link.data.url).search);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Disposition")).toContain("attachment");
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(ok.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(pdfBytes());

    const u = new URL(link.data.url);
    const tampered = `${u.pathname}?exp=${Number(u.searchParams.get("exp")) + 1000}&sig=${u.searchParams.get("sig")}`;
    expect((await call(tampered)).status).toBe(404);

    const admin = await call(`/api/files/${file.id}`, { headers: { Authorization: "Bearer test-admin-token-0123456789" } });
    expect(admin.status).toBe(200);
    expect((await call(`/api/files/${file.id}`)).status).toBe(401);
  });
});

describe("deliveries and test-notify", () => {
  it("retries a failed delivery from the API", async () => {
    mockFetch();
    await postForm("contact", good, { env: { EMAIL: fakeEmail({ fail: "E_RECIPIENT_NOT_ALLOWED" }).binding } });
    const failed = await api("GET", "deliveries?status=failed");
    expect(failed.data.deliveries).toHaveLength(1);
    const email = fakeEmail();
    const r = await api("POST", `deliveries/${failed.data.deliveries[0].id}/retry`, undefined, { EMAIL: email.binding });
    expect(r.data).toEqual({ ok: true, status: "sent" });
    expect(email.sent).toHaveLength(1);
    expect((await api("POST", `deliveries/${failed.data.deliveries[0].id}/retry`)).status).toBe(409);
  });

  it("sends a sample through every channel with exact errors", async () => {
    mockFetch({ webhookStatus: 404 });
    const email = fakeEmail();
    const r = await api("POST", "test-notify?form=contact", undefined, { EMAIL: email.binding });
    expect(r.status).toBe(502);
    expect(r.data.results).toEqual([
      { channel: "email:me@example.com", ok: true, status: "sent" },
      { channel: "webhook:discord", ok: false, status: "config", error: "the webhook answered HTTP 404; check the URL in WEBHOOK_DISCORD_URL" },
    ]);
    expect(email.sent).toHaveLength(1);
    expect(await rows("SELECT id FROM submissions")).toHaveLength(0);
  });
});
