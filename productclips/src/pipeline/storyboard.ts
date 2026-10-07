// Step 4 — Storyboard: Claude writes the creative plan (copy + image choices),
// the director times and places it, QA checks it, and failures get one repair
// pass (deterministic fixes first, then Claude if copy needs rewriting).
import { buildStoryboard, shortName, trimWords, type DirectorCtx, type TrackInfo } from "../lib/director";
import { CreativePlan, type BenefitPlan } from "../lib/plan";
import { autoFix, qaBlocking, runQa } from "../lib/qa";
import type { AnalyzedAsset, Product, QaIssue, Storyboard } from "../lib/schema";
import { hasClaude, structured } from "./claude";

const RULES = `Creative rules (non-negotiable):
1. Real assets only. Never recolour or redraw. Infographic images with baked-in text are great content.
2. Text economy: max 5 words per headline, sentence case or the brand's own casing, max ~3 words/second.
3. Copy must be traceable to the page. You may shorten, never invent specs, numbers, awards or claims. Every benefit/proof/cta item lists sourceRefs naming the product.json fields it came from (e.g. "benefits[2]", "specs.Material", "reviews[0]", "rating", "title", "description").
4. The hook is a pattern interrupt: a question or tension tied to the product ("Your glasses are lying to you." / "Who's at the door?"). It may be a rhetorical line, but it must not assert a fact the page doesn't support. Never open on the logo.
5. One benefit per scene, one image per scene; choose the image whose featureTags match the benefit. Do not use the same image in more than 2 scenes (recap montage excepted). Do not use lowvalue images.
6. Highlights point at real things: only use ring/arrow/sticker with a detailLabel that exists on that image (or null to circle the product itself). If nothing fits, use kind "none".
7. Use "flicker" only for night/dark/light/glow features, "ripple" only for buttons/sound/signal/connectivity.
8. Proof: use the page's rating/review count and/or a real review trimmed to <= 10 words (trim, don't paraphrase). If the page has neither, kind "none".
9. Recap: 4-5 cuts, each 1-3 word label echoing a benefit. CTA: 3-4 chips of <= 3 words, and the site's own CTA text if it has one.
10. Keep the page's language for all copy.`;

export function assetDigest(assets: AnalyzedAsset[]) {
  return assets.map((a) => ({
    id: a.id, type: a.analysis.type, size: `${a.width}x${a.height}`, lowRes: a.analysis.lowRes,
    featureTags: a.analysis.featureTags, details: a.analysis.details.map((d) => d.label), hasText: a.analysis.textBoxes.length > 0, faces: a.analysis.faceBoxes.length,
  }));
}

export function productDigest(p: Product) {
  return {
    brand: p.brand, title: p.title, price: p.price, rating: p.rating, reviewCount: p.reviewCount, benefits: p.benefits,
    specs: p.specs, reviews: p.topReviews.slice(0, 6), variants: p.variants.map((v) => ({ name: v.name, images: v.imageIds.length })),
    description: (p.description ?? "").slice(0, 1200), ctaText: p.ctaText, language: p.language,
  };
}

export async function writePlan(ctx: DirectorCtx, opts: { instruction?: string; previous?: CreativePlan; issues?: QaIssue[] } = {}): Promise<{ plan: CreativePlan; by: "ai" | "heuristic" }> {
  if (!hasClaude()) return { plan: heuristicPlan(ctx), by: "heuristic" };
  const { product, kit, assets } = ctx;
  const text = [
    `PRODUCT\n${JSON.stringify(productDigest(product), null, 1)}`,
    `BRAND\ntone: ${kit.tone}, energy ${kit.energy}/5, site CTA: "${kit.ctaText}"`,
    `IMAGES\n${JSON.stringify(assetDigest(assets.filter((a) => a.kind !== "screenshot")), null, 1)}`,
    `STRUCTURE (29s vertical reel, cut to the beat): hook 0-2.5s → reveal (product name, 2-4 words per line) → 3 benefit scenes (~4s each; 4 if no proof) → proof → recap montage → CTA end card.`,
    opts.previous ? `PREVIOUS PLAN\n${JSON.stringify(opts.previous)}` : "",
    opts.issues?.length ? `QA FAILURES TO FIX\n${opts.issues.map((i) => `- ${i.message}`).join("\n")}` : "",
    opts.instruction ? `DIRECTOR'S NOTE (follow it): ${opts.instruction}` : "",
    "Write the creative plan.",
  ].filter(Boolean).join("\n\n");
  try {
    const plan = await structured({
      schema: CreativePlan,
      system: `You are the creative director at ${product.brand}'s in-house studio, writing a 29-second vertical product reel that must look like the brand made it. You choose words and images; the motion system handles timing and layout.\n\n${RULES}`,
      content: [{ type: "text", text }],
      effort: "medium",
      maxTokens: 10000,
    });
    return { plan: sanitizePlan(plan, ctx), by: "ai" };
  } catch {
    return { plan: heuristicPlan(ctx), by: "heuristic" };
  }
}

/** Keeps the plan honest: real asset ids, word limits, no lowvalue images. */
export function sanitizePlan(plan: CreativePlan, ctx: DirectorCtx): CreativePlan {
  const ok = new Set(ctx.assets.filter((a) => a.analysis.type !== "lowvalue").map((a) => a.id));
  const fix = (id: string | null) => (id && ok.has(id) ? id : null);
  const fallback = heuristicPlan(ctx);
  return {
    hook: { ...plan.hook, lines: plan.hook.lines.slice(0, 2).map((l) => trimWords(l, 5)), assetId: fix(plan.hook.assetId) },
    reveal: { ...plan.reveal, assetId: fix(plan.reveal.assetId) ?? fallback.reveal.assetId },
    benefits: plan.benefits.map((b, i) => ({ ...b, headline: trimWords(b.headline, 5), pill: b.pill ? trimWords(b.pill, 4) : null, assetId: fix(b.assetId) ?? fallback.benefits[i % fallback.benefits.length]?.assetId ?? "" })),
    proof: { ...plan.proof, quote: plan.proof.quote ? trimWords(plan.proof.quote, 10) : null, assetId: fix(plan.proof.assetId) },
    recap: plan.recap.filter((r) => ok.has(r.assetId)).map((r) => ({ ...r, label: trimWords(r.label, 3) })),
    cta: { ...plan.cta, chips: plan.cta.chips.map((c) => trimWords(c, 3)).slice(0, 4), assetId: fix(plan.cta.assetId) },
    colorSwap: plan.colorSwap,
  };
}

// ---------- heuristic plan (no API key / API failure) ----------
const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "with", "in", "on", "our", "your", "is", "are", "that", "which", "it", "its", "by", "from", "so", "made"]);

const BREAK = new Set(["for", "with", "in", "on", "to", "so", "that", "which", "and", "from", "by", "at", "while", "without"]);

/** Shortens a benefit to <= max words at a phrase boundary ("Keeps drinks cold for 24 hours" → "Keeps drinks cold"). */
export function shortenBenefit(b: string, max = 5) {
  const first = b.replace(/[.!]$/, "").split(/[;:—–(]|,\s| - /)[0].trim();
  let words = first.split(/\s+/);
  if (words.length > max) {
    let cut = -1;
    for (let i = Math.min(max, words.length - 1); i >= 2; i--) if (BREAK.has(words[i].toLowerCase())) { cut = i; break; }
    words = cut > 0 ? words.slice(0, cut) : words.slice(0, max);
    while (words.length > 2 && (STOP.has(words[words.length - 1].toLowerCase()) || /^\d+$/.test(words[words.length - 1]))) words.pop();
  }
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Supporting pill: the rest of the benefit, only if it reads on its own (<= 4 words, carries a number or noun phrase). */
function pillFrom(b: string, headline: string) {
  const rest = b.replace(/[.!]$/, "").slice(headline.length).replace(/^[\s,;:—–-]+/, "").trim();
  const words = rest.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4 || BREAK.has(words[0]?.toLowerCase()) && words.length < 3) return null;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function heuristicPlan(ctx: DirectorCtx): CreativePlan {
  const { product, kit } = ctx;
  const pool = ctx.assets.filter((a) => a.analysis.type !== "lowvalue" && a.kind !== "screenshot").sort((a, b) => b.analysis.quality - a.analysis.quality);
  const use = new Map<string, number>();
  const take = (pred: (a: AnalyzedAsset) => boolean, max = 1) => {
    const u = (x: AnalyzedAsset) => use.get(x.id) ?? 0;
    const byUse = [...pool].sort((x, y) => u(x) - u(y));
    const a = byUse.find((x) => pred(x) && u(x) === 0) ?? byUse.find((x) => u(x) === 0) ?? byUse.find((x) => pred(x) && u(x) < max) ?? byUse.find((x) => u(x) < max) ?? pool[0];
    if (a) use.set(a.id, (use.get(a.id) ?? 0) + 1);
    return a;
  };
  const hookA = take((a) => ["lifestyle", "model", "ugc"].includes(a.analysis.type));
  const revealA = take((a) => a.analysis.type === "packshot", 2);
  const name = shortName(product.title, product.brand);
  const noun = name.split(" ").filter((w) => /^[a-z]/i.test(w)).pop()?.toLowerCase() ?? "favorite";
  const hooks: Record<string, string[]> = {
    "premium-minimal": [`Meet your new ${noun}.`],
    luxury: ["Quiet luxury,", "up close."],
    "playful-bold": ["Stop scrolling.", `Look at this ${noun}.`],
    "clean-clinical": [`Rethink your ${noun}.`],
    "warm-natural": [`Say hello to ${trimWords(name, 3)}.`],
    techy: [`Your ${noun},`, "reimagined."],
  };
  const benefits: BenefitPlan[] = [];
  const src = product.benefits.length ? product.benefits : Object.entries(product.specs).map(([k, v]) => `${k}: ${v}`);
  src.slice(0, 4).forEach((b, i) => {
    const a = take((x) => x.analysis.featureTags.includes(i) || ["detail", "infographic", "lifestyle", "model"].includes(x.analysis.type), 2);
    const night = /night|dark|glow|light|led|bright/i.test(b), signal = /button|sound|signal|wifi|bluetooth|alert|notif/i.test(b);
    benefits.push({
      headline: shortenBenefit(b), pill: pillFrom(b, shortenBenefit(b)), assetId: a?.id ?? "",
      highlight: a?.analysis.details[0] ? { kind: "ring", detailLabel: a.analysis.details[0].label, stickerText: null } : { kind: "none", detailLabel: null, stickerText: null },
      effect: night ? "flicker" : signal ? "ripple" : "none",
      sourceRefs: [product.benefits.length ? `benefits[${i}]` : "specs"],
    });
  });
  if (!benefits.length) benefits.push({ headline: trimWords(name, 4), pill: product.price ?? null, assetId: pool[0]?.id ?? "", highlight: { kind: "none", detailLabel: null, stickerText: null }, effect: "none", sourceRefs: ["title"] });
  const review = product.topReviews.find((r) => r.split(/\s+/).length <= 14) ?? product.topReviews[0];
  const quote = review ? trimWords(review.split(/(?<=[.!?])\s/)[0].replace(/^["“]|["”]$/g, ""), 10) : null;
  const recapIds = [...new Set([hookA, revealA, ...benefits.map((b) => pool.find((p) => p.id === b.assetId))].filter(Boolean).map((a) => a!.id))];
  for (const p of pool) if (recapIds.length < 5 && !recapIds.includes(p.id)) recapIds.push(p.id);
  return {
    hook: { lines: hooks[kit.tone] ?? hooks["premium-minimal"], assetId: hookA?.id ?? null, sourceRefs: ["title"] },
    reveal: { nameLines: [name], assetId: revealA?.id ?? pool[0]?.id ?? "", sourceRefs: ["title"] },
    benefits,
    proof: { kind: product.rating ? "rating" : quote ? "quote" : "none", quote, assetId: null, sourceRefs: quote ? ["reviews[0]"] : [] },
    recap: recapIds.slice(0, 5).map((id, i) => ({ assetId: id, label: trimWords(benefits[i % benefits.length].headline, 2) })),
    cta: { chips: benefits.slice(0, 3).map((b) => shortenBenefit(b.headline, 3)), ctaText: kit.ctaText, assetId: revealA?.id ?? null, sourceRefs: benefits.flatMap((b) => b.sourceRefs) },
    colorSwap: product.variants.filter((v) => v.imageIds.length).length >= 3,
  };
}

/** Plan → storyboard → QA → auto-fix → (Claude repair) → QA. */
export async function generateStoryboard(ctx: DirectorCtx, track: TrackInfo, opts: { instruction?: string; previous?: CreativePlan } = {}) {
  let { plan, by } = await writePlan(ctx, opts);
  let sb: Storyboard = buildStoryboard(ctx, plan, track);
  let fixed = autoFix(sb, ctx);
  sb = fixed.sb;
  let qa = runQa(sb, ctx);
  if (qaBlocking(qa).length && by === "ai") {
    const repaired = await writePlan(ctx, { previous: plan, issues: qaBlocking(qa), instruction: opts.instruction });
    const sb2 = autoFix(buildStoryboard(ctx, repaired.plan, track), ctx).sb;
    const qa2 = runQa(sb2, ctx);
    if (qaBlocking(qa2).length < qaBlocking(qa).length) { sb = sb2; qa = qa2; plan = repaired.plan; fixed = { sb: sb2, applied: [] }; }
  }
  return { storyboard: sb, qa, plan, by, applied: fixed.applied };
}
