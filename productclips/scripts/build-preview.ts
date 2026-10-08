// Builds a static, serverless preview (editor + reel engine) for one project.
//   tsx scripts/build-preview.ts <projectId> <outDir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { getAssets, getBrandKit, getProduct, getRenders, latestStoryboard, resolveFile } from "../src/lib/store";
import { ensureScore, ensureSfx } from "../src/pipeline/music";

async function main() {
  const [id, outDir] = process.argv.slice(2);
  if (!id || !outDir) throw new Error("usage: build-preview.ts <projectId> <outDir>");
  const [product, kit, assets, rec, renders] = await Promise.all([getProduct(id), getBrandKit(id), getAssets(id), latestStoryboard(id), getRenders(id)]);
  if (!product || !kit || !rec) throw new Error("project not ready");
  fs.rmSync(outDir, { recursive: true, force: true });
  const copy = (rel: string, to = rel) => { const dst = path.join(outDir, "api/files", to); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(resolveFile(rel), dst); return to; };
  const audio = (rel: string, to: string) => { const dst = path.join(outDir, "api/files", to); fs.mkdirSync(path.dirname(dst), { recursive: true }); execFileSync("ffmpeg", ["-v", "error", "-y", "-i", resolveFile(rel), "-c:a", "libmp3lame", "-b:a", "160k", dst]); return to; };

  for (const a of assets) copy(a.path);
  if (product.logo) copy(product.logo.path);
  for (const f of [kit.fonts.heading, kit.fonts.body, kit.fonts.button]) for (const file of f.files) copy(file.url);
  await ensureSfx();
  for (const n of ["chime", "whoosh", "pop", "impact", "click", "riser", "switch", "sparkle", "shutter"]) copy(`sfx/${n}.wav`);
  const score = await ensureScore(id, rec.json);
  const musicPath = score ? audio(score, score.replace(/\.wav$/, ".mp3")) : null;
  const done = renders.find((r) => r.status === "done" && r.mp4);
  const mp4 = done?.mp4 ? copy(done.mp4) : null;

  const demo = { product, kit, assets, storyboard: rec.json, musicPath, mp4 };
  await build({
    entryPoints: ["src/preview/main.tsx"], bundle: true, minify: true, format: "iife", target: "es2020",
    outfile: path.join(outDir, "preview.js"), jsx: "automatic", define: { __DEMO__: JSON.stringify(demo), "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.resolve("src") }, logLevel: "warning",
  });
  // Tailwind compiled at build time and inlined (the artifact can't load stylesheets from elsewhere).
  const postcss = (await import("postcss")).default;
  const tw = (await import("@tailwindcss/postcss")).default;
  const css = await postcss([tw({ base: process.cwd() })]).process(fs.readFileSync("src/preview/preview.css", "utf8"), { from: path.resolve("src/preview/preview.css") });
  const shell = fs.readFileSync("src/preview/index.html", "utf8").replace("/*__TAILWIND__*/", css.css);
  fs.writeFileSync(path.join(outDir, "index.html"), shell);
  console.log(`preview → ${outDir}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
