// The creative plan: what Claude (or the heuristic fallback) decides — the
// words, which image goes where, what to point at. The director turns this
// into a timed, positioned storyboard; the model never writes coordinates or
// frame numbers.
import { z } from "zod";

export const HighlightPlan = z.object({
  kind: z.enum(["ring", "arrow", "sticker", "none"]),
  detailLabel: z.string().nullable().describe("label of a detail from the image analysis to point at; null = product subject"),
  stickerText: z.string().nullable().describe("2-3 words, only for sticker"),
});

export const BenefitPlan = z.object({
  headline: z.string().describe("max 5 words, sentence case, shortened from a real benefit"),
  pill: z.string().nullable().describe("max 4 words supporting fact, from the page"),
  assetId: z.string(),
  highlight: HighlightPlan,
  effect: z.enum(["none", "flicker", "ripple"]).describe("flicker for night/dark/light features, ripple for buttons/sound/signal"),
  sourceRefs: z.array(z.string()),
});
export type BenefitPlan = z.infer<typeof BenefitPlan>;

export const CreativePlan = z.object({
  hook: z.object({
    lines: z.array(z.string()).describe("1-2 lines, each max 5 words. A question or tension tied to the product. Never the logo."),
    assetId: z.string().nullable(),
    sourceRefs: z.array(z.string()),
  }),
  reveal: z.object({
    nameLines: z.array(z.string()).describe("product name split into lines of 2-4 words"),
    assetId: z.string(),
    sourceRefs: z.array(z.string()),
  }),
  benefits: z.array(BenefitPlan).describe("3 benefits (4 if no proof), one image each, ordered strongest first"),
  proof: z.object({
    kind: z.enum(["rating", "quote", "none"]),
    quote: z.string().nullable().describe("real review, max 10 words, trimmed not rewritten"),
    assetId: z.string().nullable(),
    sourceRefs: z.array(z.string()),
  }),
  recap: z.array(z.object({ assetId: z.string(), label: z.string().describe("1-3 words") })).describe("4-5 cuts"),
  cta: z.object({
    chips: z.array(z.string()).describe("3-4 feature chips, max 3 words each"),
    ctaText: z.string(),
    assetId: z.string().nullable(),
    sourceRefs: z.array(z.string()),
  }),
  colorSwap: z.boolean().describe("true if the page has 3+ colour variants with their own images"),
});
export type CreativePlan = z.infer<typeof CreativePlan>;
