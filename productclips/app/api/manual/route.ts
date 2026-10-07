import { createProject, newId, projectFile, putFile, saveExtras, saveProduct } from "@/lib/store";
import { Product, type AssetRef } from "@/lib/schema";
import { normalizeImage } from "@/pipeline/images";
import { extractBenefits, formatPrice } from "@/pipeline/ingest";
import { startPipeline } from "@/pipeline/run";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** Manual path for sites that block automation: images + pasted copy (+ optional colours). */
export async function POST(req: Request) {
  return handle(async () => {
    const form = await req.formData();
    if (form.get("authorized") !== "on" && form.get("authorized") !== "true") return fail("Confirm you own or are authorized to market this product.");
    const files = form.getAll("images").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
    if (!files.length) return fail("Add at least one product image.");
    const title = String(form.get("title") ?? "").trim();
    if (!title) return fail("Add the product name.");
    const url = String(form.get("url") ?? "").trim() || "manual://upload";
    const project = await createProject(url, true);
    const assets: AssetRef[] = [];
    for (const f of files.slice(0, 16)) {
      const n = await normalizeImage(Buffer.from(await f.arrayBuffer()));
      if (!n) continue;
      const id = newId(8);
      const path = await putFile(projectFile(project.id, `image-${id}.${n.ext}`), n.data);
      assets.push({ id, path, width: n.width, height: n.height, kind: "image", sourceUrl: f.name });
    }
    if (!assets.length) return fail("None of those files are readable images.");
    let logo: AssetRef | undefined;
    const lf = form.get("logo");
    if (lf && typeof lf === "object" && "arrayBuffer" in lf && lf.size) {
      const n = await normalizeImage(Buffer.from(await lf.arrayBuffer()));
      if (n) logo = { id: newId(8), path: await putFile(projectFile(project.id, `logo.${n.ext}`), n.data), width: n.width, height: n.height, kind: "logo" };
    }
    const copy = String(form.get("copy") ?? "");
    const lines = copy.split(/\n|•/).map((l) => l.trim()).filter(Boolean);
    const reviews = String(form.get("reviews") ?? "").split(/\n{1,}/).map((l) => l.trim()).filter((l) => l.length > 10);
    const priceRaw = String(form.get("price") ?? "").trim();
    const product = Product.parse({
      url, brand: String(form.get("brand") ?? "").trim() || title.split(" ")[0], title,
      price: priceRaw ? (/^\d/.test(priceRaw) ? formatPrice(parseFloat(priceRaw)) : priceRaw) : undefined,
      rating: parseFloat(String(form.get("rating") ?? "")) || undefined, reviewCount: parseInt(String(form.get("reviewCount") ?? "")) || undefined,
      topReviews: reviews, benefits: extractBenefits(lines), description: copy.slice(0, 1500), ctaText: String(form.get("cta") ?? "").trim() || undefined,
      assets, logo, pageScreenshots: [], source: "manual",
    });
    await saveProduct(project.id, product);
    const colors = Object.fromEntries(["bg", "ink", "primary", "accent"].map((k) => [k, String(form.get(`color_${k}`) ?? "")]).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)));
    await saveExtras(project.id, { manualColors: colors });
    void startPipeline(project.id, "ingest");
    return json(project, 201);
  });
}
