// Image utilities: download, perceptual hash, colour/luma sampling.
import sharp from "sharp";

export type ImageInfo = { width: number; height: number; mime: string };

export async function imageInfo(buf: Buffer): Promise<ImageInfo | null> {
  try {
    const m = await sharp(buf, { animated: false }).metadata();
    if (!m.width || !m.height) return null;
    return { width: m.width, height: m.height, mime: `image/${m.format === "jpeg" ? "jpeg" : m.format}` };
  } catch { return null; }
}

/** Normalises any web image to a renderer-friendly format (webp/avif/svg → png/jpeg). */
export async function normalizeImage(buf: Buffer): Promise<{ data: Buffer; ext: string; width: number; height: number } | null> {
  try {
    const img = sharp(buf, { animated: false, density: 200 }).rotate();
    const m = await img.metadata();
    if (!m.width || !m.height) return null;
    const hasAlpha = !!m.hasAlpha;
    const out = hasAlpha ? await img.png().toBuffer({ resolveWithObject: true }) : await img.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { data: out.data, ext: hasAlpha ? "png" : "jpg", width: out.info.width, height: out.info.height };
  } catch { return null; }
}

/** 64-bit difference hash as a hex string. */
export async function dHash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).flatten({ background: "#ffffff" }).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}
export function hamming(a: string, b: string) {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Rewrites CDN width params to ask for the largest version. */
export function maxResUrl(u: string): string {
  try {
    const url = new URL(u);
    // Shopify: _1200x.jpg / _300x300.jpg / _small / ?width=
    url.pathname = url.pathname.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)(@\dx)?(?=\.\w+$)/i, "");
    for (const k of ["width", "w", "height", "h", "size", "resize", "fit", "crop"]) url.searchParams.delete(k);
    if (/cdn\.shopify\.com|shopifycdn/.test(url.host)) url.searchParams.set("width", "2400");
    // imgix / contentful / sanity / cloudinary
    if (/imgix\.net|ctfassets\.net|sanity\.io/.test(url.host)) { url.searchParams.set("w", "2400"); url.searchParams.delete("q"); }
    url.pathname = url.pathname.replace(/\/(w_\d+|c_\w+|q_\w+|f_\w+)(,(w_\d+|c_\w+|q_\w+|f_\w+))*\//, "/");
    return url.toString();
  } catch { return u; }
}

/** Picks the largest candidate from a srcset string. */
export function bestFromSrcset(srcset: string, base: string): string | null {
  let best: { u: string; w: number } | null = null;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d?.endsWith("w") ? parseInt(d) : d?.endsWith("x") ? parseFloat(d) * 1000 : 1;
    try { const abs = new URL(u, base).toString(); if (!best || w > best.w) best = { u: abs, w }; } catch { /* skip */ }
  }
  return best?.u ?? null;
}

/** 12x12 luminance grid + border colour + simple saliency used by analysis. */
export async function imageStats(buf: Buffer) {
  const N = 12;
  const flat = sharp(buf).flatten({ background: "#ffffff" });
  const grid = await flat.clone().resize(N, N, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const lumaGrid: number[] = [];
  for (let i = 0; i < N * N; i++) {
    const [r, g, b] = [grid[i * 3], grid[i * 3 + 1], grid[i * 3 + 2]].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    lumaGrid.push(+(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(3));
  }
  const S = 96;
  const small = await flat.clone().resize(S, S, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const at = (x: number, y: number) => [small[(y * S + x) * 3], small[(y * S + x) * 3 + 1], small[(y * S + x) * 3 + 2]];
  // border colour + uniformity
  const border: number[][] = [];
  for (let i = 0; i < S; i++) { border.push(at(i, 0), at(i, S - 1), at(0, i), at(S - 1, i)); }
  const mean = [0, 1, 2].map((c) => border.reduce((s, p) => s + p[c], 0) / border.length);
  const dev = Math.sqrt(border.reduce((s, p) => s + (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2 + (p[2] - mean[2]) ** 2, 0) / border.length);
  // pixels that differ from the backdrop → subject box (for packshots)
  let x0 = S, y0 = S, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const p = at(x, y);
    if (Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]) > 38) { count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  // saliency: gradient energy centroid
  let ex = 0, ey = 0, et = 0;
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const l = (q: number[]) => q[0] * 0.3 + q[1] * 0.59 + q[2] * 0.11;
    const gx = l(at(x + 1, y)) - l(at(x - 1, y)), gy = l(at(x, y + 1)) - l(at(x, y - 1));
    const e = Math.hypot(gx, gy);
    ex += e * x; ey += e * y; et += e;
  }
  // colourfulness/edge density for infographic hints: count sharp, high-contrast transitions
  const hex = "#" + mean.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return {
    lumaGrid,
    borderColor: hex,
    borderUniform: dev < 14,
    subjectBox: count > 20 && x1 > x0 ? { x: x0 / S, y: y0 / S, w: (x1 - x0 + 1) / S, h: (y1 - y0 + 1) / S } : null,
    subjectFill: count / (S * S),
    focal: et > 0 ? [ex / et / S, ey / et / S] as [number, number] : [0.5, 0.5] as [number, number],
  };
}

/** Dominant colours (k-means-lite over a small thumbnail). */
export async function palette(buf: Buffer, k = 6): Promise<{ hex: string; share: number }[]> {
  const S = 64;
  const px = await sharp(buf).flatten({ background: "#ffffff" }).resize(S, S, { fit: "inside" }).removeAlpha().raw().toBuffer();
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < px.length; i += 3) {
    const key = `${px[i] >> 4},${px[i + 1] >> 4},${px[i + 2] >> 4}`;
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2];
    buckets.set(key, e);
  }
  const total = px.length / 3;
  return [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, k).map((e) => ({
    hex: "#" + [e.r / e.n, e.g / e.n, e.b / e.n].map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""),
    share: e.n / total,
  }));
}
