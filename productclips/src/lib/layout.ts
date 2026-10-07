// Where things sit on screen. One implementation, used by the director to
// plan, by QA to check, and by the Remotion components to draw.
import { H, SAFE, SAFE_W, SLOT_Y, W, slamLines, type Rect } from "./geometry";
import type { AssetRef, Layout, Overlay, SafePos, Scene } from "./schema";

export const TYPE = {
  headline: { size: 132, lineH: 1.0, maxWordsPerLine: 3 },
  accent: { size: 100, lineH: 1.04, maxWordsPerLine: 3 },
  pill: { size: 54, padX: 40, padY: 20 },
  platePad: { x: 34, y: 20 },
};
const CHAR = 0.55; // average glyph advance in em for display faces (slightly generous)

export function headlineMetrics(text: string, style: "headline" | "accent", plate = false) {
  const t = TYPE[style];
  const lines = slamLines(text, t.maxWordsPerLine);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const avail = SAFE_W - (plate ? 2 * TYPE.platePad.x : 0);
  const size = Math.min(t.size, Math.floor(avail / (longest * CHAR)));
  return { lines, size, lineH: t.lineH };
}

export const CARD_MAX = { w: 820, h: 820, cy: 930 };
export const SPLIT_IMAGE_H = 1100;

/** Rect in which the scene's image is drawn (and cover-cropped). */
export function imageRect(layout: Layout, asset?: Pick<AssetRef, "width" | "height">): Rect {
  if (layout === "card" || layout === "endCard") {
    const ar = asset ? asset.width / asset.height : 1;
    const max = layout === "endCard" ? { w: 860, h: 600, cy: 650 } : CARD_MAX;
    let w = max.w, h = w / ar;
    if (h > max.h) { h = max.h; w = h * ar; }
    return { x: (W - w) / 2, y: max.cy - h / 2, w, h };
  }
  if (layout === "split") return { x: 0, y: 0, w: W, h: SPLIT_IMAGE_H };
  return { x: 0, y: 0, w: W, h: H };
}

// End card is a fixed composition so the CTA always lands in the same place.
export const END = {
  logo: { cy: 290, h: 80 },
  nameTop: 990,
  cta: { cy: 1452, h: 128 },
};
export const CHIP = { size: 36, rowH: 76, gap: 12, min: 28 };

/** Natural one-row width of feature chips at a font size (estimate shared by QA and render). */
export const chipsWidth = (items: string[], size: number) => items.reduce((s, t) => s + t.length * size * CHAR + size * 1.5 + 6, 0) + CHIP.gap * (items.length - 1);

/** Keeps the chips (in order) that fit one row at >= 32px; always at least two. */
export function fitChips(items: string[]) {
  const out = items.slice(0, 4);
  while (out.length > 2 && chipsWidth(out, 32) > SAFE_W) {
    const longest = out.reduce((m, t, i) => (t.length > out[m].length ? i : m), 0);
    out.splice(longest, 1);
  }
  return out;
}

/**
 * End card flows top-down from the product name: name → price → chips, with
 * the CTA fixed just above the platform UI. Chips drop to one shrunk row if
 * two rows would collide with the CTA.
 */
export function endCardLayout(overlays: Overlay[]) {
  const name = overlays.find((o) => o.kind === "slamText") as Extract<Overlay, { kind: "slamText" }> | undefined;
  const chips = overlays.find((o) => o.kind === "chips") as Extract<Overlay, { kind: "chips" }> | undefined;
  const hasPrice = overlays.some((o) => o.kind === "price");
  const m = name ? headlineMetrics(name.text, "accent") : null;
  const nameH = m ? m.lines.length * m.size * m.lineH : 0;
  let y = END.nameTop + nameH;
  const priceCy = y + 44;
  if (hasPrice) y = priceCy + 35;
  const chipsTop = y + 22;
  const ctaTop = END.cta.cy - END.cta.h / 2;
  let rows = 1, size = CHIP.size;
  if (chips) {
    const fit = Math.floor(CHIP.size * (SAFE_W / Math.max(1, chipsWidth(chips.items, CHIP.size))));
    if (fit >= 32) size = Math.min(40, fit);
    else if (chipsTop + 2 * CHIP.rowH + CHIP.gap <= ctaTop - 16) rows = 2;
    else size = Math.max(CHIP.min, fit);
  }
  // Never let chips run into the CTA: shrink to the vertical room left.
  const room = ctaTop - 14 - chipsTop - (rows - 1) * CHIP.gap;
  size = Math.max(CHIP.min, Math.min(size, Math.floor((room / rows / CHIP.rowH) * CHIP.size)));
  const chipsH = rows * CHIP.rowH * (size / CHIP.size) + (rows - 1) * CHIP.gap;
  return { nameCy: END.nameTop + nameH / 2, nameH, priceCy, chips: { top: chipsTop, h: chipsH, rows, size }, ctaCy: END.cta.cy };
}

/** Approximate on-screen rect of a text-bearing overlay (null for non-text). */
export function overlayRect(ov: Overlay, scene: Pick<Scene, "layout"> & { overlays?: Overlay[] }): Rect | null {
  const cx = SAFE.left + SAFE_W / 2;
  const nudge = "nudge" in ov && ov.nudge ? ov.nudge : [0, 0];
  if (scene.layout === "endCard") {
    const L = endCardLayout(scene.overlays ?? [ov]);
    if (ov.kind === "slamText") { const m = headlineMetrics(ov.text, "accent"); return centered(cx, L.nameCy, Math.min(SAFE_W, longestPx(m.lines, m.size)), L.nameH); }
    if (ov.kind === "price") return centered(cx, L.priceCy, ov.text.length * 60 * CHAR + 40, 70);
    if (ov.kind === "chips") return { x: SAFE.left, y: L.chips.top, w: SAFE_W, h: L.chips.h };
    if (ov.kind === "cta") return centered(cx, L.ctaCy, Math.min(SAFE_W, ov.text.length * 52 * CHAR + 140), END.cta.h);
    if (ov.kind === "logo") return centered(cx, END.logo.cy, 360, END.logo.h);
  }
  switch (ov.kind) {
    case "slamText": {
      const m = headlineMetrics(ov.text, ov.style, ov.plate);
      const pad = ov.plate ? TYPE.platePad : { x: 0, y: 0 };
      const w = Math.min(SAFE_W, longestPx(m.lines, m.size) + 2 * pad.x);
      const h = m.lines.length * m.size * m.lineH + 2 * pad.y;
      return centered(cx + nudge[0], SLOT_Y[ov.position] + nudge[1], w, h);
    }
    case "pill": {
      const p = TYPE.pill;
      const w = Math.min(SAFE_W, ov.text.length * p.size * CHAR + 2 * p.padX);
      return centered(cx + nudge[0], SLOT_Y[ov.position] + nudge[1], w, p.size * 1.15 + 2 * p.padY);
    }
    case "rating": return ov.quote ? centered(cx, SLOT_Y.center - 100, SAFE_W, 580) : centered(cx, SLOT_Y.center - 20, SAFE_W, 300);
    case "price": return centered(cx, SLOT_Y.lower, ov.text.length * 56 * CHAR + 40, 70);
    case "sticker": return null; // positioned off the anchor; checked separately
    default: return null;
  }
}

function longestPx(lines: string[], size: number) { return Math.max(...lines.map((l) => l.length)) * size * CHAR; }
const centered = (cx: number, cy: number, w: number, h: number): Rect => ({ x: cx - w / 2, y: cy - h / 2, w, h });

/** Height a text overlay will occupy at a slot, for planning. */
export function slotFor(cy: number): SafePos {
  let best: SafePos = "center", d = Infinity;
  for (const [k, v] of Object.entries(SLOT_Y) as [SafePos, number][]) if (Math.abs(v - cy) < d) { d = Math.abs(v - cy); best = k; }
  return best;
}

/** Sticker rect next to its anchor (top-right corner by default, clamped to safe zone). */
export function stickerRect(anchor: Rect, text: string): Rect {
  const w = Math.max(220, Math.min(360, text.length * 40 * CHAR + 80)), h = Math.max(140, w * 0.55);
  let x = anchor.x + anchor.w - w * 0.35, y = anchor.y - h * 0.65;
  x = Math.min(Math.max(x, SAFE.left), SAFE.right - w);
  y = Math.min(Math.max(y, SAFE.top), SAFE.bottom - h);
  return { x, y, w, h };
}
