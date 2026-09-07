// Runway plan contract — shared by the phone app (browser ESM) and the backend
// (Node ESM). One schema, one prompt, one normalizer, so Claude on the API and
// a small local model on a spare computer produce the same shape of plan.

import { DEFAULT_PREFS } from './planner.js';

export const STEP_KINDS = ['wake', 'prep', 'transition', 'travel', 'buffer', 'anchor', 'research', 'action', 'night_before'];

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'kind', 'anchor', 'deadline', 'location', 'travelMin', 'repeat', 'summary', 'questions', 'steps'],
  properties: {
    title: { type: 'string', description: 'Short task name, at most 8 words, no times or durations in it' },
    kind: { type: 'string', enum: ['timed', 'project'], description: 'timed = there is a moment you must be somewhere or start; project = logistics first, no time yet' },
    anchor: { type: ['string', 'null'], description: 'Local datetime YYYY-MM-DDTHH:MM when the task itself starts or you must be there. null for projects.' },
    deadline: { type: ['string', 'null'], description: 'Local datetime YYYY-MM-DDTHH:MM by which a project must be done, else null' },
    location: { type: ['string', 'null'] },
    travelMin: { type: ['integer', 'null'], description: 'One-way travel minutes if the person has to go somewhere, else null' },
    repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] },
    summary: { type: 'string', description: 'One line the person can remember, e.g. "Wake 5:15 · out the door 6:00 · done 9:00"' },
    questions: { type: 'array', items: { type: 'string' }, description: 'At most 2 short questions if something important is genuinely unknown, else empty' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'durationMin', 'startAt', 'kind'],
        properties: {
          title: { type: 'string', description: 'Concrete, short, imperative. Include what to grab or decide.' },
          durationMin: { type: 'integer', minimum: 0 },
          startAt: { type: ['string', 'null'], description: 'Local datetime YYYY-MM-DDTHH:MM. Required for timed tasks; null for project steps.' },
          kind: { type: 'string', enum: STEP_KINDS },
        },
      },
    },
  },
};

// A worked example. Frontier models don't need it; 7B local models do.
const EXAMPLE_IN = 'Dentist Thursday at 8am, it\'s 45 minutes away';
const EXAMPLE_OUT = {
  title: 'Dentist', kind: 'timed', anchor: '2026-09-10T08:00', deadline: null, location: null, travelMin: 45, repeat: 'none',
  summary: 'Wake 5:30 · leave 6:55 · there 7:50', questions: [],
  steps: [
    { title: 'Night before: lay out clothes, insurance card + ID by the door, alarm 5:30', durationMin: 10, startAt: '2026-09-09T21:00', kind: 'night_before' },
    { title: 'Wake up (alarm + snooze budget)', durationMin: 15, startAt: '2026-09-10T05:30', kind: 'wake' },
    { title: 'Bathroom, water, meds', durationMin: 10, startAt: '2026-09-10T05:45', kind: 'prep' },
    { title: 'Shower', durationMin: 20, startAt: '2026-09-10T05:55', kind: 'prep' },
    { title: 'Get dressed', durationMin: 10, startAt: '2026-09-10T06:15', kind: 'prep' },
    { title: 'Breakfast (sit down for it)', durationMin: 15, startAt: '2026-09-10T06:25', kind: 'prep' },
    { title: 'Grab insurance card, ID, list of questions', durationMin: 5, startAt: '2026-09-10T06:40', kind: 'transition' },
    { title: 'Out the door: shoes, keys, phone, wallet', durationMin: 10, startAt: '2026-09-10T06:45', kind: 'transition' },
    { title: 'Drive (45 min + 10 min traffic pad)', durationMin: 55, startAt: '2026-09-10T06:55', kind: 'travel' },
    { title: 'Arrive 10 min early, breathe', durationMin: 10, startAt: '2026-09-10T07:50', kind: 'buffer' },
    { title: 'Dentist', durationMin: 60, startAt: '2026-09-10T08:00', kind: 'anchor' },
  ],
};

export function buildSystemPrompt({ prefs, now = new Date(), tz, smallModel = false }) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const zone = tz || 'the person\'s local time';
  const nowStr = fmtNow(now, tz);
  const base = `You are the planner inside Runway, an app for people with ADHD. Their problem: they plan the event but not the transitions, so they are always late. Your job is to turn one spoken request into an honest, backwards-planned timeline.

Now: ${nowStr} (${zone}). All datetimes you output are local to that timezone, formatted YYYY-MM-DDTHH:MM.

How to plan:
- Read everything the person said and honor every constraint, especially durations they gave ("takes me three hours"), hard boundaries ("leave the house at six", "must be finished by"), and prep they asked for. Their numbers beat the defaults below.
- Timed task: start from the anchor moment and plan BACKWARDS to the first thing they must do (usually waking up or stopping their current activity). Then plan FORWARD through the activity itself when they gave its duration. Every step gets a startAt; steps are in chronological order; exactly one step has kind "anchor" and its startAt equals anchor.
- Always include transition time: stop-and-switch, bathroom, shower, dressing, eating if a mealtime is crossed, "grab keys/phone/wallet and what to bring", travel with a traffic pad (~20%), and arriving 10 minutes early. For starts before 11am include a wake-up step with a snooze budget and a "night before" step (kind night_before, at 21:00 the previous day) listing what to lay out and the alarm time.
- Put wake-up and leave-the-house times on 5-minute marks; absorb the slack into that step.
- Project (no time yet): 3–6 tiny logistics steps of 2–10 minutes each (find the place, check hours, pick a window, book it, plan the wait/what to bring), kind "research" or "action", startAt null, then a final step "Set the date & time in Runway" with kind "action".
- If they said it happens every week/day, set repeat and plan the next occurrence.
- Titles: short, concrete, imperative, no fluff. Do not repeat the person's whole sentence back as the title.
- Defaults only when they didn't say otherwise (minutes): wake-up+snooze ${p.wakeUpBuffer}, bathroom ${p.bathroom}, shower ${p.shower}, dress ${p.dress}, breakfast ${p.breakfast}, other meal ${p.meal}, stop-and-switch ${p.windDown}, out the door ${p.outTheDoor}, arrive early ${p.arriveEarly}, unknown travel ${p.defaultTravel}.
- Ask a question (max 2) only if a truly important fact is missing, e.g. which day for a one-off appointment; otherwise pick the sensible nearest option and say so in the summary.`;
  if (!smallModel) return base;
  return `${base}

Output ONLY a JSON object matching this schema, no prose, no markdown fences:
${JSON.stringify(PLAN_SCHEMA)}

Example. Input (asked on Monday 2026-09-07 15:00): "${EXAMPLE_IN}"
Output:
${JSON.stringify(EXAMPLE_OUT)}

Check before answering: each step's startAt + durationMin equals the next step's startAt; the anchor step's startAt equals "anchor"; wake and travel start times end in 0 or 5.`;
}

export function fmtNow(now, tz) {
  try {
    return `${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })} ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })}`;
  } catch (e) { return now.toString(); }
}

// Turn a model's local datetimes into ISO strings the app stores, and tidy up.
// Tolerant on purpose: small models drift; the app must never crash on a plan.
export function normalizePlan(plan, { toISO = defaultToISO } = {}) {
  const stamp = Date.now().toString(36);
  let steps = (Array.isArray(plan.steps) ? plan.steps : []).map((s, i) => ({
    id: `a${stamp}${i.toString(36)}`,
    title: String(s?.title || '').trim(),
    durationMin: Math.max(0, Math.round(Number(s?.durationMin) || 0)),
    startAt: toISO(s?.startAt),
    kind: s?.kind === 'night_before' ? 'prep' : (STEP_KINDS.includes(s?.kind) ? s.kind : 'action'),
    nightBefore: s?.kind === 'night_before',
    done: false,
  })).filter((s) => s.title);
  const timed = plan.kind === 'timed';
  const anchor = timed ? toISO(plan.anchor) : null;
  if (timed) {
    steps = steps.filter((s) => s.startAt);
    steps.sort((a, b) => a.startAt.localeCompare(b.startAt));
    const anchors = steps.filter((s) => s.kind === 'anchor');
    if (anchors.length > 1) {
      const keep = anchors.find((s) => s.startAt === anchor) || anchors[0];
      anchors.forEach((s) => { if (s !== keep) s.kind = 'action'; });
    }
    if (!anchors.length && anchor) {
      const at = steps.find((s) => s.startAt === anchor) || steps.find((s) => s.startAt >= anchor);
      if (at) at.kind = 'anchor';
    }
  } else {
    steps = steps.map((s) => ({ ...s, startAt: null }));
    const st = steps.find((s) => /set the (date|time)/i.test(s.title));
    if (st) { st.kind = 'settime'; st.action = 'settime'; }
    else steps.push({ id: `a${stamp}z`, title: 'Set the date & time in Runway → it plans the day backwards', durationMin: 1, startAt: null, kind: 'settime', action: 'settime', done: false });
  }
  return {
    title: String(plan.title || '').trim().slice(0, 80) || 'Task',
    anchor,
    deadline: toISO(plan.deadline),
    location: plan.location ? String(plan.location).slice(0, 80) : null,
    travelMin: plan.travelMin != null && !isNaN(Number(plan.travelMin)) ? Math.max(0, Math.round(Number(plan.travelMin))) : null,
    repeat: ['daily', 'weekdays', 'weekly'].includes(plan.repeat) ? plan.repeat : 'none',
    summary: String(plan.summary || '').slice(0, 200),
    questions: Array.isArray(plan.questions) ? plan.questions.slice(0, 2).map(String) : [],
    steps,
  };
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
