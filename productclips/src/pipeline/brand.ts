// Step 2 — Brand kit: colours, type, shape and tone from the page itself.
import fs from "node:fs/promises";
import { z } from "zod";
import { colorDistance, contrast, ensureContrast, lumOf, mix, normHex, parseColor, readableOn, saturation, toHex } from "../lib/color";
import { resolveFile } from "../lib/store";
import { BrandKit, Tone, type FontSpec, type Product } from "../lib/schema";
import { hasClaude, imageBlock, structured } from "./claude";
import { downloadFont, resolveFamily } from "./fonts";
import { palette } from "./images";
import type { FontInfo, RawExtraction } from "./ingest";

export async function buildBrandKit(product: Product, raw: RawExtraction | null, manual?: Partial<BrandKit["colors"]>): Promise<BrandKit> {
  const st = raw?.styles;
  const hero = product.pageScreenshots[0] ?? product.assets[0];
  const pal = hero ? await palette(await fs.readFile(resolveFile(hero.path))).catch(() => []) : [];

  // ---- colours ----
  const bg = normHex(manual?.bg ?? st?.bg ?? pal[0]?.hex ?? "#ffffff", "#ffffff");
  let ink = normHex(manual?.ink ?? st?.ink ?? "#111111", "#111111");
  if (contrast(ink, bg) < 4.5) ink = ensureContrast(ink, bg, 7);

  const btnBg = st?.button?.bg ? normHex(st.button.bg) : null;
  const btnFg = st?.button?.color ? normHex(st.button.color) : null;
  const candidates = [btnBg, btnFg, st?.themeColor ? normHex(st.themeColor) : null, st?.link ? normHex(st.link) : null, ...pal.map((p) => p.hex)].filter(Boolean) as string[];
  let primary = manual?.primary ?? (btnBg && colorDistance(btnBg, bg) > 40 ? btnBg : candidates.find((c) => colorDistance(c, bg) > 60 && (saturation(c) > 0.25 || Math.abs(lumOf(c) - lumOf(bg)) > 0.4)) ?? ink);
  primary = normHex(primary);
  let onPrimary = manual?.onPrimary ?? (btnBg && primary === btnBg && btnFg ? btnFg : readableOn(primary));
  if (contrast(onPrimary, primary) < 4.5) onPrimary = readableOn(primary);

  const accentCands = [st?.accent ? normHex(st.accent) : null, ...pal.map((p) => p.hex)].filter(Boolean) as string[];
  let accent = manual?.accent ?? accentCands.find((c) => colorDistance(c, bg) > 70 && colorDistance(c, primary) > 70 && saturation(c) > 0.3);
  if (!accent) accent = derivedAccent(primary, bg);
  const muted = mix(ink, bg, 0.55);

  // ---- type ----
  const [heading, body, button] = await Promise.all([
    fontSpec(st?.h1 ?? null, 700),
    fontSpec(st?.body ?? null, 400),
    fontSpec(st?.button?.font ?? st?.body ?? null, 600),
  ]);

  // ---- shape ----
  const radius = st?.button?.radius ?? 8;
  const h = st?.button?.height ?? 48;
  const style = radius >= h / 2 - 2 ? "pill" : radius >= 3 ? "rounded" : "sharp";

  // ---- tone ----
  const base = { bg, ink, primary, onPrimary, accent, muted };
  let tone = heuristicTone(base, heading);
  if (hasClaude() && hero) {
    try {
      const t = await structured({
        schema: z.object({ tone: Tone, energy: z.number().int().min(1).max(5), reason: z.string() }),
        system: "You classify the visual tone of D2C brand product pages for motion designers. Look at the page screenshot and copy. Be decisive.",
        content: [await imageBlock(hero.path, 1100), { type: "text", text: `Brand: ${product.brand}\nProduct: ${product.title}\nCopy: ${(product.description ?? "").slice(0, 800)}\n\nClassify tone (premium-minimal, playful-bold, clean-clinical, warm-natural, techy, luxury) and energy 1-5 (1 calm, 5 loud).` }],
        effort: "low",
        maxTokens: 2000,
      });
      tone = { tone: t.tone, energy: t.energy };
    } catch { /* keep heuristic */ }
  }

  return BrandKit.parse({
    colors: base,
    fonts: { heading, body, button },
    shape: { radius, style, shadow: !!st?.button?.shadow, border: !!st?.button?.border },
    tone: tone.tone,
    energy: tone.energy,
    ctaText: ctaFrom(product.ctaText),
  });
}

function ctaFrom(t?: string) {
  if (!t) return "Shop now";
  const c = t.replace(/[—–-]\s*\$?[\d.,]+.*$/, "").replace(/\s+/g, " ").trim();
  if (!c || c.length > 22) return "Shop now";
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
}

function derivedAccent(primary: string, bg: string) {
  const p = parseColor(primary) ?? [0, 0, 0];
  if (saturation(primary) < 0.15) return lumOf(bg) > 0.5 ? "#ff5a36" : "#ffd23f"; // neutral brands get a warm pop
  return toHex([255 - p[0] * 0.4, 200 - p[1] * 0.3, 80 + p[2] * 0.2] as [number, number, number]);
}

async function fontSpec(f: FontInfo | null, defaultWeight: number): Promise<FontSpec> {
  const stack = f?.family ?? "Inter";
  const { family, source } = await resolveFamily(stack);
  const weight = Math.max(f?.weight ?? defaultWeight, family === "Playfair Display" || family === "DM Serif Display" ? 400 : defaultWeight === 700 ? 600 : 400);
  const files = await downloadFont(family, [400, 600, weight, 700, 800]);
  const ls = f?.letterSpacing && f.letterSpacing !== "normal" && f.size ? parseFloat(f.letterSpacing) / f.size : 0;
  const serif = /(^|,)\s*serif\b/i.test(stack) || /serif|playfair|fraunces|garamond|caslon|bodoni|lora|cormorant|baskerville/i.test(family) && !/sans/i.test(family);
  return {
    family, serif, sourceFamily: source, weight: family === "DM Serif Display" || family === "Anton" ? 400 : weight,
    letterSpacing: Math.max(-0.04, Math.min(0.2, +ls.toFixed(3))),
    textTransform: (["none", "uppercase", "lowercase"].includes(f?.textTransform ?? "") ? f!.textTransform : "none") as FontSpec["textTransform"],
    files,
  };
}

function heuristicTone(c: { bg: string; ink: string; primary: string; accent: string }, heading: FontSpec): { tone: z.infer<typeof Tone>; energy: number } {
  const serif = heading.serif;
  const sat = saturation(c.primary);
  const darkBg = lumOf(c.bg) < 0.12;
  const [r, g, b] = parseColor(c.primary) ?? [0, 0, 0];
  if (serif && sat < 0.3) return { tone: darkBg ? "luxury" : "premium-minimal", energy: 2 };
  if (darkBg) return { tone: "techy", energy: 4 };
  if (sat > 0.55 && (heading.weight >= 700 || heading.textTransform === "uppercase")) return { tone: "playful-bold", energy: 5 };
  if (b > r && b > g * 0.9 && sat > 0.3) return { tone: "clean-clinical", energy: 3 };
  if ((r > b && g > b * 0.9 && sat < 0.5) || serif) return { tone: "warm-natural", energy: 3 };
  if (sat < 0.15) return { tone: "premium-minimal", energy: 2 };
  return { tone: "playful-bold", energy: 4 };
}
