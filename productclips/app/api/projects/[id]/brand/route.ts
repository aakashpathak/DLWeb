import { getBrandKit, latestStoryboard, saveBrandKit } from "@/lib/store";
import { applyOverrides, saveUserStoryboard } from "@/pipeline/run";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** Manual brand-kit overrides: { colors?, tone?, energy?, ctaText?, shapeStyle? }. Re-places text on the latest storyboard. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await ctx.params;
    const kit = await getBrandKit(id);
    if (!kit) return fail("No brand kit yet", 404);
    const overrides = (await req.json()) as Record<string, unknown>;
    const next = applyOverrides(kit, { ...(kit.overrides ?? {}), ...overrides });
    await saveBrandKit(id, next);
    const rec = await latestStoryboard(id);
    if (!rec) return json({ kit: next, storyboard: null });
    // Scene backgrounds that came from the old kit follow the new one.
    const sb = structuredClone(rec.json);
    for (const s of sb.scenes) {
      if (s.bg === kit.colors.bg) s.bg = next.colors.bg;
      else if (s.bg === kit.colors.primary) s.bg = next.colors.primary;
    }
    return json({ kit: next, storyboard: await saveUserStoryboard(id, sb, "brand kit edited") });
  });
}
