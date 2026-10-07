// Frame geometry shared by the director (planning), QA and the Remotion
// components, so what QA checks is exactly what gets drawn.
import type { Box, SafePos, Scene } from "./schema";

export const W = 1080;
export const H = 1920;
export const FPS = 30;
export const TOTAL_FRAMES = 870; // 29.00s

/** Reels/TikTok/Shorts UI-safe area for text. */
export const SAFE = { left: 64, right: W - 140, top: 220, bottom: H - 380 };
export const SAFE_W = SAFE.right - SAFE.left;

/** Vertical centre for each named text slot. */
export const SLOT_Y: Record<SafePos, number> = { top: 345, upper: 590, center: 940, lower: 1250, bottom: 1430 };

export type Rect = { x: number; y: number; w: number; h: number };

export const rectsOverlap = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
export const rectInside = (a: Rect, outer: Rect) =>
  a.x >= outer.x - 0.5 && a.y >= outer.y - 0.5 && a.x + a.w <= outer.x + outer.w + 0.5 && a.y + a.h <= outer.y + outer.h + 0.5;
export const safeRect = (): Rect => ({ x: SAFE.left, y: SAFE.top, w: SAFE.right - SAFE.left, h: SAFE.bottom - SAFE.top });

// ---------- camera ----------
export type CameraState = { scale: number; panX: number };

/** Base "cover" placement of an image in a frame, centred on the origin as far as coverage allows. */
export function coverBase(iw: number, ih: number, fw: number, fh: number, origin: [number, number]) {
  const s = Math.max(fw / iw, fh / ih);
  const dw = iw * s, dh = ih * s;
  const tx = clamp(fw / 2 - origin[0] * dw, fw - dw, 0);
  const ty = clamp(fh / 2 - origin[1] * dh, fh - dh, 0);
  return { s, dw, dh, tx, ty };
}

/** Maps a normalized image point to frame pixels for a given camera state. */
export function makeProjector(iw: number, ih: number, fw: number, fh: number, origin: [number, number], cam: CameraState) {
  const b = coverBase(iw, ih, fw, fh, origin);
  const ax = b.tx + origin[0] * b.dw;
  const ay = b.ty + origin[1] * b.dh;
  // Clamp pan so the scaled image still covers the frame.
  const S = Math.max(1, cam.scale);
  const left = ax + (b.tx - ax) * S;
  const right = ax + (b.tx + b.dw - ax) * S;
  const panX = clamp(cam.panX, fw - right, -left);
  const top = ay + (b.ty - ay) * S;
  const bottom = ay + (b.ty + b.dh - ay) * S;
  const dy = top > 0 ? -top : bottom < fh ? fh - bottom : 0;
  const pt = (u: number, v: number) => ({
    x: ax + (b.tx + u * b.dw - ax) * S + panX,
    y: ay + (b.ty + v * b.dh - ay) * S + dy,
  });
  const box = (bx: Box): Rect => {
    const p = pt(bx.x, bx.y), q = pt(bx.x + bx.w, bx.y + bx.h);
    return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y };
  };
  /** CSS transform for an <img> sized dw x dh at (tx,ty). */
  const css = { width: b.dw, height: b.dh, left: b.tx, top: b.ty, originX: ax - b.tx, originY: ay - b.ty, scale: S, panX, panY: dy };
  return { pt, box, css };
}

export function cameraAt(scene: Pick<Scene, "camera">, t: number, beatPhase = 0, beatBump = 0.01): CameraState {
  const { move, fromScale, toScale } = scene.camera;
  const e = easeInOutSine(clamp(t, 0, 1));
  const bump = beatBump * Math.exp(-beatPhase * 6); // ~1% kick on each beat, decays fast
  switch (move) {
    case "static": return { scale: fromScale + bump * 0.5, panX: 0 };
    case "punch": {
      const p = easeOutCubic(clamp(t * 4, 0, 1)); // fast snap in the first quarter, then hold
      return { scale: fromScale + (toScale - fromScale) * p + bump, panX: 0 };
    }
    case "panLeft": case "panRight": {
      const s = Math.max(fromScale, toScale, 1.08);
      const travel = W * (s - 1) * 0.45;
      const dir = move === "panLeft" ? -1 : 1;
      return { scale: s + bump, panX: dir * (-travel + 2 * travel * e) };
    }
    default: return { scale: fromScale + (toScale - fromScale) * e + bump, panX: 0 };
  }
}

/** Normalized image rect visible in the frame for a camera state (for crop QA). */
export function visibleRegion(iw: number, ih: number, origin: [number, number], cam: CameraState, fw = W, fh = H): Box {
  const pr = makeProjector(iw, ih, fw, fh, origin, cam);
  const p0 = pr.pt(0, 0), p1 = pr.pt(1, 1);
  const u = (x: number) => (x - p0.x) / (p1.x - p0.x);
  const v = (y: number) => (y - p0.y) / (p1.y - p0.y);
  const x0 = clamp(u(0), 0, 1), x1 = clamp(u(fw), 0, 1), y0 = clamp(v(0), 0, 1), y1 = clamp(v(fh), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const boxInside = (a: Box, outer: Box, tol = 0.002) =>
  a.x >= outer.x - tol && a.y >= outer.y - tol && a.x + a.w <= outer.x + outer.w + tol && a.y + a.h <= outer.y + outer.h + tol;

// ---------- text metrics (approximate, font-agnostic) ----------
export function estimateTextRect(text: string, fontPx: number, slot: SafePos, opts: { maxW?: number; padX?: number; padY?: number; lineH?: number; nudge?: [number, number] } = {}): Rect & { lines: string[] } {
  const maxW = opts.maxW ?? SAFE_W;
  const charW = fontPx * 0.56;
  const lines = wrapWords(text, Math.max(4, Math.floor((maxW - 2 * (opts.padX ?? 0)) / charW)));
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const w = Math.min(maxW, longest * charW + 2 * (opts.padX ?? 0));
  const h = lines.length * fontPx * (opts.lineH ?? 1.05) + 2 * (opts.padY ?? 0);
  const cx = SAFE.left + SAFE_W / 2 + (opts.nudge?.[0] ?? 0);
  const cy = SLOT_Y[slot] + (opts.nudge?.[1] ?? 0);
  return { x: cx - w / 2, y: cy - h / 2, w, h, lines };
}

export function wrapWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/**
 * Splits a headline into slam lines of at most `maxWords` words. Short lines
 * stay whole; longer ones break where the two lines are most balanced, so type
 * stays big instead of shrinking to fit ("Leakproof / one-hand cap").
 */
export function slamLines(text: string, maxWords = 3, fitChars = 17): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1 || (words.length <= maxWords && text.length <= fitChars)) return [words.join(" ")];
  if (words.length > 2 * maxWords) {
    const n = Math.ceil(words.length / maxWords), per = Math.ceil(words.length / n), out: string[] = [];
    for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
    return out;
  }
  let best: string[] = [words.join(" ")], score = words.length <= maxWords ? text.length : Infinity;
  for (let k = 1; k < words.length; k++) {
    if (k > maxWords || words.length - k > maxWords) continue;
    const a = words.slice(0, k).join(" "), b = words.slice(k).join(" ");
    const s = Math.max(a.length, b.length) + 0.01 * Math.abs(a.length - b.length);
    if (s < score) { score = s; best = [a, b]; }
  }
  return best;
}

// ---------- easing ----------
export const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutBack = (t: number, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const easeInCubic = (t: number) => t * t * t;
