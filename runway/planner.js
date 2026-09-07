// Runway planner — on-device rules engine.
//
// Turns "get my oil changed" or "dentist at 8am Thursday" into a chain of
// small, timed microtasks, planned BACKWARDS from the moment you must be
// somewhere. The whole point: transition time (shower, finding keys, traffic,
// arriving early) is baked in, so the plan is honest.
//
// Pure functions only — no DOM, no storage. Unit-tested in tests/planner.test.mjs.

export const DEFAULT_PREFS = {
  // "How long does it REALLY take you?" — the user can tune these.
  wakeUpBuffer: 15,   // snooze + actually getting out of bed
  bathroom: 10,       // morning bathroom
  shower: 20,         // shower + dry off
  dress: 10,          // get dressed, hair, etc.
  breakfast: 15,
  meal: 20,           // lunch / dinner
  windDown: 10,       // stop the current thing and switch tasks
  outTheDoor: 10,     // shoes, keys, phone, wallet
  arriveEarly: 10,    // minutes early at the destination
  trafficPct: 20,     // % padding on every drive
  defaultTravel: 20,  // minutes, when you have no idea
};

const MIN = 60 * 1000;

// ---------------------------------------------------------------------------
// Knowledge base: what kind of thing is this task?
// ---------------------------------------------------------------------------
const CATEGORIES = [
  {
    id: 'medical',
    label: 'Appointment',
    search: 'doctor',
    match: /\b(doctor|dr\.?|dentist|dental|physical|check ?up|clinic|hospital|therapy|therapist|psychiatrist|optometrist|eye exam|vet|pediatrician|derm|dermatologist|appointment|appt|blood work|lab work|vaccine|shot|physio|chiro)\b/i,
    away: true,
    getReady: true,
    bring: ['Insurance card + ID', 'List of meds + questions to ask'],
    booking: [
      { title: 'Already have a provider? If not, search “{what} near me” and pick one', min: 5 },
      { title: 'Check what days/times they have open and which work for you', min: 3 },
      { title: 'Book it — call or use their online scheduler', min: 5 },
      { title: 'Ask if you need to fast, bring records, or arrive early for paperwork', min: 2 },
    ],
    duration: 60,
  },
  {
    id: 'car',
    label: 'Car service',
    search: 'oil change',
    match: /\b(oil change|oil|mechanic|tires?|tyres?|brakes?|car wash|inspection|smog|emissions|car service|service the car|jiffy|windshield|alignment|registration|detail(ing)?)\b/i,
    away: true,
    getReady: false,
    bring: ['Car keys + registration', 'Something to do while you wait (book, laptop)'],
    booking: [
      { title: 'Already have a shop you like? If not, search “{what} near me” and pick one with good reviews', min: 5 },
      { title: 'Check their hours and whether they take walk-ins or need an appointment', min: 3 },
      { title: 'Find a 90-minute window in your calendar that overlaps their hours', min: 3 },
      { title: 'Book it (or decide which morning you’ll walk in)', min: 5 },
      { title: 'Plan the wait: bring something to do, or arrange a ride home', min: 2 },
    ],
    duration: 90,
  },
  {
    id: 'flight',
    label: 'Flight',
    match: /\b(flight|airport|fly|flying|plane|boarding|terminal)\b/i,
    away: true,
    getReady: true,
    arriveEarly: 120,
    bring: ['ID / passport', 'Phone charger', 'Boarding pass downloaded'],
    booking: [
      { title: 'Confirm the flight time and airport in your email', min: 3 },
      { title: 'Check in online 24 hours before and save the boarding pass', min: 5 },
      { title: 'Decide how you’re getting to the airport (ride, park, transit)', min: 3 },
    ],
    prepBefore: [
      { title: 'Pack your bag — do it the night before, not in the morning', min: 30 },
    ],
    duration: 180,
  },
  {
    id: 'work',
    label: 'Work',
    match: /\b(interview|meeting|presentation|demo|standup|1:1|one on one|client|pitch|review|conference|office|work)\b/i,
    away: null, // could be remote — decided by travel input
    getReady: true,
    bring: ['Laptop + charger', 'Notes / talking points'],
    booking: [
      { title: 'Write down the ONE outcome you want from this', min: 3 },
      { title: 'Prep the material (slides, notes, questions)', min: 20 },
      { title: 'Confirm time, location or video link', min: 2 },
    ],
    duration: 60,
  },
  {
    id: 'grooming',
    label: 'Haircut / salon',
    search: 'barber',
    match: /\b(haircut|hair cut|barber|salon|nails|manicure|pedicure|massage|spa|waxing|brows)\b/i,
    away: true,
    getReady: false,
    bring: [],
    booking: [
      { title: 'Pick the place — your usual, or search “{what} near me”', min: 3 },
      { title: 'Check open slots and book online or by phone', min: 5 },
    ],
    duration: 45,
  },
  {
    id: 'admin',
    label: 'Errand (with paperwork)',
    match: /\b(dmv|passport|bank|notary|post office|usps|ups|fedex|social security|court|license|permit|visa|embassy|consulate|title|tax|irs|insurance office)\b/i,
    away: true,
    getReady: true,
    bring: ['ID + the documents they need (check their website)', 'Payment method'],
    booking: [
      { title: 'Look up exactly which documents you need — screenshot the list', min: 5 },
      { title: 'Check if they need an appointment (many do) and book it', min: 5 },
      { title: 'Gather the documents into one folder or envelope', min: 10 },
    ],
    duration: 60,
  },
  {
    id: 'shopping',
    label: 'Errand',
    match: /\b(grocery|groceries|costco|target|walmart|trader joe|whole foods|store|shopping|buy|pick up|pickup|return|returns|pharmacy|cvs|walgreens|prescription|home depot|ikea|mall)\b/i,
    away: true,
    getReady: false,
    bring: ['The list (write it now, not in the parking lot)', 'Bags / returns / coupons'],
    booking: [
      { title: 'Write the list of what you actually need', min: 5 },
      { title: 'Check store hours and pick a low-crowd time', min: 2 },
    ],
    duration: 45,
  },
  {
    id: 'fitness',
    label: 'Workout',
    match: /\b(gym|workout|work out|run|running|yoga|pilates|swim|class|practice|training|hike|bike ride|cycling)\b/i,
    away: true,
    getReady: false,
    bring: ['Gym bag: shoes, water, towel, headphones'],
    booking: [
      { title: 'Decide which day/time — put it in the calendar', min: 2 },
      { title: 'Pack the bag the night before', min: 5 },
    ],
    duration: 60,
  },
  {
    id: 'social',
    label: 'Social',
    match: /\b(dinner|lunch|brunch|coffee|drinks|party|birthday|wedding|date|hang ?out|meet up|meetup|friends?|family|movie|concert|show|game)\b/i,
    away: true,
    getReady: true,
    bring: ['Gift / thing you promised to bring', 'Charged phone'],
    booking: [
      { title: 'Confirm time and place with them', min: 2 },
      { title: 'Decide what you’re wearing so it’s not a 5:30 pm scramble', min: 3 },
    ],
    duration: 120,
  },
  {
    id: 'kids',
    label: 'Kids',
    match: /\b(school|daycare|kid|kids|son|daughter|drop ?off|pick ?up the kids|practice|recital|pta|parent)\b/i,
    away: true,
    getReady: false,
    bring: ['Their bag / snack / water bottle'],
    booking: [
      { title: 'Confirm the exact time and where to be', min: 2 },
    ],
    duration: 30,
  },
  {
    id: 'call',
    label: 'Call / message',
    match: /\b(call|phone|text|email|e-mail|message|reply|respond|follow up|cancel|renew|dispute|customer service|support)\b/i,
    away: false,
    getReady: false,
    bring: [],
    booking: [
      { title: 'Find the number / email / account info and keep it open', min: 3 },
      { title: 'Write 2 lines: what you want and what you’ll say first', min: 3 },
      { title: 'Do it — set a 10-minute timer and start', min: 10 },
      { title: 'Note the outcome (reference #, next step, who you spoke to)', min: 2 },
    ],
    duration: 15,
  },
  {
    id: 'chore',
    label: 'Home',
    match: /\b(laundry|dishes|clean|cleaning|vacuum|tidy|organize|declutter|trash|garbage|recycling|bills?|budget|paperwork|taxes|filing|fix|repair|garden|mow|water the plants|cook|meal prep)\b/i,
    away: false,
    getReady: false,
    bring: [],
    booking: [
      { title: 'Set a 15-minute timer — you only have to start', min: 15 },
      { title: 'Do the first visible chunk (one surface, one basket, one drawer)', min: 15 },
      { title: 'Stop, look at what’s done, decide if you want another 15', min: 1 },
    ],
    duration: 45,
  },
];

const GENERIC = {
  id: 'generic',
  label: 'Task',
  away: null,
  getReady: false,
  bring: [],
  booking: [
    { title: 'Write one sentence: what does “done” look like?', min: 2 },
    { title: 'What’s the very first physical action? (open the site, find the number, get the box)', min: 2 },
    { title: 'Do that first action right now — 10 minutes, then stop', min: 10 },
    { title: 'Pick a day and time for the rest — tell Runway and it’ll plan it', min: 2 },
  ],
  duration: 60,
};

export function classify(text) {
  const t = String(text || '');
  for (const c of CATEGORIES) if (c.match.test(t)) return c;
  return GENERIC;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let seq = 0;
const uid = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

function step(title, min, kind, extra = {}) {
  return { id: uid(), title, durationMin: Math.max(0, Math.round(min)), kind, done: false, startAt: null, ...extra };
}

function shortWhat(title) {
  return String(title || 'this').replace(/^(get|go|do|make|have|book|schedule|take)\s+(my|the|a|an)?\s*/i, '').trim() || 'this';
}

function fill(tpl, task, cat) {
  return tpl.replace('{what}', (cat && cat.search) || shortWhat(task.title));
}

export function localHour(date) {
  return date.getHours() + date.getMinutes() / 60;
}

// ---------------------------------------------------------------------------
// Open-ended "project" plan: no time yet — figure out the logistics first.
// ---------------------------------------------------------------------------
export function buildProjectSteps(task) {
  const cat = classify(task.title);
  const steps = cat.booking.map((b) => step(fill(b.title, task, cat), b.min, 'research'));
  if (cat.away !== false) {
    steps.push(step('Tell Runway the date & time → it plans your whole morning backwards', 1, 'settime', { action: 'settime' }));
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Day-of plan: backwards from the anchor.
// ---------------------------------------------------------------------------
export function buildDayOfPlan(task, prefs = DEFAULT_PREFS) {
  const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const ov = task.overrides || {};           // per-task duration overrides, keyed by prefKey
  const d = (key) => (ov[key] != null ? Number(ov[key]) : p[key]);
  const cat = classify(task.title);
  const anchor = new Date(task.anchor);
  if (isNaN(anchor)) return [];

  const away = task.away != null ? !!task.away : cat.away !== false;
  const getReady = task.getReady != null ? !!task.getReady : !!cat.getReady;
  const travelMin = away ? (task.travelMin != null ? Number(task.travelMin) : p.defaultTravel) : 0;
  const arriveEarly = ov.arriveEarly != null ? Number(ov.arriveEarly) : (task.arriveEarly != null ? Number(task.arriveEarly) : (cat.arriveEarly ?? p.arriveEarly));
  const traffic = Math.ceil(travelMin * (p.trafficPct / 100));
  const where = task.location ? ` at ${task.location}` : '';
  const isMeal = /\b(dinner|lunch|brunch|breakfast|coffee|drinks|happy hour)\b/i.test(task.title);

  // Build in reverse (last thing first), then assign start times backwards.
  const chain = [];
  chain.push(step(task.title, ov.duration != null ? Number(ov.duration) : cat.duration, 'anchor', { fixed: true, prefKey: 'duration' }));

  if (away) {
    chain.push(step(`Arrive${where} — ${arriveEarly} min early, breathe`, arriveEarly, 'buffer', { prefKey: 'arriveEarly' }));
    chain.push(step(`Travel${task.location ? ` to ${task.location}` : ''} (${travelMin} min + ${traffic} min traffic pad)`, travelMin + traffic, 'travel', { prefKey: 'travel' }));
    chain.push(step('Out the door: shoes, keys, phone, wallet', d('outTheDoor'), 'transition', { prefKey: 'outTheDoor' }));
  }

  // When do you have to start moving? Decides whether this is a morning routine.
  const beforeAnchor = chain.filter((x) => x.kind !== 'anchor').reduce((s, x) => s + x.durationMin, 0);
  const leaveAt = new Date(anchor.getTime() - beforeAnchor * MIN);
  const morning = localHour(leaveAt) < 11;
  const meal = isMeal ? null : mealFor(leaveAt, p, d);

  const bring = task.bring || cat.bring;
  if (away && bring && bring.length) {
    chain.push(step(`Grab: ${bring.join(' · ')}`, 3, 'transition'));
  }

  const wake = () => chain.push(step('Wake up (alarm + snooze budget)', d('wakeUpBuffer'), 'wake', { prefKey: 'wakeUpBuffer' }));
  const bathroom = () => chain.push(step('Bathroom, water, meds', d('bathroom'), 'prep', { prefKey: 'bathroom' }));
  const dress = () => chain.push(step('Get dressed', d('dress'), 'prep', { prefKey: 'dress' }));
  const windDown = (t) => chain.push(step(t, d('windDown'), 'transition', { prefKey: 'windDown' }));

  if (getReady) {
    if (meal) chain.push(step(meal.label, meal.min, 'prep', { prefKey: meal.key }));
    dress();
    chain.push(step('Shower', d('shower'), 'prep', { prefKey: 'shower' }));
    if (morning) { bathroom(); wake(); }
    else windDown('Stop what you’re doing — start getting ready');
  } else if (away) {
    if (morning) { if (meal) chain.push(step(meal.label, meal.min, 'prep', { prefKey: meal.key })); dress(); bathroom(); wake(); }
    else windDown('Stop what you’re doing — wrap up and switch');
  } else {
    windDown('Stop what you’re doing — wrap up and switch');
  }

  // Assign start times walking backwards from the anchor. Round the moments
  // that matter (wake up, leave, the very first step) DOWN to a 5-minute mark —
  // "leave by 6:55" sticks in your head; "6:56" doesn't. The rounding slack is
  // added to that step's duration, so nothing downstream moves.
  let t = anchor.getTime();
  chain[0].startAt = new Date(t).toISOString();
  for (let i = 1; i < chain.length; i++) {
    t -= chain[i].durationMin * MIN;
    const s = chain[i];
    if (s.kind === 'travel' || s.kind === 'wake' || i === chain.length - 1) {
      const floored = Math.floor(t / (5 * MIN)) * 5 * MIN;
      if (floored !== t) { s.durationMin += Math.round((t - floored) / MIN); t = floored; }
    }
    s.startAt = new Date(t).toISOString();
  }
  const ordered = chain.slice().reverse();

  // Night-before step for early starts, so the morning has nothing to decide.
  const first = new Date(ordered[0].startAt);
  const extras = [];
  if (morning && away) {
    const nightBefore = new Date(first);
    nightBefore.setDate(nightBefore.getDate() - 1);
    nightBefore.setHours(21, 0, 0, 0);
    if (nightBefore.getTime() > Date.now() - 12 * 60 * MIN) {
      extras.push(step(`Night before: lay out clothes, pack ${bring.length ? 'what you’re bringing' : 'your bag'}, set alarm for ${fmtTime(first)}`, 10, 'prep', { startAt: nightBefore.toISOString() }));
    }
  }
  const pre = (cat.prepBefore || []).map((b) => {
    const s = step(fill(b.title, task, cat), b.min, 'prep');
    const dd = new Date(first); dd.setDate(dd.getDate() - 1); dd.setHours(20, 0, 0, 0);
    s.startAt = dd.toISOString();
    return s;
  });
  return [...pre, ...extras, ...ordered];
}

function mealFor(when, p, d = (k) => p[k]) {
  const h = localHour(when);
  if (h >= 5 && h < 10.5) return { label: 'Breakfast (sit down for it)', min: d('breakfast'), key: 'breakfast' };
  if (h >= 11 && h < 14) return { label: 'Lunch before you go', min: d('meal'), key: 'meal' };
  if (h >= 17 && h < 20.5) return { label: 'Eat something first', min: d('meal'), key: 'meal' };
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function buildPlan(task, prefs) {
  if (task.anchor) return buildDayOfPlan(task, prefs);
  return buildProjectSteps(task);
}

// Rebuild the timed part of a plan when the anchor/travel/durations change,
// keeping "done" state for steps with the same title.
export function replan(task, prefs) {
  const prev = new Map((task.steps || []).map((s) => [s.title, s.done]));
  const steps = buildPlan(task, prefs);
  for (const s of steps) if (prev.has(s.title)) s.done = prev.get(s.title);
  return steps;
}

// ---------------------------------------------------------------------------
// Summaries for the UI
// ---------------------------------------------------------------------------
export function keyTimes(task) {
  const steps = task.steps || [];
  const wake = steps.find((s) => s.kind === 'wake');
  const leave = steps.find((s) => s.kind === 'travel');
  const first = steps.find((s) => s.startAt && s.kind !== 'prep' && s.kind !== 'anchor' && s.startAt >= todayStart(task));
  const startGettingReady = steps.find((s) => s.startAt && ['prep', 'transition', 'wake'].includes(s.kind) && !s.title.startsWith('Night before') && sameDay(new Date(s.startAt), new Date(task.anchor)));
  return {
    wakeAt: wake ? new Date(wake.startAt) : null,
    leaveAt: leave ? new Date(leave.startAt) : null,
    startAt: startGettingReady ? new Date(startGettingReady.startAt) : (first ? new Date(first.startAt) : null),
  };
}

function todayStart(task) {
  const d = new Date(task.anchor); d.setHours(0, 0, 0, 0); return d.toISOString();
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtTime(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  let h = date.getHours(); const m = date.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

export function fmtDay(d, now = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(date); b.setHours(0, 0, 0, 0);
  const diff = Math.round((b - a) / (24 * 60 * MIN));
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function totalMinutes(steps) {
  return (steps || []).reduce((s, x) => s + (x.durationMin || 0), 0);
}

// Time span a plan occupies on its day: first timed step (excluding night-before) → end of the event.
export function planSpan(task) {
  if (!task.anchor) return null;
  const day = (task.steps || []).filter((s) => s.startAt && !s.title.startsWith('Night before') && s.kind !== 'prep' || (s.kind === 'prep' && s.startAt && sameDay(new Date(s.startAt), new Date(task.anchor))));
  if (!day.length) return null;
  const start = new Date(Math.min(...day.map((s) => new Date(s.startAt).getTime())));
  const a = (task.steps || []).find((s) => s.kind === 'anchor');
  const end = new Date(new Date(task.anchor).getTime() + ((a && a.durationMin) || 60) * MIN);
  return { start, end };
}

// Pairs of active tasks whose plans overlap in time — the "you can't do both" check.
export function findOverlaps(tasks) {
  const spans = tasks.filter((t) => !t.done && t.anchor).map((t) => ({ t, span: planSpan(t) })).filter((x) => x.span);
  const out = new Map();
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
    const a = spans[i], b = spans[j];
    if (a.span.start < b.span.end && b.span.start < a.span.end) {
      out.set(a.t.id, [...(out.get(a.t.id) || []), b.t]);
      out.set(b.t.id, [...(out.get(b.t.id) || []), a.t]);
    }
  }
  return out;
}
