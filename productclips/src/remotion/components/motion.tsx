// Motion component library. Every component is a pure function of the
// current frame and its props: no CSS animations, no timers.
import React from "react";
import { AbsoluteFill, Img, interpolate } from "remotion";
import { withAlpha, mix, lumOf } from "../../lib/color";
import { clamp, easeInOutSine, easeOutBack, easeOutCubic, makeProjector, SAFE, SAFE_W, SLOT_Y, type CameraState, type Rect } from "../../lib/geometry";
import { END, headlineMetrics, stickerRect, TYPE } from "../../lib/layout";
import type { AnalyzedAsset, Overlay, SafePos } from "../../lib/schema";
import { fontStack, measure, useBeat, useBrand } from "../context";

const CX = SAFE.left + SAFE_W / 2;
const fr = (ms: number) => Math.round((ms / 1000) * 30);

// ---------- images ----------
export function FramedImage({ asset, rect, origin, cam, radius = 0, shadow = false, style }: {
  asset: AnalyzedAsset; rect: Rect; origin: [number, number]; cam: CameraState; radius?: number; shadow?: boolean; style?: React.CSSProperties;
}) {
  const b = useBrand();
  const pr = makeProjector(asset.width, asset.height, rect.w, rect.h, origin, cam);
  const c = pr.css;
  return (
    <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, overflow: "hidden", borderRadius: radius, boxShadow: shadow ? "0 40px 80px rgba(0,0,0,0.22), 0 8px 24px rgba(0,0,0,0.12)" : undefined, background: asset.analysis.bgColor ?? "#eee", ...style }}>
      <Img src={b.url(asset.path)} style={{ position: "absolute", left: c.left, top: c.top, width: c.width, height: c.height, transformOrigin: `${c.originX}px ${c.originY}px`, transform: `translate(${c.panX}px, ${c.panY}px) scale(${c.scale})`, maxWidth: "none" }} />
    </div>
  );
}

/** Soft brand backdrop: slow drifting shapes in the brand's shape language. */
export function Backdrop({ color, seed = 0 }: { color: string; seed?: number }) {
  const b = useBrand();
  const { beat } = useBeat();
  const light = lumOf(color) > 0.5;
  const shape = withAlpha(mix(color, light ? "#000000" : "#ffffff", 0.5), 0.06);
  const accent = withAlpha(b.colors.accent, light ? 0.14 : 0.22);
  const drift = (k: number) => Math.sin((beat / 8 + seed + k) * Math.PI) * 40;
  const r = b.shape.style === "sharp" ? 0 : b.shape.style === "pill" ? "50%" : 120;
  return (
    <AbsoluteFill style={{ background: color, overflow: "hidden" }}>
      <div style={{ position: "absolute", width: 900, height: 900, left: -300 + drift(0), top: 1180 + drift(1), borderRadius: r, background: accent, transform: `rotate(${b.shape.style === "sharp" ? 12 : 0}deg)` }} />
      <div style={{ position: "absolute", width: 620, height: 620, right: -240 + drift(2), top: -120 + drift(3), borderRadius: r, background: shape }} />
    </AbsoluteFill>
  );
}

// ---------- text ----------
type Slam = Extract<Overlay, { kind: "slamText" }>;

/** Lines slam in on consecutive beats: 1.7x → 1.0 over 260ms, ease-out-cubic. */
export function SlamText({ ov, instant = false, cy: cyOverride, staggerBeats = 1 }: { ov: Slam; instant?: boolean; cy?: number; staggerBeats?: number }) {
  const b = useBrand();
  const { fpb, frame } = useBeat();
  const m = headlineMetrics(ov.text, ov.style, ov.plate);
  const font = b.fonts.heading;
  const cy = cyOverride ?? SLOT_Y[ov.position as SafePos] + (ov.nudge?.[1] ?? 0);
  const color = ov.color ?? b.colors.ink;
  const plateBg = ov.plateColor ?? (ov.style === "accent" ? b.colors.primary : b.colors.bg);
  // Exact fit: shrink if the real face is wider than the planning estimate.
  const avail = SAFE_W - (ov.plate ? 2 * TYPE.platePad.x : 0) - 8;
  const widest = Math.max(...m.lines.map((l) => measure(font.textTransform === "uppercase" ? l.toUpperCase() : l, `${font.weight} ${m.size}px ${fontStack(font)}`) + Math.max(0, font.letterSpacing) * m.size * l.length));
  const size = widest > avail ? Math.floor(m.size * (avail / widest)) : m.size;
  const onImage = !ov.plate && color.toLowerCase() === "#ffffff";
  const start = Math.round(ov.atBeat * fpb);
  const plateIn = instant ? 1 : clamp((frame - start) / fr(200), 0, 1);
  const h = m.lines.length * size * m.lineH;
  return (
    <div style={{ position: "absolute", left: SAFE.left + (ov.nudge?.[0] ?? 0), width: SAFE_W, top: cy - h / 2 - (ov.plate ? TYPE.platePad.y : 0), display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ position: "relative", padding: ov.plate ? `${TYPE.platePad.y}px ${TYPE.platePad.x}px` : 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {ov.plate && frame >= start && (
          <div style={{ position: "absolute", inset: 0, background: plateBg, borderRadius: Math.min(b.radiusPx, 36), transform: `scaleX(${easeOutCubic(plateIn)})`, boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }} />
        )}
        {m.lines.map((line, i) => {
          const t0 = start + Math.round(i * staggerBeats * fpb);
          const f = frame - t0;
          if (f < 0 && !(instant && i === 0)) return <div key={i} style={{ height: size * m.lineH }} />;
          const p = instant && i === 0 ? 1 : clamp(f / fr(260), 0, 1);
          const scale = 1.7 - 0.7 * easeOutCubic(p);
          const op = instant && i === 0 ? 1 : clamp(f / 3, 0, 1);
          return (
            <div key={i} style={{
              position: "relative", fontFamily: fontStack(font), fontWeight: font.weight, fontSize: size, lineHeight: m.lineH,
              letterSpacing: `${font.letterSpacing}em`, textTransform: font.textTransform, color, whiteSpace: "nowrap",
              transform: `scale(${scale})`, opacity: op, textAlign: "center",
              textShadow: onImage ? "0 4px 30px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.4)" : undefined,
            }}>{line}</div>
          );
        })}
      </div>
    </div>
  );
}

/** Pill styled like the site's CTA button; pops in with ease-out-back. */
export function Pill({ text, cy, atFrame = 0, big = false, pulse = false }: { text: string; cy: number; atFrame?: number; big?: boolean; pulse?: boolean }) {
  const b = useBrand();
  const { frame, beatPhase } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const p = clamp(f / fr(330), 0, 1);
  const pop = easeOutBack(p, 2.2);
  const pul = pulse && p >= 1 ? 1 + 0.035 * Math.exp(-beatPhase * 5) : 1;
  const size = big ? 52 : TYPE.pill.size;
  const font = b.fonts.button;
  return (
    <div style={{ position: "absolute", left: SAFE.left, width: SAFE_W, top: cy - (size * 1.15 + 2 * TYPE.pill.padY) / 2, display: "flex", justifyContent: "center" }}>
      <div style={{
        background: b.colors.primary, color: b.onPrimarySafe, borderRadius: b.radiusPx, padding: `${TYPE.pill.padY}px ${big ? 64 : TYPE.pill.padX}px`,
        fontFamily: fontStack(font), fontWeight: Math.max(600, font.weight), fontSize: size, lineHeight: 1.15, letterSpacing: `${font.letterSpacing}em`,
        textTransform: font.textTransform, whiteSpace: "nowrap", transform: `scale(${pop * pul})`, opacity: clamp(p * 4, 0, 1),
        boxShadow: b.shape.shadow ? "0 14px 36px rgba(0,0,0,0.22)" : "0 6px 18px rgba(0,0,0,0.12)",
        border: b.shape.border ? `3px solid ${b.onPrimarySafe}` : undefined,
      }}>{text}</div>
    </div>
  );
}

export function Sticker({ text, anchor, rotateDeg, atFrame }: { text: string; anchor: Rect; rotateDeg: number; atFrame: number }) {
  const b = useBrand();
  const { frame, beat } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const r = stickerRect(anchor, text);
  const p = easeOutBack(clamp(f / fr(380), 0, 1), 2.6);
  const wobble = Math.sin(beat * Math.PI) * 1.5;
  const radius = b.shape.style === "pill" ? 999 : b.shape.style === "sharp" ? 4 : 28;
  return (
    <div style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, display: "flex", alignItems: "center", justifyContent: "center",
      transform: `rotate(${rotateDeg - 18 * (1 - p) + wobble}deg) scale(${p})` }}>
      <div style={{ background: b.colors.accent, color: b.accentInk, borderRadius: radius, padding: "22px 34px", fontFamily: fontStack(b.fonts.heading), fontWeight: 800,
        fontSize: 40, lineHeight: 1.05, textAlign: "center", textTransform: "uppercase", letterSpacing: "0.02em", boxShadow: "0 16px 40px rgba(0,0,0,0.25)", border: "4px solid rgba(255,255,255,0.9)" }}>{text}</div>
    </div>
  );
}

/** Stroke-drawn ring (400ms) pinned to an analysed box; follows the camera. */
export function HighlightRing({ rect, atFrame }: { rect: Rect; atFrame: number }) {
  const b = useBrand();
  const { frame, beatPhase } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const p = easeOutCubic(clamp(f / fr(400), 0, 1));
  const pad = 22;
  const w = rect.w + 2 * pad, h = rect.h + 2 * pad;
  const rx = Math.min(w, h) / 2;
  const per = 2 * (w + h);
  const pulse = 1 + 0.02 * Math.exp(-beatPhase * 6) * (p >= 1 ? 1 : 0);
  return (
    <svg style={{ position: "absolute", left: rect.x - pad - 10, top: rect.y - pad - 10, overflow: "visible", transform: `scale(${pulse})`, transformOrigin: "center" }} width={w + 20} height={h + 20}>
      <rect x={10} y={10} width={w} height={h} rx={rx} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={14} strokeDasharray={per} strokeDashoffset={per * (1 - p)} strokeLinecap="round" />
      <rect x={10} y={10} width={w} height={h} rx={rx} fill="none" stroke={b.colors.accent} strokeWidth={8} strokeDasharray={per} strokeDashoffset={per * (1 - p)} strokeLinecap="round" />
    </svg>
  );
}

export function Arrow({ from, to, atFrame }: { from: [number, number]; to: [number, number]; atFrame: number }) {
  const b = useBrand();
  const { frame } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const p = easeOutCubic(clamp(f / fr(400), 0, 1));
  const mx = (from[0] + to[0]) / 2 + (to[1] - from[1]) * 0.25, my = (from[1] + to[1]) / 2 - (to[0] - from[0]) * 0.25;
  const d = `M ${from[0]} ${from[1]} Q ${mx} ${my} ${to[0]} ${to[1]}`;
  const ang = Math.atan2(to[1] - my, to[0] - mx);
  const head = (a: number) => `${to[0] - 34 * Math.cos(ang + a)},${to[1] - 34 * Math.sin(ang + a)}`;
  return (
    <svg style={{ position: "absolute", inset: 0 }} width={1080} height={1920}>
      <path d={d} fill="none" stroke={b.colors.accent} strokeWidth={10} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
      {p > 0.9 && <polyline points={`${head(0.5)} ${to[0]},${to[1]} ${head(-0.5)}`} fill="none" stroke={b.colors.accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Concentric rings — for buttons, lights, signals. One ring per beat. */
export function Ripple({ x, y, atFrame }: { x: number; y: number; atFrame: number }) {
  const b = useBrand();
  const { frame, fpb } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const rings = [0, 1, 2, 3].map((k) => {
    const t = (f - k * fpb * 0.5) / (fpb * 2);
    if (t < 0 || t > 1) return null;
    return <div key={k} style={{ position: "absolute", left: x - 260 * t, top: y - 260 * t, width: 520 * t, height: 520 * t, borderRadius: "50%", border: `${8 * (1 - t) + 2}px solid ${b.colors.accent}`, opacity: 1 - t }} />;
  });
  return <>{rings}</>;
}

/** Lights-off flicker for night/dark/glow features. */
export function LightsOffFlicker({ atFrame, lengthFrames }: { atFrame: number; lengthFrames: number }) {
  const { frame } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const pattern = [0.0, 0.7, 0.1, 0.8, 0.2, 0.75];
  const o = f < pattern.length * 2 ? pattern[Math.floor(f / 2)] : interpolate(f, [12, lengthFrames], [0.55, 0.45], { extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, rgba(0,0,10,${o * 0.4}) 0%, rgba(0,0,10,${o}) 70%)` }} />;
}

/** Star rating: stars fill one per beat, count ticks up. */
export function StarRating({ stars, count, quote, atFrame, lengthFrames }: { stars: number; count?: number; quote?: string; atFrame: number; lengthFrames: number }) {
  const b = useBrand();
  const { frame, fpb } = useBeat();
  const f = frame - atFrame;
  const per = Math.min(fpb, (lengthFrames - fpb * 1.5) / 5);
  const starColor = b.colors.accent;
  const hasStars = stars > 0;
  const shown = (i: number) => clamp((f - i * per) / 5, 0, 1);
  const n = Math.round(interpolate(f, [0, per * 5], [0, count ?? 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp" }));
  const quoteIn = clamp((f - (hasStars ? per * 3 : 0)) / 8, 0, 1);
  return (
    <div style={{ position: "absolute", left: SAFE.left, width: SAFE_W, top: SLOT_Y.center - (quote ? 380 : 170), display: "flex", flexDirection: "column", alignItems: "center", gap: 36 }}>
      {hasStars && (
        <div style={{ display: "flex", gap: 14 }}>
          {[0, 1, 2, 3, 4].map((i) => {
            const fill = clamp(stars - i, 0, 1) * shown(i);
            return (
              <svg key={i} width={150} height={150} viewBox="0 0 24 24" style={{ transform: `scale(${0.6 + 0.4 * easeOutBack(shown(i), 3)})` }}>
                <defs><linearGradient id={`g${i}`}><stop offset={fill} stopColor={starColor} /><stop offset={fill} stopColor={withAlpha(b.colors.ink, 0.15)} /></linearGradient></defs>
                <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.5 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6L2.5 9.4l6.6-.8z" fill={`url(#g${i})`} stroke={withAlpha(b.colors.ink, 0.3)} strokeWidth={0.4} />
              </svg>
            );
          })}
        </div>
      )}
      {hasStars && (
        <div style={{ fontFamily: fontStack(b.fonts.heading), fontWeight: b.fonts.heading.weight, fontSize: 104, color: b.colors.ink, opacity: shown(0) }}>
          {stars.toFixed(1)}{count ? <span style={{ fontFamily: fontStack(b.fonts.body), fontWeight: 500, fontSize: 52, opacity: 0.75 }}>{`  ·  ${n.toLocaleString("en-US")} reviews`}</span> : null}
        </div>
      )}
      {quote && (
        <div style={{ opacity: quoteIn, transform: `translateY(${(1 - easeOutCubic(quoteIn)) * 30}px)`, textAlign: "center", maxWidth: SAFE_W - 40 }}>
          <div style={{ fontFamily: fontStack(b.fonts.heading), fontSize: 72, lineHeight: 1.15, color: b.colors.ink, fontWeight: Math.min(700, b.fonts.heading.weight) }}>“{quote}”</div>
          <div style={{ fontFamily: fontStack(b.fonts.body), fontSize: 38, marginTop: 22, color: b.colors.ink, opacity: 0.7, letterSpacing: "0.04em", textTransform: "uppercase" }}>— Verified buyer</div>
        </div>
      )}
    </div>
  );
}

export function PriceTag({ text, cy, atFrame }: { text: string; cy: number; atFrame: number }) {
  const b = useBrand();
  const { frame } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const p = easeOutBack(clamp(f / 9, 0, 1), 2);
  return (
    <div style={{ position: "absolute", left: SAFE.left, width: SAFE_W, top: cy - 35, display: "flex", justifyContent: "center" }}>
      <div style={{ fontFamily: fontStack(b.fonts.body), fontWeight: 600, fontSize: 60, color: b.colors.ink, transform: `scale(${p})`, opacity: clamp(f / 3, 0, 1) }}>{text}</div>
    </div>
  );
}

export function FeatureChips({ items, top, rows, size: planned, atFrame }: { items: string[]; top: number; rows: number; size: number; atFrame: number }) {
  const b = useBrand();
  const { frame } = useBeat();
  // Planned size from the shared layout; shrink further only if the real face is wider.
  const natural = items.reduce((s, t) => s + measure(t, `600 ${planned}px ${fontStack(b.fonts.body)}`) + planned * 1.5 + 6, 0) + 12 * (items.length - 1);
  const size = rows === 1 && natural > SAFE_W ? Math.floor(planned * (SAFE_W / natural)) : planned;
  return (
    <div style={{ position: "absolute", left: SAFE.left, width: SAFE_W, top, display: "flex", flexWrap: rows > 1 ? "wrap" : "nowrap", justifyContent: "center", gap: 12 }}>
      {items.map((t, i) => {
        const f = frame - atFrame - i * 3;
        if (f < 0) return <div key={i} style={{ visibility: "hidden", padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.75)}px`, fontSize: size, fontWeight: 600, border: "3px solid transparent", whiteSpace: "nowrap", fontFamily: fontStack(b.fonts.body) }}>{t}</div>;
        const p = easeOutBack(clamp(f / 8, 0, 1), 2.2);
        return (
          <div key={i} style={{ padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.75)}px`, borderRadius: b.radiusPx, border: `3px solid ${withAlpha(b.colors.ink, 0.85)}`, color: b.colors.ink, fontFamily: fontStack(b.fonts.body),
            fontWeight: 600, fontSize: size, whiteSpace: "nowrap", transform: `scale(${p})`, background: withAlpha(b.colors.bg, 0.6) }}>{t}</div>
        );
      })}
    </div>
  );
}

export function Logo({ logo, product, cy, atFrame, maxH = END.logo.h, color }: { logo?: { path: string; width: number; height: number } | null; product: { brand: string }; cy: number; atFrame: number; maxH?: number; color?: string }) {
  const b = useBrand();
  const { frame } = useBeat();
  const f = frame - atFrame;
  if (f < 0) return null;
  const op = clamp(f / 8, 0, 1);
  if (logo) {
    const h = Math.min(maxH, 360 * (logo.height / logo.width));
    const w = h * (logo.width / logo.height);
    return <Img src={b.url(logo.path)} style={{ position: "absolute", left: CX - w / 2, top: cy - h / 2, width: w, height: h, opacity: op, objectFit: "contain" }} />;
  }
  return (
    <div style={{ position: "absolute", left: SAFE.left, width: SAFE_W, top: cy - 40, textAlign: "center", fontFamily: fontStack(b.fonts.heading), fontWeight: b.fonts.heading.weight, fontSize: 64, lineHeight: 1.2,
      letterSpacing: `${Math.max(0.02, b.fonts.heading.letterSpacing)}em`, color: color ?? b.colors.ink, opacity: op, textTransform: b.fonts.heading.textTransform }}>{product.brand}</div>
  );
}

// ---------- transitions (scene-local frame) ----------
export function Flash({ frames = fr(150) }: { frames?: number }) {
  const { frame } = useBeat();
  if (frame >= frames) return null;
  return <AbsoluteFill style={{ background: "#ffffff", opacity: 1 - easeOutCubic(frame / frames) }} />;
}
export function transitionStyle(kind: string, frame: number): React.CSSProperties {
  if (kind === "whip") {
    const p = clamp(frame / 7, 0, 1);
    return { transform: `translateX(${(1 - easeOutCubic(p)) * 700}px) skewX(${(1 - p) * -12}deg)`, filter: p < 1 ? `blur(${(1 - p) * 24}px)` : undefined };
  }
  if (kind === "zoomThrough") {
    const p = clamp(frame / 9, 0, 1);
    return { transform: `scale(${1.35 - 0.35 * easeOutCubic(p)})`, filter: p < 1 ? `blur(${(1 - p) * 18}px)` : undefined };
  }
  return {};
}
/** Drop-in with overshoot for cards. */
export function dropIn(frame: number) {
  const p = clamp(frame / 14, 0, 1);
  const y = (1 - easeOutBack(p, 1.6)) * -1300;
  return { transform: `translateY(${y}px) rotate(${(1 - p) * -4}deg)` };
}
export const breathe = (beat: number) => 1 + 0.004 * Math.sin(beat * Math.PI);
export const sweep = (t: number) => easeInOutSine(clamp(t, 0, 1));
