// Brand typography → free fonts the renderer can load. Google Fonts are used
// as-is; licensed faces map to the closest free match.
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, putFile } from "../lib/store";
import type { FontSpec } from "../lib/schema";

/** Closest free match for common licensed/custom faces. Order matters: first hit wins. */
const MAP: [RegExp, string][] = [
  [/didot|bodoni|canela|sectra|ogg|editorial new|reckless|domaine|chronicle display|freight (big|display)|gt super|saol|portrait/i, "Playfair Display"],
  [/tiempos|freight|lyon|publico|georgia|times|caslon|garamond|baskerville|mercury|miller|austin|chap/i, "DM Serif Display"],
  [/knockout|druk|tungsten|bebas|trade gothic (bold )?cond|compacta|league gothic|anton/i, "Anton"],
  [/gotham|montserrat|proxima|brandon|sofia pro|gilroy|museo sans/i, "Montserrat"],
  [/futura|avenir|circular|euclid|cera|walsheim|poppins|tt commons|campton|eina|gordita|graphik|apercu/i, "Poppins"],
  [/helvetica|neue haas|aktiv|suisse|untitled sans|söhne|sohne|gt america|akzidenz|atlas|maison|founders|inter|arial|sf pro|-apple-system|system-ui|roboto|neue montreal|basis/i, "Inter"],
  [/gill sans|frutiger|myriad|source sans|open sans|segoe|calibri|fira|lato|whitney|benton/i, "Nunito Sans"],
  [/rounded|nunito|quicksand|varela|filson|gt maru|recoleta/i, "Nunito"],
  [/mono|courier|plex mono|menlo|consolas/i, "Space Mono"],
  [/manrope|plus jakarta|dm sans|outfit|urbanist|general sans|satoshi|clash/i, "Outfit"],
];

export function firstFamily(stack: string) {
  return (stack || "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).find(Boolean) ?? "Inter";
}

const googleCache = new Map<string, boolean>();
async function googleCss(family: string, weights: number[], ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36") {
  const ws = [...new Set(weights.map((w) => Math.round(w / 100) * 100))].sort((a, b) => a - b).join(";");
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${ws}&display=swap`;
  const res = await fetch(url, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    // Static families reject wght ranges they don't have; retry without weights.
    const r2 = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(10000) });
    return r2.ok ? r2.text() : null;
  }
  return res.text();
}

export async function isGoogleFont(family: string) {
  if (googleCache.has(family)) return googleCache.get(family)!;
  let ok = false;
  try { ok = !!(await googleCss(family, [400])); } catch { ok = false; }
  googleCache.set(family, ok);
  return ok;
}

export async function resolveFamily(stack: string): Promise<{ family: string; source: string }> {
  const source = firstFamily(stack);
  const clean = source.replace(/\s+(variable|vf|web|text|display|pro|std)$/i, "").trim();
  if (!/^(-apple-system|system-ui|blinkmacsystemfont|sans-serif|serif)$/i.test(clean) && await isGoogleFont(clean)) return { family: clean, source };
  for (const [re, fam] of MAP) if (re.test(source)) return { family: fam, source };
  return { family: /serif/i.test(stack) && !/sans-serif/i.test(stack) ? "DM Serif Display" : "Inter", source };
}

/** Downloads woff2 files for a family/weights into shared storage. */
export async function downloadFont(family: string, weights: number[], subsets = ["latin", "latin-ext"]): Promise<FontSpec["files"]> {
  try {
    const css = await googleCss(family, weights);
    if (!css) return [];
    const files: FontSpec["files"] = [];
    const blocks = css.split("/*").slice(1);
    for (const b of blocks) {
      const subset = b.match(/^\s*([\w-]+)\s*\*\//)?.[1] ?? "latin";
      if (subsets.length && !subsets.includes(subset)) continue;
      const weight = b.match(/font-weight:\s*([\d ]+);/)?.[1]?.trim() ?? "400";
      const style = b.match(/font-style:\s*(\w+);/)?.[1] ?? "normal";
      const src = b.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
      const range = b.match(/unicode-range:\s*([^;]+);/)?.[1];
      if (!src) continue;
      const rel = path.posix.join("fonts", family.replace(/\W+/g, "-").toLowerCase(), `${weight.replace(/\s+/g, "-")}-${style}-${subset}.woff2`);
      const abs = path.join(DATA_DIR, rel);
      try { await fs.access(abs); } catch {
        const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        await putFile(rel, Buffer.from(await r.arrayBuffer()));
      }
      files.push({ url: rel, weight, style, unicodeRange: range });
    }
    return files;
  } catch { return []; }
}
