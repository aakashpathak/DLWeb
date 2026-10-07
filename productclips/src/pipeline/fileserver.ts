// Tiny static server for DATA_DIR at /api/files/*, used by the render worker so
// rendering never depends on the web app's port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DATA_DIR } from "../lib/store";

export const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".woff2": "font/woff2", ".json": "application/json",
};

export async function startFileServer(root = DATA_DIR): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const rel = decodeURIComponent(u.pathname.replace(/^\/api\/files\//, ""));
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) { res.writeHead(404); res.end(); return; }
    const stat = fs.statSync(abs);
    const type = MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    const headers = { "content-type": type, "access-control-allow-origin": "*", "accept-ranges": "bytes" };
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : stat.size - 1;
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${stat.size}`, "content-length": end - start + 1 });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "content-length": stat.size });
      fs.createReadStream(abs).pipe(res);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
