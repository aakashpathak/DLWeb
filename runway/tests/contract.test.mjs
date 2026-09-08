import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePlan, extractJSON, buildSystemPrompt, PLAN_SCHEMA } from '../plan-contract.js';

test('extractJSON copes with fences and prose around the object', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJSON('Here you go: {"a":3} hope that helps'), { a: 3 });
  assert.throws(() => extractJSON('nope'));
});

const id = (s) => s; // keep wall-clock strings for readable assertions

test('normalizePlan computes the timeline backwards and repairs a sloppy plan', () => {
  const sloppy = {
    title: 'Dentist', kind: 'timed', anchor: '2026-09-10T08:00', repeat: 'sometimes', travelMin: '45', summary: 'Wake 5:30am and go',
    steps: [
      { title: 'Wake up', durationMin: 15, when: 'before', kind: 'wake' },
      { title: 'Weird kind', durationMin: 'x', when: 'before', kind: 'banana' },
      { title: 'Shower', durationMin: 22, when: 'before', kind: 'prep' },
      { title: 'Drive', durationMin: 53, when: 'before', kind: 'travel' },
      { title: 'Dentist', durationMin: 60, when: 'anchor', kind: 'anchor' },
      { title: 'Also anchor', durationMin: 5, when: 'after', kind: 'anchor' },
      { title: '', durationMin: 5, when: 'after', kind: 'prep' },
    ],
  };
  const p = normalizePlan(sloppy, { toISO: id });
  assert.equal(p.repeat, 'none');
  assert.equal(p.travelMin, 45);
  assert.equal(p.summary, 'Wake and go');
  assert.deepEqual(p.steps.map((s) => s.title), ['Wake up', 'Weird kind', 'Shower', 'Drive', 'Dentist', 'Also anchor']);
  assert.equal(p.steps.filter((s) => s.kind === 'anchor').length, 1);
  assert.equal(p.steps.find((s) => s.title === 'Also anchor').kind, 'action');
  // drive 53 min before 8:00 = 7:07 → floored to 7:05 with 55 min
  const drive = p.steps.find((s) => s.title === 'Drive');
  assert.equal(drive.startAt, '2026-09-10T07:05'); assert.equal(drive.durationMin, 55);
  assert.equal(p.steps.find((s) => s.title === 'Dentist').startAt, '2026-09-10T08:00');
  assert.equal(p.steps.find((s) => s.title === 'Also anchor').startAt, '2026-09-10T09:00');
  const wake = p.steps.find((s) => s.title === 'Wake up');
  assert.equal(new Date(wake.startAt + 'Z').getUTCMinutes() % 5, 0);
});

test('finishBy is enforced: the whole day moves earlier so the last step ends on time', () => {
  const plan = { title: 'Run', kind: 'timed', anchor: '2026-09-11T06:00', finishBy: '2026-09-11T09:00', steps: [
    { title: 'Wake up', durationMin: 15, when: 'before', kind: 'wake' },
    { title: 'Run 12 miles', durationMin: 180, when: 'anchor', kind: 'anchor' },
    { title: 'Shower and eat', durationMin: 40, when: 'after', kind: 'prep' },
  ] };
  const p = normalizePlan(plan, { toISO: id });
  assert.equal(p.endsAt, '2026-09-11T09:00');
  assert.equal(p.anchor, '2026-09-11T05:20');
  assert.equal(p.shiftedMin, 40);
  assert.equal(p.steps[0].startAt, '2026-09-11T05:05');
});

test('night-before lands at 9pm the previous evening', () => {
  const plan = { title: 'Flight', kind: 'timed', anchor: '2026-09-11T06:00', steps: [
    { title: 'Pack', durationMin: 30, when: 'night_before', kind: 'prep' },
    { title: 'Wake up', durationMin: 15, when: 'before', kind: 'wake' },
    { title: 'Flight', durationMin: 120, when: 'anchor', kind: 'anchor' },
  ] };
  const p = normalizePlan(plan, { toISO: id });
  assert.equal(p.steps[0].startAt, '2026-09-10T21:00');
  assert.equal(p.steps[0].nightBefore, true);
});

test('a project plan always ends with the set-time step', () => {
  const p = normalizePlan({ title: 'Oil change', kind: 'project', steps: [{ title: 'Find a shop', durationMin: 5, when: 'before', kind: 'research' }] });
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
