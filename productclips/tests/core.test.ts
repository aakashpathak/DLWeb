import { test } from "node:test";
import assert from "node:assert/strict";
import { beatMap, buildStoryboard, protectText, totalBeats } from "../src/lib/director";
import { runQa, framesForBeats } from "../src/lib/qa";
import { slamLines, visibleRegion, boxInside, cameraAt } from "../src/lib/geometry";
import { imageRect } from "../src/lib/layout";
import { heuristicPlan, shortenBenefit } from "../src/pipeline/storyboard";
import { maxResUrl, bestFromSrcset } from "../src/pipeline/images";
import { extractBenefits } from "../src/pipeline/ingest";
import { compose, MOODS } from "../src/lib/audio-synth";
import type { AnalyzedAsset, AssetAnalysis, BrandKit, Product } from "../src/lib/schema";

const grid = (v: number) => new Array(144).fill(v);
const analysis = (o: Partial<AssetAnalysis>): AssetAnalysis => ({
  type: "lifestyle", subjectBox: null, textBoxes: [], faceBoxes: [], focalPoint: [0.5, 0.5], featureTags: [], details: [],
  quality: 1, lowRes: false, lumaGrid: grid(0.5), disclaimer: null, source: "heuristic", ...o,
});
const asset = (id: string, w: number, h: number, a: Partial<AssetAnalysis>): AnalyzedAsset => ({ id, path: `x/${id}.jpg`, width: w, height: h, kind: "image", analysis: analysis(a) });

const kit: BrandKit = {
  colors: { bg: "#f4efe8", ink: "#2b3442", primary: "#2b3442", onPrimary: "#f4efe8", accent: "#c27a5a", muted: "#8f8f8f" },
  fonts: { heading: { family: "Fraunces", serif: true, weight: 600, letterSpacing: 0, textTransform: "none", files: [] }, body: { family: "DM Sans", serif: false, weight: 400, letterSpacing: 0, textTransform: "none", files: [] }, button: { family: "DM Sans", serif: false, weight: 600, letterSpacing: 0, textTransform: "none", files: [] } },
  shape: { radius: 28, style: "pill", shadow: false, border: false }, tone: "premium-minimal", energy: 2, ctaText: "Add to bag",
};
const assets = [
  asset("pack", 1600, 2000, { type: "packshot", subjectBox: { x: 0.4, y: 0.2, w: 0.2, h: 0.6 }, bgColor: "#f4efe8", lumaGrid: grid(0.85) }),
  asset("life", 1800, 2400, { type: "lifestyle", subjectBox: { x: 0.45, y: 0.3, w: 0.12, h: 0.35 }, lumaGrid: grid(0.4) }),
  asset("info", 1600, 1600, { type: "infographic", textBoxes: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.12 }], lumaGrid: grid(0.85) }),
  asset("detail", 1600, 1600, { type: "detail", details: [{ label: "cap", box: { x: 0.3, y: 0.15, w: 0.4, h: 0.25 } }], lumaGrid: grid(0.5) }),
  asset("night", 1800, 2400, { type: "lifestyle", lumaGrid: grid(0.05) }),
];
const product: Product = {
  url: "http://x", brand: "Halden", title: "The Everyday Bottle", price: "$42", rating: 4.8, reviewCount: 2314,
  topReviews: ["Love the clay colour and it really doesn't leak in my bag."], benefits: ["Keeps drinks cold for 24 hours, hot for 12", "Ceramic lining — no metallic taste", "Leakproof one-hand cap", "Glow-in-the-dark cap band"],
  specs: {}, variants: [], language: "en", assets, pageScreenshots: [], source: "jsonld",
};
const ctx = { product, kit, assets };

for (const bpm of [92, 100, 108, 112, 122, 126]) {
  test(`beat map at ${bpm} BPM follows the 29s structure`, () => {
    const m = beatMap(bpm, true);
    const s = (b: number) => (b * 60) / bpm;
    assert.ok(m.reveal < m.benefits && m.benefits < m.proof && m.proof < m.recap && m.recap < m.cta && m.cta < m.total);
    assert.equal(m.reveal % 4, 0, "reveal lands on a bar");
    assert.equal(m.cta % 4, 0, "CTA lands on a bar");
    assert.ok(s(m.reveal) >= 1.8 && s(m.reveal) <= 3.2, `hook ${s(m.reveal)}s`);
    assert.ok(s(m.total - m.cta) >= 4.5, "end card holds long enough to read");
    assert.ok(m.cta - m.recap >= 4 && m.cta - m.recap <= 5, "recap is 4-5 one-beat cuts");
  });

  test(`heuristic storyboard at ${bpm} BPM is exactly 29.00s and passes QA`, () => {
    const sb = buildStoryboard(ctx, heuristicPlan(ctx), { id: "composer:x", bpm });
    const end = sb.scenes.reduce((a, s) => a + s.lengthBeats, 0);
    assert.ok(Math.abs(end - totalBeats(bpm)) < 1e-9);
    assert.equal(framesForBeats(sb, end), 870);
    const errors = runQa(sb, ctx).filter((i) => i.severity === "error");
    assert.deepEqual(errors.map((e) => e.message), []);
    assert.equal(sb.scenes[0].role, "hook");
    assert.ok(sb.scenes[0].overlays.some((o) => o.kind === "slamText" && o.atBeat === 0), "text in the first frame");
    for (const s of sb.scenes.slice(0, -1)) assert.equal(s.startBeat % 1, 0, "every cut lands on a beat");
  });
}

test("zoom never crops baked-in text on infographics", () => {
  const info = assets[2];
  for (const layout of ["fullBleed", "card", "split"] as const) {
    const cam = protectText(info, layout, { move: "pushIn", origin: [0.5, 0.9], fromScale: 1, toScale: 1.3 });
    const ir = imageRect(layout, info);
    for (const t of [0, 0.5, 1]) {
      const vis = visibleRegion(info.width, info.height, cam.origin, cameraAt({ camera: cam }, t, 0, 0), ir.w, ir.h);
      // fullBleed crops a square into 9:16, so full-bleed text safety is the director's job (it switches layout)
      if (layout !== "fullBleed") assert.ok(info.analysis.textBoxes.every((b) => boxInside(b, vis)), `${layout} t=${t}`);
    }
    assert.ok(Math.max(cam.fromScale, cam.toScale) <= 1.05);
  }
});

test("copy shortening keeps phrases whole", () => {
  assert.equal(shortenBenefit("Keeps drinks cold for 24 hours, hot for 12"), "Keeps drinks cold");
  assert.equal(shortenBenefit("Ceramic lining — no metallic taste"), "Ceramic lining");
  assert.ok(shortenBenefit("Made from responsibly sourced ZQ merino wool that is soft").split(" ").length <= 5);
});

test("slam lines are at most 3 words and at most 2 lines for 6 words", () => {
  for (const t of ["Your glasses are lying to you.", "Leakproof one-hand cap", "A"]) {
    const l = slamLines(t);
    assert.ok(l.length <= 2 && l.every((x) => x.split(" ").length <= 3), JSON.stringify(l));
  }
});

test("CDN URLs are rewritten to full resolution", () => {
  assert.equal(maxResUrl("https://cdn.shopify.com/s/files/1/products/shoe_600x.jpg?v=1"), "https://cdn.shopify.com/s/files/1/products/shoe.jpg?v=1&width=2400");
  assert.equal(bestFromSrcset("a.jpg 300w, b.jpg 1200w, c.jpg 800w", "https://x.com/p"), "https://x.com/b.jpg");
});

test("benefit extraction drops navigation and policy noise", () => {
  const b = extractBenefits(["Free shipping over $50", "Machine washable", "Sign up for our newsletter", "$42", "Made with ZQ merino wool"]);
  assert.deepEqual(b, ["Machine washable", "Made with ZQ merino wool"]);
});

test("composer is deterministic and covers the full reel", () => {
  const arr = { revealBeat: 4, recapBeat: 36, ctaBeat: 40, totalBeats: 49 };
  const a = compose(MOODS[0], arr, 7), b = compose(MOODS[0], arr, 7);
  assert.ok(a.l.length / 48000 >= 29);
  assert.equal(a.l[123456], b.l[123456]);
});
