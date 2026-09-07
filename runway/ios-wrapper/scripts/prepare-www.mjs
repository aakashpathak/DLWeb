// Copies the Runway web app (one folder up) into www/ so the iOS shell bundles it.
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');
const out = join(here, '..', 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.js', 'planner.js', 'nlp.js', 'store.js', 'firebase-config.js', 'manifest.webmanifest', 'sw.js', 'icons']) {
  if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f), { recursive: true });
}
// The service worker is a browser thing; the native shell serves files itself.
let html = readFileSync(join(out, 'index.html'), 'utf8');
html = html.replace(/<link rel="manifest"[^>]*>\s*/g, '');
writeFileSync(join(out, 'index.html'), html);
console.log('www/ prepared from', src);
