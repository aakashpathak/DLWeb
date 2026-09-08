// Runway planning server.
//
// One endpoint: POST /plan  { text, prefs, tz }  ->  plan JSON (see ../plan-contract.js)
// Holds the API key so the phone never does. PROVIDER=claude talks to the
// Anthropic API; PROVIDER=ollama talks to a local model on this computer.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PLAN_SCHEMA, buildSystemPrompt, normalizePlan, extractJSON } from '../plan-contract.js';

// --- config: .env next to this file, then real environment variables win ----
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const cfg = {
  provider: (process.env.PROVIDER || 'claude').toLowerCase(),
  port: Number(process.env.PORT || 8787),
  token: process.env.RUNWAY_TOKEN || '',
  origins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5',
  claudeEffort: process.env.CLAUDE_EFFORT || 'medium',
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
};

const anthropic = cfg.provider === 'claude' ? new Anthropic() : null; // reads ANTHROPIC_API_KEY

// --- providers ---------------------------------------------------------------
async function planWithClaude({ text, prefs, tz, now }) {
  const system = buildSystemPrompt({ prefs, now, tz });
  const params = {
    model: cfg.claudeModel,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: text }],
    output_config: { effort: cfg.claudeEffort, format: { type: 'json_schema', schema: PLAN_SCHEMA } },
  };
  let msg;
  try {
    // Server-side refusal fallback: if a safety classifier declines, the API re-runs on a fallback model in the same call.
    msg = await anthropic.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError) msg = await anthropic.messages.create(params); // older SDK/API without fallbacks
    else throw e;
  }
  if (msg.stop_reason === 'refusal') throw httpError(422, 'Claude declined this request.');
  const block = msg.content.find((b) => b.type === 'text');
  if (!block) throw httpError(502, 'Empty response from Claude.');
  return { plan: extractJSON(block.text), model: msg.model, usage: msg.usage };
}

async function planWithOllama({ text, prefs, tz, now }) {
  const system = buildSystemPrompt({ prefs, now, tz, smallModel: true });
  const body = {
    model: cfg.ollamaModel,
    stream: false,
    format: PLAN_SCHEMA,
    options: { temperature: 0.1, num_ctx: 8192 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
  };
  const ask = async () => {
    const res = await fetch(`${cfg.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw httpError(502, `Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return extractJSON(data.message?.content ?? '');
  };
  let plan;
  try { plan = await ask(); }
  catch (e) { if (e.status) throw e; body.messages.push({ role: 'user', content: 'That was not valid JSON. Output only the JSON object.' }); plan = await ask(); }
  return { plan, model: cfg.ollamaModel };
}

// --- http ------------------------------------------------------------------------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function cors(req, res) {
  const origin = req.headers.origin || '';
  const ok = cfg.origins.includes('*') || cfg.origins.some((o) => o === origin || (o.endsWith('*') && origin.startsWith(o.slice(0, -1))));
  if (ok && origin) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-max-age', '86400');
  res.setHeader('vary', 'origin');
  return ok || !origin;
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(httpError(413, 'Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(httpError(400, 'Body must be JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
  if (!allowed) return send(res, 403, { error: `Origin ${req.headers.origin} is not allowed. Add it to ALLOWED_ORIGINS.` });

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'runway-backend', provider: cfg.provider, model: cfg.provider === 'claude' ? cfg.claudeModel : cfg.ollamaModel, auth: !!cfg.token });
  }
  if (req.method === 'POST' && url.pathname === '/plan') {
    const started = Date.now();
    try {
      if (cfg.token) {
        const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (got !== cfg.token) throw httpError(401, 'Wrong server password.');
      }
      const { text, prefs, tz, now } = await readBody(req);
      if (!text || typeof text !== 'string' || text.length > 2000) throw httpError(400, 'Send { text } (1–2000 characters).');
      const when = now ? new Date(now) : new Date();
      const args = { text, prefs: prefs || {}, tz: typeof tz === 'string' ? tz : undefined, now: isNaN(when) ? new Date() : when };
      const { plan, model } = cfg.provider === 'ollama' ? await planWithOllama(args) : await planWithClaude(args);
      const normalized = normalizePlan(plan, { toISO: (s) => localToISO(s, args.tz) });
      console.log(`[plan] ${model} ${Date.now() - started}ms "${text.slice(0, 60)}" -> ${normalized.steps.length} steps`);
      return send(res, 200, { plan: normalized, model, provider: cfg.provider });
    } catch (e) {
      const status = e.status || (e instanceof Anthropic.AuthenticationError ? 401 : e instanceof Anthropic.RateLimitError ? 429 : e instanceof Anthropic.APIError ? 502 : 500);
      const msg = e instanceof Anthropic.AuthenticationError ? 'The server’s Anthropic API key was rejected.' : e.message || 'Planning failed';
      console.error(`[plan] ${status} ${msg}`);
      return send(res, status, { error: msg });
    }
  }
  send(res, 404, { error: 'Not found. Use POST /plan or GET /health.' });
});

// The model writes local wall-clock times ("2026-09-11T06:00"). Convert them to
// UTC ISO using the phone's timezone (the server may be anywhere).
function localToISO(s, tz) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); }
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!tz) return new Date(y, mo - 1, d, h, mi).toISOString();
  // Find the UTC instant whose wall-clock in tz equals the requested time (handles DST).
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const diff = Date.UTC(y, mo - 1, d, h, mi) - asUTC;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

server.listen(cfg.port, () => {
  console.log(`Runway backend on http://localhost:${cfg.port}  provider=${cfg.provider} model=${cfg.provider === 'claude' ? cfg.claudeModel : cfg.ollamaModel} auth=${cfg.token ? 'on' : 'OFF'}`);
  if (cfg.provider === 'claude' && !process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set — /plan will fail. Put it in backend/.env');
});
