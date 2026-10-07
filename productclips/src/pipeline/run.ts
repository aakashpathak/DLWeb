// Orchestrates the steps. Each step reads its inputs from the store and writes
// its output back, so any step can be re-run alone.
import {
  getAssets, getBrandKit, getExtras, getProduct, getProject, latestStoryboard, newId, saveAssets, saveBrandKit, saveExtras, saveProduct,
  saveStoryboard, setStep, updateProject, upsertRender,
} from "../lib/store";
import { STEPS, type BrandKit, type Product, type StepName, type Storyboard } from "../lib/schema";
import { finalize, type DirectorCtx } from "../lib/director";
import { runQa } from "../lib/qa";
import type { CreativePlan } from "../lib/plan";
import { analyzeAssets } from "./analyze";
import { buildBrandKit } from "./brand";
import { BlockedError, ingest, type RawExtraction } from "./ingest";
import { getTrack, pickTrack } from "./music";
import { generateStoryboard } from "./storyboard";
import { renderReel } from "./render";

const running = new Map<string, Promise<void>>();

export async function ctxFor(projectId: string): Promise<DirectorCtx> {
  const [product, kit, assets] = await Promise.all([getProduct(projectId), getBrandKit(projectId), getAssets(projectId)]);
  if (!product || !kit) throw new Error("Run ingest and brand first");
  return { product, kit, assets };
}

/** Runs steps from `from` through `until` in the background (one run per project at a time). */
export function startPipeline(projectId: string, from: StepName = "ingest", until: StepName = "render", opts: { instruction?: string } = {}) {
  if (running.has(projectId)) return running.get(projectId)!;
  const p = (async () => {
    const steps = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(until) + 1);
    await updateProject(projectId, (pr) => {
      pr.status = "running";
      for (const s of steps) pr.steps[s] = { status: "pending" };
      if (opts.instruction !== undefined) pr.instruction = opts.instruction;
    });
    for (const step of steps) {
      await setStep(projectId, step, { status: "running", error: undefined, note: undefined });
      try {
        const note = await STEP_FNS[step](projectId, (m) => setStep(projectId, step, { note: m }).catch(() => {}), opts);
        await setStep(projectId, step, { status: "done", note: note ?? undefined });
      } catch (e) {
        const blocked = e instanceof BlockedError;
        await setStep(projectId, step, { status: "error", error: blocked ? `${e.message} Upload images and paste the product copy instead.` : (e as Error).message });
        await updateProject(projectId, (pr) => { pr.status = blocked ? "blocked" : "error"; });
        console.error(`[pipeline ${projectId}] ${step} failed`, e);
        return;
      }
    }
    await updateProject(projectId, (pr) => { pr.status = "ready"; });
  })().finally(() => running.delete(projectId));
  running.set(projectId, p);
  return p;
}
export const isRunning = (id: string) => running.has(id);

type Log = (m: string) => void;
const STEP_FNS: Record<StepName, (id: string, log: Log, opts: { instruction?: string }) => Promise<string | void>> = {
  async ingest(id, log) {
    const project = await getProject(id);
    if (!project) throw new Error("No project");
    const existing = await getProduct(id);
    if (existing?.source === "manual") return "Using uploaded images and copy";
    const { product, raw } = await ingest(id, project.url, log);
    await saveProduct(id, product);
    await saveExtras(id, { ...(await getExtras(id)), raw });
    return `${product.assets.length} images · ${product.benefits.length} benefits · via ${product.source}`;
  },
  async brand(id) {
    const product = await getProduct(id);
    if (!product) throw new Error("No product data");
    const extras = await getExtras(id);
    const prev = await getBrandKit(id);
    let kit = await buildBrandKit(product, (extras.raw as RawExtraction) ?? null, extras.manualColors as Partial<BrandKit["colors"]> | undefined);
    if (prev?.overrides) kit = applyOverrides(kit, prev.overrides);
    await saveBrandKit(id, kit);
    return `${kit.tone} · ${kit.fonts.heading.family} · ${kit.colors.primary}`;
  },
  async analyze(id, log) {
    const product = await getProduct(id);
    if (!product) throw new Error("No product data");
    const assets = await analyzeAssets(product, product.assets, log);
    await saveAssets(id, assets);
    const types = assets.reduce<Record<string, number>>((m, a) => ((m[a.analysis.type] = (m[a.analysis.type] ?? 0) + 1), m), {});
    return Object.entries(types).map(([k, v]) => `${v} ${k}`).join(" · ");
  },
  async storyboard(id, _log, opts) {
    const ctx = await ctxFor(id);
    const project = await getProject(id);
    const prev = await latestStoryboard(id);
    // Keep a track the user picked; otherwise choose by (possibly updated) tone.
    const track = prev?.createdBy === "user" ? await getTrack(prev.json.musicTrackId) : await pickTrack(ctx.kit);
    const extras = await getExtras(id);
    const res = await generateStoryboard(ctx, { id: track.id, bpm: track.bpm, offsetSec: track.beatGrid.offsetSec }, { instruction: opts.instruction ?? project?.instruction, previous: opts.instruction ? (extras.plan as CreativePlan | undefined) : undefined });
    await saveExtras(id, { ...extras, plan: res.plan });
    await saveStoryboard(id, { json: res.storyboard, qa: res.qa, createdBy: res.by, note: opts.instruction });
    const errors = res.qa.filter((q) => q.severity === "error").length;
    return `${res.storyboard.scenes.length} scenes · ${res.by === "ai" ? "Claude" : "heuristic"} copy · QA ${errors ? `${errors} issue(s)` : "passed"}`;
  },
  async render(id, log) {
    const rec = await latestStoryboard(id);
    if (!rec) throw new Error("No storyboard");
    await renderStoryboard(id, rec.version, rec.json, log);
  },
};

export async function renderStoryboard(id: string, version: number, sb: Storyboard, log: Log = () => {}) {
  const renderId = newId(8);
  const base = { id: renderId, storyboardVersion: version, createdAt: new Date().toISOString() };
  await upsertRender(id, { ...base, status: "rendering", progress: 0 });
  let last = 0;
  try {
    const out = await renderReel({
      projectId: id, renderId, storyboard: sb,
      onProgress: (p) => { if (p - last > 0.04) { last = p; log(`Rendering ${Math.round(p * 100)}%`); upsertRender(id, { ...base, status: "rendering", progress: p }).catch(() => {}); } },
    });
    await upsertRender(id, { ...base, status: "done", progress: 1, mp4: out.mp4, poster: out.poster, gif: out.gif, lufs: out.lufs });
    return out;
  } catch (e) {
    await upsertRender(id, { ...base, status: "error", progress: last, error: (e as Error).message });
    throw e;
  }
}

/** Saves a user-edited storyboard: re-times, re-places text, re-runs QA. */
export async function saveUserStoryboard(id: string, sb: Storyboard, note?: string) {
  const ctx = await ctxFor(id);
  const fixed = finalize(structuredClone(sb), ctx);
  return saveStoryboard(id, { json: fixed, qa: runQa(fixed, ctx), createdBy: "user", note });
}

export function applyOverrides(kit: BrandKit, o: Record<string, unknown>): BrandKit {
  const next = structuredClone(kit);
  const colors = o.colors as Partial<BrandKit["colors"]> | undefined;
  if (colors) Object.assign(next.colors, Object.fromEntries(Object.entries(colors).filter(([, v]) => !!v)));
  if (o.tone) next.tone = o.tone as BrandKit["tone"];
  if (o.energy) next.energy = Number(o.energy);
  if (o.ctaText) next.ctaText = String(o.ctaText);
  if (o.shapeStyle) next.shape.style = o.shapeStyle as BrandKit["shape"]["style"];
  next.overrides = o;
  return next;
}

export async function saveManualProduct(id: string, p: Product) { await saveProduct(id, p); }
