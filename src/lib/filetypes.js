// Decides a file's type by its first bytes, and checks it matches the name's
// extension. No executables, HTML or SVG are ever accepted (SVG and HTML can
// carry scripts); a renamed .exe starts with "MZ" and matches nothing here.

const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

const ZIP_BASED = new Set(["docx", "xlsx", "pptx", "odt", "ods"]);

const starts = (b, sig) => sig.every((v, i) => b[i] === v);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** "photo.JPEG" -> "jpg"; "" if none. */
export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!m) return "";
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/** The kind of file these bytes are, or null. */
export function sniff(bytes) {
  const b = bytes;
  if (starts(b, ascii("%PDF-"))) return "pdf";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (starts(b, ascii("GIF87a")) || starts(b, ascii("GIF89a"))) return "gif";
  if (starts(b, ascii("RIFF")) && b.length >= 12 && starts(b.subarray(8), ascii("WEBP"))) return "webp";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (b.includes(0)) return null;
  let textValue;
  try {
    textValue = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, Math.min(b.length, 64 * 1024)));
  } catch {
    // A cut in the middle of a character at the 64 KB mark is fine; anything else isn't text.
    if (b.length <= 64 * 1024) return null;
    try {
      textValue = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, 64 * 1024 - 4));
    } catch {
      return null;
    }
  }
  if (/^\s*<(!doctype|html|svg|script|\?xml|head|body|iframe)/i.test(textValue)) return null;
  return "text";
}

/**
 * Checks a file against a field's allowed types.
 * @returns {{ ok: true, ext: string, contentType: string } | { ok: false }}
 */
export function checkFileType(name, bytes, allowed) {
  const ext = extensionOf(name);
  const allowedNorm = allowed.map((t) => (t === "jpeg" ? "jpg" : t));
  if (!ext || !allowedNorm.includes(ext)) return { ok: false };
  const kind = sniff(bytes);
  const matches =
    kind === ext || (kind === "zip" && ZIP_BASED.has(ext)) || (kind === "text" && (ext === "txt" || ext === "csv"));
  return matches ? { ok: true, ext, contentType: MIME[ext] } : { ok: false };
}

/** The original name, without any path, control characters or quotes, at most 200 characters. */
export function cleanFileName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\x00-\x1f\x7f"<>|*?:]+/g, "").replace(/^\.+/, "").trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 200) return cleaned;
  const ext = extensionOf(cleaned);
  return ext ? `${cleaned.slice(0, 199 - ext.length)}.${ext}` : cleaned.slice(0, 200);
}
