// GET /file/<id>?exp=&sig= : a signed, expiring download link.
// The same "not found" answer for a bad signature, an expired link and a
// missing file, so links can't be probed.
import { verifyFileLink, downloadHeaders } from "../lib/links.js";
import { text } from "../lib/http.js";

export async function fileDownload(request, app, fileId) {
  const { env } = app;
  const url = new URL(request.url);
  const notFound = () => text("This link has expired or isn't valid. Ask for a new one.\n", 404, { "Referrer-Policy": "no-referrer" });
  if (!env.FILES) return notFound();
  if (!(await verifyFileLink(env, fileId, url.searchParams.get("exp"), url.searchParams.get("sig")))) return notFound();
  return streamFile(env, fileId, notFound);
}

/** Streams a file by id from R2 with download-only headers. */
export async function streamFile(env, fileId, notFound) {
  const row = await env.DB.prepare("SELECT id, name, content_type, size, r2_key FROM files WHERE id = ?1").bind(fileId).first();
  if (!row) return notFound();
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return notFound();
  return new Response(obj.body, { status: 200, headers: downloadHeaders(row) });
}
