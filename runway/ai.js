// Runway AI planner — Claude (or a local model) reads the whole request and plans backwards.
//
// Two ways to reach a model, picked in Settings:
//   1. Runway server URL  → POST {url}/plan  (the server holds the key; can run Claude or a local model)
//   2. Anthropic API key  → talks to the Claude API directly from the phone
// Falls back to the on-device rules in planner.js when neither is set or the call fails.

import { PLAN_SCHEMA, buildSystemPrompt, normalizePlan, extractJSON } from './plan-contract.js';

export const AI_MODEL = 'claude-opus-5';
const API = 'https://api.anthropic.com/v1/messages';
const TZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; } };

export async function planWithAI({ text, prefs, apiKey, endpoint, token, now = new Date() }) {
  if (endpoint) return planViaServer({ text, prefs, endpoint, token, now });
  if (apiKey) return planDirect({ text, prefs, apiKey, now });
  throw new Error('No AI configured.');
}

async function planViaServer({ text, prefs, endpoint, token, now }) {
  const base = endpoint.replace(/\/+$/, '').replace(/\/plan$/, '');
  let res;
  try {
    res = await fetch(`${base}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, prefs, tz: TZ(), now: now.toISOString() }),
    });
  } catch (e) { throw new Error('Can’t reach your Runway server. Is it running and is the URL right?'); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || (res.status === 401 ? 'Wrong server password.' : `Server error ${res.status}`));
  if (!data.plan) throw new Error('Server sent no plan.');
  // Server already normalized; re-run for safety (idempotent) so the shape is guaranteed.
  return { ...normalizePlan({ ...data.plan, kind: data.plan.anchor ? 'timed' : 'project', steps: data.plan.steps.map((s) => ({ ...s, kind: s.nightBefore ? 'night_before' : s.kind })) }), model: data.model, provider: data.provider };
}

async function planDirect({ text, prefs, apiKey, now }) {
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
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      fallbacks: 'default',
      system: buildSystemPrompt({ prefs, now, tz: TZ() }),
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
  return { ...normalizePlan(extractJSON(textBlock.text)), model: msg.model, provider: 'claude' };
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
