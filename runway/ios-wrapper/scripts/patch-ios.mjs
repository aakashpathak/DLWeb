// Adds the permission texts iOS requires to ios/App/App/Info.plist (idempotent).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const plist = join(here, '..', 'ios', 'App', 'App', 'Info.plist');
let s = readFileSync(plist, 'utf8');
const keys = {
  NSMicrophoneUsageDescription: 'Runway listens when you tap the mic so you can say a task instead of typing it.',
  NSSpeechRecognitionUsageDescription: 'Runway turns what you say into a task and a plan.',
};
for (const [k, v] of Object.entries(keys)) {
  if (s.includes(`<key>${k}</key>`)) continue;
  s = s.replace('</dict>\n</plist>', `\t<key>${k}</key>\n\t<string>${v}</string>\n</dict>\n</plist>`);
}
writeFileSync(plist, s);
console.log('Info.plist patched with microphone + speech permissions');
