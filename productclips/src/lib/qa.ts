// Section 9 QA. Runs before every render and live in the editor. Each issue
// carries an id; autoFix() applies the matching repair deterministically.
import { contrast, contrastL, lumOf } from "./color";
import { cameraAt, rectInside, rectsOverlap, safeRect, visibleRegion, boxInside, TOTAL_FRAMES } from "./geometry";
import { headlineMetrics, imageRect, overlayRect, stickerRect } from "./layout";
import { backdropLuma, finalize, isLocked, obstacles, protectText, sceneBg, stickerHitsText, type DirectorCtx } from "./director";
import type { AnalyzedAsset, Overlay, QaIssue, Scene, Storyboard } from "./schema";

export const framesForBeats = (sb: Pick<Storyboard, "bpm">, beats: number) => Math.round((beats * 60 * 30) / sb.bpm);

const CLAIM_ROLES = new Set<Scene["role"]>(["benefit", "proof", "reveal", "cta"]);

export function runQa(sb: Storyboard, ctx: DirectorCtx): QaIssue[] {
  const issues: QaIssue[] = [];
  const assets = new Map(ctx.assets.map((a) => [a.id, a]));
  const push = (i: Omit<QaIssue, "id">) => issues.push({ id: `${i.sceneId ?? "sb"}:${issues.length}:${i.message.slice(0, 24)}`, ...i });

  // Duration: exactly 29.00s
  const end = sb.scenes.reduce((m, s) => Math.max(m, s.startBeat + s.lengthBeats), 0);
  const endFrames = framesForBeats(sb, end);
  if (Math.abs(endFrames - TOTAL_FRAMES) > 0) push({ severity: "error", message: `Timeline is ${(endFrames / 30).toFixed(2)}s, must be 29.00s`, fix: "Stretch the last scene to 29.00s" });
  let expect = 0;
  for (const s of sb.scenes) { if (Math.abs(s.startBeat - expect) > 1e-6) { push({ severity: "error", sceneId: s.id, message: "Scenes overlap or leave a gap", fix: "Re-time scenes back to back" }); break; } expect += s.lengthBeats; }

  // First 0.5s must have motion or text
  const first = sb.scenes[0];
  if (first && !first.overlays.some((o) => o.kind === "slamText" && o.atBeat * 60 / sb.bpm < 0.5) && first.camera.move === "static")
    push({ severity: "error", sceneId: first.id, message: "Nothing moves or reads in the first 0.5s", fix: "Slam the hook line on beat 0 and punch in" });

  const useCount = new Map<string, number>();
  let flashes = 0;

  for (const s of sb.scenes) {
    const a = s.assetId ? assets.get(s.assetId) : undefined;
    if (s.transitionIn === "flash" || s.transitionIn === "dropIn") flashes++;
    if (s.assetId && s.role !== "recap") useCount.set(s.assetId, (useCount.get(s.assetId) ?? 0) + 1);
    if (s.montage && s.role !== "recap") for (const m of s.montage) useCount.set(m.assetId, (useCount.get(m.assetId) ?? 0) + 1);

    // Low-res full bleed
    if (a && a.analysis.lowRes && (s.layout === "fullBleed" || s.layout === "split"))
      push({ severity: "error", sceneId: s.id, message: `Low-res image (${Math.min(a.width, a.height)}px) shown ${s.layout}`, fix: "Switch to card layout" });
    if (a && Math.max(1080 / a.width, 1920 / a.height) > 1.5 * 1.08 && s.layout === "fullBleed")
      push({ severity: "warn", sceneId: s.id, message: "Image is upscaled more than 1.5x", fix: "Switch to card layout" });

    // Crop of baked-in text
    if (a && s.layout !== "textOnly" && s.layout !== "endCard" && s.layout !== "montage") {
      const keep = [...a.analysis.textBoxes, ...(a.analysis.disclaimer ? [a.analysis.disclaimer] : [])];
      if (keep.length) {
        const ir = imageRect(s.layout, a);
        const bump = isLocked(s) ? 0 : 0.01;
        const cut = [0, 0.5, 1].some((t) => {
          const cam = cameraAt(s, t, 0, 0);
          const vis = visibleRegion(a.width, a.height, s.camera.origin, { ...cam, scale: cam.scale + bump }, ir.w, ir.h);
          return keep.some((b) => !boxInside(b, vis));
        });
        if (cut) push({ severity: "error", sceneId: s.id, message: "Camera crops baked-in text on this image", fix: "Limit zoom so all text stays in frame" });
      }
      if (a.analysis.type === "infographic" && Math.max(s.camera.fromScale, s.camera.toScale) > 1.05 && !keep.length)
        push({ severity: "warn", sceneId: s.id, message: "Infographic zoom above 1.05x", fix: "Limit zoom so all text stays in frame" });
    }

    // Text rules
    const obs = obstacles(s, a);
    const rects: { ov: Overlay; r: ReturnType<typeof overlayRect> }[] = [];
    let words = 0;
    for (const ov of s.overlays) {
      if (ov.kind === "slamText") {
        const m = headlineMetrics(ov.text, ov.style, ov.plate);
        if (m.lines.some((l) => l.split(/\s+/).length > 5)) push({ severity: "error", sceneId: s.id, message: `Slam line over 5 words: "${ov.text}"`, fix: "Shorten text" });
        if (m.lines.length > 2) push({ severity: "error", sceneId: s.id, message: `More than 2 lines on screen: "${ov.text}"`, fix: "Shorten text" });
        words += ov.text.split(/\s+/).length;
      }
      if (ov.kind === "pill") words += ov.text.split(/\s+/).length;
      if (ov.kind === "chips") words += ov.items.join(" ").split(/\s+/).length;
      if (ov.kind === "rating" && ov.quote) {
        words += ov.quote.split(/\s+/).length;
        if (ov.quote.split(/\s+/).length > 10) push({ severity: "error", sceneId: s.id, message: "Review quote over 10 words", fix: "Shorten text" });
      }
      const r = overlayRect(ov, s);
      if (r) {
        rects.push({ ov, r });
        if (!rectInside(r, safeRect())) push({ severity: "error", sceneId: s.id, message: `${label(ov)} is outside the safe zone`, fix: "Re-place text" });
        if (obs.some((o) => rectsOverlap(r, o))) push({ severity: "error", sceneId: s.id, message: `${label(ov)} covers the product or a face`, fix: "Re-place text" });
      }
      if (ov.kind === "sticker" && a) {
        const ir = imageRect(s.layout, a);
        const anchor = { x: ir.x + ov.anchorBox.x * ir.w, y: ir.y + ov.anchorBox.y * ir.h, w: ov.anchorBox.w * ir.w, h: ov.anchorBox.h * ir.h };
        const sr = stickerRect(anchor, ov.text);
        if (!rectInside(sr, safeRect())) push({ severity: "warn", sceneId: s.id, message: "Sticker clipped by safe zone" });
        if (stickerHitsText(ov.anchorBox, ov.text, a)) push({ severity: "error", sceneId: s.id, message: `Sticker "${ov.text}" covers baked-in text`, fix: "Swap sticker for a ring" });
      }
      // Contrast
      if (ov.kind === "slamText") {
        const c = ov.color ?? "#ffffff";
        let ratio: number;
        if (ov.plate) ratio = contrast(c, ov.plateColor ?? (ov.style === "accent" ? ctx.kit.colors.primary : ctx.kit.colors.bg));
        else {
          const l = r ? backdropLuma(s, a, r) : null;
          ratio = l ? Math.min(contrastL(lumOf(c), l.hi), contrastL(lumOf(c), l.lo)) : contrast(c, sceneBg(s, ctx.kit));
          if (l && ov.color === "#ffffff") ratio = contrastL(1, l.hi);
        }
        if (ratio < 3) push({ severity: "error", sceneId: s.id, message: `"${ov.text}" fails AA contrast (${ratio.toFixed(1)}:1)`, fix: "Put text on a brand plate" });
      }
    }
    if (ov2(rects)) push({ severity: "error", sceneId: s.id, message: "Two text elements overlap", fix: "Re-place text" });
    const secs = (s.lengthBeats * 60) / sb.bpm;
    if (s.role !== "cta" && words / Math.max(secs, 0.1) > 3.2 && s.role !== "recap")
      push({ severity: "warn", sceneId: s.id, message: `Reading load ${(words / secs).toFixed(1)} words/s (max ~3)`, fix: "Shorten text" });

    // Claims must be traceable
    if (CLAIM_ROLES.has(s.role) && !s.sourceRefs.length) push({ severity: "error", sceneId: s.id, message: "Claim has no source on the page", fix: undefined });
  }
  for (const [id, n] of useCount) if (n > 2) push({ severity: "error", message: `Image ${id} used in ${n} scenes (max 2)`, fix: undefined });
  if (flashes > 5) push({ severity: "warn", message: `${flashes} flash cuts; keep it to the 4-5 biggest`, fix: "Turn extra flashes into cuts" });
  return issues;
}

function ov2(rs: { r: ReturnType<typeof overlayRect> }[]) {
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].r && rs[j].r && rectsOverlap(rs[i].r!, rs[j].r!)) return true;
  return false;
}
const label = (ov: Overlay) => ("text" in ov ? `"${ov.text}"` : ov.kind);

/** Applies every deterministic fix and re-runs placement. Returns the fixed storyboard + what changed. */
export function autoFix(sb: Storyboard, ctx: DirectorCtx, only?: string): { sb: Storyboard; applied: string[] } {
  const out: Storyboard = JSON.parse(JSON.stringify(sb));
  const applied: string[] = [];
  const assets = new Map(ctx.assets.map((a) => [a.id, a]));
  const issues = runQa(out, ctx).filter((i) => !only || i.id === only);
  for (const i of issues) {
    const s = out.scenes.find((x) => x.id === i.sceneId);
    const a: AnalyzedAsset | undefined = s?.assetId ? assets.get(s.assetId) : undefined;
    switch (i.fix) {
      case "Switch to card layout": if (s) { s.layout = "card"; applied.push(`${s.role}: card layout`); } break;
      case "Limit zoom so all text stays in frame": if (s && a) { s.camera = protectText(a, s.layout, s.camera); applied.push(`${s.role}: zoom limited`); } break;
      case "Shorten text": if (s) { shorten(s); applied.push(`${s.role}: text shortened`); } break;
      case "Swap sticker for a ring": if (s) { s.overlays = s.overlays.map((o) => (o.kind === "sticker" ? { kind: "highlightRing", box: o.anchorBox, atBeat: o.atBeat } : o)); applied.push(`${s.role}: sticker → ring`); } break;
      case "Put text on a brand plate": if (s) { for (const o of s.overlays) if (o.kind === "slamText") o.plate = true; applied.push(`${s.role}: text on plate`); } break;
      case "Slam the hook line on beat 0 and punch in": if (s) { s.camera = { ...s.camera, move: "punch", toScale: Math.max(s.camera.toScale, 1.06) }; const t = s.overlays.find((o) => o.kind === "slamText"); if (t) t.atBeat = 0; applied.push("hook: beat-0 slam"); } break;
      case "Turn extra flashes into cuts": { let n = 0; for (const x of out.scenes) if (x.transitionIn === "flash" && ++n > 4) x.transitionIn = "cut"; applied.push("flashes trimmed"); break; }
      default: break;
    }
  }
  // Re-time + re-place text covers duration, gaps, safe zones and overlaps.
  finalize(out, ctx);
  if (issues.some((i) => i.fix === "Re-place text" || i.fix === "Stretch the last scene to 29.00s" || i.fix === "Re-time scenes back to back")) applied.push("re-timed and re-placed text");
  return { sb: out, applied };
}

function shorten(s: Scene) {
  for (const o of s.overlays) {
    if (o.kind === "slamText") o.text = o.text.split(/\s+/).slice(0, 5).join(" ");
    if (o.kind === "pill") o.text = o.text.split(/\s+/).slice(0, 4).join(" ");
    if (o.kind === "rating" && o.quote) o.quote = o.quote.split(/\s+/).slice(0, 10).join(" ");
  }
}

export const qaBlocking = (issues: QaIssue[]) => issues.filter((i) => i.severity === "error");
