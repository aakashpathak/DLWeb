// The director: turns a CreativePlan (words + image choices) into a timed,
// positioned Storyboard. All timing is in beats and all coordinates come from
// the image analysis boxes, never from the model.
import { contrast, contrastL, ensureContrast, lumOf, readableOn, colorDistance } from "./color";
import { cameraAt, makeProjector, rectsOverlap, rectInside, safeRect, visibleRegion, boxInside, SAFE, type Rect } from "./geometry";
import { fitChips, imageRect, overlayRect, stickerRect } from "./layout";
import type { CreativePlan } from "./plan";
import type { AnalyzedAsset, BrandKit, Box, Layout, Overlay, Product, SafePos, Scene, Storyboard } from "./schema";

export type DirectorCtx = { product: Product; kit: BrandKit; assets: AnalyzedAsset[] };
export type TrackInfo = { id: string; bpm: number; offsetSec?: number };

export const totalBeats = (bpm: number) => (29 * bpm) / 60;
export const beatsPerSec = (bpm: number) => bpm / 60;

// ---------- beat map ----------
export function beatMap(bpm: number, hasProof: boolean) {
  const bps = beatsPerSec(bpm);
  const total = totalBeats(bpm);
  const bar = (t: number) => Math.max(4, Math.round((t * bps) / 4) * 4);
  const beat = (t: number) => Math.round(t * bps);
  const reveal = bar(2.5) > 3.2 * bps ? 4 : bar(2.5); // hook never longer than ~3s
  const benefits = Math.max(reveal + Math.round(2.6 * bps), beat(6));
  let cta = Math.floor((total - 4.6 * bps) / 4) * 4; // end card holds >= 4.6s
  cta = Math.min(cta, bar(24));
  let recap = cta - Math.max(4, Math.min(5, Math.round(2.6 * bps)));
  if (Math.abs(recap - bar(21)) <= 1 && recap % 4 !== 0 && cta - bar(21) >= 4 && cta - bar(21) <= 6) recap = bar(21);
  const proof = hasProof ? recap - Math.max(4, Math.round(3.4 * bps)) : recap;
  return { reveal, benefits, proof, recap, cta, total };
}

// ---------- helpers ----------
const byId = (ctx: DirectorCtx) => new Map(ctx.assets.map((a) => [a.id, a]));
let sceneSeq = 0;
const sid = (role: string) => `${role}-${(++sceneSeq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function isLocked(scene: Pick<Scene, "camera">) {
  return scene.camera.move === "static" && scene.camera.fromScale === 1 && scene.camera.toScale === 1;
}

/** Areas text must not cover, in frame pixels, unioned across the camera move. */
export function obstacles(scene: Scene, asset?: AnalyzedAsset): Rect[] {
  if (!asset || scene.layout === "textOnly" || scene.layout === "endCard" || scene.layout === "montage") return [];
  const ir = imageRect(scene.layout, asset);
  if (scene.layout === "card" || scene.layout === "split") return [ir];
  const out: Rect[] = [];
  const a = asset.analysis;
  const boxes: Box[] = [...(a.subjectBox ? [a.subjectBox] : []), ...a.faceBoxes, ...(a.disclaimer ? [a.disclaimer] : [])];
  for (const t of [0, 0.5, 1]) {
    const pr = makeProjector(asset.width, asset.height, ir.w, ir.h, scene.camera.origin, cameraAt(scene, t, 1, 0));
    for (const b of boxes) {
      const r = pr.box(b);
      out.push({ x: r.x + ir.x, y: r.y + ir.y, w: r.w, h: r.h });
    }
  }
  return out;
}

/** Luminance samples (p10, p90) of the image under a frame rect. Null if no image behind it. */
export function backdropLuma(scene: Scene, asset: AnalyzedAsset | undefined, rect: Rect): { lo: number; hi: number } | null {
  if (!asset || !asset.analysis.lumaGrid.length) return null;
  if (scene.layout !== "fullBleed" && scene.layout !== "montage") {
    const ir = imageRect(scene.layout, asset);
    if (!rectsOverlap(rect, ir)) return null;
  }
  const ir = imageRect(scene.layout === "montage" ? "fullBleed" : scene.layout, asset);
  const g = asset.analysis.lumaGrid, n = Math.round(Math.sqrt(g.length));
  const vals: number[] = [];
  const pr = makeProjector(asset.width, asset.height, ir.w, ir.h, scene.camera.origin, cameraAt(scene, 0.5, 1, 0));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = pr.pt((i + 0.5) / n, (j + 0.5) / n);
    const x = p.x + ir.x, y = p.y + ir.y;
    if (x >= rect.x - 40 && x <= rect.x + rect.w + 40 && y >= rect.y - 40 && y <= rect.y + rect.h + 40) vals.push(g[j * n + i]);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return { lo: vals[Math.floor(vals.length * 0.1)], hi: vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))] };
}

/** Background colour behind non-image text. */
export const sceneBg = (scene: Scene, kit: BrandKit) => scene.bg ?? kit.colors.bg;

/** Decide text colour / plate for a slam line so it passes AA (3:1 large text, aim 4.5). */
export function resolveTextColor(scene: Scene, ov: Extract<Overlay, { kind: "slamText" }>, asset: AnalyzedAsset | undefined, kit: BrandKit): { color: string; plate: boolean; plateColor?: string } {
  const rect = overlayRect({ ...ov, plate: false }, scene)!;
  const luma = backdropLuma(scene, asset, rect);
  if (!luma) {
    const bg = sceneBg(scene, kit);
    const want = ov.style === "accent" ? kit.colors.primary : kit.colors.ink;
    const c = contrast(want, bg) >= 3 ? want : ensureContrast(kit.colors.ink, bg, 4.5);
    return { color: c, plate: false, plateColor: undefined };
  }
  // white text against the brightest 10% / ink against the darkest 10%
  const white = contrastL(1, luma.hi), dark = contrastL(lumOf(kit.colors.ink), luma.lo);
  if (scene.role !== "hook") {
    if (white >= 4.5 && white >= dark) return { color: "#ffffff", plate: false };
    if (dark >= 4.5) return { color: kit.colors.ink, plate: false };
  }
  // Busy or mid-tone backdrop (and always for the hook): a brand plate.
  const plateBg = ov.style === "accent" || scene.role === "hook" ? kit.colors.primary : kit.colors.bg;
  return { color: plateBg === kit.colors.primary ? onPrimary(kit) : ensureContrast(kit.colors.ink, plateBg, 4.5), plate: true, plateColor: plateBg };
}

const SLOT_ORDER: Record<Layout, SafePos[]> = {
  fullBleed: ["upper", "top", "lower", "bottom", "center"],
  card: ["top", "bottom"],
  split: ["lower", "bottom"],
  textOnly: ["center", "upper", "lower"],
  montage: ["lower", "upper", "center"],
  endCard: ["center"],
  pageScroll: ["top", "bottom"],
};

function fitNudge(r: Rect): [number, number] {
  let dy = 0;
  if (r.y < SAFE.top) dy = SAFE.top - r.y + 4;
  if (r.y + r.h > SAFE.bottom) dy = SAFE.bottom - (r.y + r.h) - 4;
  return [0, Math.round(dy)];
}

/**
 * Positions every text overlay in a scene: inside safe zones, off the subject
 * and faces, not on top of each other, readable. Mutates and returns scene.
 */
export function placeText(scene: Scene, asset: AnalyzedAsset | undefined, kit: BrandKit): Scene {
  if (scene.layout === "endCard") return scene;
  const obs = obstacles(scene, asset);
  const taken: Rect[] = [];
  const order = SLOT_ORDER[scene.layout];
  const free = (r: Rect) => rectInside(r, safeRect()) && !obs.some((o) => rectsOverlap(r, o, 12)) && !taken.some((t) => rectsOverlap(r, t, 16));
  const textOvs = scene.overlays.filter((o) => o.kind === "slamText" || o.kind === "pill") as Extract<Overlay, { kind: "slamText" | "pill" }>[];
  // Overlays the user positioned by hand stay put; everything else flows around them.
  for (const ov of textOvs) if (ov.pinned) {
    if (ov.kind === "slamText") { const c = resolveTextColor(scene, ov, asset, kit); ov.color = c.color; ov.plate = c.plate; ov.plateColor = c.plateColor; }
    taken.push(overlayRect(ov, scene)!);
  }
  for (const ov of textOvs) {
    if (ov.pinned) continue;
    let placed = false;
    // Try preferred slot first, then the rest; nudge each into the safe zone.
    const prefs = [ov.position, ...order.filter((s) => s !== ov.position), ...(["top", "upper", "center", "lower", "bottom"] as SafePos[])];
    for (const slot of prefs) {
      ov.position = slot;
      ov.nudge = undefined;
      if (ov.kind === "slamText") Object.assign(ov, resolveTextColor(scene, ov, asset, kit));
      let r = overlayRect(ov, scene)!;
      const n = fitNudge(r);
      if (n[1]) { ov.nudge = n; r = overlayRect(ov, scene)!; }
      if (free(r)) { taken.push(r); placed = true; break; }
    }
    if (!placed) {
      // Last resort: keep the first preference on a plate; QA reports it.
      ov.position = prefs[0];
      if (ov.kind === "slamText") { ov.plate = true; }
      const r = overlayRect(ov, scene)!;
      const n = fitNudge(r); ov.nudge = n[1] ? n : undefined;
      taken.push(overlayRect(ov, scene)!);
    }
  }
  return scene;
}

// ---------- camera ----------
export function cameraFor(asset: AnalyzedAsset, layout: Layout, role: Scene["role"], variant = 0): Scene["camera"] {
  const a = asset.analysis;
  const origin: [number, number] = a.subjectBox && a.type === "packshot"
    ? [a.subjectBox.x + a.subjectBox.w / 2, a.subjectBox.y + a.subjectBox.h / 2]
    : a.focalPoint;
  let cam: Scene["camera"];
  const frame = packshotScale(asset, layout);
  if (frame > 1) cam = { move: "pushIn", origin, fromScale: frame, toScale: frame * 1.05 };
  else if (role === "hook") cam = { move: "punch", origin, fromScale: 1.0, toScale: 1.08 };
  else if (layout === "card") cam = { move: "pushIn", origin, fromScale: 1.0, toScale: 1.04 };
  else if (variant % 3 === 2 && asset.width / asset.height > 0.75 && layout === "fullBleed") cam = { move: variant % 2 ? "panLeft" : "panRight", origin, fromScale: 1.08, toScale: 1.08 };
  else if (variant % 4 === 3) cam = { move: "pullOut", origin, fromScale: 1.06, toScale: 1.0 };
  else cam = { move: "pushIn", origin, fromScale: 1.0, toScale: 1.06 };
  return protectText(asset, layout, cam);
}

/** Packshots on a plain backdrop are framed to the product (≈78% of the card), not the empty backdrop. */
export function packshotScale(asset: AnalyzedAsset, layout: Layout) {
  const a = asset.analysis;
  if (a.type !== "packshot" || !a.subjectBox || a.textBoxes.length || (layout !== "card" && layout !== "endCard")) return 1;
  const s = Math.min((layout === "endCard" ? 0.9 : 0.84) / a.subjectBox.h, 0.9 / a.subjectBox.w, 2.4);
  return Math.max(1, +s.toFixed(3));
}

/** Rule 1: never crop baked-in text. Limits zoom (and the beat bump) to what keeps every text box in frame. */
export function protectText(asset: AnalyzedAsset, layout: Layout, cam: Scene["camera"]): Scene["camera"] {
  const a = asset.analysis;
  const keep = [...a.textBoxes, ...(a.disclaimer ? [a.disclaimer] : [])];
  if (!keep.length && a.type !== "infographic") return cam;
  const ir = imageRect(layout, asset);
  const ok = (c: Scene["camera"]) => [0, 0.5, 1].every((t) => {
    const vis = visibleRegion(asset.width, asset.height, c.origin, cameraAt({ camera: c }, t, 0, 0), ir.w, ir.h);
    const bump = { ...vis, x: vis.x + 0.006, y: vis.y + 0.006, w: vis.w - 0.012, h: vis.h - 0.012 };
    return keep.every((b) => boxInside(b, bump));
  });
  const capped = a.type === "infographic" ? { ...cam, fromScale: Math.min(cam.fromScale, 1.05), toScale: Math.min(cam.toScale, 1.05) } : cam;
  if (ok(capped)) return capped;
  // Re-centre on the text and try gentler moves.
  const u = unionBox(keep);
  const centred: [number, number] = [u.x + u.w / 2, u.y + u.h / 2];
  for (const s of [1.04, 1.02]) {
    const c = { move: "pushIn" as const, origin: centred, fromScale: 1, toScale: s };
    if (ok(c)) return c;
  }
  return { move: "static", origin: centred, fromScale: 1, toScale: 1 };
}

export function unionBox(bs: Box[]): Box {
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Can this image go full bleed without losing baked-in text or resolution? */
export function fullBleedOk(asset: AnalyzedAsset) {
  const a = asset.analysis;
  if (a.lowRes || a.type === "lowvalue") return false;
  const keep = [...a.textBoxes, ...(a.disclaimer ? [a.disclaimer] : [])];
  if (keep.length || a.type === "infographic") {
    const vis = visibleRegion(asset.width, asset.height, a.focalPoint, { scale: 1, panX: 0 });
    if (!keep.every((b) => boxInside(b, vis))) return false;
  }
  // Very wide images crop too much of the product in 9:16
  if (a.subjectBox) {
    const vis = visibleRegion(asset.width, asset.height, [a.subjectBox.x + a.subjectBox.w / 2, a.subjectBox.y + a.subjectBox.h / 2], { scale: 1.06, panX: 0 });
    if (a.subjectBox.w > vis.w * 1.05) return false;
  }
  // Packshots on a plain backdrop read better as a card on the brand colour
  return a.type !== "packshot";
}

function chooseLayout(asset: AnalyzedAsset | undefined, prefer: Layout, i: number): Layout {
  if (!asset) return "textOnly";
  if (prefer === "fullBleed" && !fullBleedOk(asset)) return i % 2 ? "split" : "card";
  if (prefer === "split" && asset.analysis.lowRes) return "card";
  if (prefer === "split") {
    // split crops to 1080x1100; protect text
    const keep = [...asset.analysis.textBoxes, ...(asset.analysis.disclaimer ? [asset.analysis.disclaimer] : [])];
    const vis = visibleRegion(asset.width, asset.height, asset.analysis.focalPoint, { scale: 1, panX: 0 }, 1080, 1100);
    if (keep.length && !keep.every((b) => boxInside(b, vis))) return "card";
  }
  return prefer;
}

// ---------- build ----------
export function buildStoryboard(ctx: DirectorCtx, plan: CreativePlan, track: TrackInfo): Storyboard {
  const { product, kit } = ctx;
  const assets = byId(ctx);
  const usable = (id: string | null | undefined) => (id && assets.has(id) ? assets.get(id)! : undefined);
  const hasProof = plan.proof.kind !== "none" && (product.rating != null || !!plan.proof.quote);
  const bm = beatMap(track.bpm, hasProof);
  const scenes: Scene[] = [];
  const altBg = kit.energy >= 4 || kit.tone === "playful-bold";

  // --- hook ---
  const hookAsset = usable(plan.hook.assetId) ?? pickHero(ctx, ["lifestyle", "model", "ugc", "detail"]);
  const hookLayout: Layout = hookAsset && fullBleedOk(hookAsset) ? "fullBleed" : hookAsset ? "card" : "textOnly";
  const hookText = plan.hook.lines.join(" ").split(/\s+/).slice(0, 6).join(" ");
  scenes.push({
    id: sid("hook"), role: "hook", startBeat: 0, lengthBeats: bm.reveal, layout: hookLayout,
    assetId: hookAsset?.id, bg: hookLayout !== "fullBleed" ? kit.colors.primary : undefined,
    camera: hookAsset ? cameraFor(hookAsset, hookLayout, "hook") : still(),
    overlays: [{ kind: "slamText", text: hookText, atBeat: 0, position: "upper", style: "headline" }],
    transitionIn: "cut",
    sfx: [{ name: "whoosh", atBeat: 0 }, { name: "click", atBeat: 1 }],
    sourceRefs: plan.hook.sourceRefs.length ? plan.hook.sourceRefs : ["title"],
  });

  // --- reveal ---
  const revealAsset = usable(plan.reveal.assetId) ?? pickHero(ctx, ["packshot", "detail", "lifestyle"]);
  const nameText = plan.reveal.nameLines.join(" ").split(/\s+/).slice(0, 6).join(" ");
  scenes.push({
    id: sid("reveal"), role: "reveal", startBeat: bm.reveal, lengthBeats: bm.benefits - bm.reveal,
    layout: revealAsset ? "card" : "textOnly", assetId: revealAsset?.id, bg: kit.colors.bg,
    camera: revealAsset ? cameraFor(revealAsset, "card", "reveal") : still(),
    overlays: [{ kind: "slamText", text: nameText, atBeat: 1, position: "top", style: "headline" }],
    transitionIn: "dropIn",
    sfx: [{ name: "impact", atBeat: 0 }],
    sourceRefs: ["title", ...plan.reveal.sourceRefs],
  });

  // --- benefits (+ colour swap) ---
  let benefits = plan.benefits.slice(0, hasProof ? 3 : 4);
  const variantImgs = colourSwapAssets(ctx);
  const doSwap = plan.colorSwap && variantImgs.length >= 3;
  const span = bm.proof - bm.benefits - (doSwap ? 4 : 0);
  if (benefits.length > 3 && span / benefits.length < 2.4 * beatsPerSec(track.bpm)) benefits = benefits.slice(0, 3);
  const lens = splitBeats(span, Math.max(1, benefits.length));
  let at = bm.benefits;
  const prefs: Layout[] = ["fullBleed", "card", "fullBleed", "split"];
  const transitions: Scene["transitionIn"][] = ["flash", "whip", "zoomThrough", "cut"];
  benefits.forEach((b, i) => {
    const asset = usable(b.assetId);
    const layout = chooseLayout(asset, prefs[i % prefs.length], i);
    const overlays: Overlay[] = [{ kind: "slamText", text: b.headline, atBeat: 0, position: "upper", style: "headline" }];
    if (b.pill) overlays.push({ kind: "pill", text: b.pill, atBeat: Math.min(2, lens[i] - 2), position: "lower" });
    const sfx: Scene["sfx"] = [];
    if (asset) addHighlight(overlays, sfx, b, asset, Math.min(lens[i] - 1.5, 2.5));
    if (b.effect === "flicker") { overlays.push({ kind: "flicker", atBeat: 1 }); sfx.push({ name: "switch", atBeat: 1 }); }
    if (b.effect === "ripple" && asset) {
      const box = findDetail(asset, b.highlight.detailLabel) ?? asset.analysis.subjectBox;
      if (box) overlays.push({ kind: "ripple", at: [box.x + box.w / 2, box.y + box.h / 2], atBeat: 1 });
    }
    if (i === 0) sfx.push({ name: "whoosh", atBeat: 0 });
    if (b.pill) sfx.push({ name: "click", atBeat: Math.min(2, lens[i] - 2) });
    const sc: Scene = {
      id: sid("benefit"), role: "benefit", startBeat: at, lengthBeats: lens[i], layout,
      assetId: asset?.id, bg: altBg && i % 2 === 1 ? kit.colors.primary : kit.colors.bg,
      camera: asset ? cameraFor(asset, layout, "benefit", i) : still(),
      overlays, transitionIn: layout === "fullBleed" && transitions[i % 4] === "zoomThrough" ? "zoomThrough" : transitions[i % 4],
      sfx, sourceRefs: b.sourceRefs,
    };
    scenes.push(sc);
    at += lens[i];
  });
  if (doSwap) {
    scenes.push({
      id: sid("benefit"), role: "benefit", startBeat: at, lengthBeats: 4, layout: "montage",
      montage: variantImgs.slice(0, 4).map((v) => ({ assetId: v.asset.id, label: v.name })),
      camera: still(), overlays: [{ kind: "pill", text: `${product.variants.length} colours`, atBeat: 0, position: "top" }],
      transitionIn: "cut", sfx: [0, 1, 2, 3].map((b) => ({ name: "click", atBeat: b })), sourceRefs: ["variants"],
      bg: kit.colors.bg,
    });
    at += 4;
  }

  // --- proof ---
  if (hasProof) {
    const overlays: Overlay[] = [];
    const quote = plan.proof.quote ? trimWords(plan.proof.quote, 10) : undefined;
    overlays.push({ kind: "rating", stars: product.rating ?? 0, count: product.reviewCount, atBeat: 0, quote });
    scenes.push({
      id: sid("proof"), role: "proof", startBeat: bm.proof, lengthBeats: bm.recap - bm.proof, layout: "textOnly",
      assetId: undefined, bg: kit.colors.bg, camera: still(),
      overlays, transitionIn: "cut",
      sfx: [{ name: "chime", atBeat: 0 }, ...[1, 2, 3].map((b) => ({ name: "pop", atBeat: b * 0.5 }))],
      sourceRefs: [...(product.rating != null ? ["rating", "reviewCount"] : []), ...plan.proof.sourceRefs],
    });
  }

  // --- recap ---
  const cuts = Math.round(bm.cta - bm.recap);
  const recapItems = plan.recap.filter((r) => usable(r.assetId)).slice(0, cuts);
  while (recapItems.length < cuts && ctx.assets.length) {
    const fill = ctx.assets.filter((a) => a.analysis.type !== "lowvalue")[recapItems.length % Math.max(1, ctx.assets.filter((a) => a.analysis.type !== "lowvalue").length)];
    if (!fill) break;
    recapItems.push({ assetId: fill.id, label: plan.benefits[recapItems.length % Math.max(1, plan.benefits.length)]?.headline.split(" ").slice(0, 2).join(" ") ?? "" });
  }
  scenes.push({
    id: sid("recap"), role: "recap", startBeat: bm.recap, lengthBeats: bm.cta - bm.recap, layout: recapItems.length ? "montage" : "textOnly",
    montage: recapItems.map((r) => ({ assetId: r.assetId, label: trimWords(r.label, 3) })),
    camera: still(), overlays: [], transitionIn: "flash", bg: kit.colors.primary,
    sfx: recapItems.map((_, i) => ({ name: "impact", atBeat: i })),
    sourceRefs: ["benefits"],
  });
  placeMontageLabels(scenes[scenes.length - 1], ctx);

  // --- CTA ---
  const ctaAsset = usable(plan.cta.assetId) ?? pickHero(ctx, ["packshot", "detail", "lifestyle"]);
  const ctaOverlays: Overlay[] = [
    { kind: "logo", atBeat: 0 },
    { kind: "slamText", text: shortName(product.title, product.brand), atBeat: 0.5, position: "center", style: "accent", color: ensureContrast(kit.colors.ink, kit.colors.bg, 4.5) },
  ];
  if (product.price) ctaOverlays.push({ kind: "price", text: product.price, atBeat: 1.5 });
  ctaOverlays.push({ kind: "chips", items: fitChips(plan.cta.chips.map((c) => trimWords(c, 3))), atBeat: 2 });
  ctaOverlays.push({ kind: "cta", text: plan.cta.ctaText || kit.ctaText || "Shop now", atBeat: 3 });
  scenes.push({
    id: sid("cta"), role: "cta", startBeat: bm.cta, lengthBeats: bm.total - bm.cta, layout: "endCard",
    assetId: ctaAsset?.id, bg: kit.colors.bg, camera: { move: "static", origin: [0.5, 0.5], fromScale: 1, toScale: 1 },
    overlays: ctaOverlays, transitionIn: "flash",
    sfx: [{ name: "sparkle", atBeat: 0 }, { name: "pop", atBeat: 2 }, { name: "pop", atBeat: 3 }],
    sourceRefs: ["title", ...(product.price ? ["price"] : []), ...plan.cta.sourceRefs],
  });

  const sb: Storyboard = {
    durationSec: 29, fps: 30, width: 1080, height: 1920, bpm: track.bpm, musicTrackId: track.id,
    beatOffsetSec: track.offsetSec ?? 0, scenes, voiceover: false,
  };
  return finalize(sb, ctx);
}

/** Recompute start beats from order + lengths, stretch the last scene to 29s, re-place text. */
export function finalize(sb: Storyboard, ctx: DirectorCtx): Storyboard {
  const assets = byId(ctx);
  let at = 0;
  const total = totalBeats(sb.bpm);
  sb.scenes.forEach((s, i) => {
    s.startBeat = at;
    if (i === sb.scenes.length - 1) s.lengthBeats = Math.max(1, total - at);
    at += s.lengthBeats;
  });
  for (const s of sb.scenes) {
    const a = s.assetId ? assets.get(s.assetId) : undefined;
    if (a && s.layout !== "textOnly" && s.layout !== "endCard" && s.layout !== "montage") s.camera = protectText(a, s.layout, s.camera);
    placeText(s, a, ctx.kit);
    if (s.layout === "montage") placeMontageLabels(s, ctx);
  }
  return sb;
}

function placeMontageLabels(s: Scene, ctx: DirectorCtx) {
  if (!s.montage) return;
  const assets = byId(ctx);
  for (const m of s.montage) {
    const a = assets.get(m.assetId);
    if (!a || !m.label) continue;
    const scene: Scene = { ...s, layout: a.analysis.lowRes ? "card" : "fullBleed", camera: { move: "punch", origin: a.analysis.focalPoint, fromScale: 1.0, toScale: 1.05 }, overlays: [{ kind: "slamText", text: m.label, atBeat: 0, position: m.position ?? "lower", style: "accent", plate: true }] };
    placeText(scene, a, ctx.kit);
    const ov = scene.overlays[0] as Extract<Overlay, { kind: "slamText" }>;
    m.position = ov.position;
  }
}

function addHighlight(overlays: Overlay[], sfx: Scene["sfx"], b: CreativePlan["benefits"][number], asset: AnalyzedAsset, atBeat: number) {
  const box = findDetail(asset, b.highlight.detailLabel) ?? (b.highlight.detailLabel ? null : asset.analysis.subjectBox);
  const kind = b.highlight.kind;
  if (kind === "none") return;
  if (!box) {
    // Rule 6: no box for the claim → pill instead of a ring.
    if (!overlays.some((o) => o.kind === "pill") && b.highlight.stickerText) overlays.push({ kind: "pill", text: b.highlight.stickerText, atBeat, position: "lower" });
    return;
  }
  if (kind === "sticker" && b.highlight.stickerText && !stickerHitsText(box, b.highlight.stickerText, asset)) {
    overlays.push({ kind: "sticker", text: trimWords(b.highlight.stickerText, 3), atBeat, anchorBox: box, rotateDeg: -6 });
    sfx.push({ name: "pop", atBeat });
  } else if (kind === "arrow") {
    overlays.push({ kind: "highlightRing", box, atBeat, label: b.highlight.detailLabel ?? undefined });
    sfx.push({ name: "sparkle", atBeat });
  } else {
    overlays.push({ kind: "highlightRing", box, atBeat, label: b.highlight.detailLabel ?? undefined });
    sfx.push({ name: "sparkle", atBeat });
  }
}

/** A sticker must never cover baked-in text or disclaimers (checked in image space, full-bleed approximation). */
export function stickerHitsText(anchor: Box, text: string, asset: AnalyzedAsset) {
  const keep = [...asset.analysis.textBoxes, ...(asset.analysis.disclaimer ? [asset.analysis.disclaimer] : [])];
  if (!keep.length) return false;
  const W0 = 1000, H0 = 1000 * (asset.height / asset.width);
  const r = stickerRect({ x: anchor.x * W0, y: anchor.y * H0, w: anchor.w * W0, h: anchor.h * H0 }, text);
  return keep.some((k) => rectsOverlap(r, { x: k.x * W0, y: k.y * H0, w: k.w * W0, h: k.h * H0 }));
}

export function findDetail(asset: AnalyzedAsset, label: string | null | undefined): Box | null {
  if (!label) return null;
  const l = label.toLowerCase();
  const d = asset.analysis.details.find((x) => x.label.toLowerCase() === l) ?? asset.analysis.details.find((x) => x.label.toLowerCase().includes(l) || l.includes(x.label.toLowerCase()));
  return d?.box ?? null;
}

function pickHero(ctx: DirectorCtx, types: string[], avoid: Scene[] = []): AnalyzedAsset | undefined {
  const used = new Set(avoid.map((s) => s.assetId));
  const pool = ctx.assets.filter((a) => a.analysis.type !== "lowvalue" && a.kind !== "screenshot");
  for (const t of types) {
    const c = pool.filter((a) => a.analysis.type === t && !used.has(a.id)).sort((a, b) => b.analysis.quality - a.analysis.quality)[0];
    if (c) return c;
  }
  return pool.sort((a, b) => b.analysis.quality - a.analysis.quality)[0];
}

function colourSwapAssets(ctx: DirectorCtx) {
  const assets = byId(ctx);
  const out: { name: string; asset: AnalyzedAsset }[] = [];
  for (const v of ctx.product.variants) {
    const a = v.imageIds.map((id) => assets.get(id)).find(Boolean);
    if (a && !out.some((o) => o.asset.id === a.id)) out.push({ name: trimWords(v.name, 2), asset: a });
  }
  return out;
}

export function splitBeats(total: number, n: number) {
  const base = Math.floor(total / n), out = new Array(n).fill(base);
  let rem = total - base * n;
  for (let i = n - 1; rem > 0; i--, rem--) out[(i + n) % n] += 1;
  return out;
}

const still = (): Scene["camera"] => ({ move: "static", origin: [0.5, 0.5], fromScale: 1, toScale: 1 });

export function trimWords(s: string, n: number) {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ").replace(/[,;:\-–—]+$/, "");
}

export function shortName(title: string, brand?: string) {
  let t = title.split(/\s[|\-–—]\s|\s\(|,/)[0].trim();
  if (brand && t.toLowerCase().startsWith(brand.toLowerCase() + " ") && t.split(" ").length > 3) t = t.slice(brand.length).trim();
  return trimWords(t, 5);
}

/** Colour for text on the brand's primary (pills, CTA). */
export const onPrimary = (kit: BrandKit) => (contrast(kit.colors.onPrimary, kit.colors.primary) >= 3 ? kit.colors.onPrimary : readableOn(kit.colors.primary));
export const bgIsPackshotBg = (asset: AnalyzedAsset, bg: string) => !!asset.analysis.bgColor && colorDistance(asset.analysis.bgColor, bg) < 24;
