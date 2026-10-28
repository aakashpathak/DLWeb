import test from 'node:test';
import assert from 'node:assert/strict';
import { kindFromText, classify, settle, summarize } from '../triage.js';

const at = (s) => new Date(Date.UTC(2026, 9, 28, 14, 0, s)).toISOString();
const ev = (kind, s = 0, extra = {}) => ({ id: `${kind}${s}`, at: at(s), deviceId: '1', deviceName: 'Front Door', kind, ...extra });

test('kindFromText reads Ring push wording', () => {
  assert.equal(kindFromText({ category: 'com.ring.pn.live-event.ding', subtype: 'ding' }), 'doorbell');
  assert.equal(kindFromText({ subtype: 'motion', detection: 'human', body: 'There is a person at your Front Door' }), 'person');
  assert.equal(kindFromText({ subtype: 'motion', body: 'A package was delivered at your Front Door' }), 'package');
  assert.equal(kindFromText({ body: 'A package was picked up from your Front Door' }), 'package_pickup');
  assert.equal(kindFromText({ detection: 'loitering' }), 'loitering');
  assert.equal(kindFromText({ detection: 'other_motion' }), 'motion');
  assert.equal(kindFromText({ body: 'A vehicle was detected at your Driveway' }), 'vehicle');
});

test('routine events never need attention', () => {
  for (const k of ['package', 'vehicle', 'animal', 'motion']) assert.equal(classify(ev(k)).status, 'routine', k);
  assert.equal(classify(ev('sensor', 0, { deviceName: 'Garage', open: false })).title, 'Garage closed');
});

test('a person waits for a decision, then is a courier if a package shows up', () => {
  const person = ev('person', 0);
  assert.equal(classify(person).status, 'hold');
  const decided = settle(person, [ev('package', 5)], Date.parse(at(20)));
  assert.equal(decided.status, 'routine');
  assert.equal(decided.title, 'Courier at the door');
});

test('an unknown person who stays needs attention, with how long', () => {
  const d = settle(ev('person', 0), [], Date.parse(at(17)));
  assert.equal(d.status, 'attention');
  assert.match(d.summary, /17 seconds/);
});

test('person right after a package is routine immediately', () => {
  assert.equal(classify(ev('person', 30), [ev('package', 0)]).status, 'routine');
});

test('history loaded at startup never raises attention for people', () => {
  assert.equal(classify(ev('person'), [], { live: false }).status, 'routine');
});

test('lingering, package pickup, alarm and armed sensor need attention', () => {
  assert.equal(classify(ev('loitering')).status, 'attention');
  assert.equal(classify(ev('package_pickup')).status, 'attention');
  assert.equal(classify(ev('alarm')).status, 'attention');
  assert.equal(classify(ev('sensor', 0, { open: true }), [], { armed: true }).status, 'attention');
  assert.equal(classify(ev('sensor', 0, { open: true }), [], { armed: false }).status, 'routine');
});

test('summary counts handled vs needing attention', () => {
  const now = new Date();
  const list = [
    { at: now.toISOString(), status: 'routine' },
    { at: now.toISOString(), status: 'routine' },
    { at: now.toISOString(), status: 'attention' },
  ];
  const s = summarize(list, now);
  assert.equal(s.handledToday, 2);
  assert.equal(s.attention, 1);
  assert.match(s.headline, /One thing needs your attention/);
  assert.match(summarize([], now).headline, /good shape/);
});
