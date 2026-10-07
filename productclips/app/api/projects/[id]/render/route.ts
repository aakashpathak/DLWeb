import { latestStoryboard } from "@/lib/store";
import { qaBlocking } from "@/lib/qa";
import { isRunning, startPipeline } from "@/pipeline/run";
import { fail, handle, json, projectOr404 } from "@/server/http";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!(await projectOr404(id))) return fail("Not found", 404);
    if (isRunning(id)) return fail("Already working on this project.", 409);
    const rec = await latestStoryboard(id);
    if (!rec) return fail("No storyboard yet");
    const { force } = (await req.json().catch(() => ({}))) as { force?: boolean };
    const blocking = qaBlocking(rec.qa);
    if (blocking.length && !force) return fail(`QA has ${blocking.length} blocking issue(s). Fix them or render anyway.`, 422);
    void startPipeline(id, "render", "render");
    return json({ ok: true });
  });
}
