import { buildStoryboard, finalize } from "@/lib/director";
import { runQa } from "@/lib/qa";
import { Storyboard, type Scene } from "@/lib/schema";
import type { CreativePlan } from "@/lib/plan";
import { getExtras, saveExtras } from "@/lib/store";
import { ctxFor } from "@/pipeline/run";
import { writePlan } from "@/pipeline/storyboard";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** Regenerate one scene: Claude rewrites the plan with a note scoped to that scene; only that scene is swapped in. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = (await req.json()) as { storyboard: unknown; sceneId: string; instruction?: string };
    const parsed = Storyboard.safeParse(body.storyboard);
    if (!parsed.success) return fail("Invalid storyboard");
    const sb = parsed.data;
    const idx = sb.scenes.findIndex((s) => s.id === body.sceneId);
    if (idx < 0) return fail("Scene not found", 404);
    const target = sb.scenes[idx];
    const nth = sb.scenes.slice(0, idx).filter((s) => s.role === target.role).length;
    const c = await ctxFor(id);
    const extras = await getExtras(id);
    const note = `Rewrite ONLY the ${target.role} scene #${nth + 1}${body.instruction ? `: ${body.instruction}` : " with a fresh angle (different words and, if possible, a different image)"}. Keep every other part of the previous plan identical.`;
    const { plan, by } = await writePlan(c, { previous: extras.plan as CreativePlan | undefined, instruction: note });
    const fresh = buildStoryboard(c, plan, { id: sb.musicTrackId, bpm: sb.bpm, offsetSec: sb.beatOffsetSec });
    const candidates = fresh.scenes.filter((s) => s.role === target.role);
    const replacement: Scene | undefined = candidates[nth] ?? candidates[0];
    if (!replacement) return fail("Could not regenerate that scene");
    sb.scenes[idx] = { ...replacement, id: target.id, lengthBeats: target.lengthBeats };
    const out = finalize(sb, c);
    await saveExtras(id, { ...extras, plan });
    return json({ storyboard: out, qa: runQa(out, c), by });
  });
}
