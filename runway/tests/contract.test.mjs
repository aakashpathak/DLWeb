import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePlan, extractJSON, buildSystemPrompt, PLAN_SCHEMA } from '../plan-contract.js';

test('extractJSON copes with fences and prose around the object', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJSON('Here you go: {"a":3} hope that helps'), { a: 3 });
  assert.throws(() => extractJSON('nope'));
});

test('normalizePlan repairs a sloppy small-model plan', () => {
  const sloppy = {
    title: 'Dentist', kind: 'timed', anchor: '2026-09-10T08:00', repeat: 'sometimes', travelMin: '45',
    steps: [
      { title: 'Dentist', durationMin: 60, startAt: '2026-09-10T08:00', kind: 'anchor' },
      { title: 'Wake up', durationMin: 15, startAt: '2026-09-10T05:30', kind: 'wake' },
      { title: 'Also anchor', durationMin: 5, startAt: '2026-09-10T07:00', kind: 'anchor' },
      { title: '', durationMin: 5, startAt: '2026-09-10T07:10', kind: 'prep' },
      { title: 'No time', durationMin: 5, startAt: null, kind: 'prep' },
      { title: 'Weird kind', durationMin: 'x', startAt: '2026-09-10T06:00', kind: 'banana' },
    ],
  };
  const p = normalizePlan(sloppy);
  assert.equal(p.repeat, 'none');
  assert.equal(p.travelMin, 45);
  assert.deepEqual(p.steps.map((s) => s.title), ['Wake up', 'Weird kind', 'Also anchor', 'Dentist']);
  assert.equal(p.steps.filter((s) => s.kind === 'anchor').length, 1);
  assert.equal(p.steps.find((s) => s.title === 'Dentist').kind, 'anchor');
  assert.equal(p.steps.find((s) => s.title === 'Weird kind').kind, 'action');
  assert.equal(p.steps.find((s) => s.title === 'Weird kind').durationMin, 0);
});

test('a project plan always ends with the set-time step', () => {
  const p = normalizePlan({ title: 'Oil change', kind: 'project', steps: [{ title: 'Find a shop', durationMin: 5, startAt: null, kind: 'research' }] });
  assert.equal(p.anchor, null);
  assert.equal(p.steps[p.steps.length - 1].action, 'settime');
});

test('small-model prompt carries the schema and worked example', () => {
  const big = buildSystemPrompt({ prefs: {}, now: new Date(2026, 8, 7, 15), tz: 'America/Los_Angeles' });
  const small = buildSystemPrompt({ prefs: {}, now: new Date(2026, 8, 7, 15), tz: 'America/Los_Angeles', smallModel: true });
  assert.ok(!big.includes('Example.'));
  assert.ok(small.includes('Example.') && small.includes(JSON.stringify(PLAN_SCHEMA)));
  assert.match(big, /Monday, September 7, 2026/);
});
