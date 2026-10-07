import { STEPS, type StepName } from "@/lib/schema";
import { isRunning, startPipeline } from "@/pipeline/run";
import { fail, handle, json, projectOr404 } from "@/server/http";

export const runtime = "nodejs";

/** Re-run one step or a range: { from: "storyboard", until?: "render", instruction?: "make it more premium" } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!(await projectOr404(id))) return fail("Not found", 404);
    if (isRunning(id)) return fail("A step is already running for this project.", 409);
    const body = (await req.json().catch(() => ({}))) as { from?: StepName; until?: StepName; instruction?: string };
    const from = STEPS.includes(body.from as StepName) ? body.from! : "ingest";
    const until = STEPS.includes(body.until as StepName) ? body.until! : "render";
    if (STEPS.indexOf(until) < STEPS.indexOf(from)) return fail("until must come after from");
    void startPipeline(id, from, until, { instruction: body.instruction });
    return json({ ok: true });
  });
}
