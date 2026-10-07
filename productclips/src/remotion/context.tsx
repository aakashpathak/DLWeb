import React, { createContext, useContext, useEffect, useState } from "react";
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { contrast, ensureContrast, readableOn } from "../lib/color";
import type { AnalyzedAsset, BrandKit } from "../lib/schema";

export type ReelProps = {
  storyboard: import("../lib/schema").Storyboard;
  kit: BrandKit;
  assets: AnalyzedAsset[];
  product: { title: string; brand: string; price?: string };
  logo?: { path: string; width: number; height: number } | null;
  musicUrl?: string | null;
  /** Prefix for /api/files/... URLs. "" in the browser, http://host:port when rendering. */
  assetBase: string;
  watermark?: boolean;
};

// ---------- brand ----------
export type Brand = BrandKit & {
  radiusPx: number; // CTA/pill radius at 1080 width
  cardRadius: number;
  onPrimarySafe: string;
  accentInk: string;
  url: (path: string) => string;
};
const BrandCtx = createContext<Brand | null>(null);
export const useBrand = () => useContext(BrandCtx)!;

export function BrandProvider({ kit, assetBase, children }: { kit: BrandKit; assetBase: string; children: React.ReactNode }) {
  const radiusPx = kit.shape.style === "pill" ? 999 : kit.shape.style === "sharp" ? 0 : Math.min(40, Math.max(10, kit.shape.radius * 1.6));
  const cardRadius = kit.shape.style === "sharp" ? 0 : kit.shape.style === "pill" ? 56 : Math.min(48, Math.max(18, kit.shape.radius * 2.4));
  const value: Brand = {
    ...kit,
    radiusPx,
    cardRadius,
    onPrimarySafe: contrast(kit.colors.onPrimary, kit.colors.primary) >= 3 ? kit.colors.onPrimary : readableOn(kit.colors.primary),
    accentInk: readableOn(kit.colors.accent, [ensureContrast(kit.colors.ink, kit.colors.accent, 4.5), "#ffffff", "#111111"]),
    url: (p: string) => (p.startsWith("http") || p.startsWith("data:") ? p : `${assetBase}/api/files/${p}`),
  };
  return <BrandCtx.Provider value={value}>{children}</BrandCtx.Provider>;
}

export const fontStack = (f: BrandKit["fonts"]["heading"]) => `"${f.family}", ${f.serif ? "Georgia, serif" : "Helvetica Neue, Arial, sans-serif"}`;

/** Measures rendered text width (after fonts load) so lines can be shrunk to fit exactly. */
let canvas: HTMLCanvasElement | null = null;
export function measure(text: string, font: string) {
  if (typeof document === "undefined") return 0;
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Loads the brand's (free-matched) fonts before the first frame renders. */
export function FontLoader({ kit, assetBase }: { kit: BrandKit; assetBase: string }) {
  const [handle] = useState(() => delayRender("brand fonts"));
  useEffect(() => {
    const specs = [kit.fonts.heading, kit.fonts.body, kit.fonts.button];
    const loads: Promise<unknown>[] = [];
    for (const f of specs) for (const file of f.files) {
      const url = file.url.startsWith("http") ? file.url : `${assetBase}${file.url.startsWith("/") ? "" : "/api/files/"}${file.url}`;
      const face = new FontFace(f.family, `url(${url})`, { weight: file.weight, style: file.style, ...(file.unicodeRange ? { unicodeRange: file.unicodeRange } : {}) });
      loads.push(face.load().then((ff) => { (document.fonts as unknown as { add: (f: FontFace) => void }).add(ff); }).catch(() => {}));
    }
    const timeout = new Promise((r) => setTimeout(r, 8000));
    Promise.race([Promise.all(loads), timeout]).then(() => continueRender(handle));
  }, [kit, assetBase, handle]);
  return null;
}

// ---------- beat clock ----------
export type Clock = { frame: number; beat: number; bar: number; beatPhase: number; fpb: number; bpm: number };
const ClockCtx = createContext<{ bpm: number }>({ bpm: 120 });
export const ClockProvider = ({ bpm, children }: { bpm: number; children: React.ReactNode }) => <ClockCtx.Provider value={{ bpm }}>{children}</ClockCtx.Provider>;

/** Global beat clock (absolute frame) — any component can pulse on the beat. */
export function useBeat(offsetFrames = 0): Clock {
  const { bpm } = useContext(ClockCtx);
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame() + offsetFrames;
  const fpb = (fps * 60) / bpm;
  const beat = frame / fpb;
  return { frame, beat, bar: Math.floor(beat / 4), beatPhase: beat - Math.floor(beat), fpb, bpm };
}

/** Frames since an event at `atBeat` (scene-relative). Negative = not yet. */
export function useSince(atBeat: number) {
  const c = useBeat();
  return c.frame - Math.round(atBeat * c.fpb);
}

export type SceneAsset = AnalyzedAsset;
