import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, useCurrentFrame } from "remotion";
import { colorDistance } from "../lib/color";
import { cameraAt, clamp, easeOutCubic, makeProjector, SLOT_Y, TOTAL_FRAMES, type Rect } from "../lib/geometry";
import { END, endCardLayout, imageRect } from "../lib/layout";
import { isLocked, packshotScale } from "../lib/director";
import type { AnalyzedAsset, Overlay, Scene } from "../lib/schema";
import { BrandProvider, ClockProvider, FontLoader, useBeat, useBrand, type ReelProps } from "./context";
import {
  Arrow, Backdrop, breathe, dropIn, FeatureChips, Flash, FramedImage, HighlightRing, LightsOffFlicker, Logo, Pill, PriceTag, Ripple,
  SlamText, StarRating, Sticker, transitionStyle,
} from "./components/motion";

const SFX_GAIN: Record<string, number> = { impact: 0.5, whoosh: 0.45, pop: 0.5, click: 0.35, chime: 0.35, sparkle: 0.3, riser: 0.4, switch: 0.5, shutter: 0.45 };

export const Reel: React.FC<ReelProps> = (props) => {
  const { storyboard: sb, kit, assetBase } = props;
  const fpb = (30 * 60) / sb.bpm;
  const f = (beats: number) => Math.round(beats * fpb);
  const assets = new Map(props.assets.map((a) => [a.id, a]));
  const sfxUrl = (n: string) => `${assetBase}/api/files/sfx/${n}.wav`;
  return (
    <BrandProvider kit={kit} assetBase={assetBase}>
      <ClockProvider bpm={sb.bpm}>
        <FontLoader kit={kit} assetBase={assetBase} />
        <AbsoluteFill style={{ background: kit.colors.bg }}>
          {sb.scenes.map((s, i) => {
            const from = f(s.startBeat);
            const to = i === sb.scenes.length - 1 ? TOTAL_FRAMES : f(s.startBeat + s.lengthBeats);
            return (
              <Sequence key={s.id} from={from} durationInFrames={Math.max(1, to - from)} name={`${s.role}:${s.layout}`}>
                <SceneView scene={s} asset={s.assetId ? assets.get(s.assetId) : undefined} assets={assets} lengthFrames={to - from} props={props} />
              </Sequence>
            );
          })}
          {props.watermark && <Watermark />}
        </AbsoluteFill>
        {props.musicUrl && (
          <Audio src={props.musicUrl} startFrom={Math.round((sb.beatOffsetSec ?? 0) * 30)}
            volume={(fr) => 0.9 * (fr > TOTAL_FRAMES - 24 ? Math.max(0, (TOTAL_FRAMES - fr) / 24) : 1)} />
        )}
        {sb.scenes.flatMap((s) => s.sfx.map((x, k) => {
          const at = f(s.startBeat + x.atBeat);
          if (at >= TOTAL_FRAMES - 2) return null;
          return (
            <Sequence key={`${s.id}-sfx-${k}`} from={at} durationInFrames={Math.min(60, TOTAL_FRAMES - at)} layout="none">
              <Audio src={sfxUrl(x.name)} volume={SFX_GAIN[x.name] ?? 0.4} />
            </Sequence>
          );
        }))}
      </ClockProvider>
    </BrandProvider>
  );
};

function Watermark() {
  return <div style={{ position: "absolute", right: 160, top: 240, color: "rgba(255,255,255,0.7)", fontSize: 34, fontFamily: "Helvetica, Arial", fontWeight: 700, textShadow: "0 2px 8px rgba(0,0,0,0.5)" }}>PREVIEW · ProductClips</div>;
}

type SceneProps = { scene: Scene; asset?: AnalyzedAsset; assets: Map<string, AnalyzedAsset>; lengthFrames: number; props: ReelProps };

function SceneView({ scene, asset, assets, lengthFrames, props }: SceneProps) {
  const frame = useCurrentFrame();
  const b = useBrand();
  const { beatPhase, beat } = useBeat();
  const t = frame / Math.max(1, lengthFrames);
  const bump = isLocked(scene) ? 0 : 0.01;
  const cam = cameraAt(scene, t, beatPhase, bump);
  const bg = scene.bg ?? b.colors.bg;
  const tStyle = transitionStyle(scene.transitionIn, frame);

  let base: React.ReactNode = null;
  let ir: Rect | null = null;
  if (scene.layout === "montage") return <Montage {...{ scene, assets, lengthFrames, props }} />;
  if (scene.layout === "endCard") return <EndCard {...{ scene, asset, lengthFrames, props }} />;

  if (asset && scene.layout === "fullBleed") {
    ir = imageRect("fullBleed", asset);
    base = <FramedImage asset={asset} rect={ir} origin={scene.camera.origin} cam={cam} />;
  } else if (asset && scene.layout === "card") {
    ir = imageRect("card", asset);
    const drop = scene.transitionIn === "dropIn" ? dropIn(frame) : {};
    const wobble = Math.sin(beat * Math.PI) * 0.5;
    base = (
      <>
        <Backdrop color={bg} seed={scene.startBeat} />
        <div style={{ position: "absolute", inset: 0, ...drop }}>
          <div style={{ position: "absolute", inset: 0, transform: `rotate(${wobble}deg) scale(${breathe(beat)})`, transformOrigin: `${ir.x + ir.w / 2}px ${ir.y + ir.h / 2}px` }}>
            <FramedImage asset={asset} rect={ir} origin={scene.camera.origin} cam={cam} radius={b.cardRadius} shadow />
          </div>
        </div>
      </>
    );
  } else if (asset && scene.layout === "split") {
    ir = imageRect("split", asset);
    base = (
      <>
        <AbsoluteFill style={{ background: bg }} />
        <FramedImage asset={asset} rect={ir} origin={scene.camera.origin} cam={cam} />
        <div style={{ position: "absolute", left: 0, top: ir.h - 4, width: 1080 * easeOutCubic(clamp(frame / 10, 0, 1)), height: 8, background: b.colors.accent }} />
      </>
    );
  } else if (scene.layout === "pageScroll" && asset) {
    base = <PageScroll asset={asset} t={t} bg={bg} />;
  } else {
    // textOnly: brand colour, optionally over a soft, dimmed version of the image
    base = (
      <>
        <Backdrop color={bg} seed={scene.startBeat} />
        {asset && (
          <AbsoluteFill style={{ opacity: 0.22, filter: "blur(26px) saturate(1.1)" }}>
            <FramedImage asset={asset} rect={{ x: -60, y: -60, w: 1200, h: 2040 }} origin={scene.camera.origin} cam={cam} />
          </AbsoluteFill>
        )}
      </>
    );
  }

  // Map an analysed box to screen pixels (follows the camera every frame)
  const project = (box: { x: number; y: number; w: number; h: number }): Rect | null => {
    if (!asset || !ir) return null;
    const pr = makeProjector(asset.width, asset.height, ir.w, ir.h, scene.camera.origin, cam);
    const r = pr.box(box);
    const drop = scene.transitionIn === "dropIn" && scene.layout === "card" ? (1 - Math.min(1, frame / 14)) * -1300 : 0;
    return { x: r.x + ir.x, y: r.y + ir.y + drop, w: r.w, h: r.h };
  };

  return (
    <AbsoluteFill style={{ background: bg }}>
      <AbsoluteFill style={tStyle}>
        {base}
        {scene.layout === "fullBleed" && <Scrims scene={scene} />}
        {scene.overlays.map((ov, i) => <OverlayView key={i} ov={ov} scene={scene} project={project} lengthFrames={lengthFrames} />)}
      </AbsoluteFill>
      {(scene.transitionIn === "flash" || scene.transitionIn === "dropIn") && <Flash />}
    </AbsoluteFill>
  );
}

/** Gentle top/bottom scrims on full-bleed shots: helps the platform UI and white text. */
function Scrims({ scene }: { scene: Scene }) {
  const hasTop = scene.overlays.some((o) => "position" in o && (o.position === "top" || o.position === "upper") && !("plate" in o && o.plate));
  const hasBottom = scene.overlays.some((o) => "position" in o && (o.position === "lower" || o.position === "bottom") && !("plate" in o && o.plate));
  return (
    <>
      <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(0,0,0,${hasTop ? 0.38 : 0.18}) 0%, rgba(0,0,0,0) 38%)` }} />
      <AbsoluteFill style={{ background: `linear-gradient(0deg, rgba(0,0,0,${hasBottom ? 0.42 : 0.22}) 0%, rgba(0,0,0,0) 40%)` }} />
    </>
  );
}

function OverlayView({ ov, scene, project, lengthFrames }: { ov: Overlay; scene: Scene; project: (b: { x: number; y: number; w: number; h: number }) => Rect | null; lengthFrames: number }) {
  const { fpb } = useBeat();
  const at = Math.round(ov.atBeat * fpb);
  switch (ov.kind) {
    case "slamText": return <SlamText ov={ov} instant={scene.role === "hook" && ov.atBeat === 0} />;
    case "pill": return <Pill text={ov.text} cy={SLOT_Y[ov.position] + (ov.nudge?.[1] ?? 0)} atFrame={at} />;
    case "sticker": { const r = project(ov.anchorBox); return r ? <Sticker text={ov.text} anchor={r} rotateDeg={ov.rotateDeg} atFrame={at} /> : null; }
    case "highlightRing": { const r = project(ov.box); return r ? <HighlightRing rect={r} atFrame={at} /> : null; }
    case "arrow": return <Arrow from={[ov.from[0] * 1080, ov.from[1] * 1920]} to={[ov.to[0] * 1080, ov.to[1] * 1920]} atFrame={at} />;
    case "rating": return <StarRating stars={ov.stars} count={ov.count} quote={ov.quote} atFrame={at} lengthFrames={lengthFrames} />;
    case "price": return <PriceTag text={ov.text} cy={SLOT_Y.lower} atFrame={at} />;
    case "ripple": { const r = project({ x: ov.at[0], y: ov.at[1], w: 0, h: 0 }); return r ? <Ripple x={r.x} y={r.y} atFrame={at} /> : null; }
    case "flicker": return <LightsOffFlicker atFrame={at} lengthFrames={lengthFrames} />;
    default: return null;
  }
}

// ---------- montage: one cut per beat ----------
function Montage({ scene, assets }: Omit<SceneProps, "asset">) {
  const { fpb } = useBeat();
  const b = useBrand();
  const items = scene.montage ?? [];
  return (
    <AbsoluteFill style={{ background: scene.bg ?? b.colors.primary }}>
      {items.map((m, i) => {
        const a = assets.get(m.assetId);
        const from = Math.round(i * fpb);
        const dur = i === items.length - 1 ? Math.max(1, Math.round(scene.lengthBeats * fpb) - from) : Math.round((i + 1) * fpb) - from;
        if (!a) return null;
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            <MontageCut a={a} label={m.label} position={m.position ?? "lower"} bg={i % 2 ? b.colors.bg : b.colors.primary} isRecap={scene.role === "recap"} />
          </Sequence>
        );
      })}
      {scene.overlays.map((ov, i) => ov.kind === "pill" ? <Pill key={i} text={ov.text} cy={SLOT_Y[ov.position] + (ov.nudge?.[1] ?? 0)} atFrame={0} /> : null)}
      {scene.transitionIn === "flash" && <Flash />}
    </AbsoluteFill>
  );
}

function MontageCut({ a, label, position, bg, isRecap }: { a: AnalyzedAsset; label?: string; position: NonNullable<NonNullable<Scene["montage"]>[number]["position"]>; bg: string; isRecap: boolean }) {
  const frame = useCurrentFrame();
  const b = useBrand();
  const card = a.analysis.lowRes || a.analysis.type === "packshot" || a.analysis.type === "infographic";
  const ps = card ? packshotScale(a, "card") : 1;
  const cam = { scale: card ? 1 + 0.03 * easeOutCubic(clamp(frame / 6, 0, 1)) : 1.0 + 0.05 * easeOutCubic(clamp(frame / 6, 0, 1)), panX: 0 };
  const origin: [number, number] = a.analysis.subjectBox ? [a.analysis.subjectBox.x + a.analysis.subjectBox.w / 2, a.analysis.subjectBox.y + a.analysis.subjectBox.h / 2] : a.analysis.focalPoint;
  const ir = imageRect(card ? "card" : "fullBleed", a);
  return (
    <AbsoluteFill style={{ background: bg }}>
      {card ? <><Backdrop color={bg} /><FramedImage asset={a} rect={ir} origin={origin} cam={{ scale: ps * (1 + 0.03 * easeOutCubic(clamp(frame / 6, 0, 1))), panX: 0 }} radius={b.cardRadius} shadow /></> : <FramedImage asset={a} rect={ir} origin={origin} cam={cam} />}
      {label && <SlamText ov={{ kind: "slamText", text: label, atBeat: 0, position, style: "accent", plate: true, plateColor: b.colors.primary, color: b.onPrimarySafe }} instant={isRecap} />}
    </AbsoluteFill>
  );
}

// ---------- end card ----------
function EndCard({ scene, asset, lengthFrames, props }: { scene: Scene; asset?: AnalyzedAsset; lengthFrames: number; props: ReelProps }) {
  const b = useBrand();
  const frame = useCurrentFrame();
  const { fpb } = useBeat();
  const at = (ov: Overlay) => Math.round(ov.atBeat * fpb);
  const bg = scene.bg ?? b.colors.bg;
  const ir = asset ? imageRect("endCard", asset) : null;
  const blend = asset?.analysis.bgColor ? colorDistance(asset.analysis.bgColor, bg) < 24 : false;
  const float = Math.sin((frame / lengthFrames) * Math.PI * 2) * 12;
  const enter = easeOutCubic(clamp(frame / 12, 0, 1));
  const sweepT = clamp((frame - fpb * 2) / (fpb * 3), 0, 1);
  const name = scene.overlays.find((o) => o.kind === "slamText") as Extract<Overlay, { kind: "slamText" }> | undefined;
  const L = endCardLayout(scene.overlays);
  return (
    <AbsoluteFill>
      <Backdrop color={bg} seed={3} />
      {asset && ir && (
        <div style={{ position: "absolute", inset: 0, transform: `translateY(${float + (1 - enter) * 120}px) scale(${0.92 + 0.08 * enter})`, opacity: enter, transformOrigin: `${ir.x + ir.w / 2}px ${ir.y + ir.h / 2}px` }}>
          <FramedImage asset={asset} rect={ir} origin={asset.analysis.subjectBox ? [asset.analysis.subjectBox.x + asset.analysis.subjectBox.w / 2, asset.analysis.subjectBox.y + asset.analysis.subjectBox.h / 2] : [0.5, 0.5]} cam={{ scale: packshotScale(asset, "endCard"), panX: 0 }} radius={blend ? 0 : b.cardRadius} shadow={!blend} style={blend ? { background: "transparent" } : undefined} />
          {sweepT > 0 && sweepT < 1 && (
            <div style={{ position: "absolute", left: ir.x, top: ir.y, width: ir.w, height: ir.h, overflow: "hidden", borderRadius: blend ? 0 : b.cardRadius, mixBlendMode: "screen" }}>
              <div style={{ position: "absolute", top: -200, left: -400 + (ir.w + 800) * sweepT, width: 180, height: ir.h + 400, transform: "rotate(18deg)", background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.45) 50%, rgba(255,255,255,0) 100%)" }} />
            </div>
          )}
        </div>
      )}
      {scene.overlays.map((ov, i) => {
        switch (ov.kind) {
          case "logo": return <Logo key={i} logo={props.logo} product={props.product} cy={END.logo.cy} atFrame={at(ov)} />;
          case "price": return <PriceTag key={i} text={ov.text} cy={L.priceCy} atFrame={at(ov)} />;
          case "chips": return <FeatureChips key={i} items={ov.items} top={L.chips.top} rows={L.chips.rows} size={L.chips.size} atFrame={at(ov)} />;
          case "cta": return <Pill key={i} text={ov.text} cy={L.ctaCy} atFrame={at(ov)} big pulse />;
          default: return null;
        }
      })}
      {name && <SlamText ov={{ ...name, color: name.color ?? b.colors.ink, plate: false }} cy={L.nameCy} staggerBeats={0.5} />}
      {scene.transitionIn === "flash" && <Flash />}
    </AbsoluteFill>
  );
}

// ---------- page scroll (few-images fallback) ----------
function PageScroll({ asset, t, bg }: { asset: AnalyzedAsset; t: number; bg: string }) {
  const b = useBrand();
  const w = 760, h = 1240;
  const scaled = (asset.height / asset.width) * w;
  const y = -Math.max(0, scaled - h) * easeOutCubic(t);
  return (
    <>
      <Backdrop color={bg} />
      <div style={{ position: "absolute", left: (1080 - w) / 2 - 16, top: 470 - 16, width: w + 32, height: h + 32, borderRadius: 72, background: "#111", boxShadow: "0 40px 90px rgba(0,0,0,0.35)" }}>
        <div style={{ position: "absolute", left: 16, top: 16, width: w, height: h, borderRadius: 58, overflow: "hidden", background: "#fff" }}>
          <Img src={b.url(asset.path)} style={{ width: w, transform: `translateY(${y}px)` }} />
        </div>
      </div>
    </>
  );
}
