// End-to-end run against the bundled demo store, without the web app:
//   npm run demo            → scrape, brand, analyze, storyboard, render
//   npm run demo -- <url>   → same for any URL your network can reach
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createProject, getProject, getRenders, latestStoryboard, resolveFile } from "../src/lib/store";
import { startPipeline } from "../src/pipeline/run";
import { MIME } from "../src/pipeline/fileserver";

async function serveFixtures() {
  const root = path.join(process.cwd(), "fixtures");
  if (!fs.existsSync(path.join(root, "halden", "packshot-sage.jpg"))) {
    await import("./make-fixture");
    await new Promise((r) => setTimeout(r, 1500));
  }
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "index.html") : p;
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/halden/`, server };
}

async function main() {
  const arg = process.argv[2];
  const fx = arg ? null : await serveFixtures();
  const url = arg ?? fx!.url;
  const project = await createProject(url, true);
  console.log(`project ${project.id} → ${url}`);
  const t0 = Date.now();
  const timer = setInterval(async () => {
    const p = await getProject(project.id);
    const line = Object.entries(p!.steps).map(([k, v]) => `${k}:${v.status}${v.note ? `(${v.note})` : ""}`).join("  ");
    process.stdout.write(`\r${line.slice(0, 200).padEnd(200)}`);
  }, 1000);
  await startPipeline(project.id);
  clearInterval(timer);
  const p = await getProject(project.id);
  console.log("\n");
  for (const [k, v] of Object.entries(p!.steps)) console.log(`${k.padEnd(11)} ${v.status.padEnd(6)} ${v.note ?? ""} ${v.error ?? ""}`);
  const sb = await latestStoryboard(project.id);
  if (sb) for (const q of sb.qa) console.log(`QA ${q.severity}: ${q.message}`);
  const r = (await getRenders(project.id))[0];
  if (r?.mp4) console.log(`\nMP4: ${resolveFile(r.mp4)}\nposter: ${resolveFile(r.poster!)}\nGIF: ${resolveFile(r.gif!)}\nLUFS: ${r.lufs}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  fx?.server.close();
  process.exit(p?.status === "ready" ? 0 : 1);
}
main();
