import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveFile } from "@/lib/store";
import { MIME } from "@/pipeline/fileserver";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  let abs: string;
  try { abs = resolveFile(parts.map(decodeURIComponent).join("/")); } catch { return new Response("bad path", { status: 400 }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response("not found", { status: 404 });
  const size = fs.statSync(abs).size;
  const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  const download = new URL(req.url).searchParams.has("download");
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  if (download) headers["content-disposition"] = `attachment; filename="${path.basename(abs)}"`;
  const m = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })) as ReadableStream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(abs)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
}
