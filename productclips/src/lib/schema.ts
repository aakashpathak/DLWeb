// Shared data contracts. Everything the pipeline writes and the video reads is
// validated against these Zod schemas. Kept free of Node imports so the
// Remotion bundle and the browser can use it too.
import { z } from "zod";

// ---------- geometry ----------
/** Normalized box, 0..1 relative to the source image. */
export const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof Box>;

export const SafePos = z.enum(["top", "upper", "center", "lower", "bottom"]);
export type SafePos = z.infer<typeof SafePos>;

// ---------- product ----------
export const AssetRef = z.object({
  id: z.string(),
  path: z.string(), // storage path, served at /api/files/<path>
  sourceUrl: z.string().optional(),
  width: z.number(),
  height: z.number(),
  kind: z.enum(["image", "screenshot", "logo"]).default("image"),
  mime: z.string().optional(),
});
export type AssetRef = z.infer<typeof AssetRef>;

export const Product = z.object({
  url: z.string(),
  brand: z.string(),
  title: z.string(),
  price: z.string().optional(),
  currency: z.string().optional(),
  rating: z.number().optional(),
  reviewCount: z.number().optional(),
  topReviews: z.array(z.string()).default([]),
  benefits: z.array(z.string()).default([]),
  description: z.string().optional(),
  specs: z.record(z.string(), z.string()).default({}),
  variants: z.array(z.object({ name: z.string(), imageIds: z.array(z.string()) })).default([]),
  ctaText: z.string().optional(),
  language: z.string().default("en"),
  assets: z.array(AssetRef).default([]),
  logo: AssetRef.optional(),
  pageScreenshots: z.array(AssetRef).default([]),
  source: z.enum(["shopify", "jsonld", "meta", "dom", "manual"]).default("dom"),
});
export type Product = z.infer<typeof Product>;

// ---------- brand kit ----------
export const Tone = z.enum(["premium-minimal", "playful-bold", "clean-clinical", "warm-natural", "techy", "luxury"]);
export type Tone = z.infer<typeof Tone>;

export const FontSpec = z.object({
  family: z.string(), // CSS family used in the video (free match)
  serif: z.boolean().default(false),
  sourceFamily: z.string().optional(), // what the page actually used
  weight: z.number().default(700),
  letterSpacing: z.number().default(0), // em
  textTransform: z.enum(["none", "uppercase", "lowercase"]).default("none"),
  files: z.array(z.object({ url: z.string(), weight: z.string(), style: z.string().default("normal"), unicodeRange: z.string().optional() })).default([]),
});
export type FontSpec = z.infer<typeof FontSpec>;

export const BrandKit = z.object({
  colors: z.object({
    bg: z.string(),
    ink: z.string(),
    primary: z.string(),
    onPrimary: z.string(),
    accent: z.string(),
    muted: z.string(),
  }),
  fonts: z.object({ heading: FontSpec, body: FontSpec, button: FontSpec }),
  shape: z.object({
    radius: z.number(), // px at 1440 desktop, CTA button
    style: z.enum(["pill", "rounded", "sharp"]),
    shadow: z.boolean(),
    border: z.boolean(),
  }),
  tone: Tone,
  energy: z.number().min(1).max(5),
  ctaText: z.string().default("Shop now"),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type BrandKit = z.infer<typeof BrandKit>;

// ---------- asset analysis ----------
export const AssetType = z.enum(["packshot", "lifestyle", "infographic", "detail", "ugc", "model", "comparison", "lowvalue"]);
export type AssetType = z.infer<typeof AssetType>;

export const AssetAnalysis = z.object({
  type: AssetType,
  subjectBox: Box.nullable(),
  textBoxes: z.array(Box).default([]),
  faceBoxes: z.array(Box).default([]),
  focalPoint: z.tuple([z.number(), z.number()]),
  featureTags: z.array(z.number()).default([]), // indexes into product.benefits
  details: z.array(z.object({ label: z.string(), box: Box })).default([]), // pinnable parts: lens, sole, button
  quality: z.number(), // 0..1
  lowRes: z.boolean(),
  bgColor: z.string().optional(), // plain backdrop colour for packshots
  lumaGrid: z.array(z.number()).default([]), // 12x12 luminance grid, row-major, 0..1
  disclaimer: Box.nullable().default(null), // "image simulated" etc. must stay visible
  source: z.enum(["claude", "heuristic"]).default("heuristic"),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysis>;

export const AnalyzedAsset = AssetRef.extend({ analysis: AssetAnalysis });
export type AnalyzedAsset = z.infer<typeof AnalyzedAsset>;

// ---------- storyboard ----------
const Beat = z.number();
export const Overlay = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slamText"), text: z.string(), atBeat: Beat, position: SafePos, style: z.enum(["headline", "accent"]), plate: z.boolean().optional(), plateColor: z.string().optional(), color: z.string().optional(), nudge: z.tuple([z.number(), z.number()]).optional(), pinned: z.boolean().optional() }),
  z.object({ kind: z.literal("pill"), text: z.string(), atBeat: Beat, position: SafePos, nudge: z.tuple([z.number(), z.number()]).optional(), pinned: z.boolean().optional() }),
  z.object({ kind: z.literal("sticker"), text: z.string(), atBeat: Beat, anchorBox: Box, rotateDeg: z.number() }),
  z.object({ kind: z.literal("highlightRing"), box: Box, atBeat: Beat, label: z.string().optional() }),
  z.object({ kind: z.literal("arrow"), from: z.tuple([z.number(), z.number()]), to: z.tuple([z.number(), z.number()]), atBeat: Beat }),
  z.object({ kind: z.literal("rating"), stars: z.number(), count: z.number().optional(), atBeat: Beat, quote: z.string().optional() }),
  z.object({ kind: z.literal("price"), text: z.string(), atBeat: Beat }),
  z.object({ kind: z.literal("logo"), atBeat: Beat }),
  z.object({ kind: z.literal("chips"), items: z.array(z.string()), atBeat: Beat }),
  z.object({ kind: z.literal("cta"), text: z.string(), atBeat: Beat }),
  z.object({ kind: z.literal("ripple"), at: z.tuple([z.number(), z.number()]), atBeat: Beat }),
  z.object({ kind: z.literal("flicker"), atBeat: Beat }),
]);
export type Overlay = z.infer<typeof Overlay>;

export const CameraMove = z.enum(["pushIn", "pullOut", "panLeft", "panRight", "punch", "static"]);
export const Transition = z.enum(["cut", "flash", "whip", "zoomThrough", "dropIn"]);
export const Layout = z.enum(["fullBleed", "card", "split", "textOnly", "endCard", "montage", "pageScroll"]);
export type Layout = z.infer<typeof Layout>;

export const Scene = z.object({
  id: z.string(),
  role: z.enum(["hook", "reveal", "benefit", "proof", "recap", "cta"]),
  startBeat: z.number(), // absolute; always derived from order + lengths
  lengthBeats: z.number(),
  layout: Layout,
  assetId: z.string().optional(),
  /** recap montage / colour-swap: one cut per beat */
  montage: z.array(z.object({ assetId: z.string(), label: z.string().optional(), position: SafePos.optional() })).optional(),
  /** background colour for non-full-bleed layouts */
  bg: z.string().optional(),
  camera: z.object({
    move: CameraMove,
    origin: z.tuple([z.number(), z.number()]),
    fromScale: z.number(),
    toScale: z.number(),
  }),
  overlays: z.array(Overlay),
  transitionIn: Transition,
  sfx: z.array(z.object({ name: z.string(), atBeat: z.number() })),
  sourceRefs: z.array(z.string()),
});
export type Scene = z.infer<typeof Scene>;

export const Storyboard = z.object({
  durationSec: z.literal(29),
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  bpm: z.number(),
  musicTrackId: z.string(),
  /** seconds of the first downbeat in the track (beat grid offset) */
  beatOffsetSec: z.number().default(0),
  scenes: z.array(Scene),
  voiceover: z.boolean().default(false),
});
export type Storyboard = z.infer<typeof Storyboard>;

// ---------- music ----------
export const MusicTrack = z.object({
  id: z.string(),
  title: z.string(),
  bpm: z.number(),
  mood: z.string(),
  energy: z.number(),
  tones: z.array(Tone),
  beatGrid: z.object({ offsetSec: z.number(), beatsPerBar: z.number().default(4) }),
  path: z.string(),
  license: z.string(),
});
export type MusicTrack = z.infer<typeof MusicTrack>;

// ---------- projects ----------
export const STEPS = ["ingest", "brand", "analyze", "storyboard", "render"] as const;
export type StepName = (typeof STEPS)[number];
export const StepState = z.object({
  status: z.enum(["pending", "running", "done", "error", "skipped"]),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  note: z.string().optional(),
});
export type StepState = z.infer<typeof StepState>;

export type QaIssue = {
  id: string;
  severity: "error" | "warn";
  sceneId?: string;
  message: string;
  fixed?: boolean;
  fix?: string; // description of the auto-fix that can be applied
};

export type RenderRecord = {
  id: string;
  storyboardVersion: number;
  status: "queued" | "rendering" | "done" | "error";
  progress: number;
  mp4?: string;
  poster?: string;
  gif?: string;
  lufs?: number;
  error?: string;
  createdAt: string;
};

export type Project = {
  id: string;
  url: string;
  status: "new" | "running" | "ready" | "error" | "blocked";
  createdAt: string;
  steps: Record<StepName, StepState>;
  authorized: boolean;
  instruction?: string;
};
