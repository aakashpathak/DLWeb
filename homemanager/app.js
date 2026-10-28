// Ring Home Manager app. Shows what was handled quietly and the few things that need you.
// Talks to the Home Manager server (backend/); with no server set it shows a demo.

const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NP = NATIVE ? (window.Capacitor.Plugins || {}) : {};
const $ = (id) => document.getElementById(id);

const settings = {
  get url() { return (localStorage.getItem('hm.url') || '').replace(/\/+$/, ''); },
  set url(v) { localStorage.setItem('hm.url', v || ''); },
  get key() { return localStorage.getItem('hm.key') || ''; },
  set key(v) { localStorage.setItem('hm.key', v || ''); },
};

let state = null;
let lastFetch = 0;

// --- server -------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(settings.url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(settings.key ? { authorization: `Bearer ${settings.key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}
const imgUrl = (path) => `${settings.url}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(settings.key)}&t=${Date.now()}`;

// --- demo -------------------------------------------------------------------------------
function demoState() {
  const t = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const handled = [
    { id: 'd1', at: t(14, 14), kind: 'package', title: 'Package delivery logged', summary: 'A delivery was placed at your front door.', badge: 'Logged — no action needed', deviceName: 'Front Door' },
    { id: 'd2', at: t(11, 32), kind: 'sensor', title: 'Garage closed', summary: 'Your garage door was closed after the delivery.', badge: 'Secured', deviceName: 'Garage' },
    { id: 'd3', at: t(9, 5), kind: 'vehicle', title: 'Vehicle passed by', summary: 'A car was seen by your driveway camera.', badge: 'Logged', deviceName: 'Driveway' },
  ];
  const attention = [{ id: 'd4', at: new Date().toISOString(), kind: 'person', status: 'attention', deviceId: 'demo', deviceName: 'Front Door', title: 'Unknown person at your door', summary: 'Someone has been at your front door for **17 seconds**. I don’t recognize them.' }];
  return {
    demo: true, linked: false, firstName: 'there', handled, attention,
    summary: { handledToday: 3, attention: 1, headline: 'One thing needs your attention', body: 'I handled 3 routine events today. This one I couldn’t decide for you.' },
  };
}

// --- rendering ------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'Now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return clock(iso);
}

const ICONS = {
  package: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M4 11h16M12 7v4M8 4h8l2 3H6z"/>',
  sensor: '<path d="M3 10l9-6 9 6v10H3z"/><path d="M7 20v-7h10v7M7 16h10"/>',
  vehicle: '<path d="M5 16V11l2-5h10l2 5v5M3 16h18v3H3zM5 11h14"/><circle cx="7.5" cy="16" r="1.4"/><circle cx="16.5" cy="16" r="1.4"/>',
  animal: '<circle cx="7" cy="9" r="2"/><circle cx="17" cy="9" r="2"/><circle cx="10" cy="5" r="2"/><circle cx="14" cy="5" r="2"/><path d="M12 12c-3 0-5 3-5 5.5S9 20 12 19s5 1 5-1.5S15 12 12 12z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  doorbell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/>',
  motion: '<path d="M3 12h3l3-7 4 14 3-7h5"/>',
  alarm: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k] || ICONS[k?.startsWith('package') ? 'package' : 'motion']}</svg>`;

function eventRow(e) {
  return `<li class="ev">
    <div class="ev-icon k-${esc(e.kind)}">${icon(e.kind)}</div>
    <div class="ev-main">
      <div class="ev-top"><span class="ev-title">${esc(e.title)}</span><span class="ev-time">${clock(e.at)}</span></div>
      <p class="ev-text">${rich(e.summary)}</p>
      ${e.badge ? `<span class="badge">${e.badge.startsWith('✓') ? '' : '✓ '}${esc(e.badge)}</span>` : ''}
    </div>
  </li>`;
}

function attentionCard(e) {
  const label = { person: 'MOTION ALERT', doorbell: 'DOORBELL', loitering: 'MOTION ALERT', package_pickup: 'PACKAGE ALERT', alarm: 'ALARM', sensor: 'SENSOR ALERT' }[e.kind] || 'NEEDS ATTENTION';
  const hasCam = !!e.deviceId && e.kind !== 'sensor' && e.kind !== 'alarm';
  const img = state.demo ? '<div class="placeholder">Demo — your camera picture shows here</div>'
    : e.hasSnap ? `<img src="${esc(imgUrl(`/snapshot/${encodeURIComponent(e.id)}`))}" alt="${esc(e.deviceName)} snapshot">`
    : '<div class="placeholder">No picture for this event</div>';
  return `<section class="alert-card" data-id="${esc(e.id)}">
    <div class="alert-head"><span class="alert-label">${label}</span><span class="muted small">${ago(e.at)}</span></div>
    ${hasCam ? `<div class="snap">${img}${Date.now() - Date.parse(e.at) < 5 * 60_000 ? '<span class="live-badge">● LIVE</span>' : ''}<span class="cam-label">${esc(e.deviceName)}</span></div>` : ''}
    <div class="alert-body">
      <h3>${esc(e.title)}</h3>
      <p>${rich(e.summary)}</p>
      <div class="actions">
        <button class="btn primary" data-act="secure" type="button">Secure home</button>
        ${hasCam ? '<button class="btn" data-act="live" type="button">View live</button>' : '<button class="btn" data-act="ok" type="button">It’s fine</button>'}
      </div>
      <div class="alert-links">
        <button class="link" data-act="ask" type="button">Ask Home Manager</button>
        ${hasCam ? '<button class="link" data-act="ok" type="button">I know them</button>' : ''}
      </div>
    </div>
  </section>`;
}

function render() {
  if (!state) return;
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const name = state.firstName && state.firstName !== 'there' ? `, ${state.firstName}` : '';
  $('greeting').textContent = `Good ${part}${name}.`;

  const s = state.summary;
  const hot = s.attention > 0;
  $('hero').classList.toggle('alert', hot);
  $('heroIcon').innerHTML = hot
    ? '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  $('heroTitle').textContent = s.headline;
  $('heroText').textContent = s.body;
  $('heroTime').textContent = 'Just now';
  $('chipHandled').textContent = `${s.handledToday} handled`;
  $('chipAttention').textContent = hot ? `${s.attention} needs attention` : 'No action needed';
  $('chipAttention').classList.toggle('hot', hot);

  $('attentionList').innerHTML = state.attention.map(attentionCard).join('');
  $('handledList').innerHTML = state.handled.length
    ? state.handled.slice(0, 3).map(eventRow).join('')
    : '<li class="empty">Nothing yet today. Deliveries, cars and doors opening will show up here.</li>';
  $('viewHistory').hidden = state.handled.length <= 3;
  $('historyList').innerHTML = state.handled.map(eventRow).join('') || '<li class="empty">Nothing yet today.</li>';

  const pill = $('statusPill');
  pill.className = 'status';
  if (state.demo) { pill.classList.add('idle'); $('statusText').textContent = 'Demo'; }
  else if (!state.linked) { pill.classList.add('warn'); $('statusText').textContent = state.error ? 'Ring error' : 'Ring not linked'; }
  else if (hot) { pill.classList.add('warn'); $('statusText').textContent = 'Needs attention'; }
  else $('statusText').textContent = 'All systems normal';

  const banner = $('banner');
  if (state.demo) { banner.hidden = false; banner.innerHTML = 'This is a demo. <button type="button" data-open-settings>Connect your Ring</button> to see your home.'; }
  else if (!state.linked) { banner.hidden = false; banner.innerHTML = `${state.error ? `Ring: ${esc(state.error)} ` : 'Your server is running but no Ring account is linked. '}<button type="button" data-open-settings>Link Ring</button>`; }
  else banner.hidden = true;

  renderSettings();
}

function renderSettings() {
  const live = state && !state.demo;
  $('ringSection').hidden = !live;
  if (!live) return;
  $('ringLinked').hidden = !state.linked;
  $('ringAccount').textContent = state.account || 'your Ring account';
  if (state.linked) { $('ringLinkForm').hidden = true; $('ringCodeForm').hidden = true; }
  else if ($('ringCodeForm').hidden) $('ringLinkForm').hidden = false;
  $('pushMsg').textContent = !NATIVE ? 'Phone alerts work in the iPhone app.' : state.push ? 'Alerts: only for things that need you.' : 'Alerts are off: the server has no Apple push key yet (see README).';
}

// --- data loop -------------------------------------------------------------------------
async function refresh() {
  if (!settings.url) { state = demoState(); render(); return; }
  try {
    state = await api('/state');
    lastFetch = Date.now();
    render();
  } catch (e) {
    if (!state || state.demo) state = { ...demoState(), demo: false, linked: false, attention: [], handled: [], summary: { handledToday: 0, attention: 0, headline: 'Can’t reach your server', body: e.message } };
    state.error = e.message;
    render();
  }
}
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastFetch > 3000) refresh(); });

// --- actions -------------------------------------------------------------------------
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

let liveTimer = null;
function openLive(ev) {
  $('liveTitle').textContent = ev.deviceName;
  const img = $('liveImg');
  if (state.demo) { img.removeAttribute('src'); $('liveNote').textContent = 'Demo — connect your Ring to see your camera.'; $('liveSheet').showModal(); return; }
  $('liveNote').textContent = 'A fresh picture every few seconds.';
  const load = () => {
    const next = new Image();
    next.onload = () => { img.src = next.src; };
    next.onerror = () => { $('liveNote').textContent = 'Camera is busy or asleep; showing the last picture.'; };
    next.src = imgUrl(`/live/${encodeURIComponent(ev.deviceId)}`);
  };
  load();
  clearInterval(liveTimer);
  liveTimer = setInterval(load, 4000);
  $('liveSheet').showModal();
}
$('liveSheet').addEventListener('close', () => clearInterval(liveTimer));

$('attentionList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const ev = state.attention.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'live') return openLive(ev);
  if (act === 'ask') {
    $('askInput').value = `Who is at my ${ev.deviceName.toLowerCase()} and what should I do?`;
    $('askForm').requestSubmit();
    return;
  }
  if (state.demo) {
    state.attention = state.attention.filter((x) => x.id !== id);
    state.handled.unshift({ ...ev, badge: act === 'secure' ? 'Home secured' : 'Marked as known', title: act === 'secure' ? 'Home secured' : 'Known visitor' });
    state.summary = { handledToday: state.handled.length, attention: 0, headline: 'Your home is in good shape', body: `I handled ${state.handled.length} routine events for you today. You’ll only hear from me when something needs your attention.` };
    render();
    return toast(act === 'secure' ? 'Demo: alarm armed, lights on.' : 'Got it.');
  }
  btn.disabled = true;
  try {
    if (act === 'secure') {
      const r = await api('/secure', { eventId: id });
      state = r.state; render();
      toast(r.done.join(' · '));
    } else {
      state = await api(`/events/${encodeURIComponent(id)}/resolve`, { note: 'Known visitor' });
      render();
      toast('Got it. Marked as known.');
    }
  } catch (err) { toast(err.message); btn.disabled = false; }
});

$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('askInput').value.trim();
  if (!q) return;
  const out = $('answer');
  out.hidden = false; out.textContent = 'Thinking…';
  const send = e.target.querySelector('.ask-send'); send.disabled = true;
  try {
    out.textContent = state.demo
      ? 'Demo: today I logged a package delivery at 2:14 PM, saw the garage close, and noticed one person at the front door I don’t recognize.'
      : (await api('/ask', { question: q })).answer;
    $('askInput').value = '';
  } catch (err) { out.textContent = err.message; }
  send.disabled = false;
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('chipHandled').addEventListener('click', () => $('handledCard').scrollIntoView({ behavior: 'smooth' }));
$('chipAttention').addEventListener('click', () => ($('attentionList').firstElementChild || $('handledCard')).scrollIntoView({ behavior: 'smooth' }));
$('viewHistory').addEventListener('click', () => $('historySheet').showModal());
$('statusPill').addEventListener('click', () => openSettings());
$('openSettings').addEventListener('click', () => openSettings());
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-settings]')) openSettings();
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

// --- settings -------------------------------------------------------------------------
function openSettings() {
  $('serverUrl').value = settings.url;
  $('serverKey').value = settings.key;
  renderSettings();
  $('settingsSheet').showModal();
}
$('saveServer').addEventListener('click', async () => {
  const url = $('serverUrl').value.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) { $('serverMsg').textContent = 'The URL should start with https://'; $('serverMsg').className = 'small err'; return; }
  settings.url = url; settings.key = $('serverKey').value.trim();
  state = null;
  await refresh();
  const msg = $('serverMsg');
  if (!url) { msg.textContent = 'Showing the demo.'; msg.className = 'small'; }
  else if (state?.error && !state.linked && !state.account) { msg.textContent = state.error; msg.className = 'small err'; }
  else { msg.textContent = 'Connected.'; msg.className = 'small ok'; registerPush(); }
});

$('ringLinkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('ringMsg'); msg.className = 'small'; msg.textContent = 'Signing in to Ring…';
  try {
    const r = await api('/link/start', { email: $('ringEmail').value.trim(), password: $('ringPassword').value });
    $('ringPassword').value = '';
    if (r.needsCode) {
      $('ringPrompt').textContent = r.prompt || 'Enter the code Ring sent you.';
      $('ringLinkForm').hidden = true; $('ringCodeForm').hidden = false; msg.textContent = '';
      $('ringCode').focus();
    } else { state = r; render(); msg.textContent = 'Ring linked.'; msg.className = 'small ok'; }
  } catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
});
$('ringCodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('ringMsg'); msg.className = 'small'; msg.textContent = 'Verifying…';
  try {
    state = await api('/link/verify', { code: $('ringCode').value });
    $('ringCode').value = ''; $('ringCodeForm').hidden = true;
    render();
    msg.textContent = state.linked ? 'Ring linked. I’ll take it from here.' : (state.error || 'Linked, still connecting…');
    msg.className = state.linked ? 'small ok' : 'small';
  } catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
});
$('unlinkRing').addEventListener('click', async () => {
  if (!confirm('Unlink your Ring account from Home Manager?')) return;
  try { state = await api('/link/remove', {}); render(); } catch (err) { toast(err.message); }
});
for (const b of document.querySelectorAll('[data-sim]')) {
  b.addEventListener('click', async () => {
    try {
      await api('/simulate', { scenario: b.dataset.sim });
      toast(b.dataset.sim === 'stranger' ? 'Someone “arrived”. Watch for ~30 seconds.' : 'Sent. It will show up in a moment.');
      setTimeout(refresh, 1500);
    } catch (err) { toast(err.message); }
  });
}

// --- iPhone push: only events that need attention ever reach the lock screen -----------
async function registerPush() {
  const P = NP.PushNotifications;
  if (!P || !settings.url) return;
  try {
    let perm = await P.checkPermissions();
    if (perm.receive === 'prompt') perm = await P.requestPermissions();
    if (perm.receive !== 'granted') return;
    await P.register();
  } catch (e) { console.warn('push', e); }
}
if (NP.PushNotifications) {
  NP.PushNotifications.addListener('registration', ({ value }) => { api('/push/register', { token: value }).catch(() => {}); });
  NP.PushNotifications.addListener('pushNotificationActionPerformed', () => refresh());
  NP.PushNotifications.addListener('pushNotificationReceived', () => refresh());
}
if (NP.App) NP.App.addListener('resume', () => refresh());

refresh();
registerPush();
