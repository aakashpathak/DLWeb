// Copies the Home Manager web app (one folder up) into www/ so the iOS shell bundles it.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');
const out = join(here, '..', 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.js', 'icons']) {
  if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f), { recursive: true });
}
console.log('www/ prepared from', src);
