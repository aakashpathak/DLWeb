// Quick self-test: asks the running server for a plan and prints it.
//   node check.mjs                      -> uses http://localhost:8787
//   node check.mjs https://your-url     -> tests a tunnel URL
const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.RUNWAY_TOKEN || '';
const health = await (await fetch(`${base}/health`)).json();
console.log('health:', health);
const text = process.argv[3] || 'Run 12 miles Friday morning, takes me three hours, I need prep time and I want to leave the house at six';
const t0 = Date.now();
const res = await fetch(`${base}/plan`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ text, prefs: {}, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
const data = await res.json();
console.log(`status ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!res.ok) { console.error(data); process.exit(1); }
console.log(`model: ${data.model}\n${data.plan.title} — ${data.plan.summary}`);
for (const s of data.plan.steps) console.log(`  ${s.startAt ? new Date(s.startAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '   —    '}  ${String(s.durationMin).padStart(3)}m  ${s.title}`);
