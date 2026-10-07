import fs from "node:fs";
import { chromium, type Browser } from "playwright-core";

/** Finds a Chromium binary: env override, the preinstalled Playwright browsers, or common system paths. */
export function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", `${process.env.HOME}/.cache/ms-playwright`].filter(Boolean) as string[];
  for (const root of roots) {
    try {
      const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
      for (const d of dirs) {
        for (const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
          const p = `${root}/${d}/${rel}`;
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* not there */ }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (fs.existsSync(p)) return p;
  return undefined;
}

const shared = new Map<string, Promise<Browser>>();

/** Browser for a target URL: proxied for the public web, direct for local/private hosts. */
export function getBrowser(target?: string): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const direct = !proxy || (target ? isLocal(target) : false);
  const key = direct ? "direct" : "proxy";
  if (!shared.has(key)) {
    shared.set(key, chromium.launch({
      executablePath: chromiumPath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      proxy: direct ? undefined : { server: proxy!, bypass: bypassList() },
    }).catch((e) => { shared.delete(key); throw e; }));
  }
  return shared.get(key)!;
}

export function isLocal(u: string) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local");
  } catch { return false; }
}

/** NO_PROXY → Chromium bypass list (domains only; CIDRs are not understood there). */
function bypassList() {
  const extra = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim()).filter((s) => s && !s.includes("/") && !s.includes("*") && s !== "::");
  return [...new Set(["localhost", "127.0.0.1", ...extra])].join(",");
}
