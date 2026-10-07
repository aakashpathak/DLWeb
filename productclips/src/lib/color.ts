// Colour math: parsing, WCAG contrast, and picking readable pairs.
export type RGB = [number, number, number];

export function parseColor(input: string | undefined | null): RGB | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a < 0.5) return null; // mostly transparent: not a real colour
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }
  if (s === "white") return [255, 255, 255];
  if (s === "black") return [0, 0, 0];
  return null;
}

export const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
export const normHex = (c: string, fallback = "#000000") => { const p = parseColor(c); return p ? toHex(p) : fallback; };

function channel(c: number) { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
export const luminance = (rgb: RGB) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
export const lumOf = (hex: string) => luminance(parseColor(hex) ?? [0, 0, 0]);
export const contrastL = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
export const contrast = (a: string, b: string) => contrastL(lumOf(a), lumOf(b));

export const mix = (a: string, b: string, t: number) => {
  const pa = parseColor(a) ?? [0, 0, 0], pb = parseColor(b) ?? [0, 0, 0];
  return toHex([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]);
};
export const withAlpha = (hex: string, a: number) => {
  const p = parseColor(hex) ?? [0, 0, 0];
  return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
};

/** Best of black/white (or the given candidates) against a background. */
export function readableOn(bg: string, candidates: string[] = ["#ffffff", "#111111"]) {
  return candidates.slice().sort((x, y) => contrast(y, bg) - contrast(x, bg))[0];
}

export function saturation(hex: string) {
  const [r, g, b] = (parseColor(hex) ?? [0, 0, 0]).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

export const colorDistance = (a: string, b: string) => {
  const pa = parseColor(a) ?? [0, 0, 0], pb = parseColor(b) ?? [0, 0, 0];
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
};

/** Nudges `fg` lighter/darker until it reaches `target` contrast on `bg`. */
export function ensureContrast(fg: string, bg: string, target = 4.5) {
  if (contrast(fg, bg) >= target) return fg;
  const toward = lumOf(bg) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.1; t <= 1; t += 0.1) {
    const c = mix(fg, toward, t);
    if (contrast(c, bg) >= target) return c;
  }
  return toward;
}
