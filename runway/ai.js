// Runway AI planner — Claude reads the whole request and plans backwards.
//
// Used when an API key is saved in Settings. Talks to the Claude API directly
// from the phone (raw HTTP; the app has no build step). Falls back to the
// on-device rules in planner.js when there's no key or the call fails.

import { DEFAULT_PREFS } from './planner.js';

export const AI_MODEL = 'claude-opus-5';
const API = 'https://api.anthropic.com/v1/messages';

const STEP_KINDS = ['wake', 'prep', 'transition', 'travel', 'buffer', 'anchor', 'research', 'action', 'night_before'];

const SCHEMA = {
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

function systemPrompt(prefs, now) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const nowStr = `${now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  return `You are the planner inside Runway, an app for people with ADHD. Their problem: they plan the event but not the transitions, so they are always late. Your job is to turn one spoken request into an honest, backwards-planned timeline.

Now: ${nowStr} (${tz}). All datetimes you output are local to that timezone, formatted YYYY-MM-DDTHH:MM.

How to plan:
- Read everything the person said and honor every constraint, especially durations they gave ("takes me three hours"), hard boundaries ("leave the house at six", "must be finished by"), and prep they asked for. Their numbers beat the defaults below.
- Timed task: start from the anchor moment and plan BACKWARDS to the first thing they must do (usually waking up or stopping their current activity). Then plan FORWARD through the activity itself when they gave its duration. Every step gets a startAt; steps are in chronological order; the anchor step has kind "anchor".
- Always include transition time: stop-and-switch, bathroom, shower, dressing, eating if a mealtime is crossed, "grab keys/phone/wallet and what to bring", travel with a traffic pad (~20%), and arriving 10 minutes early. For starts before 11am include a wake-up step with a snooze budget and a "night before" step (kind night_before, at 21:00 the previous day) listing what to lay out and the alarm time.
- Put wake-up and leave-the-house times on 5-minute marks; absorb the slack into that step.
- Project (no time yet): 3–6 tiny logistics steps of 2–10 minutes each (find the place, check hours, pick a window, book it, plan the wait/what to bring), kind "research" or "action", startAt null, then a final step "Set the date & time in Runway" with kind "action".
- If they said it happens every week/day, set repeat and plan the next occurrence.
- Titles: short, concrete, imperative, no fluff. Do not repeat the person's whole sentence back as the title.
- Defaults only when they didn't say otherwise (minutes): wake-up+snooze ${p.wakeUpBuffer}, bathroom ${p.bathroom}, shower ${p.shower}, dress ${p.dress}, breakfast ${p.breakfast}, other meal ${p.meal}, stop-and-switch ${p.windDown}, out the door ${p.outTheDoor}, arrive early ${p.arriveEarly}, unknown travel ${p.defaultTravel}.
- Ask a question (max 2) only if a truly important fact is missing, e.g. which day for a one-off appointment; otherwise pick the sensible nearest option and say so in the summary.`;
}

export async function planWithAI({ text, prefs, apiKey, now = new Date() }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 8000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      fallbacks: 'default',
      system: systemPrompt(prefs, now),
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    const err = new Error(res.status === 401 ? 'That API key was rejected.' : res.status === 429 ? 'Rate limited — try again in a moment.' : `Claude API error ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status; throw err;
  }
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  const textBlock = (msg.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Empty response from Claude.');
  const plan = JSON.parse(textBlock.text);
  return normalize(plan);
}

// Turn the model's local datetimes into ISO strings the app stores, and tidy.
function normalize(plan) {
  const toISO = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };
  const steps = (plan.steps || []).map((s, i) => ({
    id: `a${Date.now().toString(36)}${i.toString(36)}`,
    title: String(s.title || '').trim(),
    durationMin: Math.max(0, Math.round(Number(s.durationMin) || 0)),
    startAt: toISO(s.startAt),
    kind: s.kind === 'night_before' ? 'prep' : (STEP_KINDS.includes(s.kind) ? s.kind : 'action'),
    nightBefore: s.kind === 'night_before',
    done: false,
  })).filter((s) => s.title);
  steps.sort((a, b) => (a.startAt && b.startAt) ? a.startAt.localeCompare(b.startAt) : 0);
  const anchor = plan.kind === 'timed' ? toISO(plan.anchor) : null;
  if (anchor && !steps.some((s) => s.kind === 'anchor')) {
    const at = steps.find((s) => s.startAt === anchor); if (at) at.kind = 'anchor';
  }
  if (!anchor && plan.kind === 'project' && !steps.some((s) => /set the (date|time)/i.test(s.title))) {
    steps.push({ id: `a${Date.now().toString(36)}z`, title: 'Set the date & time in Runway → it plans the day backwards', durationMin: 1, startAt: null, kind: 'settime', action: 'settime', done: false });
  } else if (!anchor) {
    const st = steps.find((s) => /set the (date|time)/i.test(s.title)); if (st) { st.kind = 'settime'; st.action = 'settime'; }
  }
  return {
    title: String(plan.title || '').trim() || 'Task',
    anchor,
    deadline: toISO(plan.deadline),
    location: plan.location || null,
    travelMin: plan.travelMin != null ? Math.max(0, Math.round(Number(plan.travelMin))) : null,
    repeat: ['daily', 'weekdays', 'weekly'].includes(plan.repeat) ? plan.repeat : 'none',
    summary: String(plan.summary || ''),
    questions: Array.isArray(plan.questions) ? plan.questions.slice(0, 2) : [],
    steps,
  };
}

// --- Editing an AI-made plan without re-asking ---------------------------
const MIN = 60000;

// Move every timed step by the same amount (anchor changed).
export function shiftSteps(steps, deltaMs) {
  return steps.map((s) => (s.startAt ? { ...s, startAt: new Date(new Date(s.startAt).getTime() + deltaMs).toISOString() } : s));
}

// One step got longer/shorter: keep the anchor fixed, move everything BEFORE it earlier/later.
export function resizeStep(steps, stepId, newMin) {
  const idx = steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return steps;
  const delta = (newMin - steps[idx].durationMin) * MIN;
  const target = steps[idx];
  return steps.map((s, i) => {
    if (i === idx) return { ...s, durationMin: newMin, startAt: s.startAt && !target.nightBefore ? new Date(new Date(s.startAt).getTime() - delta).toISOString() : s.startAt };
    if (i < idx && s.startAt && !s.nightBefore && !target.nightBefore) return { ...s, startAt: new Date(new Date(s.startAt).getTime() - delta).toISOString() };
    return s;
  });
}

// Next occurrence for a repeating task.
export function nextOccurrence(task) {
  if (!task.anchor || !task.repeat || task.repeat === 'none') return null;
  const a = new Date(task.anchor);
  let days = task.repeat === 'weekly' ? 7 : 1;
  if (task.repeat === 'weekdays') { const dow = a.getDay(); days = dow === 5 ? 3 : dow === 6 ? 2 : 1; }
  const delta = days * 24 * 60 * MIN;
  return {
    ...task,
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: Date.now(), updatedAt: Date.now(), done: false,
    anchor: new Date(a.getTime() + delta).toISOString(),
    steps: shiftSteps(task.steps, delta).map((s) => ({ ...s, done: false })),
  };
}
