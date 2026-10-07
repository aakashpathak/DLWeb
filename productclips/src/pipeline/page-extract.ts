// Runs inside the product page. Kept as a plain JS string so bundlers can't
// inject helpers that don't exist in the page context.
export const EXTRACT_SCRIPT = String.raw`(() => {
  const txt = (el) => (el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim();
  const abs = (u) => { try { return new URL(u, location.href).toString(); } catch (e) { return null; } };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05; };
  const out = { jsonld: [], meta: {}, dom: {}, styles: {}, images: [], logo: null, isShopify: false, fonts: [], googleFonts: [], lang: document.documentElement.lang || "" };

  // JSON-LD
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent || "null");
      const walk = (n) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n !== "object") return;
        const t = [].concat(n["@type"] || []); if (t.includes("Product") || t.includes("ProductGroup")) out.jsonld.push(n); if (n["@graph"]) walk(n["@graph"]); };
      walk(j);
    } catch (e) {}
  }
  // meta
  for (const m of document.querySelectorAll("meta[property], meta[name]")) {
    const k = m.getAttribute("property") || m.getAttribute("name"); const v = m.getAttribute("content");
    if (k && v && /^(og:|product:|twitter:|description$|theme-color$)/.test(k)) out.meta[k] = v;
  }
  out.isShopify = !!(window.Shopify || document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"]'));
  out.shopifyHandle = (location.pathname.match(/\/products\/([^/?#]+)/) || [])[1] || null;

  // DOM fallback
  const h1 = [...document.querySelectorAll("h1")].find(visible);
  out.dom.h1 = txt(h1);
  const priceEl = [...document.querySelectorAll('[class*="price" i], [data-price], [itemprop="price"]')].find((e) => visible(e) && /\d/.test(txt(e)) && txt(e).length < 40);
  out.dom.price = txt(priceEl);
  const buyRe = /add to (cart|bag|basket)|buy now|shop now|order now|get it|add to trolley|in den warenkorb|ajouter au panier/i;
  const buttons = [...document.querySelectorAll('button, a[role="button"], input[type="submit"], a[class*="button" i], a[class*="btn" i]')].filter(visible);
  const buy = buttons.find((b) => buyRe.test(txt(b) || b.value || "")) || buttons.find((b) => /cart|bag|buy/i.test(b.className + " " + (b.name || "")));
  out.dom.cta = buy ? (txt(buy) || buy.value || "").slice(0, 32) : "";
  // bullets near the buy button / product info
  const scope = (buy && (buy.closest('form, [class*="product" i], main, section'))) || document.querySelector("main") || document.body;
  const lis = [...(scope.closest('[class*="product" i]') || scope).querySelectorAll("li")].filter(visible).map(txt).filter((t) => t.length > 3 && t.length < 120);
  out.dom.bullets = [...new Set(lis)].slice(0, 30);
  // accordions / spec tables
  const specs = {};
  for (const d of document.querySelectorAll("details, [class*=accordion i], [class*=collapsible i]")) {
    const head = txt(d.querySelector("summary, button, h2, h3, h4")).slice(0, 40); const body = txt(d).replace(head, "").trim().slice(0, 400);
    if (head && body) specs[head] = body;
  }
  for (const tr of document.querySelectorAll("table tr, dl")) {
    const cells = tr.tagName === "DL" ? [...tr.children] : [...tr.children];
    if (cells.length >= 2) { const k = txt(cells[0]).slice(0, 40), v = txt(cells[1]).slice(0, 200); if (k && v && k.length < 40) specs[k] = v; }
  }
  out.dom.specs = specs;
  out.dom.description = txt(document.querySelector('[class*="description" i], [itemprop="description"]')).slice(0, 2000);
  out.dom.reviews = [...document.querySelectorAll('[class*="review" i] p, [class*="review-body" i], [class*="testimonial" i] p, [itemprop="reviewBody"]')]
    .map(txt).filter((t) => t.length > 20 && t.length < 260).slice(0, 12);
  const ratingEl = document.querySelector('[class*="rating" i][aria-label], [class*="stars" i][aria-label], [itemprop="ratingValue"]');
  out.dom.rating = ratingEl ? (ratingEl.getAttribute("aria-label") || ratingEl.getAttribute("content") || txt(ratingEl)) : "";
  const countEl = [...document.querySelectorAll('[class*="review" i], [class*="rating" i]')].map(txt).find((t) => /\d[\d,.]*\s*(reviews|ratings)/i.test(t) && t.length < 60);
  out.dom.reviewCount = countEl || "";
  // variants (swatches)
  out.dom.swatches = [...document.querySelectorAll('[class*="swatch" i] [aria-label], [class*="color" i] input[type=radio], [class*="colour" i] input[type=radio], [data-option-value]')]
    .map((e) => e.getAttribute("aria-label") || e.getAttribute("value") || e.getAttribute("data-option-value")).filter(Boolean).slice(0, 12);

  // images: gallery first
  const seen = new Set();
  const addImg = (u, w, h, area, inGallery, alt) => { if (!u || seen.has(u) || u.startsWith("data:")) return; seen.add(u); out.images.push({ url: u, w, h, area, inGallery, alt: alt || "" }); };
  const gallery = document.querySelector('[class*="gallery" i], [class*="media" i][class*="product" i], [class*="product__media" i], [class*="carousel" i], [class*="slider" i]');
  for (const img of document.querySelectorAll("img, picture source")) {
    const isSource = img.tagName === "SOURCE";
    const el = isSource ? img.parentElement.querySelector("img") : img;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
    let best = null, bw = 0;
    for (const part of srcset.split(/,\s+(?=\S)/)) { const [u, d] = part.trim().split(/\s+/); const w = d && d.endsWith("w") ? parseInt(d) : d && d.endsWith("x") ? parseFloat(d) * 1000 : 1; if (u && w >= bw) { bw = w; best = abs(u); } }
    const src = best || abs(img.getAttribute("data-zoom") || img.getAttribute("data-src") || img.getAttribute("src") || el.currentSrc || "");
    if (!src || /\.svg(\?|$)/i.test(src) || /sprite|icon|logo|badge|payment|flag|avatar/i.test(src + " " + (el.alt || "") + " " + el.className)) continue;
    const natural = Math.max(el.naturalWidth || 0, bw);
    if (natural && natural < 300 && r.width < 200) continue;
    addImg(src, el.naturalWidth || 0, el.naturalHeight || 0, r.width * r.height, !!(gallery && gallery.contains(el)), el.alt);
  }
  for (const v of document.querySelectorAll("video")) { const s = v.currentSrc || (v.querySelector("source") || {}).src; if (s) out.video = abs(s); }

  // logo
  const header = document.querySelector("header") || document.body;
  const logoEl = header.querySelector('[class*="logo" i] svg, [class*="logo" i] img, a[href="/"] svg, a[href="/"] img, img[alt*="logo" i], svg[class*="logo" i]');
  if (logoEl) {
    if (logoEl.tagName.toLowerCase() === "svg") {
      const c = logoEl.cloneNode(true); const r = logoEl.getBoundingClientRect();
      if (!c.getAttribute("width")) { c.setAttribute("width", String(Math.round(r.width))); c.setAttribute("height", String(Math.round(r.height))); }
      if (!c.getAttribute("xmlns")) c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const fill = getComputedStyle(logoEl).color; c.setAttribute("color", fill);
      out.logo = { svg: c.outerHTML.replace(/currentColor/g, fill), w: r.width, h: r.height };
    } else out.logo = { url: abs(logoEl.currentSrc || logoEl.src), w: logoEl.naturalWidth, h: logoEl.naturalHeight };
  }
  const icon = document.querySelector('link[rel="apple-touch-icon"], link[rel~="icon"]');
  out.favicon = icon ? abs(icon.href) : null;

  // computed styles for the brand kit
  const cs = (el) => el ? getComputedStyle(el) : null;
  const font = (el) => { const s = cs(el); return s ? { family: s.fontFamily, weight: +s.fontWeight || 400, letterSpacing: s.letterSpacing, textTransform: s.textTransform, size: parseFloat(s.fontSize) } : null; };
  const bgOf = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; el = el.parentElement; } return "rgb(255, 255, 255)"; };
  out.styles.bg = bgOf(document.querySelector("main") || document.body);
  out.styles.ink = cs(document.body).color;
  out.styles.h1 = font(h1 || document.querySelector("h1, h2"));
  out.styles.body = font([...document.querySelectorAll("p")].find(visible) || document.body);
  if (buy) { const s = cs(buy); out.styles.button = { bg: bgOf(buy), color: s.color, radius: parseFloat(s.borderTopLeftRadius) || 0, height: buy.getBoundingClientRect().height, shadow: s.boxShadow !== "none", border: parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== s.backgroundColor, font: font(buy) }; }
  const link = [...document.querySelectorAll("main a, a")].find((a) => visible(a) && !a.closest("header, footer, nav"));
  out.styles.link = link ? cs(link).color : null;
  const accentEl = [...document.querySelectorAll('[class*="badge" i], [class*="tag" i], [class*="sale" i], [class*="label" i], [class*="announcement" i]')].find(visible);
  out.styles.accent = accentEl ? bgOf(accentEl) : null;
  out.styles.accentText = accentEl ? cs(accentEl).color : null;
  const cards = [...document.querySelectorAll('[class*="card" i], img')].filter(visible).slice(0, 10);
  out.styles.cardRadius = cards.map((c) => parseFloat(cs(c).borderTopLeftRadius) || 0).sort((a, b) => b - a)[0] || 0;
  out.styles.themeColor = (document.querySelector('meta[name="theme-color"]') || {}).content || null;
  // fonts actually loaded + Google Fonts links
  try { document.fonts.forEach((f) => { if (f.status === "loaded") out.fonts.push({ family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style }); }); } catch (e) {}
  out.googleFonts = [...document.querySelectorAll('link[href*="fonts.googleapis.com"]')].map((l) => l.href);
  return out;
})()`;
