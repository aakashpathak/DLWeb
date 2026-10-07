import { createProject, getRenders, listProjects, getProduct } from "@/lib/store";
import { startPipeline } from "@/pipeline/run";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => {
    const projects = await listProjects();
    const rows = await Promise.all(projects.slice(0, 60).map(async (p) => {
      const [renders, product] = await Promise.all([getRenders(p.id), getProduct(p.id)]);
      const done = renders.find((r) => r.status === "done");
      return { ...p, title: product?.title, brand: product?.brand, poster: done?.poster ?? product?.assets[0]?.path ?? null };
    }));
    return json(rows);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { url, authorized } = (await req.json()) as { url?: string; authorized?: boolean };
    if (!authorized) return fail("Confirm you own or are authorized to market this product.");
    let u: URL;
    try { u = new URL(String(url ?? "").trim()); } catch { return fail("That doesn't look like a URL."); }
    if (!/^https?:$/.test(u.protocol)) return fail("Use an http(s) product URL.");
    const project = await createProject(u.toString(), true);
    void startPipeline(project.id);
    return json(project, 201);
  });
}
