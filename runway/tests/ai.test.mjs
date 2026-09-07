import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWithAI, shiftSteps, resizeStep, nextOccurrence } from '../ai.js';

const day = (h, m = 0) => { const d = new Date(2026, 8, 11, h, m); return d; };
const iso = (h, m) => day(h, m).toISOString();
const local = (h, m = 0) => `2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

const MODEL_PLAN = {
  title: 'Weekly 12-mile run', kind: 'timed', anchor: local(6), deadline: null, location: null, travelMin: null, repeat: 'weekly',
  summary: 'Wake 5:15 · out the door 6:00 · done 9:00',
  questions: [],
  steps: [
    { title: 'Night before: lay out kit, charge watch, alarm 5:15', durationMin: 10, startAt: '2026-09-10T21:00', kind: 'night_before' },
    { title: 'Wake up (alarm + snooze budget)', durationMin: 15, startAt: local(5, 15), kind: 'wake' },
    { title: 'Bathroom, water, fuel', durationMin: 15, startAt: local(5, 30), kind: 'prep' },
    { title: 'Kit on, shoes, watch, keys', durationMin: 15, startAt: local(5, 45), kind: 'transition' },
    { title: 'Run 12 miles', durationMin: 180, startAt: local(6), kind: 'anchor' },
    { title: 'Stretch, shower, eat', durationMin: 40, startAt: local(9), kind: 'prep' },
  ],
};

function mockFetch(body, status = 200) {
  globalThis.fetch = async (url, opts) => {
    mockFetch.last = { url, opts: JSON.parse(opts.body), headers: opts.headers };
    return { ok: status < 400, status, json: async () => body };
  };
}

test('planWithAI sends the right request and normalizes the plan', async () => {
  mockFetch({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MODEL_PLAN) }] });
  const plan = await planWithAI({ text: 'Run 12 miles each week, takes three hours, leave at six', prefs: {}, apiKey: 'sk-ant-test', now: day(15) });
  const req = mockFetch.last;
  assert.equal(req.opts.model, 'claude-opus-5');
  assert.equal(req.opts.output_config.format.type, 'json_schema');
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(req.opts.system, /Friday, September 11, 2026/);
  assert.equal(plan.title, 'Weekly 12-mile run');
  assert.equal(plan.anchor, iso(6));
  assert.equal(plan.repeat, 'weekly');
  assert.equal(plan.steps.length, 6);
  assert.equal(plan.steps[0].nightBefore, true);
  assert.equal(plan.steps.find((s) => s.kind === 'anchor').title, 'Run 12 miles');
  assert.ok(plan.steps.every((s, i, a) => i === 0 || a[i - 1].startAt <= s.startAt), 'chronological');
});

test('API errors become readable messages', async () => {
  mockFetch({ error: { message: 'invalid x-api-key' } }, 401);
  await assert.rejects(() => planWithAI({ text: 'x', prefs: {}, apiKey: 'bad' }), /rejected/);
});

test('shiftSteps moves every timed step by the same delta', () => {
  const steps = [{ id: 'a', startAt: iso(5, 15), durationMin: 15 }, { id: 'b', startAt: null, durationMin: 5 }, { id: 'c', startAt: iso(6), durationMin: 180 }];
  const moved = shiftSteps(steps, 60 * 60000);
  assert.equal(moved[0].startAt, iso(6, 15));
  assert.equal(moved[1].startAt, null);
  assert.equal(moved[2].startAt, iso(7));
});

test('resizeStep keeps the anchor fixed and moves earlier steps earlier', () => {
  const steps = [
    { id: 'w', startAt: iso(5, 15), durationMin: 15, kind: 'wake' },
    { id: 'p', startAt: iso(5, 30), durationMin: 15, kind: 'prep' },
    { id: 'k', startAt: iso(5, 45), durationMin: 15, kind: 'transition' },
    { id: 'r', startAt: iso(6), durationMin: 180, kind: 'anchor' },
  ];
  const out = resizeStep(steps, 'p', 30);
  assert.equal(out.find((s) => s.id === 'p').durationMin, 30);
  assert.equal(out.find((s) => s.id === 'p').startAt, iso(5, 15));
  assert.equal(out.find((s) => s.id === 'w').startAt, iso(5));
  assert.equal(out.find((s) => s.id === 'k').startAt, iso(5, 45));
  assert.equal(out.find((s) => s.id === 'r').startAt, iso(6));
});

test('nextOccurrence rolls a weekly task forward 7 days with fresh state', () => {
  const t = { id: 't1', title: 'Run', anchor: iso(6), repeat: 'weekly', done: true, steps: [{ id: 'a', startAt: iso(5, 15), durationMin: 15, done: true }] };
  const n = nextOccurrence(t);
  assert.notEqual(n.id, t.id);
  assert.equal(new Date(n.anchor).getDate(), 18);
  assert.equal(n.steps[0].done, false);
  assert.equal(new Date(n.steps[0].startAt).getDate(), 18);
  assert.equal(nextOccurrence({ ...t, repeat: 'none' }), null);
});
