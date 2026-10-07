import { finalize } from "@/lib/director";
import { autoFix, runQa } from "@/lib/qa";
import { Storyboard } from "@/lib/schema";
import { ctxFor } from "@/pipeline/run";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** { storyboard, fix?: issueId | "all" } → re-placed storyboard + QA report (not saved). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = (await req.json()) as { storyboard: unknown; fix?: string };
    const parsed = Storyboard.safeParse(body.storyboard);
    if (!parsed.success) return fail("Invalid storyboard");
    const c = await ctxFor(id);
    if (body.fix) {
      const { sb, applied } = autoFix(parsed.data, c, body.fix === "all" ? undefined : body.fix);
      return json({ storyboard: sb, qa: runQa(sb, c), applied });
    }
    const sb = finalize(structuredClone(parsed.data), c);
    return json({ storyboard: sb, qa: runQa(sb, c), applied: [] });
  });
}
