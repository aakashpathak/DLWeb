import { Storyboard } from "@/lib/schema";
import { saveUserStoryboard } from "@/pipeline/run";
import { fail, handle, json, projectOr404 } from "@/server/http";

export const runtime = "nodejs";

/** Save an edited storyboard as a new version (re-timed, text re-placed, QA re-run). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!(await projectOr404(id))) return fail("Not found", 404);
    const body = (await req.json()) as { storyboard: unknown; note?: string };
    const parsed = Storyboard.safeParse(body.storyboard);
    if (!parsed.success) return fail(`Invalid storyboard: ${parsed.error.issues[0]?.message}`);
    return json(await saveUserStoryboard(id, parsed.data, body.note));
  });
}
