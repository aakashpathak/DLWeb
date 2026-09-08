// Runway plan contract — shared by the phone app (browser ESM) and the backend (Node ESM).
//
// Division of labour, on purpose:
//   • The model decides WHAT the steps are, in what ORDER, and HOW LONG each takes.
//   • This file computes every clock time, backwards from the anchor, and enforces
//     hard constraints ("ready by 9") arithmetically. Models are bad at time math;
//     code is not. This also lets small/fast models produce good plans.

import { DEFAULT_PREFS } from './planner.js';

export const STEP_KINDS = ['wake', 'prep', 'transition', 'travel', 'buffer', 'anchor', 'research', 'action'];
const MIN = 60000;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'kind', 'anchor', 'finishBy', 'deadline', 'location', 'travelMin', 'repeat', 'summary', 'questions', 'steps'],
  properties: {
    title: { type: 'string', description: 'Task name, max 6 words, no times/durations' },
    kind: { type: 'string', enum: ['timed', 'project'] },
    anchor: { type: ['string', 'null'], description: 'YYYY-MM-DDTHH:MM local. The moment the activity itself starts / you must be there. null for project.' },
    finishBy: { type: ['string', 'null'], description: 'YYYY-MM-DDTHH:MM local. Hard time by which EVERYTHING must be finished, if they said one (e.g. "ready by 9"). Else null.' },
    deadline: { type: ['string', 'null'], description: 'For projects: date by which it must be done, else null' },
    location: { type: ['string', 'null'] },
    travelMin: { type: ['integer', 'null'], description: 'One-way travel minutes if going somewhere, else null' },
    repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] },
    summary: { type: 'string', description: 'Max 8 words about the plan, no clock times (the app adds them)' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Empty unless a vital fact is missing (max 1)' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'durationMin', 'when', 'kind'],
        properties: {
          title: { type: 'string', description: 'Short, concrete, imperative' },
          durationMin: { type: 'integer', minimum: 0 },
          when: { type: 'string', enum: ['night_before', 'before', 'anchor', 'after'], description: 'before = leads up to the anchor (chronological order); anchor = the activity itself (exactly one); after = follows it' },
          kind: { type: 'string', enum: STEP_KINDS },
        },
      },
    },
  },
};

const EXAMPLE_IN = 'Dentist Thursday at 8am, it\'s 45 minutes away';
const EXAMPLE_OUT = {
  title: 'Dentist', kind: 'timed', anchor: '2026-09-10T08:00', finishBy: null, deadline: null, location: null, travelMin: 45, repeat: 'none',
  summary: 'Early start, drive with traffic pad', questions: [],
  steps: [
    { title: 'Lay out clothes, insurance card + ID by the door, set alarm', durationMin: 10, when: 'night_before', kind: 'prep' },
    { title: 'Wake up (alarm + snooze budget)', durationMin: 15, when: 'before', kind: 'wake' },
    { title: 'Bathroom, water, meds', durationMin: 10, when: 'before', kind: 'prep' },
    { title: 'Shower', durationMin: 20, when: 'before', kind: 'prep' },
    { title: 'Get dressed', durationMin: 10, when: 'before', kind: 'prep' },
    { title: 'Breakfast (sit down for it)', durationMin: 15, when: 'before', kind: 'prep' },
    { title: 'Grab insurance card, ID, list of questions', durationMin: 5, when: 'before', kind: 'transition' },
    { title: 'Out the door: shoes, keys, phone, wallet', durationMin: 10, when: 'before', kind: 'transition' },
    { title: 'Drive (45 min + traffic pad)', durationMin: 55, when: 'before', kind: 'travel' },
    { title: 'Arrive early, breathe', durationMin: 10, when: 'before', kind: 'buffer' },
    { title: 'Dentist', durationMin: 60, when: 'anchor', kind: 'anchor' },
  ],
};

export function buildSystemPrompt({ prefs, now = new Date(), tz, smallModel = false }) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const base = `You plan for Runway, an app for people with ADHD who plan the event but forget the transitions and end up late. Turn one spoken request into steps. You choose the steps, their order and their durations. The app computes all clock times backwards from the anchor, so never do time arithmetic and never put clock times in titles or the summary.

Now: ${fmtNow(now, tz)}${tz ? ` (${tz})` : ''}. Datetimes you output are local, YYYY-MM-DDTHH:MM.

Rules:
- Honor every constraint they said. Their durations ("takes me three hours") beat defaults. "Leave at six" → the leaving step must land at six: make the anchor the moment they leave, or put the activity as the anchor and the app will fit the rest. "Ready/done/finished by X" → finishBy = X; include the activity and any after-steps (shower, eat) so everything ends by X.
- Timed task: steps when="before" in chronological order (wake-up first if the start is early), exactly one when="anchor" step for the activity itself with its real duration, and when="after" steps only if something must happen after the activity before they're free. Include transitions: stop-and-switch or wake-up, bathroom, shower, dressing, a meal if a mealtime is crossed, "grab" items, out the door, travel with ~20% traffic pad, arrive early. Early start → one when="night_before" step (lay out things, set alarm).
- Project (no time yet): 3–6 steps of 2–10 min, when="before", kind research/action: find the place, check hours, pick a window, book it, plan the wait. Do not add a "set the time" step; the app does.
- Repeat: set if they said every day/week.
- Defaults when they didn't say (minutes): wake+snooze ${p.wakeUpBuffer}, bathroom ${p.bathroom}, shower ${p.shower}, dress ${p.dress}, breakfast ${p.breakfast}, other meal ${p.meal}, stop-and-switch ${p.windDown}, out the door ${p.outTheDoor}, arrive early ${p.arriveEarly}, unknown travel ${p.defaultTravel}.
- Titles ≤ 8 words. Title of the task ≤ 6 words. questions: only if a vital fact is missing and cannot be sensibly assumed.`;
  if (!smallModel) return base;
  return `${base}

Output ONLY a JSON object matching this schema, no prose, no markdown:
${JSON.stringify(PLAN_SCHEMA)}

Example. Input (asked Monday 2026-09-07 15:00): "${EXAMPLE_IN}"
Output:
${JSON.stringify(EXAMPLE_OUT)}`;
}

export function fmtNow(now, tz) {
  try {
    return `${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })} ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}`;
  } catch (e) { return now.toString(); }
}

// ---------------------------------------------------------------------------
// Layout: turn steps + durations into a timeline. Pure arithmetic in "wall
// clock minutes" so it works the same in the browser and on a server in any
// timezone; `toISO` converts a local "YYYY-MM-DDTHH:MM" into a real instant.
// ---------------------------------------------------------------------------
const wallMs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };
const wallStr = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const floor5 = (ms) => Math.floor(ms / (5 * MIN)) * 5 * MIN;

export function normalizePlan(plan, { toISO = defaultToISO } = {}) {
  const stamp = Date.now().toString(36);
  const clean = (Array.isArray(plan.steps) ? plan.steps : []).map((s, i) => ({
    id: `a${stamp}${i.toString(36)}`,
    title: String(s?.title || '').trim().slice(0, 90),
    durationMin: Math.max(0, Math.round(Number(s?.durationMin) || 0)),
    when: ['night_before', 'before', 'anchor', 'after'].includes(s?.when) ? s.when : (s?.kind === 'anchor' ? 'anchor' : 'before'),
    kind: STEP_KINDS.includes(s?.kind) ? s.kind : 'action',
    done: false,
  })).filter((s) => s.title);

  const timed = plan.kind === 'timed' && wallMs(plan.anchor) != null;
  const out = {
    title: String(plan.title || '').trim().slice(0, 60) || 'Task',
    anchor: null, finishBy: null,
    deadline: toISO(plan.deadline),
    location: plan.location ? String(plan.location).slice(0, 80) : null,
    travelMin: plan.travelMin != null && !isNaN(Number(plan.travelMin)) ? Math.max(0, Math.round(Number(plan.travelMin))) : null,
    repeat: ['daily', 'weekdays', 'weekly'].includes(plan.repeat) ? plan.repeat : 'none',
    summary: String(plan.summary || '').replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '').replace(/\s{2,}/g, ' ').trim().slice(0, 80),
    questions: Array.isArray(plan.questions) ? plan.questions.slice(0, 1).map(String) : [],
    steps: [],
    shiftedMin: 0,
  };

  if (!timed) {
    const steps = clean.filter((s) => s.when !== 'night_before').map((s) => ({ ...s, startAt: null, when: 'before' }));
    steps.push({ id: `a${stamp}z`, title: 'Set the date & time in Runway → it plans the day backwards', durationMin: 1, startAt: null, kind: 'settime', action: 'settime', when: 'before', done: false });
    out.steps = steps.map(({ when, ...s }) => s);
    return out;
  }

  let anchorMs = wallMs(plan.anchor);
  const finishBy = wallMs(plan.finishBy);
  const night = clean.filter((s) => s.when === 'night_before');
  const before = clean.filter((s) => s.when === 'before');
  const after = clean.filter((s) => s.when === 'after');
  let anchorStep = clean.find((s) => s.when === 'anchor');
  if (!anchorStep) anchorStep = { id: `a${stamp}A`, title: out.title, durationMin: 60, kind: 'anchor', done: false };
  anchorStep.kind = 'anchor';
  for (const s of clean) if (s !== anchorStep && s.kind === 'anchor') s.kind = 'action';

  // Backwards from the anchor. Wake-up, leaving, and the very first step land on
  // 5-minute marks; the slack is absorbed into that step so nothing later moves.
  let t = anchorMs;
  for (let i = before.length - 1; i >= 0; i--) {
    const s = before[i];
    t -= s.durationMin * MIN;
    if (s.kind === 'wake' || s.kind === 'travel' || i === 0) {
      const f = floor5(t);
      if (f !== t) { s.durationMin += Math.round((t - f) / MIN); t = f; }
    }
    s.start = t;
  }
  anchorStep.start = anchorMs;
  let end = anchorMs + anchorStep.durationMin * MIN;
  for (const s of after) { s.start = end; end += s.durationMin * MIN; }

  // Hard finish time: if the plan runs past it, move the whole day earlier.
  if (finishBy != null && end > finishBy) {
    const shift = Math.ceil((end - finishBy) / (5 * MIN)) * 5 * MIN;
    for (const s of [...before, anchorStep, ...after]) s.start -= shift;
    anchorMs -= shift; end -= shift;
    out.shiftedMin = shift / MIN;
  }

  // Night-before steps: 9pm the evening before the first step.
  const first = before.length ? before[0].start : anchorMs;
  const nightAt = floor5(first - (first % (24 * 60 * MIN)) - 3 * 60 * MIN); // 21:00 previous day, wall clock
  for (const s of night) { s.start = nightAt; s.nightBefore = true; }

  out.anchor = toISO(wallStr(anchorMs));
  out.finishBy = finishBy != null ? toISO(wallStr(finishBy)) : null;
  out.endsAt = toISO(wallStr(end));
  out.steps = [...night, ...before, anchorStep, ...after].map(({ when, start, ...s }) => ({ ...s, startAt: toISO(wallStr(start)) }));
  return out;
}

function defaultToISO(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

// Pull a JSON object out of a model reply that may be wrapped in prose or fences.
export function extractJSON(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) { try { return JSON.parse(m[1]); } catch (e) { /* fall through */ } }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('No JSON object in model reply');
}
