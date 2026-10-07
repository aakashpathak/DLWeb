import { getAssets, getBrandKit, getProduct, getRenders, latestStoryboard, listStoryboards } from "@/lib/store";
import { isRunning } from "@/pipeline/run";
import { allTracks } from "@/pipeline/music";
import { fail, handle, json, projectOr404 } from "@/server/http";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const project = await projectOr404(id);
    if (!project) return fail("Not found", 404);
    const [product, kit, assets, storyboard, versions, renders, tracks] = await Promise.all([
      getProduct(id), getBrandKit(id), getAssets(id), latestStoryboard(id), listStoryboards(id), getRenders(id), allTracks(),
    ]);
    return json({
      project: { ...project, running: isRunning(id) }, product, kit, assets, storyboard, renders,
      versions: versions.map((v) => ({ version: v.version, createdBy: v.createdBy, createdAt: v.createdAt, note: v.note })),
      tracks: tracks.map(({ id, title, bpm, mood, energy, license }) => ({ id, title, bpm, mood, energy, license })),
    });
  });
}
