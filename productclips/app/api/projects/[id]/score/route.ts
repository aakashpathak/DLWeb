import { Storyboard } from "@/lib/schema";
import { ensureScore, ensureSfx } from "@/pipeline/music";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** The audio for a storyboard (composer tracks are scored to its sections). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const parsed = Storyboard.safeParse(((await req.json()) as { storyboard: unknown }).storyboard);
    if (!parsed.success) return fail("Invalid storyboard");
    await ensureSfx();
    const path = await ensureScore(id, parsed.data);
    return json({ url: path ? `/api/files/${path}` : null });
  });
}
