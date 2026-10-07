// Step 1 — Ingest: open the product page, extract structured product data,
// download full-res images, capture screenshots and the logo.
import type { BrowserContext, Page } from "playwright-core";
import { getBrowser } from "./browser";
import { EXTRACT_SCRIPT } from "./page-extract";
import { dHash, hamming, maxResUrl, normalizeImage } from "./images";
import { newId, projectFile, putFile } from "../lib/store";
import type { AssetRef, Product } from "../lib/schema";

export class BlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = "BlockedError"; }
}

export type RawExtraction = Awaited<ReturnType<typeof runExtract>>;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 ProductClips/0.1";

export async function ingest(projectId: string, url: string, log: (m: string) => void = () => {}) {
  await checkRobots(url);
  const browser = await getBrowser(url);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, deviceScaleFactor: 1, ignoreHTTPSErrors: false });
  try {
    const page = await desktop.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => { throw new Error(`Could not open the page: ${e.message.split("\n")[0]}`); });
    const status = resp?.status() ?? 0;
    if ([401, 403, 429, 503].includes(status)) throw new BlockedError(`The site answered ${status}.`);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await detectBotWall(page);
    await dismissPopups(page);
    await autoScroll(page);
    log("Reading product data");
    const raw = await runExtract(page);

    let shop: ShopifyProduct | null = null;
    if (raw.isShopify && raw.shopifyHandle) shop = await fetchShopify(desktop, url, raw.shopifyHandle);

    // screenshots
    log("Capturing screenshots");
    const shots: AssetRef[] = [];
    await page.evaluate("window.scrollTo(0,0)");
    const dShot = await page.screenshot({ fullPage: true, type: "jpeg", quality: 82, clip: undefined, timeout: 20000 }).catch(() => null);
    if (dShot) shots.push(await saveBuf(projectId, dShot, "screenshot", "desktop"));
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, userAgent: UA.replace("Macintosh; Intel Mac OS X 14_5", "iPhone; CPU iPhone OS 18_0 like Mac OS X") });
    try {
      const mp = await mobile.newPage();
      await mp.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await mp.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await dismissPopups(mp);
      const mShot = await mp.screenshot({ fullPage: false, type: "jpeg", quality: 85 }).catch(() => null);
      if (mShot) shots.push(await saveBuf(projectId, mShot, "screenshot", "mobile"));
    } catch { /* mobile is best-effort */ } finally { await mobile.close(); }

    // images
    log("Downloading full-res images");
    const candidates = rankImages(raw, shop, page.url());
    const assets = await downloadImages(desktop, projectId, candidates, url);
    if (!assets.length) throw new BlockedError("No product images could be downloaded.");

    // logo
    let logo: AssetRef | undefined;
    if (raw.logo?.svg) {
      const n = await normalizeImage(Buffer.from(raw.logo.svg)).catch(() => null);
      if (n) logo = await saveNormalized(projectId, n, "logo");
    } else if (raw.logo?.url || raw.favicon) {
      const buf = await fetchBuf(desktop, (raw.logo?.url || raw.favicon)!, url);
      const n = buf && await normalizeImage(buf);
      if (n) logo = await saveNormalized(projectId, n, "logo");
    }

    const product = buildProduct(url, raw, shop, assets, logo, shots);
    return { product, raw };
  } finally {
    await desktop.close();
  }
}

async function runExtract(page: Page) {
  return (await page.evaluate(EXTRACT_SCRIPT)) as {
    jsonld: Record<string, unknown>[]; meta: Record<string, string>; isShopify: boolean; shopifyHandle: string | null; lang: string;
    dom: { h1: string; price: string; cta: string; bullets: string[]; specs: Record<string, string>; description: string; reviews: string[]; rating: string; reviewCount: string; swatches: string[] };
    styles: {
      bg: string; ink: string; link: string | null; accent: string | null; accentText: string | null; cardRadius: number; themeColor: string | null;
      h1: FontInfo | null; body: FontInfo | null;
      button?: { bg: string; color: string; radius: number; height: number; shadow: boolean; border: boolean; font: FontInfo | null };
    };
    images: { url: string; w: number; h: number; area: number; inGallery: boolean; alt: string }[];
    logo: { svg?: string; url?: string; w: number; h: number } | null; favicon: string | null;
    fonts: { family: string; weight: string; style: string }[]; googleFonts: string[]; video?: string;
  };
}
export type FontInfo = { family: string; weight: number; letterSpacing: string; textTransform: string; size: number };

// ---------- robots + bot walls ----------
async function checkRobots(url: string) {
  const u = new URL(url);
  if (["localhost", "127.0.0.1"].includes(u.hostname)) return;
  try {
    const res = await fetch(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const txt = await res.text();
    let applies = false;
    const rules: string[] = [];
    for (const line of txt.split(/\r?\n/)) {
      const [k, ...rest] = line.split(":"); const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k.trim())) applies = v === "*" || /productclips/i.test(v);
      else if (applies && /^disallow$/i.test(k.trim()) && v) rules.push(v);
    }
    const path = u.pathname + u.search;
    const hit = rules.find((r) => r === "/" || (r.endsWith("$") ? path === r.slice(0, -1) : path.startsWith(r.replace(/\*.*$/, ""))) && !r.includes("*"));
    if (hit) throw new BlockedError(`robots.txt disallows ${hit}`);
  } catch (e) { if (e instanceof BlockedError) throw e; }
}

async function detectBotWall(page: Page) {
  const title = (await page.title()).toLowerCase();
  const body = ((await page.textContent("body").catch(() => "")) || "").slice(0, 4000).toLowerCase();
  const walls = ["verify you are human", "are you a robot", "access denied", "attention required", "just a moment", "captcha", "px-captcha", "request unsuccessful", "pardon our interruption"];
  if (walls.some((w) => title.includes(w) || body.includes(w)) && body.length < 3000) throw new BlockedError("The site shows a bot check.");
}

async function dismissPopups(page: Page) {
  const sel = [
    "#onetrust-accept-btn-handler", "button#accept-recommended-btn-handler", "[id*=cookie i] button", "[class*=cookie i] button", "[class*=consent i] button",
    "[aria-label*=close i]", "[class*=modal i] [class*=close i]", "[class*=popup i] [class*=close i]", "button[class*=dismiss i]",
  ];
  for (const s of sel) {
    const els = await page.$$(s).catch(() => []);
    for (const el of els.slice(0, 3)) {
      const t = ((await el.textContent().catch(() => "")) || "").toLowerCase();
      const label = ((await el.getAttribute("aria-label").catch(() => "")) || "").toLowerCase();
      if (/accept|agree|got it|ok|allow|close|no thanks|dismiss|×|✕/.test(t + " " + label) || s.includes("close")) await el.click({ timeout: 1000 }).catch(() => {});
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

async function autoScroll(page: Page) {
  await page.evaluate(`(async () => {
    const h = () => document.body.scrollHeight;
    for (let y = 0; y < Math.min(h(), 14000); y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  })()`).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
}

// ---------- Shopify fast path ----------
type ShopifyProduct = { title: string; vendor: string; description: string; price: number; compare_at_price?: number; images: string[]; variants: { title: string; option1?: string; featured_image?: { src: string } | null; price: number }[]; options?: { name: string; values: string[] }[] };
async function fetchShopify(ctx: BrowserContext, url: string, handle: string): Promise<ShopifyProduct | null> {
  try {
    const u = new URL(url);
    const res = await ctx.request.get(`${u.origin}/products/${handle}.js`, { timeout: 15000 });
    if (!res.ok()) return null;
    const j = (await res.json()) as ShopifyProduct;
    j.images = (j.images || []).map((s) => (s.startsWith("//") ? "https:" + s : s));
    return j;
  } catch { return null; }
}

// ---------- images ----------
function rankImages(raw: RawExtraction, shop: ShopifyProduct | null, base: string) {
  const urls: { url: string; score: number }[] = [];
  const push = (u: string | undefined | null, score: number) => {
    if (!u) return;
    try { urls.push({ url: maxResUrl(new URL(u, base).toString()), score }); } catch { /* not a URL */ }
  };
  shop?.images.forEach((u, i) => push(u, 100 - i));
  for (const p of raw.jsonld) for (const im of ([] as unknown[]).concat((p as { image?: unknown }).image ?? [])) push(typeof im === "string" ? im : (im as { url?: string })?.url, 80);
  push(raw.meta["og:image"], 60);
  raw.images.forEach((im, i) => push(im.url, (im.inGallery ? 50 : 10) + Math.min(30, im.area / 20000) - i * 0.2));
  const best = new Map<string, number>();
  for (const u of urls) best.set(u.url, Math.max(best.get(u.url) ?? 0, u.score));
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 24);
}

async function fetchBuf(ctx: BrowserContext, url: string, referer: string): Promise<Buffer | null> {
  try {
    const res = await ctx.request.get(url, { headers: { referer }, timeout: 20000 });
    if (!res.ok()) return null;
    return Buffer.from(await res.body());
  } catch { return null; }
}

async function downloadImages(ctx: BrowserContext, projectId: string, urls: string[], referer: string) {
  const got: (AssetRef & { hash: string; area: number })[] = [];
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift()!;
      const buf = await fetchBuf(ctx, u, referer);
      if (!buf) continue;
      const n = await normalizeImage(buf);
      if (!n || Math.min(n.width, n.height) < 300) continue;
      const hash = await dHash(n.data);
      const dup = got.find((g) => hamming(g.hash, hash) <= 6);
      if (dup) {
        if (dup.area >= n.width * n.height) continue;
        got.splice(got.indexOf(dup), 1); // keep the larger copy
      }
      const ref = await saveNormalized(projectId, n, "image", u);
      got.push({ ...ref, hash, area: n.width * n.height });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // keep source order (gallery order matters)
  return got.sort((a, b) => urls.indexOf(a.sourceUrl!) - urls.indexOf(b.sourceUrl!)).slice(0, 16).map(({ hash: _h, area: _a, ...r }) => r);
}

async function saveNormalized(projectId: string, n: { data: Buffer; ext: string; width: number; height: number }, kind: AssetRef["kind"], sourceUrl?: string): Promise<AssetRef> {
  const id = newId(8);
  const path = await putFile(projectFile(projectId, `${kind}-${id}.${n.ext}`), n.data);
  return { id, path, sourceUrl, width: n.width, height: n.height, kind, mime: n.ext === "png" ? "image/png" : "image/jpeg" };
}
async function saveBuf(projectId: string, buf: Buffer, kind: AssetRef["kind"], name: string): Promise<AssetRef> {
  const n = await normalizeImage(buf);
  const id = newId(8);
  const path = await putFile(projectFile(projectId, `${kind}-${name}-${id}.jpg`), n?.data ?? buf);
  return { id, path, width: n?.width ?? 1440, height: n?.height ?? 900, kind };
}

// ---------- product assembly ----------
const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
function stripHtml(html: string) { return html.replace(/<li[^>]*>/gi, "\n• ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"'); }

const NOISE = /shipping|returns?|warranty|privacy|cookie|sign up|newsletter|log ?in|account|size guide|klarna|afterpay|subscribe|wishlist|share|©|reviews?$|^\$|^[\d\s.,$€£]+$|menu|search|cart|checkout|help|contact|faq|gift card|store locator|careers|terms/i;
export function extractBenefits(texts: string[]): string[] {
  const out: string[] = [];
  for (const t0 of texts) {
    const t = clean(t0).replace(/^[•\-–*✓✔︎·]\s*/, "");
    if (t.length < 4 || t.length > 110 || NOISE.test(t)) continue;
    if (t.split(" ").length > 18) continue;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, 12);
}

function buildProduct(url: string, raw: RawExtraction, shop: ShopifyProduct | null, assets: AssetRef[], logo: AssetRef | undefined, shots: AssetRef[]): Product {
  const ld = (raw.jsonld[0] ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const offers = [].concat(ld.offers ?? []).flatMap((o: any) => (o?.offers ? [].concat(o.offers) : [o])) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const offer = offers[0] ?? {};
  const agg = ld.aggregateRating ?? {};
  const currency = offer.priceCurrency ?? raw.meta["product:price:currency"] ?? raw.meta["og:price:currency"];
  const priceNum = shop ? shop.price / 100 : parseFloat(offer.price ?? offer.lowPrice ?? raw.meta["product:price:amount"] ?? "");
  const price = Number.isFinite(priceNum) && priceNum > 0 ? formatPrice(priceNum, currency) : clean(raw.dom.price).match(/[$€£¥₹]\s?\d[\d,.]*/)?.[0];
  const brandName = clean(typeof ld.brand === "string" ? ld.brand : ld.brand?.name) || clean(shop?.vendor) || clean(raw.meta["og:site_name"]) || new URL(url).hostname.replace(/^www\./, "").split(".")[0];
  const title = clean(shop?.title) || clean(ld.name) || clean(raw.dom.h1) || clean(raw.meta["og:title"]);
  const descHtml = shop?.description || ld.description || raw.dom.description || raw.meta["og:description"] || raw.meta.description || "";
  const descText = clean(stripHtml(descHtml));
  const descBullets = stripHtml(descHtml).split(/\n|•/).map(clean).filter(Boolean);
  const sentences = descText.split(/(?<=[.!?])\s+/).filter((s) => s.length < 110);
  const benefits = extractBenefits([...descBullets.filter((b) => b.length < 110), ...raw.dom.bullets, ...sentences]);
  const reviews = [
    ...[].concat(ld.review ?? []).map((r: any) => clean(r?.reviewBody ?? r?.description)), // eslint-disable-line @typescript-eslint/no-explicit-any
    ...raw.dom.reviews,
  ].filter((r) => r && r.length > 15).slice(0, 8);
  const rating = parseFloat(agg.ratingValue ?? raw.dom.rating.match(/(\d(?:\.\d)?)\s*(out of|\/|stars?)/i)?.[1] ?? "");
  const reviewCount = parseInt(String(agg.reviewCount ?? agg.ratingCount ?? raw.dom.reviewCount.match(/([\d,]+)\s*(reviews|ratings)/i)?.[1] ?? "").replace(/,/g, ""));

  // variants → images by matching source URLs
  const variants: Product["variants"] = [];
  if (shop?.variants?.length) {
    const byName = new Map<string, string[]>();
    for (const v of shop.variants) {
      const name = v.option1 ?? v.title;
      const src = v.featured_image?.src ? maxResUrl(v.featured_image.src.startsWith("//") ? "https:" + v.featured_image.src : v.featured_image.src) : null;
      const a = src ? assets.find((x) => x.sourceUrl && stripQuery(x.sourceUrl) === stripQuery(src)) : undefined;
      if (!byName.has(name)) byName.set(name, []);
      if (a) byName.get(name)!.push(a.id);
    }
    for (const [name, ids] of byName) variants.push({ name, imageIds: ids });
  } else if (raw.dom.swatches.length) for (const s of raw.dom.swatches) variants.push({ name: s, imageIds: [] });
  const ldVariants = ld.hasVariant as any[] | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!variants.length && Array.isArray(ldVariants)) {
    for (const v of ldVariants) {
      const img = [].concat(v.image ?? [])[0] as string | undefined;
      const a = img ? assets.find((x) => x.sourceUrl && stripQuery(x.sourceUrl) === stripQuery(maxResUrl(new URL(img, url).toString()))) : undefined;
      variants.push({ name: clean(v.color ?? v.name), imageIds: a ? [a.id] : [] });
    }
  }

  const specs: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.dom.specs)) if (!NOISE.test(k)) specs[k] = v;

  return {
    url, brand: brandName, title, price, currency, rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    reviewCount: Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : undefined, topReviews: reviews, benefits, description: descText.slice(0, 1500),
    specs, variants, ctaText: clean(raw.dom.cta) || undefined, language: (raw.lang || "en").slice(0, 2), assets, logo, pageScreenshots: shots,
    source: shop ? "shopify" : raw.jsonld.length ? "jsonld" : raw.meta["og:title"] ? "meta" : "dom",
  };
}
const stripQuery = (u: string) => u.split("?")[0];

export function formatPrice(n: number, currency?: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", minimumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
  catch { return `$${n}`; }
}
