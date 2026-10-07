// Step 3 — Asset analysis. Pixel statistics run on every image (luma grid,
// backdrop colour, packshot subject box); Claude vision adds the semantic
// layer (type, text/face boxes, pinnable details, which benefit it shows).
import fs from "node:fs/promises";
import { z } from "zod";
import { resolveFile } from "../lib/store";
import type { AnalyzedAsset, AssetAnalysis, AssetRef, Box, Product } from "../lib/schema";
import { hasClaude, imageBlock, structured } from "./claude";
import { imageStats } from "./images";

const ZBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const VisionResult = z.object({
  images: z.array(z.object({
    id: z.string(),
    type: z.enum(["packshot", "lifestyle", "infographic", "detail", "ugc", "model", "comparison", "lowvalue"]),
    subjectBox: ZBox.nullable().describe("tight box around the product itself"),
    textBoxes: z.array(ZBox).describe("every block of baked-in text, logos-as-text, badges"),
    faceBoxes: z.array(ZBox),
    focalPoint: z.object({ x: z.number(), y: z.number() }),
    featureTags: z.array(z.number()).describe("indexes of benefits this image clearly illustrates"),
    details: z.array(z.object({ label: z.string(), box: ZBox })).describe("up to 3 specific product parts worth pointing at (e.g. lens, sole, pump, zipper), short lowercase labels"),
    disclaimerBox: ZBox.nullable().describe("legal text such as 'image simulated' that must stay visible"),
  })),
});

const SYSTEM = `You analyse e-commerce product images for a motion designer who will animate them into a vertical reel.
All boxes are normalized to the image: x,y = top-left corner, w,h = size, each 0..1.
Be precise with boxes: they decide crops and where highlight rings land. Include every piece of baked-in text in textBoxes.
Types: packshot = product on a plain backdrop; lifestyle = product in a scene; infographic = has baked-in headline/callout text; detail = close-up of part of the product; ugc = customer-style photo; model = worn/held by a person (face visible or not); comparison = side-by-side or vs chart; lowvalue = icons, badges, size charts, swatches, payment logos.`;

export async function analyzeAssets(product: Product, assets: AssetRef[], log: (m: string) => void = () => {}): Promise<AnalyzedAsset[]> {
  const base = await Promise.all(assets.map(async (a) => ({ a, h: await heuristic(a) })));
  if (!hasClaude()) return base.map(({ a, h }) => ({ ...a, analysis: h }));

  const out = new Map<string, AssetAnalysis>(base.map(({ a, h }) => [a.id, h]));
  const batches: AssetRef[][] = [];
  for (let i = 0; i < assets.length; i += 5) batches.push(assets.slice(i, i + 5));
  let done = 0;
  await Promise.all(batches.map(async (batch) => {
    try {
      const content = [] as Awaited<ReturnType<typeof imageBlock>>[];
      for (const a of batch) {
        content.push({ type: "text", text: `Image id: ${a.id} (${a.width}x${a.height})` });
        content.push(await imageBlock(a.path, 1024));
      }
      content.push({ type: "text", text: `Product: ${product.title} by ${product.brand}\nBenefits (index: text):\n${product.benefits.map((b, i) => `${i}: ${b}`).join("\n") || "(none listed)"}\n\nAnalyse each image above. Return one entry per image id.` });
      const res = await structured({ schema: VisionResult, system: SYSTEM, content, effort: "medium", maxTokens: 12000 });
      for (const r of res.images) {
        const h = out.get(r.id);
        if (!h) continue;
        out.set(r.id, {
          ...h,
          type: r.type,
          subjectBox: clampBox(r.subjectBox) ?? h.subjectBox,
          textBoxes: r.textBoxes.map(clampBox).filter(Boolean) as Box[],
          faceBoxes: r.faceBoxes.map(clampBox).filter(Boolean) as Box[],
          focalPoint: [clamp01(r.focalPoint.x), clamp01(r.focalPoint.y)],
          featureTags: r.featureTags.filter((i) => i >= 0 && i < product.benefits.length),
          details: r.details.map((d) => ({ label: d.label.toLowerCase().slice(0, 24), box: clampBox(d.box)! })).filter((d) => d.box).slice(0, 4),
          disclaimer: clampBox(r.disclaimerBox),
          source: "claude",
        });
      }
    } catch (e) {
      log(`Vision analysis failed for a batch, using pixel heuristics: ${(e as Error).message}`);
    }
    done += batch.length;
    log(`Analyzed ${done}/${assets.length} images`);
  }));
  return assets.map((a) => ({ ...a, analysis: out.get(a.id)! }));
}

async function heuristic(a: AssetRef): Promise<AssetAnalysis> {
  const buf = await fs.readFile(resolveFile(a.path));
  const s = await imageStats(buf);
  const short = Math.min(a.width, a.height);
  const ar = a.width / a.height;
  const packshot = s.borderUniform && s.subjectFill < 0.8 && !!s.subjectBox;
  const type: AssetAnalysis["type"] = ar > 3.2 || ar < 0.28 ? "lowvalue" : packshot ? "packshot" : "lifestyle";
  const subject = packshot ? s.subjectBox : null;
  return {
    type,
    subjectBox: subject,
    textBoxes: [],
    faceBoxes: [],
    focalPoint: subject ? [subject.x + subject.w / 2, subject.y + subject.h / 2] : s.focal,
    featureTags: [],
    details: [],
    quality: Math.min(1, short / 1400),
    lowRes: short < 800,
    bgColor: s.borderUniform ? s.borderColor : undefined,
    lumaGrid: s.lumaGrid,
    disclaimer: null,
    source: "heuristic",
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
function clampBox(b: Box | null | undefined): Box | null {
  if (!b) return null;
  // Accept 0..100 or pixel-ish answers defensively.
  const scale = Math.max(b.x, b.y, b.w, b.h) > 1.5 ? 100 : 1;
  const x = clamp01(b.x / scale), y = clamp01(b.y / scale);
  const w = Math.min(1 - x, Math.max(0, b.w / scale)), h = Math.min(1 - y, Math.max(0, b.h / scale));
  return w > 0.005 && h > 0.005 ? { x, y, w, h } : null;
}
