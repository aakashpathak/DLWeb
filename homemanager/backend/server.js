// Home Manager server.
//
// Stays connected to your Ring account, quietly handles routine events, and only
// pushes to your phone when something needs you. The app talks to it over HTTPS:
//
//   GET  /state                  summary, what was handled today, what needs attention
//   GET  /snapshot/:eventId      the camera still for an event (JPEG)
//   GET  /live/:deviceId         a fresh still from a camera right now (JPEG)
//   POST /events/:id/resolve     { note }   mark an attention item handled
//   POST /secure                 { eventId? }   arm the alarm + turn on camera lights
//   POST /ask                    { question }   ask Home Manager about today
//   POST /push/register          { token }   iPhone push token
//   POST /link/start             { email, password }  -> { needsCode, prompt } or linked
//   POST /link/verify            { code }
//   POST /link/token             { refreshToken }   (from `npx -p ring-client-api ring-auth-cli`)
//   POST /link/remove
//   POST /simulate               { scenario }   fake an event to test the flow end to end

import http from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { classify, settle, summarize, HOLD_MS, COURIER_WINDOW_MS } from './triage.js';
import { connectRing, startLink, finishLink } from './ring.js';
import { createApns } from './apns.js';
import { openStore } from './store.js';

// --- config: .env next to this file, then real environment variables win ----
const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const cfg = {
  port: Number(process.env.PORT || 8788),
  token: process.env.HM_TOKEN || '',
  dataDir: resolve(here, process.env.DATA_DIR || 'data'),
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  holdMs: Number(process.env.HOLD_SECONDS || HOLD_MS / 1000) * 1000,
};

const store = openStore(cfg.dataDir);
const S = store.state;
if (process.env.RING_REFRESH_TOKEN && !S.refreshToken) S.refreshToken = process.env.RING_REFRESH_TOKEN;
// A restart drops pending timers; those visitors are long gone, so just log them.
for (const e of S.events) if (e.status === 'pending') Object.assign(e, { status: 'routine', title: 'Visitor at the door', summary: `Someone came to your ${(e.deviceName || 'door').toLowerCase()}.`, badge: 'Logged' });

const apns = createApns({
  keyFile: process.env.APNS_KEY_FILE && resolve(here, process.env.APNS_KEY_FILE),
  keyId: process.env.APNS_KEY_ID,
  teamId: process.env.APNS_TEAM_ID,
  topic: process.env.APNS_TOPIC || 'fyi.vaak.homemanager',
  production: process.env.APNS_PRODUCTION !== 'false', // TestFlight + App Store use production APNs
});
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// --- Ring ---------------------------------------------------------------------------
let ring = null;
let ringError = null;
const holds = new Map(); // deviceId -> pending person event

async function connect() {
  ring?.disconnect();
  ring = null; ringError = null;
  if (!S.refreshToken) return;
  try {
    ring = await connectRing({
      refreshToken: S.refreshToken,
      onToken: (t) => { S.refreshToken = t; store.save(); },
      onEvent: (ev) => handleEvent(ev).catch((e) => console.error('[event]', e)),
    });
    S.account = ring.account; S.firstName = ring.firstName; store.save();
    for (const ev of await ring.history()) await handleEvent(ev);
    console.log(`[ring] connected as ${ring.account || 'unknown'}`);
  } catch (e) {
    ringError = e.message;
    console.error('[ring] connect failed:', e.message);
  }
}

const recent = () => S.events.filter((e) => Date.now() - Date.parse(e.at) < 30 * 60_000);

async function handleEvent(raw) {
  if (S.events.some((e) => e.id === raw.id)) return;
  const held = holds.get(raw.deviceId);
  // Same person still at the door: the pending decision covers it.
  if (held && (raw.kind === 'person' || raw.kind === 'doorbell')) {
    if (raw.kind === 'doorbell') held.kind = 'doorbell';
    return;
  }
  const decision = classify(raw, recent(), { armed: ring?.armed, live: raw.live !== false });
  const { live, snapshotUuid, ...rest } = raw;
  const ev = { ...rest, ...decision };
  if (decision.status === 'hold') {
    ev.status = 'pending';
    holds.set(raw.deviceId, ev);
    setTimeout(() => decideHeld(raw.deviceId), cfg.holdMs);
  }
  S.events.push(ev);
  store.save();
  console.log(`[event] ${ev.kind} @ ${ev.deviceName} -> ${ev.status}`);

  // A package arriving settles a waiting person right away: it was the courier.
  // Ring's package detection can lag, so also take back a recent "unknown person".
  if (raw.kind === 'package') {
    if (held) decideHeld(raw.deviceId);
    for (const e of S.events) {
      if (e.status !== 'attention' || e.deviceId !== raw.deviceId || !['person', 'doorbell'].includes(e.kind)) continue;
      if (Math.abs(Date.parse(raw.at) - Date.parse(e.at)) <= COURIER_WINDOW_MS) Object.assign(e, settle(e, recent()));
    }
    store.save();
  }
  if (ev.status === 'attention') notify(ev);
  if (raw.live !== false && ring?.wantsSnapshot(ev)) saveSnapshot(ev, snapshotUuid);
}

function decideHeld(deviceId) {
  const ev = holds.get(deviceId);
  if (!ev) return;
  holds.delete(deviceId);
  Object.assign(ev, settle(ev, recent()));
  store.save();
  console.log(`[event] held ${ev.kind} @ ${ev.deviceName} -> ${ev.status}`);
  if (ev.status === 'attention') notify(ev);
}

async function saveSnapshot(ev, uuid) {
  try {
    const jpg = await ring.snapshot(ev.deviceId, uuid);
    if (!jpg) return;
    writeFileSync(store.snapPath(ev.id), jpg);
    ev.hasSnap = true;
    store.save();
  } catch (e) { console.warn(`[snapshot] ${ev.deviceName}: ${e.message}`); }
}

async function notify(ev) {
  if (!apns || !S.pushTokens.length) return;
  const body = ev.summary.replace(/\*\*/g, '');
  const results = await apns.notify(S.pushTokens, { title: ev.title, body, eventId: ev.id });
  for (const r of results) {
    if (r.ok) continue;
    console.warn(`[push] ${r.status} ${r.reason}`);
    if (r.status === 410 || r.reason === 'BadDeviceToken') S.pushTokens = S.pushTokens.filter((t) => t !== r.token);
  }
  store.save();
}

// --- views ---------------------------------------------------------------------------
function stateView() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const pub = ({ id, at, deviceId, deviceName, kind, status, title, summary, badge, hasSnap, resolution }) =>
    ({ id, at, deviceId, deviceName, kind, status, title, summary, badge, hasSnap: !!hasSnap, resolution });
  const newest = (a, b) => Date.parse(b.at) - Date.parse(a.at);
  return {
    linked: !!ring, linking: !!S.refreshToken && !ring && !ringError, error: ringError,
    account: S.account || null, firstName: S.firstName || null,
    hasAlarm: !!ring?.hasAlarm, armed: !!ring?.armed, push: !!apns,
    cameras: ring?.cameras || [],
    summary: summarize(S.events),
    attention: S.events.filter((e) => e.status === 'attention').sort(newest).map(pub),
    handled: S.events.filter((e) => (e.status === 'routine' || e.status === 'resolved') && Date.parse(e.at) >= start.getTime()).sort(newest).slice(0, 40).map(pub),
    watching: S.events.filter((e) => e.status === 'pending').length,
  };
}

async function ask(question) {
  const log = S.events.filter((e) => Date.now() - Date.parse(e.at) < 48 * 3600_000)
    .map((e) => `${new Date(e.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} | ${e.deviceName} | ${e.kind} | ${e.status} | ${e.title}${e.resolution ? ` | resolved: ${e.resolution}` : ''}`)
    .join('\n') || '(no events)';
  if (!anthropic) {
    const s = summarize(S.events);
    return `${s.headline}. I handled ${s.handledToday} routine events today. (Add ANTHROPIC_API_KEY on the server for full answers.)`;
  }
  const msg = await anthropic.messages.create({
    model: cfg.claudeModel,
    max_tokens: 600,
    system: `You are Ring Home Manager, a calm assistant that watches the user's Ring cameras and sensors. Routine events are handled silently; only unusual ones need the user. Answer in 1-3 short sentences, plain text, based only on the event log. Now: ${new Date().toString()}.\nDevices: ${(ring?.cameras || []).map((c) => c.name).join(', ') || 'unknown'}. Alarm: ${ring?.hasAlarm ? (ring.armed ? 'armed' : 'disarmed') : 'none'}.\nEvent log (time | device | kind | status | title):\n${log}`,
    messages: [{ role: 'user', content: question }],
  });
  return msg.content.find((b) => b.type === 'text')?.text || 'I couldn’t answer that.';
}

const SCENARIOS = {
  delivery: [{ kind: 'person', delay: 0 }, { kind: 'package', delay: 4000 }],
  stranger: [{ kind: 'person', delay: 0 }],
  doorbell: [{ kind: 'doorbell', delay: 0 }],
  lingering: [{ kind: 'loitering', delay: 0 }],
  car: [{ kind: 'vehicle', delay: 0 }],
  garage: [{ kind: 'sensor', delay: 0, open: false, name: 'Garage' }],
};
function simulate(name) {
  const steps = SCENARIOS[name];
  if (!steps) throw httpError(400, `Scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  const cam = ring?.cameras.find((c) => c.doorbell) || ring?.cameras[0] || { id: 'demo-door', name: 'Front Door' };
  for (const s of steps) {
    setTimeout(() => handleEvent({
      id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(),
      deviceId: s.kind === 'sensor' ? 'sim-garage' : String(cam.id), deviceName: s.name || cam.name,
      kind: s.kind, open: s.open, live: true, simulated: true,
    }).catch(console.error), s.delay);
  }
}

// --- http ------------------------------------------------------------------------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function cors(res) {
  // The app authenticates with a bearer password, never cookies, so any origin is fine.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-max-age', '86400');
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendJpeg(res, buf) {
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
  res.end(buf);
}
function readBody(req, limit = 32 * 1024) {
  return new Promise((ok, fail) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { fail(httpError(413, 'Request too large')); req.destroy(); } });
    req.on('end', () => { try { ok(data ? JSON.parse(data) : {}); } catch { fail(httpError(400, 'Body must be JSON')); } });
    req.on('error', fail);
  });
}

const routes = {
  'GET /state': () => stateView(),
  'GET /snapshot/:id': (_, [id]) => {
    const p = store.snapPath(id);
    if (!existsSync(p)) throw httpError(404, 'No snapshot for this event.');
    return { jpeg: readFileSync(p) };
  },
  'GET /live/:id': async (_, [id]) => {
    if (!ring) throw httpError(409, 'Ring is not connected.');
    const jpg = await ring.snapshot(id);
    if (!jpg) throw httpError(404, 'Unknown camera.');
    return { jpeg: jpg };
  },
  'POST /events/:id/resolve': (body, [id]) => {
    const ev = S.events.find((e) => e.id === id);
    if (!ev) throw httpError(404, 'Unknown event.');
    ev.status = 'resolved';
    ev.resolution = String(body.note || 'Marked as OK').slice(0, 120);
    ev.badge = `✓ ${ev.resolution}`;
    store.save();
    return stateView();
  },
  'POST /secure': async (body) => {
    if (!ring) throw httpError(409, 'Ring is not connected.');
    const done = await ring.secure();
    const ev = body.eventId && S.events.find((e) => e.id === body.eventId);
    if (ev) { ev.status = 'resolved'; ev.resolution = 'Home secured'; ev.badge = '✓ Home secured'; store.save(); }
    return { done, state: stateView() };
  },
  'POST /ask': async (body) => {
    const q = String(body.question || '').trim();
    if (!q || q.length > 500) throw httpError(400, 'Ask a question (up to 500 characters).');
    return { answer: await ask(q) };
  },
  'POST /push/register': (body) => {
    const t = String(body.token || '');
    if (!/^[0-9a-f]{64,200}$/i.test(t)) throw httpError(400, 'Invalid push token.');
    if (!S.pushTokens.includes(t)) S.pushTokens.push(t);
    store.save();
    return { ok: true, push: !!apns };
  },
  'POST /link/start': async (body) => {
    if (!body.email || !body.password) throw httpError(400, 'Email and password are required.');
    const r = await startLink(String(body.email), String(body.password));
    if (r.needsCode) return r;
    S.refreshToken = r.refreshToken; store.save(); await connect();
    return stateView();
  },
  'POST /link/verify': async (body) => {
    const r = await finishLink(body.code);
    S.refreshToken = r.refreshToken; store.save(); await connect();
    return stateView();
  },
  'POST /link/token': async (body) => {
    if (!body.refreshToken) throw httpError(400, 'refreshToken is required.');
    S.refreshToken = String(body.refreshToken).trim(); store.save(); await connect();
    return stateView();
  },
  'POST /link/remove': () => {
    ring?.disconnect(); ring = null;
    delete S.refreshToken; delete S.account; delete S.firstName; store.save();
    return stateView();
  },
  'POST /simulate': (body) => { simulate(String(body.scenario)); return { ok: true }; },
};

function route(method, path) {
  for (const [key, fn] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const re = new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`);
    const hit = path.match(re);
    if (hit) return { fn, params: hit.slice(1).map(decodeURIComponent) };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'ring-home-manager', linked: !!ring, auth: !!cfg.token });
  }
  const hit = route(req.method, url.pathname);
  if (!hit) return send(res, 404, { error: 'Not found.' });
  try {
    if (cfg.token) {
      // Images load through <img>, which can't send headers, so accept ?key= as well.
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
      if (got !== cfg.token) throw httpError(401, 'Wrong server password.');
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await hit.fn(body, hit.params);
    if (out?.jpeg) return sendJpeg(res, out.jpeg);
    return send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e);
    return send(res, status, { error: e.message || 'Something went wrong' });
  }
});

server.listen(cfg.port, () => {
  console.log(`Home Manager on http://localhost:${cfg.port}  auth=${cfg.token ? 'on' : 'OFF'}  push=${apns ? 'on' : 'off'}  ask=${anthropic ? cfg.claudeModel : 'basic'}`);
  if (!cfg.token) console.warn('WARNING: HM_TOKEN is not set — anyone who finds this URL can see your cameras. Set it in backend/.env');
  connect();
});
