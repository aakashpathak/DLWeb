// Generates PNG app icons with zero dependencies (Node zlib + hand-rolled PNG).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Icon: indigo rounded square, a light "runway" running up-right with dashed centreline, amber dot (you) near the start.
function icon(size, rounded) {
  const bg = [59, 91, 219], run = [255, 255, 255], dash = [59, 91, 219], you = [255, 178, 36];
  const r = size * 0.22;
  return png(size, (x, y) => {
    const u = x / size, v = y / size;
    // rounded corners
    if (rounded) {
      const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    }
    // amber "you" dot at the start of the runway (drawn on top)
    const dx = u - 0.5, dy = v - 0.76;
    if (dx * dx + dy * dy < 0.05 ** 2) return [...you, 255];
    // runway: a perspective trapezoid from bottom-left to top-right
    // parametrize t along the runway (0 bottom, 1 top), w half-width shrinking
    const t = (v - 0.85) / (0.15 - 0.85);        // 0 at v=0.85, 1 at v=0.15
    if (t >= 0 && t <= 1) {
      const centre = 0.5;                          // vertical runway
      const half = 0.30 * (1 - t) + 0.06 * t;
      if (Math.abs(u - centre) <= half) {
        // dashed centreline
        const dashW = 0.012 * (1 - t) + 0.004 * t;
        if (Math.abs(u - centre) <= dashW && Math.floor(t * 9) % 2 === 0) return [...dash, 255];
        return [...run, 255];
      }
    }
    return [...bg, 255];
  });
}
function splash(size) {
  const bg = [246, 245, 242];
  return png(size, (x, y) => {
    // centred 400px icon on an off-white field
    const half = 200, cx = size / 2, cy = size / 2;
    if (Math.abs(x - cx) < half && Math.abs(y - cy) < half) {
      const px = icon.__pixel || (icon.__pixel = iconPixel(half * 2));
      return px(x - cx + half, y - cy + half, bg);
    }
    return [...bg, 255];
  });
}
function iconPixel(size) {
  const bg = [59, 91, 219], run = [255, 255, 255], dash = [59, 91, 219], you = [255, 178, 36];
  const r = size * 0.22;
  return (x, y, outside) => {
    const u = x / size, v = y / size;
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [...outside, 255];
    const dx = u - 0.5, dy = v - 0.76;
    if (dx * dx + dy * dy < 0.05 ** 2) return [...you, 255];
    const t = (v - 0.85) / (0.15 - 0.85);
    if (t >= 0 && t <= 1) {
      const half = 0.30 * (1 - t) + 0.06 * t;
      if (Math.abs(u - 0.5) <= half) {
        const dashW = 0.012 * (1 - t) + 0.004 * t;
        if (Math.abs(u - 0.5) <= dashW && Math.floor(t * 9) % 2 === 0) return [...dash, 255];
        return [...run, 255];
      }
    }
    return [...bg, 255];
  };
}
for (const s of [180, 192, 512]) writeFileSync(new URL(`../icons/icon-${s}.png`, import.meta.url), icon(s, s !== 180));
// App Store icon (square, no transparency) + splash source for the iOS shell
writeFileSync(new URL('../ios-wrapper/assets/icon.png', import.meta.url), icon(1024, false));
writeFileSync(new URL('../ios-wrapper/assets/splash.png', import.meta.url), splash(2732));
writeFileSync(new URL('../icons/icon-maskable-512.png', import.meta.url), icon(512, false));
console.log('icons written');
