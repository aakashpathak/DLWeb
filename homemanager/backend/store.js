// Tiny JSON-file store: Ring refresh token, phone push tokens, last 7 days of events.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_MS = 7 * 24 * 3600_000;

export function openStore(dir) {
  mkdirSync(join(dir, 'snaps'), { recursive: true });
  const file = join(dir, 'state.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  state.events ||= [];
  state.pushTokens ||= [];
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const cutoff = Date.now() - KEEP_MS;
      const keep = new Set();
      state.events = state.events.filter((e) => Date.parse(e.at) >= cutoff).slice(-2000);
      for (const e of state.events) keep.add(`${e.id}.jpg`);
      for (const f of readdirSync(join(dir, 'snaps'))) if (!keep.has(f)) rmSync(join(dir, 'snaps', f), { force: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
      renameSync(`${file}.tmp`, file);
    }, 300);
  };
  return {
    state,
    save,
    snapPath: (id) => join(dir, 'snaps', `${String(id).replace(/[^\w-]/g, '')}.jpg`),
  };
}
