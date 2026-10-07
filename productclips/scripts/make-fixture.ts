// Builds a self-contained demo store (fictional brand "Halden") with
// generated product photography, so the whole pipeline can run offline.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "fixtures", "halden");

// A ceramic-look insulated bottle drawn in SVG.
function bottle(body: string, cap: string, x: number, y: number, s: number, opts: { label?: boolean; shadow?: boolean } = {}) {
  const w = 300 * s, h = 860 * s;
  return `
  ${opts.shadow !== false ? `<ellipse cx="${x}" cy="${y + h + 18 * s}" rx="${w * 0.62}" ry="${26 * s}" fill="rgba(0,0,0,0.18)" filter="url(#blur)"/>` : ""}
  <g transform="translate(${x - w / 2},${y})">
    <rect x="${w * 0.22}" y="0" width="${w * 0.56}" height="${h * 0.12}" rx="${18 * s}" fill="${cap}"/>
    <rect x="${w * 0.2}" y="${h * 0.1}" width="${w * 0.6}" height="${h * 0.04}" rx="${6 * s}" fill="${cap}" opacity="0.85"/>
    <path d="M ${w * 0.18} ${h * 0.14} Q 0 ${h * 0.2} 0 ${h * 0.3} L 0 ${h * 0.94} Q 0 ${h} ${w * 0.08} ${h} L ${w * 0.92} ${h} Q ${w} ${h} ${w} ${h * 0.94} L ${w} ${h * 0.3} Q ${w} ${h * 0.2} ${w * 0.82} ${h * 0.14} Z" fill="url(#g-${body.slice(1)})"/>
    <rect x="${w * 0.08}" y="${h * 0.3}" width="${w * 0.12}" height="${h * 0.6}" rx="${w * 0.06}" fill="rgba(255,255,255,0.22)"/>
    ${opts.label !== false ? `<text x="${w / 2}" y="${h * 0.62}" text-anchor="middle" font-family="Georgia, serif" font-size="${44 * s}" letter-spacing="${6 * s}" fill="rgba(255,255,255,0.85)">HALDEN</text>` : ""}
  </g>`;
}
const defs = (colors: string[]) => `<defs><filter id="blur"><feGaussianBlur stdDeviation="12"/></filter>
  ${colors.map((c) => `<linearGradient id="g-${c.slice(1)}" x1="0" x2="1"><stop offset="0" stop-color="${c}" stop-opacity="0.85"/><stop offset="0.45" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0.7"/></linearGradient>`).join("")}
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3d9b8"/><stop offset="1" stop-color="#d9a77c"/></linearGradient>
  <linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c2433"/><stop offset="1" stop-color="#3a3f58"/></linearGradient></defs>`;

const COLORS = { Sage: "#7f9a83", Clay: "#c27a5a", Ink: "#2b3442", Oat: "#d8c7a8" };

async function svg(name: string, w: number, h: number, body: string) {
  const buf = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs(Object.values(COLORS))}${body}</svg>`);
  await sharp(buf).jpeg({ quality: 92 }).toFile(path.join(OUT, name));
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  // 1. Packshot on warm off-white
  await svg("packshot-sage.jpg", 1600, 2000, `<rect width="1600" height="2000" fill="#f4efe8"/>${bottle(COLORS.Sage, "#3b3b3b", 800, 420, 1.4)}`);
  // variants
  for (const [n, c] of Object.entries(COLORS)) await svg(`packshot-${n.toLowerCase()}.jpg`, 1600, 2000, `<rect width="1600" height="2000" fill="#f4efe8"/>${bottle(c, "#3b3b3b", 800, 420, 1.4)}`);
  // 2. Lifestyle: desk at golden hour
  await svg("lifestyle-desk.jpg", 1800, 2400, `<rect width="1800" height="2400" fill="url(#sky)"/>
    <rect x="0" y="1500" width="1800" height="900" fill="#8a5a3c"/><rect x="0" y="1500" width="1800" height="26" fill="#6e4630"/>
    <circle cx="1380" cy="520" r="230" fill="#fff3d6" opacity="0.8"/>
    <rect x="160" y="1140" width="520" height="360" rx="20" fill="#2d2d2d"/><rect x="190" y="1170" width="460" height="300" rx="8" fill="#5a7690"/>
    <rect x="1180" y="1320" width="380" height="180" rx="16" fill="#efe6d8"/><rect x="1210" y="1290" width="320" height="40" rx="8" fill="#c9b79c"/>
    ${bottle(COLORS.Sage, "#3b3b3b", 930, 690, 0.95)}`);
  // 3. Detail close-up of the cap
  await svg("detail-cap.jpg", 1600, 1600, `<rect width="1600" height="1600" fill="#e9e2d8"/>
    <rect x="420" y="260" width="760" height="300" rx="60" fill="#3b3b3b"/><rect x="380" y="540" width="840" height="90" rx="20" fill="#2f2f2f"/>
    <path d="M 340 630 L 1260 630 L 1400 900 L 1400 1600 L 200 1600 L 200 900 Z" fill="${COLORS.Sage}"/>
    <rect x="560" y="330" width="480" height="40" rx="20" fill="#555"/><circle cx="1110" cy="410" r="38" fill="#c9a96e"/>`);
  // 4. Infographic with baked-in text
  await svg("infographic-temp.jpg", 1600, 1600, `<rect width="1600" height="1600" fill="#f4efe8"/>
    <text x="800" y="200" text-anchor="middle" font-family="Georgia, serif" font-size="96" fill="#2b3442">24h cold. 12h hot.</text>
    <text x="800" y="290" text-anchor="middle" font-family="Helvetica, Arial" font-size="44" fill="#6b6b6b">Double-wall vacuum insulation</text>
    ${bottle(COLORS.Clay, "#3b3b3b", 800, 420, 1.15)}
    <rect x="130" y="760" width="260" height="120" rx="60" fill="#7aa3c8"/><text x="260" y="836" text-anchor="middle" font-family="Helvetica" font-size="52" fill="#fff">24h</text>
    <rect x="1210" y="760" width="260" height="120" rx="60" fill="#d9764f"/><text x="1340" y="836" text-anchor="middle" font-family="Helvetica" font-size="52" fill="#fff">12h</text>`);
  // 5. Night scene (glow-in-the-dark claim on the page)
  await svg("lifestyle-night.jpg", 1800, 2400, `<rect width="1800" height="2400" fill="url(#night)"/>
    <circle cx="420" cy="420" r="120" fill="#f5f1d8" opacity="0.9"/>
    <rect x="0" y="1700" width="1800" height="700" fill="#262a38"/>
    ${bottle(COLORS.Ink, "#1f1f1f", 900, 860, 0.95)}
    <rect x="845" y="900" width="110" height="26" rx="13" fill="#d8ffcf" opacity="0.9"/>`);
  // 6. Small low-res swatch (should be ignored or carded)
  await svg("swatches.jpg", 900, 300, `<rect width="900" height="300" fill="#fff"/>${Object.values(COLORS).map((c, i) => `<circle cx="${130 + i * 210}" cy="150" r="80" fill="${c}"/>`).join("")}`);
  // logo
  await fs.writeFile(path.join(OUT, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="80" viewBox="0 0 360 80"><text x="0" y="60" font-family="Georgia, serif" font-size="60" letter-spacing="14" fill="#2b3442">HALDEN</text></svg>`);
  console.log("fixture written to", OUT);
}
main();
