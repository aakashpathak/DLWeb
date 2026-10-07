// Step 7 — Render: Remotion → H.264, then ffmpeg masters the audio to
// -14 LUFS / -1 dBTP, and we cut a poster and a 2s GIF.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, getAssets, getProduct, getBrandKit, projectFile, resolveFile } from "../lib/store";
import type { Storyboard } from "../lib/schema";
import type { ReelProps } from "../remotion/context";
import { chromiumPath } from "./browser";
import { ensureScore, ensureSfx } from "./music";
import { startFileServer } from "./fileserver";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export async function reelProps(projectId: string, sb: Storyboard, assetBase: string): Promise<ReelProps> {
  const [product, kit, assets] = await Promise.all([getProduct(projectId), getBrandKit(projectId), getAssets(projectId)]);
  if (!product || !kit) throw new Error("Project is missing product or brand kit");
  await ensureSfx();
  const music = await ensureScore(projectId, sb);
  return {
    storyboard: sb, kit, assets, assetBase,
    product: { title: product.title, brand: product.brand, price: product.price },
    logo: product.logo ? { path: product.logo.path, width: product.logo.width, height: product.logo.height } : null,
    musicUrl: music ? `${assetBase}/api/files/${music}` : null,
  };
}

let bundlePromise: Promise<string> | null = null;
async function getBundle() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { bundle } = await import("@remotion/bundler");
      return bundle({ entryPoint: path.join(process.cwd(), "src/remotion/index.ts"), outDir: path.join(DATA_DIR, "bundle"), webpackOverride: (c) => c });
    })().catch((e) => { bundlePromise = null; throw e; });
  }
  return bundlePromise;
}

export async function renderReel(opts: { projectId: string; renderId: string; storyboard: Storyboard; onProgress?: (p: number) => void }) {
  const files = await startFileServer();
  try { return await renderWith({ ...opts, assetBase: files.url }); } finally { await files.close(); }
}

async function renderWith(opts: { projectId: string; renderId: string; storyboard: Storyboard; assetBase: string; onProgress?: (p: number) => void }) {
  const { renderMedia, selectComposition } = await import("@remotion/renderer");
  const props = await reelProps(opts.projectId, opts.storyboard, opts.assetBase);
  const serveUrl = await getBundle();
  const browserExecutable = headlessShellPath();
  const composition = await selectComposition({ serveUrl, id: "Reel", inputProps: props, browserExecutable, chromiumOptions: { disableWebSecurity: true } });
  const raw = resolveFile(projectFile(opts.projectId, `render-${opts.renderId}-raw.mp4`));
  await fs.mkdir(path.dirname(raw), { recursive: true });
  await renderMedia({
    composition, serveUrl, codec: "h264", outputLocation: raw, inputProps: props, crf: 18, pixelFormat: "yuv420p",
    audioBitrate: "192k", x264Preset: "medium", colorSpace: "bt709", browserExecutable, chromiumOptions: { disableWebSecurity: true, gl: "swangle" },
    concurrency: Math.max(1, Math.min(4, os.cpus().length - 1)), timeoutInMilliseconds: 120000,
    onProgress: ({ progress }) => opts.onProgress?.(progress * 0.9),
  });
  const out = await master(raw, opts.projectId, opts.renderId, opts.storyboard);
  await fs.rm(raw, { force: true });
  opts.onProgress?.(1);
  return out;
}

/** Remotion's bundled headless shell is preferred; fall back to the system Chromium. */
function headlessShellPath(): string | undefined {
  if (process.env.REMOTION_BROWSER) return process.env.REMOTION_BROWSER;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const d = fsSync.readdirSync(root).find((x: string) => x.startsWith("chromium_headless_shell-"));
    if (d) {
      for (const rel of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = `${root}/${d}/${rel}`;
        if (fsSync.existsSync(p)) return p;
      }
    }
  } catch { /* none */ }
  return chromiumPath();
}

async function master(raw: string, projectId: string, renderId: string, sb: Storyboard) {
  const rel = (name: string) => projectFile(projectId, name);
  const mp4 = rel(`clip-${renderId}.mp4`), poster = rel(`poster-${renderId}.jpg`), gif = rel(`preview-${renderId}.gif`);
  // Pass 1: measure loudness
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-i", raw, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { maxBuffer: 1 << 24 });
  const m = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1));
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  // Pass 2: normalise, fade the last 0.8s, exact 29.00s, faststart
  await run(FFMPEG, ["-y", "-hide_banner", "-i", raw, "-c:v", "copy", "-af", `${ln},afade=t=out:st=28.2:d=0.8,aresample=48000`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "29", "-movflags", "+faststart", resolveFile(mp4)], { maxBuffer: 1 << 24 });
  // Verify integrated loudness
  const { stderr: s2 } = await run(FFMPEG, ["-hide_banner", "-i", resolveFile(mp4), "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 1 << 25 });
  const lufs = parseFloat(s2.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()?.match(/-?[\d.]+/)?.[0] ?? "NaN");
  // Poster: the hook's strongest frame (after the first slam settles)
  const hook = sb.scenes[0];
  const t = Math.min(((hook.lengthBeats * 60) / sb.bpm) * 0.75, 2.2);
  await run(FFMPEG, ["-y", "-hide_banner", "-ss", t.toFixed(2), "-i", resolveFile(mp4), "-frames:v", "1", "-q:v", "2", resolveFile(poster)]);
  // 2-second GIF of the reveal
  const reveal = sb.scenes.find((s) => s.role === "reveal");
  const gs = reveal ? (reveal.startBeat * 60) / sb.bpm : 2.5;
  await run(FFMPEG, ["-y", "-hide_banner", "-ss", gs.toFixed(2), "-t", "2", "-i", resolveFile(mp4), "-vf", "fps=15,scale=360:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", resolveFile(gif)]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", resolveFile(mp4)]).catch(() => ({ stdout: "29" }));
  return { mp4, poster, gif, lufs, duration: parseFloat(stdout) };
}


/** Renders individual frames as JPEGs (fast visual review / thumbnails). */
export async function renderStills(projectId: string, sb: Storyboard, frames: number[], outDir: string) {
  const files = await startFileServer();
  try {
    const { renderStill, selectComposition } = await import("@remotion/renderer");
    const props = await reelProps(projectId, sb, files.url);
    const serveUrl = await getBundle();
    const browserExecutable = headlessShellPath();
    const composition = await selectComposition({ serveUrl, id: "Reel", inputProps: props, browserExecutable });
    await fs.mkdir(outDir, { recursive: true });
    const out: string[] = [];
    for (const frame of frames) {
      const output = path.join(outDir, `f${String(frame).padStart(4, "0")}.jpg`);
      await renderStill({ composition, serveUrl, frame, output, inputProps: props, imageFormat: "jpeg", jpegQuality: 85, browserExecutable, scale: 0.5 });
      out.push(output);
    }
    return out;
  } finally { await files.close(); }
}
