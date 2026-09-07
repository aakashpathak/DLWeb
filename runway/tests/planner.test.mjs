import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTask } from '../nlp.js';
import { buildPlan, classify, DEFAULT_PREFS, keyTimes, fmtTime } from '../planner.js';

const NOW = new Date(2026, 8, 7, 15, 0); // Mon Sep 7 2026, 3pm local

test('parses explicit time + weekday + travel', () => {
  const r = parseTask("Dentist at 8am Thursday, it's 45 minutes away", NOW);
  const a = new Date(r.anchor);
  assert.equal(a.getDay(), 4);
  assert.equal(a.getHours(), 8);
  assert.equal(r.travelMin, 45);
  assert.equal(r.title, 'Dentist');
});

test('parses "tomorrow at 6:30 pm" and location', () => {
  const r = parseTask('Dinner with Sam at Canlis tomorrow at 6:30 pm', NOW);
  const a = new Date(r.anchor);
  assert.equal(a.getDate(), 8);
  assert.equal(a.getHours(), 18);
  assert.equal(a.getMinutes(), 30);
  assert.equal(r.location, 'Canlis');
  assert.match(r.title, /^Dinner with Sam/);
});

test('bare time in the past rolls to tomorrow', () => {
  const r = parseTask('Call the bank at 9am', NOW);
  const a = new Date(r.anchor);
  assert.equal(a.getDate(), 8);
  assert.equal(a.getHours(), 9);
});

test('open-ended task has no anchor and gets research steps', () => {
  const r = parseTask('Get my oil changed', NOW);
  assert.equal(r.anchor, null);
  assert.equal(classify(r.title).id, 'car');
  const steps = buildPlan({ title: r.title, anchor: null });
  assert.ok(steps.length >= 4);
  assert.equal(steps[steps.length - 1].action, 'settime');
});

test('day-of plan is backwards from anchor and includes wake up for morning events', () => {
  const anchor = new Date(2026, 8, 10, 8, 0);
  const task = { title: 'Doctor appointment', anchor: anchor.toISOString(), travelMin: 45 };
  const steps = buildPlan(task, DEFAULT_PREFS);
  const timed = steps.filter((s) => s.startAt && !s.title.startsWith('Night before'));
  for (let i = 1; i < timed.length; i++) assert.ok(timed[i].startAt >= timed[i - 1].startAt, 'chronological');
  const last = timed[timed.length - 1];
  assert.equal(last.kind, 'anchor');
  assert.equal(new Date(last.startAt).getTime(), anchor.getTime());
  const kt = keyTimes({ ...task, steps });
  assert.ok(kt.wakeAt, 'has wake time');
  // travel 45 + 20% = 54, arrive 10 early → leave 64 min before 8:00 = 6:56
  assert.equal(fmtTime(kt.leaveAt), '6:55am'); // 6:56 floored to a 5-minute mark
  assert.ok(kt.wakeAt < kt.leaveAt);
  assert.ok(steps.some((s) => s.title.startsWith('Night before')));
});

test('afternoon event has no wake-up but has a wind-down transition', () => {
  const anchor = new Date(2026, 8, 10, 15, 0);
  const steps = buildPlan({ title: 'Haircut', anchor: anchor.toISOString(), travelMin: 15 });
  assert.ok(!steps.some((s) => s.kind === 'wake'));
  assert.ok(steps.some((s) => s.kind === 'transition' && /Stop what/.test(s.title)));
});

test('at-home task has no travel', () => {
  const anchor = new Date(2026, 8, 10, 15, 0);
  const steps = buildPlan({ title: 'Call the insurance company', anchor: anchor.toISOString() });
  assert.ok(!steps.some((s) => s.kind === 'travel'));
});

test('prefs change durations', () => {
  const anchor = new Date(2026, 8, 10, 8, 0);
  const a = buildPlan({ title: 'Dentist', anchor: anchor.toISOString(), travelMin: 20 }, DEFAULT_PREFS);
  const b = buildPlan({ title: 'Dentist', anchor: anchor.toISOString(), travelMin: 20 }, { ...DEFAULT_PREFS, shower: 40 });
  assert.ok(keyTimes({ steps: b, anchor: anchor.toISOString() }).wakeAt < keyTimes({ steps: a, anchor: anchor.toISOString() }).wakeAt);
});

test('weekday parsing: "next monday" from a monday is 7 days out', () => {
  const r = parseTask('Gym next monday at 7am', NOW);
  assert.equal(new Date(r.anchor).getDate(), 14);
});

test('month-day parsing', () => {
  const r = parseTask('Flight on Oct 3 at 6am, airport is an hour away', NOW);
  const a = new Date(r.anchor);
  assert.equal(a.getMonth(), 9); assert.equal(a.getDate(), 3); assert.equal(a.getHours(), 6);
  assert.equal(r.travelMin, 60);
});

test('key times land on 5-minute marks and a dinner task has no pre-meal', () => {
  const anchor = new Date(2026, 8, 7, 18, 30);
  const steps = buildPlan({ title: 'Dinner with Sam', anchor: anchor.toISOString(), travelMin: 25, away: true, getReady: true });
  assert.ok(!steps.some((s) => /Eat something/.test(s.title)));
  const leave = steps.find((s) => s.kind === 'travel');
  assert.equal(new Date(leave.startAt).getMinutes() % 5, 0);
  assert.equal(new Date(steps[0].startAt).getMinutes() % 5, 0);
});

test('overrides change one step and shift everything earlier', () => {
  const anchor = new Date(2026, 8, 10, 8, 0);
  const a = buildPlan({ title: 'Dentist', anchor: anchor.toISOString(), travelMin: 20 });
  const b = buildPlan({ title: 'Dentist', anchor: anchor.toISOString(), travelMin: 20, overrides: { shower: 45 } });
  assert.equal(b.find((s) => s.prefKey === 'shower').durationMin, 45);
  assert.ok(new Date(b.find((s) => s.kind === 'wake').startAt) < new Date(a.find((s) => s.kind === 'wake').startAt));
});

test('overlap detection flags two plans on the same morning', async () => {
  const { findOverlaps } = await import('../planner.js');
  const t1 = { id: 'a', title: 'Dentist', anchor: new Date(2026, 8, 10, 8, 0).toISOString(), travelMin: 20 };
  const t2 = { id: 'b', title: 'Gym', anchor: new Date(2026, 8, 10, 8, 30).toISOString(), travelMin: 10 };
  const t3 = { id: 'c', title: 'Haircut', anchor: new Date(2026, 8, 10, 15, 0).toISOString(), travelMin: 10 };
  for (const t of [t1, t2, t3]) t.steps = buildPlan(t);
  const ov = findOverlaps([t1, t2, t3]);
  assert.ok(ov.get('a') && ov.get('b') && !ov.get('c'));
});

test('"by Friday" is a deadline, not an appointment', () => {
  const r = parseTask('Get my oil changed by Friday', NOW);
  assert.equal(r.anchor, null);
  assert.equal(new Date(r.deadline).getDay(), 5);
  assert.equal(r.title, 'Get my oil changed');
});

test('"tomorrow morning" and "half an hour away" are understood and removed from the title', () => {
  const r = parseTask('Dentist tomorrow morning, half an hour away', NOW);
  const a = new Date(r.anchor);
  assert.equal(a.getDate(), 8); assert.equal(a.getHours(), 9);
  assert.equal(r.travelMin, 30);
  assert.equal(r.title, 'Dentist');
});
