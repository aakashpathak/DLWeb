// Runway — app UI. ES module, no build step.
import { parseTask } from './nlp.js';
import { buildPlan, replan, classify, keyTimes, fmtTime, fmtDay, findOverlaps, planSpan, DEFAULT_PREFS } from './planner.js';
import * as store from './store.js';
import { planWithAI, shiftSteps, resizeStep, nextOccurrence, testApiKey, testServer as pingServer, AI_MODEL } from './ai.js';

const $ = (id) => document.getElementById(id);
const state = store.state;
// Native iOS shell (Capacitor) — gives us real speech recognition and real notifications.
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NP = NATIVE ? (window.Capacitor.Plugins || {}) : {};
const MIN = 60000;
const openIds = new Set();
let draft = null;          // parsed task being reviewed
let editingId = null;
let recognition = null;
let listening = false;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
store.load();
store.subscribe(render);
render();
$('todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
$('version').textContent = 'Runway 0.1 · plans run on your phone';
setInterval(tick, 20000);
tick();
if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (NATIVE) { store.subscribe(scheduleNativeNotifications); scheduleNativeNotifications(); }
store.initCloud();

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const now = new Date();
  const tasks = state.tasks.slice();
  const active = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  $('empty').hidden = tasks.length > 0;
  renderUpNext(active, now);

  const today = [], upcoming = [], someday = [], past = [];
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  for (const t of active) {
    if (!t.anchor) someday.push(t);
    else if (new Date(t.anchor) < new Date(now.getTime() - 3 * 60 * MIN)) past.push(t);
    else if (new Date(t.anchor) <= dayEnd || firstStepToday(t, now)) today.push(t);
    else upcoming.push(t);
  }
  const byAnchor = (a, b) => new Date(a.anchor) - new Date(b.anchor);
  today.sort(byAnchor); upcoming.sort(byAnchor); past.sort(byAnchor);
  someday.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const overlaps = findOverlaps(active);
  const list = $('taskList');
  list.innerHTML = '';
  const group = (title, arr) => {
    if (!arr.length) return;
    const h = document.createElement('div'); h.className = 'group-title'; h.textContent = title; list.appendChild(h);
    for (const t of arr) list.appendChild(taskCard(t, now, overlaps.get(t.id)));
  };
  group('Today', today);
  group('Coming up', upcoming);
  group('No time yet — figure out the logistics first', someday);
  group('Earlier', past);
  group('Done', done.slice(0, 20));
}

function firstStepToday(task, now) {
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  return (task.steps || []).some((s) => s.startAt && new Date(s.startAt) <= dayEnd && !s.done && !s.title.startsWith('Night before'));
}

function renderUpNext(active, now) {
  const box = $('upNext');
  let best = null;
  for (const t of active) {
    for (const s of t.steps || []) {
      if (!s.startAt || s.done || s.kind === 'anchor') continue;
      const start = new Date(s.startAt);
      const end = new Date(start.getTime() + Math.max(1, s.durationMin) * MIN);
      if (end < now && !(s.kind === 'travel' && start > new Date(now.getTime() - 60 * MIN))) continue;
      if (start > new Date(now.getTime() + 18 * 60 * MIN)) continue;
      if (!best || start < best.start) best = { t, s, start, end };
    }
  }
  if (!best) { box.hidden = true; return; }
  box.hidden = false;
  const { t, s, start, end } = best;
  const diff = start - now;
  const inProgress = diff <= 0 && now < end;
  const late = diff < -MIN && !inProgress;
  const idx = t.steps.indexOf(s);
  const next = t.steps.slice(idx + 1).find((x) => x.startAt && !x.done);
  const label = inProgress ? 'Now' : late ? 'Overdue' : s.kind === 'travel' ? 'Leave by' : s.kind === 'wake' ? 'Wake up at' : 'Up next';
  const count = inProgress ? `${humanDur(end - now)} left` : late ? `${humanDur(-diff)} late` : `in ${humanDur(diff)}`;
  const pct = inProgress ? Math.min(100, Math.round(((now - start) / (end - start)) * 100)) : 0;
  box.innerHTML = `
    <div class="label">${label} · ${fmtTime(start)}${inProgress ? `–${fmtTime(end)}` : ''}</div>
    <div class="big">${esc(s.title)}</div>
    <div class="sub">for “${esc(t.title)}” · ${fmtDay(new Date(t.anchor), now)} ${fmtTime(new Date(t.anchor))}${next ? `<br>Then: ${esc(next.title)} at ${fmtTime(new Date(next.startAt))}` : ''}</div>
    ${inProgress ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    <div class="count-row"><div class="count ${late ? 'late' : ''}">${count}</div>
    <button class="btn light sm" id="upNextDone">Done ✓</button></div>`;
  box.querySelector('#upNextDone').addEventListener('click', () => { s.done = true; t.updatedAt = Date.now(); store.save(); });
}

function taskCard(t, now, overlapWith) {
  const el = document.createElement('article');
  el.className = 'task' + (openIds.has(t.id) ? ' open' : '');
  el.dataset.id = t.id;
  const cat = classify(t.title);
  const steps = t.steps || [];
  const doneCount = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : 0;

  let when = '', pills = '';
  if (t.anchor) {
    const kt = keyTimes(t);
    const a = new Date(t.anchor);
    when = `${esc(fmtDay(a, now))} ${fmtTime(a)}${t.location ? ' · ' + esc(t.location) : ''}`;
    const p = [];
    if (kt.wakeAt) p.push(`<span class="pill wake">⏰ Wake ${fmtTime(kt.wakeAt)}</span>`);
    else if (kt.startAt) p.push(`<span class="pill">▶ Start ${fmtTime(kt.startAt)}</span>`);
    if (kt.leaveAt) p.push(`<span class="pill leave">🚗 Leave ${fmtTime(kt.leaveAt)}</span>`);
    if (overlapWith && overlapWith.length) p.push(`<span class="pill warn">⚠️ Overlaps “${esc(overlapWith[0].title)}”</span>`);
    if (t.repeat && t.repeat !== 'none') p.push(`<span class="pill">↻ ${esc(t.repeat)}</span>`);
    if (t.aiError) p.push(`<span class="pill warn">AI didn’t run: ${esc(t.aiError)}</span>`);
    pills = p.join('');
  } else {
    when = `${steps.length - doneCount} tiny steps · ~${totalMin(steps.filter((s) => !s.done))} min total${t.deadline ? ` · by ${esc(fmtDay(new Date(t.deadline), now))}` : ''}`;
    const nxt = steps.find((s) => !s.done);
    pills = nxt ? `<span class="pill next">Next: ${esc(nxt.title)}</span>` : '';
  }

  el.innerHTML = `
    <button class="task-head" aria-expanded="${openIds.has(t.id)}">
      <div class="task-main">
        <div class="t ${t.done ? 'done' : ''}">${esc(t.title)}</div>
        <div class="meta"><span class="cat">${esc(cat.label)}</span><span>${when}</span></div>
        <div class="pills">${pills}</div>
      </div>
      <div class="chev"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></div>
    </button>
    <div class="progress"><i style="width:${pct}%"></i></div>`;

  el.querySelector('.task-head').addEventListener('click', () => {
    if (openIds.has(t.id)) openIds.delete(t.id); else openIds.add(t.id);
    render();
  });

  if (openIds.has(t.id)) {
    const box = document.createElement('div');
    box.className = 'steps';
    if (t.anchor) {
      const hint = document.createElement('div'); hint.className = 'steps-hint';
      hint.textContent = (t.source === 'ai' && t.summary ? `✦ ${t.summary} · ` : '') + 'Tap a duration to fix it — the whole plan shifts.';
      box.appendChild(hint);
    }
    let lastDay = null;
    for (const s of steps) {
      if (s.startAt) {
        const d = fmtDay(new Date(s.startAt), now);
        if (d !== lastDay) { const dv = document.createElement('div'); dv.className = 'day-divider'; dv.textContent = d; box.appendChild(dv); lastDay = d; }
      }
      box.appendChild(stepRow(t, s, now));
    }
    if (t.anchor && steps.length) {
      const tot = document.createElement('div'); tot.className = 'day-divider';
      tot.textContent = `Total runway: ${humanDur(totalMin(steps.filter((s) => s.kind !== 'anchor' && !s.nightBefore && !s.title.startsWith('Night before') && s.startAt && s.startAt < t.anchor)) * MIN)} before you’re there`;
      box.appendChild(tot);
    }
    el.appendChild(box);

    const tools = document.createElement('div');
    tools.className = 'task-tools';
    tools.innerHTML = `
      ${t.source !== 'ai' && aiEnabled() ? '<button class="btn secondary" data-act="retry">Replan with AI</button>' : ''}
      <button class="btn secondary" data-act="edit">${t.anchor ? 'Edit' : 'Set time'}</button>
      ${t.anchor ? '<button class="btn secondary" data-act="cal">Calendar</button>' : ''}
      <button class="btn ghost" data-act="done">${t.done ? 'Reopen' : 'All done'}</button>
      <button class="btn danger ghost" data-act="delete">Delete</button>`;
    tools.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'edit') openEdit(t.id);
      if (act === 'retry') retryWithAI(t);
      if (act === 'cal') openCalendar(t);
      if (act === 'done') { t.done = !t.done; t.updatedAt = Date.now(); if (t.done) { t.steps.forEach((s) => (s.done = true)); spawnRepeat(t); } store.save(); toast(t.done ? 'Nice. Done.' : 'Reopened'); }
      if (act === 'delete') { if (confirm(`Delete “${t.title}”?`)) { state.tasks = state.tasks.filter((x) => x.id !== t.id); store.save(); } }
    });
    el.appendChild(tools);
  }
  return el;
}

function stepRow(t, s, now) {
  const row = document.createElement('div');
  const start = s.startAt ? new Date(s.startAt) : null;
  const end = start ? new Date(start.getTime() + Math.max(1, s.durationMin) * MIN) : null;
  const isNow = start && start <= now && now < end && !s.done;
  const past = end && end < now;
  row.className = `step ${s.kind} ${s.done ? 'done' : ''} ${isNow ? 'now' : ''} ${past ? 'past' : ''}`;
  row.innerHTML = `
    <button class="chk" aria-label="Mark done"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></button>
    <div><div class="st">${esc(s.title)}</div><div class="sm">${s.kind === 'anchor' ? `<button class="dur" data-dur>be there · ${s.durationMin} min</button>` : (s.prefKey || t.source === 'ai') && s.startAt ? `<button class="dur" data-dur>${s.durationMin} min ✎</button>` : `${s.durationMin} min`}${isNow ? ' · <b>now</b>' : ''}</div></div>
    <div class="tm">${start ? fmtTime(start) : ''}</div>
    ${s.action === 'settime' ? `<button class="btn primary sm act" data-settime>Set the time</button>` : ''}`;
  row.querySelector('.chk').addEventListener('click', () => {
    s.done = !s.done; t.updatedAt = Date.now();
    if (t.steps.every((x) => x.done)) { t.done = true; toast('All steps done. 🎉'); spawnRepeat(t); }
    store.save();
  });
  row.querySelector('[data-settime]')?.addEventListener('click', () => openEdit(t.id, true));
  row.querySelector('[data-dur]')?.addEventListener('click', (e) => { e.stopPropagation(); openDuration(t, s); });
  return row;
}

// ---------------------------------------------------------------------------
// Fix a duration in place ("shower actually takes me 35 minutes")
// ---------------------------------------------------------------------------
let durCtx = null;
$('durCancel').addEventListener('click', closeSheets);
$('durSave').addEventListener('click', () => {
  if (!durCtx) return;
  const { t, s } = durCtx;
  const val = Math.max(0, Number($('durValue').value) || 0);
  if (t.source === 'ai') {
    t.steps = resizeStep(t.steps, s.id, val);
    if ($('durRemember').checked && s.prefKey in state.prefs) state.prefs[s.prefKey] = val;
    t.updatedAt = Date.now(); store.save(); closeSheets();
    const k = keyTimes(t); toast(k.leaveAt ? `Updated — leave by ${fmtTime(k.leaveAt)}.` : 'Updated.'); return;
  }
  t.overrides = t.overrides || {};
  if (s.prefKey === 'travel') t.travelMin = val;
  else t.overrides[s.prefKey] = val;
  if ($('durRemember').checked && s.prefKey in state.prefs) {
    state.prefs[s.prefKey] = val;
    for (const x of state.tasks) if (x.id !== t.id && x.anchor && !x.done) x.steps = replan(x, state.prefs);
  }
  if ($('durRemember').checked && s.prefKey === 'travel') state.prefs.defaultTravel = val;
  t.updatedAt = Date.now();
  t.steps = replan(t, state.prefs);
  store.save(); closeSheets();
  const kt = keyTimes(t);
  toast(kt.leaveAt ? `Replanned — leave by ${fmtTime(kt.leaveAt)}.` : 'Replanned.');
});
$('durMinus').addEventListener('click', () => { $('durValue').value = Math.max(0, (Number($('durValue').value) || 0) - 5); });
$('durPlus').addEventListener('click', () => { $('durValue').value = (Number($('durValue').value) || 0) + 5; });
function openDuration(t, s) {
  durCtx = { t, s };
  const nice = (PREF_LABELS[s.prefKey] || [s.title.replace(/ \(.*\)$/, '').replace(/ —.*$/, '').slice(0, 40)])[0];
  const label = s.kind === 'anchor' ? `How long is “${t.title}”?` : s.prefKey === 'travel' ? 'How long is the trip, really?' : `“${nice}” — how long, really?`;
  $('durTitle').textContent = label;
  $('durValue').value = t.source === 'ai' ? s.durationMin : s.prefKey === 'travel' ? (t.travelMin ?? state.prefs.defaultTravel) : (s.kind === 'anchor' ? s.durationMin : ((t.overrides || {})[s.prefKey] ?? state.prefs[s.prefKey] ?? s.durationMin));
  const rememberable = t.source !== 'ai' && (s.prefKey in state.prefs || s.prefKey === 'travel');
  $('durRememberRow').hidden = !rememberable;
  $('durRemember').checked = rememberable && s.prefKey !== 'travel';
  showSheet('durSheet');
}

// ---------------------------------------------------------------------------
// Calendar export — the way to get alerts even when Runway is closed.
// ---------------------------------------------------------------------------
function calendarPayload(t) {
  const kt = keyTimes(t);
  const span = planSpan(t);
  const start = kt.wakeAt || kt.startAt || (span && span.start) || new Date(t.anchor);
  const lines = (t.steps || []).filter((s) => s.startAt).map((s) => `${fmtTime(new Date(s.startAt))}  ${s.title}`);
  const title = `${kt.leaveAt ? `Leave ${fmtTime(kt.leaveAt)} → ` : ''}${t.title}`;
  const desc = `Runway plan:\n${lines.join('\n')}`;
  return { title, start, end: new Date(t.anchor), desc, leaveAt: kt.leaveAt, wakeAt: kt.wakeAt };
}
function gcalDate(d) { return d.toISOString().replace(/[-:]|\.\d{3}/g, ''); }
function openCalendar(t) {
  const c = calendarPayload(t);
  $('calTitle').textContent = c.title;
  $('calSub').textContent = `${fmtDay(c.start)} ${fmtTime(c.start)} → ${fmtTime(c.end)}, with the step-by-step plan in the notes. Your calendar app will alert you even if Runway is closed.`;
  const g = new URL('https://calendar.google.com/calendar/render');
  g.searchParams.set('action', 'TEMPLATE'); g.searchParams.set('text', c.title); g.searchParams.set('dates', `${gcalDate(c.start)}/${gcalDate(c.end)}`);
  g.searchParams.set('details', c.desc); if (t.location) g.searchParams.set('location', t.location);
  $('calGoogle').href = g.toString();
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Runway//EN', 'BEGIN:VEVENT', `UID:${t.id}@runway`, `DTSTAMP:${gcalDate(new Date())}`, `DTSTART:${gcalDate(c.start)}`, `DTEND:${gcalDate(c.end)}`,
    `SUMMARY:${icsEsc(c.title)}`, `DESCRIPTION:${icsEsc(c.desc)}`, t.location ? `LOCATION:${icsEsc(t.location)}` : null,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(c.wakeAt ? 'Wake up — Runway' : 'Start — Runway')}`, 'END:VALARM',
    c.leaveAt ? `BEGIN:VALARM\nTRIGGER;RELATED=END:-PT${Math.max(0, Math.round((c.end - c.leaveAt) / MIN))}M\nACTION:DISPLAY\nDESCRIPTION:Leave now — Runway\nEND:VALARM`.replace(/\\n/g, '\n') : null,
    'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  const a = $('calApple');
  a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  a.download = `${t.title.replace(/[^\w]+/g, '-').toLowerCase()}.ics`;
  showSheet('calSheet');
}
function icsEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c); }
$('calClose').addEventListener('click', closeSheets);

async function retryWithAI(t) {
  toast('Asking the planner…');
  try {
    const ai = await planWithAI({ text: t.raw || t.title, prefs: state.prefs, ...aiArgs() });
    t.title = ai.title; t.anchor = ai.anchor; t.location = ai.location; t.travelMin = ai.travelMin; t.away = ai.travelMin != null;
    t.deadline = ai.deadline; t.repeat = ai.repeat; t.summary = ai.summary; t.steps = ai.steps; t.source = 'ai'; delete t.aiError;
    t.updatedAt = Date.now(); store.save();
    const kt = keyTimes(t); toast(kt.leaveAt ? `Replanned. Leave by ${fmtTime(kt.leaveAt)}.` : 'Replanned.');
  } catch (e) { t.aiError = e.message; store.save(); toast(`AI planner: ${e.message}`); }
}
function spawnRepeat(t) {
  const n = nextOccurrence(t);
  if (!n || state.tasks.some((x) => x.anchor === n.anchor && x.title === n.title)) return;
  state.tasks.unshift(n);
  setTimeout(() => toast(`Next one planned: ${fmtDay(new Date(n.anchor))} ${fmtTime(new Date(n.anchor))}`), 1200);
}

// ---------------------------------------------------------------------------
// Add flow
// ---------------------------------------------------------------------------
$('addBtn').addEventListener('click', () => openAdd(false));
document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => { openAdd(false); $('taskInput').value = b.dataset.example; goReview(); }));
$('micBtn').addEventListener('click', () => openAdd(true));
$('cancelAdd').addEventListener('click', closeSheets);
$('sheetBackdrop').addEventListener('click', closeSheets);
$('nextAdd').addEventListener('click', goReview);
$('backAdd').addEventListener('click', () => { showStep('stepCapture'); });
$('saveAdd').addEventListener('click', saveNew);
$('micToggle').addEventListener('click', toggleMic);
$('taskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goReview(); } });
$('rvNoTime').addEventListener('click', () => toggleNoTime('rv'));
$('edNoTime').addEventListener('click', () => toggleNoTime('ed'));
$('rvAway').addEventListener('change', () => syncAway('rv'));
$('edAway').addEventListener('change', () => syncAway('ed'));

function openAdd(withMic) {
  showSheet('addSheet');
  showStep('stepCapture');
  $('taskInput').value = '';
  $('listenStatus').textContent = 'Tap the mic and talk, or type.';
  if (withMic) startMic(); else setTimeout(() => $('taskInput').focus(), 50);
}
function showStep(id) { $('stepCapture').hidden = id !== 'stepCapture'; $('stepReview').hidden = id !== 'stepReview'; }
function showSheet(id) { $('toast').hidden = true; $('sheetBackdrop').hidden = false; $(id).hidden = false; }
function closeSheets() {
  stopMic();
  for (const id of ['addSheet', 'settingsSheet', 'editSheet', 'durSheet', 'calSheet']) $(id).hidden = true;
  $('sheetBackdrop').hidden = true;
}

let planning = false;
async function goReview() {
  const text = $('taskInput').value.trim();
  if (!text || planning) { if (!text) $('taskInput').focus(); return; }
  stopMic();
  draft = parseTask(text);
  draft.raw = text; draft.ai = null;
  if (aiEnabled()) {
    planning = true;
    $('nextAdd').disabled = true; $('nextAdd').textContent = 'Planning…';
    $('listenStatus').innerHTML = '<span class="spin"></span> Reading the whole thing and planning backwards…';
    try {
      draft.ai = await planWithAI({ text, prefs: state.prefs, ...aiArgs() });
      draft.title = draft.ai.title; draft.anchor = draft.ai.anchor; draft.location = draft.ai.location;
      draft.travelMin = draft.ai.travelMin; draft.deadline = draft.ai.deadline; draft.hints = [];
    } catch (e) {
      draft.aiError = e.message;
      toast(`AI planner: ${e.message} Using built-in rules.`);
    } finally {
      planning = false; $('nextAdd').disabled = false; $('nextAdd').textContent = 'Next';
      $('listenStatus').textContent = 'Tap the mic and talk, or type.';
    }
  }
  fillReview();
}
function fillReview() {
  const cat = classify(draft.title);
  $('rvTitle').value = draft.title;
  const away = cat.away !== false && (cat.away === true || draft.travelMin != null || !!draft.location || cat.id === 'generic' ? cat.away !== null : true);
  $('rvAway').checked = cat.away === null ? (draft.travelMin != null || !!draft.location) : away;
  $('rvReady').checked = !!cat.getReady;
  $('rvWhere').value = draft.location || '';
  $('rvTravel').value = draft.travelMin != null ? draft.travelMin : (draft.ai ? '' : state.prefs.defaultTravel);
  if (draft.ai) $('rvAway').checked = draft.ai.travelMin != null;
  setWhen('rv', draft.anchor);
  const hint = [];
  if (draft.deadline) hint.push(`Deadline ${fmtDay(new Date(draft.deadline))} — you’ll get the logistics steps first, then set the real time.`);
  if ($('rvAway').checked && draft.travelMin == null) hint.push(`Travel time is a guess (${state.prefs.defaultTravel} min) — fix it if you know it.`);
  if (draft.hints.includes('guessed-ampm')) hint.push('Guessed am/pm — double-check.');
  if (draft.hints.includes('no-time')) hint.push('Heard the day but no time — set it, or tap “No time yet”.');
  if (draft.hints.includes('vague-time')) hint.push('Set the exact time if you have it.');
  if (!draft.anchor) hint.push('No time yet? Fine — Runway will give you the logistics steps first.');
  if (draft.ai) {
    hint.length = 0;
    if (draft.ai.questions.length) hint.push(draft.ai.questions.join(' '));
    $('rvSummary').hidden = false;
    $('rvSummary').innerHTML = `<b>Claude’s plan:</b> ${esc(draft.ai.summary)}${draft.ai.repeat !== 'none' ? ` · repeats ${esc(draft.ai.repeat)}` : ''}<br><span class="muted small" style="margin:0">${draft.ai.steps.length} steps. Change the time here and the whole plan moves with it.</span>`;
    document.querySelector('#stepReview .toggles').hidden = true;
  } else if (draft.aiError) {
    $('rvSummary').hidden = false;
    $('rvSummary').innerHTML = `<b>AI planner didn’t run:</b> ${esc(draft.aiError)}<br><span class="muted small" style="margin:0">Using the built-in rules for this one. Check gear → AI planning → Test.</span>`;
    document.querySelector('#stepReview .toggles').hidden = false;
  } else {
    $('rvSummary').hidden = true;
    document.querySelector('#stepReview .toggles').hidden = false;
  }
  $('rvWhenHint').textContent = hint.join(' ');
  syncAway('rv');
  showStep('stepReview');
}

function setWhen(prefix, iso) {
  const input = $(prefix + 'When'); const chip = $(prefix + 'NoTime');
  if (iso) { input.value = toLocalInput(new Date(iso)); chip.classList.remove('on'); input.disabled = false; }
  else { input.value = ''; chip.classList.add('on'); input.disabled = true; }
}
function toggleNoTime(prefix) {
  const input = $(prefix + 'When'); const chip = $(prefix + 'NoTime');
  if (chip.classList.contains('on')) { chip.classList.remove('on'); input.disabled = false; input.value = input.value || toLocalInput(nextHour()); input.focus(); }
  else { chip.classList.add('on'); input.disabled = true; }
}
function syncAway(prefix) {
  const away = $(prefix + 'Away').checked;
  $(prefix + 'Travel').disabled = !away; $(prefix + 'Where').disabled = !away;
}
function readWhen(prefix) {
  const input = $(prefix + 'When'); const chip = $(prefix + 'NoTime');
  if (chip.classList.contains('on') || !input.value) return null;
  const d = new Date(input.value);
  return isNaN(d) ? null : d.toISOString();
}

function saveNew() {
  const title = $('rvTitle').value.trim() || draft.title;
  const task = {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, raw: draft.raw || title, createdAt: Date.now(), updatedAt: Date.now(), done: false,
    anchor: readWhen('rv'),
    away: $('rvAway').checked,
    getReady: $('rvReady').checked,
    location: $('rvWhere').value.trim() || null,
    travelMin: $('rvAway').checked ? Number($('rvTravel').value || 0) : 0,
    deadline: draft.deadline || null,
  };
  if (draft.ai) {
    task.source = 'ai'; task.repeat = draft.ai.repeat; task.summary = draft.ai.summary;
    task.travelMin = draft.ai.travelMin; task.away = draft.ai.travelMin != null;
    let steps = draft.ai.steps;
    if (task.anchor && draft.ai.anchor && task.anchor !== draft.ai.anchor) steps = shiftSteps(steps, new Date(task.anchor) - new Date(draft.ai.anchor));
    if (task.anchor && !draft.ai.anchor) { task.source = 'rules'; steps = buildPlan(task, state.prefs); }
    if (!task.anchor && draft.ai.anchor) { steps = steps.map((x) => ({ ...x, startAt: null })); }
    task.steps = steps;
  } else {
    task.steps = buildPlan(task, state.prefs);
    if (draft.aiError) task.aiError = draft.aiError;
  }
  state.tasks.unshift(task);
  openIds.clear(); openIds.add(task.id);
  store.save();
  closeSheets();
  const kt = keyTimes(task);
  if (task.anchor && kt.leaveAt) toast(`Planned. Leave by ${fmtTime(kt.leaveAt)}${kt.wakeAt ? `, wake ${fmtTime(kt.wakeAt)}` : ''}.`);
  else if (task.anchor) toast(`Planned. Start at ${fmtTime(kt.startAt)}.`);
  else toast(`${task.steps.length} tiny steps. Just do the first one.`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Edit / replan
// ---------------------------------------------------------------------------
$('edCancel').addEventListener('click', closeSheets);
$('edSave').addEventListener('click', saveEdit);
$('edDelete').addEventListener('click', () => {
  const t = state.tasks.find((x) => x.id === editingId);
  if (t && confirm(`Delete “${t.title}”?`)) { state.tasks = state.tasks.filter((x) => x.id !== editingId); store.save(); closeSheets(); }
});

function openEdit(id, focusTime) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  editingId = id;
  $('edTitle').value = t.title;
  setWhen('ed', t.anchor);
  if (focusTime && !t.anchor) toggleNoTime('ed');
  $('edWhere').value = t.location || '';
  $('edTravel').value = t.travelMin != null ? t.travelMin : state.prefs.defaultTravel;
  const cat = classify(t.title);
  $('edAway').checked = t.away != null ? t.away : cat.away !== false;
  $('edReady').checked = t.getReady != null ? t.getReady : !!cat.getReady;
  syncAway('ed');
  showSheet('editSheet');
  if (focusTime) setTimeout(() => $('edWhen').focus(), 60);
}
async function saveEdit() {
  const t = state.tasks.find((x) => x.id === editingId); if (!t) return;
  t._prevAnchor = t.anchor; t._prevTravel = t.travelMin;
  t.title = $('edTitle').value.trim() || t.title;
  t.anchor = readWhen('ed');
  t.away = $('edAway').checked;
  t.getReady = $('edReady').checked;
  t.location = $('edWhere').value.trim() || null;
  t.travelMin = t.away ? Number($('edTravel').value || 0) : 0;
  t.updatedAt = Date.now();
  t.done = false;
  const prevAnchor = t._prevAnchor; delete t._prevAnchor;
  if (t.source === 'ai' && t.anchor && prevAnchor) {
    // Same plan, moved in time. Travel change resizes the travel step.
    t.steps = shiftSteps(t.steps, new Date(t.anchor) - new Date(prevAnchor));
    const travel = t.steps.find((x) => x.kind === 'travel');
    const prevTravel = t._prevTravel; delete t._prevTravel;
    if (travel && prevTravel != null && t.travelMin !== prevTravel) t.steps = resizeStep(t.steps, travel.id, Math.round(t.travelMin * 1.2));
  } else if (aiEnabled()) {
    closeSheets(); toast('Asking the planner to redo this…');
    const desc = `${t.title}${t.anchor ? ` at ${new Date(t.anchor).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ' (no time yet)'}${t.location ? ` at ${t.location}` : ''}${t.away && t.travelMin ? `, ${t.travelMin} minutes away` : ''}${t.getReady ? ', I need to shower and get ready first' : ''}${t.summary ? `. Earlier plan summary: ${t.summary}` : ''}`;
    try {
      const ai = await planWithAI({ text: desc, prefs: state.prefs, ...aiArgs() });
      t.source = 'ai'; t.repeat = ai.repeat; t.summary = ai.summary;
      t.steps = t.anchor && ai.anchor && ai.anchor !== t.anchor ? shiftSteps(ai.steps, new Date(t.anchor) - new Date(ai.anchor)) : ai.steps;
    } catch (e) { toast(`AI planner: ${e.message} Used built-in rules.`); t.source = 'rules'; t.steps = replan(t, state.prefs); }
  } else {
    t.source = 'rules';
    t.steps = replan(t, state.prefs);
  }
  openIds.add(t.id);
  store.save(); closeSheets();
  const kt = keyTimes(t);
  toast(t.anchor && kt.leaveAt ? `Replanned. Leave by ${fmtTime(kt.leaveAt)}.` : 'Replanned.');
}

// ---------------------------------------------------------------------------
// Mic (Web Speech API — works in Safari on iPhone and Chrome)
// ---------------------------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function toggleMic() { listening ? stopMic() : startMic(); }
let nativeSilenceTimer = null;
async function startMicNative() {
  const SRN = NP.SpeechRecognition;
  try {
    const { available } = await SRN.available();
    if (!available) throw new Error('unavailable');
    const perm = await SRN.requestPermissions();
    if (perm.speechRecognition && perm.speechRecognition !== 'granted') {
      $('listenStatus').textContent = 'Microphone blocked. Allow it in Settings → Runway, or just type.'; return;
    }
    await SRN.removeAllListeners();
    let heard = '';
    const finish = () => { clearTimeout(nativeSilenceTimer); stopMic(); if (heard.trim()) { $('listenStatus').textContent = 'Got it. Check it, then Next.'; setTimeout(goReview, 250); } };
    SRN.addListener('partialResults', ({ matches }) => {
      if (matches && matches[0]) { heard = matches[0]; $('taskInput').value = heard; }
      clearTimeout(nativeSilenceTimer);
      nativeSilenceTimer = setTimeout(finish, 1800); // 1.8 s of silence after speech = done
    });
    SRN.addListener('listeningState', ({ status }) => { if (status === 'stopped' && listening) finish(); });
    listening = true; $('micToggle').classList.add('on');
    $('listenStatus').textContent = 'Listening… say the task, when, and how far.';
    const res = await SRN.start({ language: navigator.language || 'en-US', maxResults: 1, partialResults: true, popup: false });
    if (res && res.matches && res.matches[0] && !heard) { heard = res.matches[0]; $('taskInput').value = heard; finish(); }
  } catch (e) {
    listening = false; $('micToggle').classList.remove('on');
    $('listenStatus').textContent = 'Voice isn’t available right now — just type.'; $('taskInput').focus();
  }
}
function startMic() {
  if (NATIVE && NP.SpeechRecognition) return startMicNative();
  if (!SR) { $('listenStatus').textContent = 'Voice isn’t available in this browser — just type it.'; $('taskInput').focus(); return; }
  try {
    recognition = new SR();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = '';
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      $('taskInput').value = (finalText + ' ' + interim).trim();
    };
    recognition.onerror = (e) => {
      const msg = e.error === 'not-allowed' ? 'Microphone blocked. Allow it in Settings → Safari → Microphone, or just type.' : e.error === 'no-speech' ? 'Didn’t catch that. Tap the mic and try again, or type.' : 'Voice hiccup — try again or type.';
      $('listenStatus').textContent = msg; stopMic();
    };
    recognition.onend = () => {
      listening = false; $('micToggle').classList.remove('on');
      if (finalText.trim()) { $('listenStatus').textContent = 'Got it. Check it, then Next.'; setTimeout(goReview, 250); }
      else if ($('taskInput').value.trim()) $('listenStatus').textContent = 'Check it, then Next.';
    };
    recognition.start();
    listening = true; $('micToggle').classList.add('on');
    $('listenStatus').textContent = 'Listening… say the task, when, and how far.';
  } catch (e) { $('listenStatus').textContent = 'Voice isn’t available — just type.'; }
}
function stopMic() {
  if (recognition) { try { recognition.stop(); } catch (e) { /* ignore */ } }
  if (NATIVE && NP.SpeechRecognition && listening) { try { NP.SpeechRecognition.stop(); } catch (e) { /* ignore */ } }
  clearTimeout(nativeSilenceTimer);
  listening = false; $('micToggle').classList.remove('on');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const PREF_LABELS = {
  wakeUpBuffer: ['Wake up + snooze', 'min'], bathroom: ['Bathroom / meds', 'min'], shower: ['Shower', 'min'], dress: ['Get dressed', 'min'],
  breakfast: ['Breakfast', 'min'], meal: ['Lunch / dinner', 'min'], windDown: ['Stop & switch tasks', 'min'], outTheDoor: ['Keys, shoes, out the door', 'min'],
  arriveEarly: ['Arrive early by', 'min'], trafficPct: ['Traffic padding', '%'], defaultTravel: ['Default travel time', 'min'],
};
$('settingsBtn').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSheets);
$('exportBtn').addEventListener('click', () => {
  const text = store.exportJSON();
  if (navigator.share) navigator.share({ title: 'Runway export', text }).catch(() => {});
  else { navigator.clipboard?.writeText(text); toast('Copied to clipboard'); }
});
$('wipeBtn').addEventListener('click', () => { if (confirm('Delete every task and reset settings on this phone?')) { store.wipe(); closeSheets(); } });
$('notifBtn').addEventListener('click', enableNotifications);
function aiEnabled() { return !!(state.settings.aiEndpoint || state.settings.aiKey); }
function aiArgs() { return { endpoint: state.settings.aiEndpoint || '', token: state.settings.aiToken || '', apiKey: state.settings.aiKey || '' }; }
$('aiEndpoint').addEventListener('change', () => {
  let u = $('aiEndpoint').value.trim();
  if (u && !/^https?:\/\//.test(u)) u = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/]+\.local)/i.test(u) ? 'http://' : 'https://') + u;
  state.settings.aiEndpoint = u; $('aiEndpoint').value = u; store.save(); renderAiStatus();
  if (u) testServer(u);
});
$('aiToken').addEventListener('change', () => { state.settings.aiToken = $('aiToken').value.trim(); store.save(); if (state.settings.aiEndpoint) testServer(state.settings.aiEndpoint); });
function saveKey() {
  const k = $('aiKey').value.trim();
  if (state.settings.aiKey === k) return;
  state.settings.aiKey = k; store.save(); renderAiStatus();
}
$('aiKey').addEventListener('input', saveKey);
$('aiKey').addEventListener('change', saveKey);
$('aiKey').addEventListener('blur', saveKey);
$('aiTest').addEventListener('click', async () => {
  saveKey();
  const el = $('aiStatus');
  if (state.settings.aiEndpoint) { testServer(state.settings.aiEndpoint); return; }
  if (!state.settings.aiKey) { el.textContent = 'Paste a key first.'; return; }
  if (!/^sk-ant-/.test(state.settings.aiKey)) { el.textContent = 'That doesn’t look like an Anthropic key (they start with sk-ant-). Paste the whole thing.'; return; }
  el.innerHTML = '<span class="spin"></span> Testing the key…';
  try { el.textContent = await testApiKey(state.settings.aiKey); }
  catch (e) { el.textContent = `Key test failed: ${e.message}`; }
});
async function testServer(u) {
  const el = $('aiStatus');
  el.textContent = 'Checking your server…';
  try {
    const h = await pingServer(u, state.settings.aiToken);
    el.textContent = `Connected — ${h.provider === 'ollama' ? 'local model' : 'Claude'} (${h.model}) on your server${h.auth && !state.settings.aiToken ? '. It wants a password — enter it below.' : '.'}`;
  } catch (e) {
    el.textContent = 'Can’t reach that server. Check the URL, that it’s running, and that it’s reachable from this phone (see backend/README.md).';
  }
}
function renderAiStatus() {
  $('aiStatus').textContent = state.settings.aiEndpoint ? 'On — plans come from your Runway server. Tap Test to check it.' : state.settings.aiKey ? `On — plans come from Claude (${AI_MODEL}) directly. Tap Test to be sure the key works.` : 'Off — plans come from the built-in rules. Connect a server or paste a key to turn on real understanding of what you say.';
}

function openSettings() {
  const grid = $('prefsGrid'); grid.innerHTML = '';
  for (const [k, [label, unit]] of Object.entries(PREF_LABELS)) {
    const box = document.createElement('label'); box.className = 'pref';
    box.innerHTML = `<span>${label}</span><input type="number" inputmode="numeric" min="0" step="${k === 'trafficPct' ? 5 : 5}" value="${state.prefs[k] ?? DEFAULT_PREFS[k]}" data-pref="${k}" /><span class="unit">${unit}</span>`;
    box.querySelector('input').addEventListener('change', (e) => {
      state.prefs[k] = Math.max(0, Number(e.target.value) || 0);
      for (const t of state.tasks) if (t.anchor && !t.done) t.steps = replan(t, state.prefs);
      store.save();
    });
    grid.appendChild(box);
  }
  $('aiKey').value = state.settings.aiKey || '';
  $('aiEndpoint').value = state.settings.aiEndpoint || '';
  $('aiToken').value = state.settings.aiToken || '';
  renderAiStatus();
  renderNotifStatus();
  renderAccount();
  showSheet('settingsSheet');
}

function renderAccount() {
  const box = $('accountBox');
  if (!store.cloudEnabled) {
    box.innerHTML = `<p class="muted" style="margin:0">Your tasks live on this phone. Accounts &amp; sync (email or Google) switch on once Firebase is connected — see <b>SETUP.md</b> in the project. Nothing else changes.</p>`;
    return;
  }
  if (state.user) {
    box.innerHTML = `<div>Signed in as <b>${esc(state.user.name || state.user.email)}</b></div><div class="muted small" style="margin:0">Sync: ${state.cloud}${state.cloudError ? ' — ' + esc(state.cloudError) : ''}</div><button class="btn ghost" id="signOut">Sign out</button>`;
    box.querySelector('#signOut').addEventListener('click', () => store.signOut());
    return;
  }
  box.innerHTML = `
    <button class="btn secondary" id="googleBtn">Continue with Google</button>
    <div class="muted small" style="text-align:center;margin:2px 0">or with email</div>
    <input type="email" id="acEmail" placeholder="email" autocomplete="email" />
    <input type="password" id="acPass" placeholder="password (6+ characters)" autocomplete="current-password" />
    <div class="row-btns"><button class="btn secondary" id="acIn">Sign in</button><button class="btn ghost" id="acUp">Create account</button></div>
    <button class="btn ghost sm" id="acReset">Forgot password</button>
    <div class="muted small" id="acMsg" style="margin:0">${state.cloud === 'error' ? esc(state.cloudError || 'Cloud error') : ''}</div>`;
  const msg = (m) => (box.querySelector('#acMsg').textContent = m);
  const run = (p) => p.then(() => renderAccount()).catch((e) => msg(friendlyAuthError(e)));
  box.querySelector('#googleBtn').addEventListener('click', () => run(store.signInGoogle()));
  box.querySelector('#acIn').addEventListener('click', () => run(store.signInEmail(box.querySelector('#acEmail').value.trim(), box.querySelector('#acPass').value, false)));
  box.querySelector('#acUp').addEventListener('click', () => run(store.signInEmail(box.querySelector('#acEmail').value.trim(), box.querySelector('#acPass').value, true)));
  box.querySelector('#acReset').addEventListener('click', () => run(store.resetPassword(box.querySelector('#acEmail').value.trim()).then(() => msg('Reset email sent.'))));
}
function friendlyAuthError(e) {
  const c = String(e?.code || e?.message || e);
  if (/invalid-email/.test(c)) return 'That email doesn’t look right.';
  if (/weak-password/.test(c)) return 'Password needs 6+ characters.';
  if (/email-already-in-use/.test(c)) return 'That email already has an account — tap Sign in.';
  if (/wrong-password|invalid-credential|user-not-found/.test(c)) return 'Wrong email or password.';
  if (/popup-closed/.test(c)) return 'Sign-in window closed.';
  return c.replace(/^.*auth\//, '').replace(/[-_]/g, ' ');
}

// ---------------------------------------------------------------------------
// Reminders (local, while the app is installed/open)
// ---------------------------------------------------------------------------
async function enableNotifications() {
  if (NATIVE && NP.LocalNotifications) {
    const p = await NP.LocalNotifications.requestPermissions();
    state.settings.notifications = p.display === 'granted';
    store.save(); renderNotifStatus();
    if (state.settings.notifications) toast('Reminders on. You’ll get a nudge at every step.');
    return;
  }
  if (!('Notification' in window)) { $('notifStatus').textContent = 'Reminders need the app on your home screen (Share → Add to Home Screen), then come back here.'; return; }
  const perm = await Notification.requestPermission();
  state.settings.notifications = perm === 'granted';
  store.save(); renderNotifStatus();
  if (perm === 'granted') notify('Runway reminders are on', 'You’ll get a nudge when it’s time to move.');
}
function renderNotifStatus() {
  if (NATIVE && NP.LocalNotifications) {
    const on = !!state.settings.notifications;
    $('notifStatus').textContent = on ? 'On. Runway sends a notification at every step — wake up, leave now — even when the app is closed.' : 'Off. Turn on to get a nudge at every step, even when the app is closed.';
    $('notifBtn').hidden = on;
    return;
  }
  const supported = 'Notification' in window;
  const on = supported && Notification.permission === 'granted' && state.settings.notifications;
  $('notifStatus').textContent = !supported
    ? 'On iPhone: add Runway to your home screen (Share → Add to Home Screen) to unlock reminders.'
    : on ? 'On. Runway nudges you when a step starts (leave now, wake up, etc.) while it’s open or installed.'
    : Notification.permission === 'denied' ? 'Blocked in system settings. Enable notifications for Runway there.' : 'Off.';
  $('notifBtn').hidden = on;
}
// Native: (re)schedule real iOS notifications for every upcoming step in the next 7 days.
let nativeSchedTimer = null;
function scheduleNativeNotifications() {
  if (!(NATIVE && NP.LocalNotifications)) return;
  clearTimeout(nativeSchedTimer);
  nativeSchedTimer = setTimeout(async () => {
    const LN = NP.LocalNotifications;
    try {
      const pending = await LN.getPending();
      if (pending.notifications && pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
      if (!state.settings.notifications) return;
      const now = Date.now(), horizon = now + 7 * 24 * 60 * MIN;
      const list = [];
      for (const t of state.tasks) {
        if (t.done) continue;
        for (const s of t.steps || []) {
          if (!s.startAt || s.done) continue;
          const at = new Date(s.startAt).getTime();
          if (at <= now || at > horizon) continue;
          list.push({
            id: hash32(s.id), sound: 'default',
            title: s.kind === 'travel' ? `Leave now · ${t.title}` : s.kind === 'wake' ? `Wake up · ${t.title}` : s.kind === 'anchor' ? t.title : s.title,
            body: s.kind === 'anchor' ? 'You should be there now.' : `${fmtTime(at)} · for “${t.title}”`,
            schedule: { at: new Date(at), allowWhileIdle: true },
            extra: { taskId: t.id },
          });
        }
      }
      list.sort((a, b) => a.schedule.at - b.schedule.at);
      if (list.length) await LN.schedule({ notifications: list.slice(0, 60) }); // iOS caps pending notifications at 64
    } catch (e) { /* never break the UI over a notification */ }
  }, 600);
}
function hash32(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; return Math.abs(h) || 1; }

const notified = new Set();
function tick() {
  const now = Date.now();
  if (NATIVE) { render(); return; }
  if (!(state.settings.notifications && 'Notification' in window && Notification.permission === 'granted')) { render(); return; }
  for (const t of state.tasks) {
    if (t.done) continue;
    for (const s of t.steps || []) {
      if (!s.startAt || s.done || notified.has(s.id)) continue;
      const start = new Date(s.startAt).getTime();
      if (start <= now && start > now - 2 * MIN) {
        notified.add(s.id);
        notify(s.kind === 'travel' ? `Leave now · ${t.title}` : `${fmtTime(start)} · ${s.title}`, s.kind === 'travel' ? s.title : `for “${t.title}”`);
      }
    }
  }
  render();
}
async function notify(title, body) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.showNotification) return reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: title });
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function totalMin(steps) { return steps.reduce((a, s) => a + (s.durationMin || 0), 0); }
function humanDur(ms) {
  const m = Math.round(Math.abs(ms) / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; }

// Expose for tests / debugging
window.__runway = { state, store, parseTask, buildPlan, render };
