// Home Manager triage: decides which Ring events the owner needs to see.
//
// Most events are routine (deliveries, cars, animals, the garage closing) and are
// logged quietly. Only a few need attention: an unknown person who stays, someone
// lingering, a package taken, a sensor opening while the alarm is armed.
//
// Pure functions, no Ring or I/O, so the rules are easy to test and change.

export const HOLD_MS = 30_000;          // how long a person may be at the door before we decide
export const COURIER_WINDOW_MS = 5 * 60_000; // a package seen this close to a person means a courier

// Normalised event kinds the rest of the app understands.
// package | package_pickup | person | doorbell | loitering | vehicle | animal | motion | sensor | alarm
export function kindFromText({ category = '', subtype = '', detection = '', body = '' }) {
  const t = `${subtype} ${detection} ${body}`.toLowerCase();
  if (/pick(ed)?[ -]?up/.test(t) && /package/.test(t)) return 'package_pickup';
  if (/package|deliver/.test(t)) return 'package';
  if (/loiter/.test(t)) return 'loitering';
  if (/\.ding$/.test(category) || subtype === 'ding' || /rang|doorbell|is at your/.test(t)) return 'doorbell';
  if (/human|person/.test(t)) return 'person';
  if (/vehicle|car /.test(t)) return 'vehicle';
  if (/animal|pet/.test(t)) return 'animal';
  return 'motion';
}

const plainName = (name) => (name || 'camera').replace(/^the\s+/i, '');
const yourPlace = (name) => `your ${plainName(name).toLowerCase()}`;

function routine(title, summary, badge = 'Logged — no action needed') {
  return { status: 'routine', title, summary, badge };
}
function attention(title, summary) {
  return { status: 'attention', title, summary };
}

// Was there a package on the same device near this time? Then the person was a courier.
export function courierNearby(ev, recent) {
  const t = Date.parse(ev.at);
  return recent.some((r) => r.deviceId === ev.deviceId && (r.kind === 'package') && Math.abs(Date.parse(r.at) - t) <= COURIER_WINDOW_MS);
}

// First decision when an event arrives. Returns { status: 'routine' | 'attention' | 'hold', ... }.
// 'hold' means: wait HOLD_MS, then call settle() (a courier usually drops the package and leaves).
export function classify(ev, recent = [], { armed = false, live = true } = {}) {
  const where = yourPlace(ev.deviceName);
  switch (ev.kind) {
    case 'package':
      return routine('Package delivery logged', `A delivery was placed at ${where}.`);
    case 'package_pickup':
      return attention('A package was picked up', `Someone took a package from ${where}. Was that you or someone you know?`);
    case 'vehicle':
      return routine('Vehicle passed by', `A car was seen by ${where} camera.`, 'Logged');
    case 'animal':
      return routine('Animal spotted', `An animal walked past ${where} camera.`, 'Logged');
    case 'motion':
      return routine('Motion logged', `Motion at ${where}, no person detected.`, 'Logged');
    case 'sensor': {
      const name = ev.deviceName || 'Sensor';
      if (ev.open && armed) return attention(`${name} opened while armed`, `${name} opened while your alarm is on.`);
      return ev.open
        ? routine(`${name} opened`, `${name} was opened.`, 'Logged')
        : routine(`${name} closed`, `${name} was closed.`, 'Secured');
    }
    case 'alarm':
      return attention('Alarm triggered', ev.detail || 'Your Ring Alarm is sounding.');
    case 'loitering':
      return attention(`Someone is lingering at ${where}`, `A person has been hanging around ${where}. I don’t recognize them.`);
    case 'person':
    case 'doorbell':
      if (courierNearby(ev, recent)) return routine('Courier at the door', `A delivery person came to ${where} and left a package.`);
      // History loaded at startup is past; never raise an alarm about it.
      if (!live) return routine(ev.kind === 'doorbell' ? 'Doorbell rang' : 'Visitor at the door', `Someone came to ${where}.`, 'Logged');
      return { status: 'hold' };
    default:
      return routine('Event logged', `Activity at ${where}.`, 'Logged');
  }
}

// Called HOLD_MS after a person/doorbell event: no package showed up, so they aren't a courier.
export function settle(ev, recent = [], now = Date.now()) {
  const where = yourPlace(ev.deviceName);
  if (courierNearby(ev, recent)) return routine('Courier at the door', `A delivery person came to ${where} and left a package.`);
  const seconds = Math.max(1, Math.round((now - Date.parse(ev.at)) / 1000));
  const verb = ev.kind === 'doorbell' ? 'rang the doorbell and has been' : 'has been';
  return attention('Unknown person at your door', `Someone ${verb} at ${where} for **${seconds} seconds**. I don’t recognize them.`);
}

// Today's numbers for the summary card.
export function summarize(events, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = events.filter((e) => Date.parse(e.at) >= start.getTime());
  const handled = today.filter((e) => e.status === 'routine' || e.status === 'resolved');
  const open = events.filter((e) => e.status === 'attention');
  const n = handled.length;
  const headline = open.length ? `${open.length === 1 ? 'One thing needs' : `${open.length} things need`} your attention` : 'Your home is in good shape';
  const body = open.length
    ? `I handled ${n} routine ${n === 1 ? 'event' : 'events'} today. ${open.length === 1 ? 'This one' : 'These'} I couldn’t decide for you.`
    : `I handled ${n} routine ${n === 1 ? 'event' : 'events'} for you today. You’ll only hear from me when something needs your attention.`;
  return { handledToday: n, attention: open.length, headline, body };
}
