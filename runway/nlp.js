// Runway NLP — pulls a time, date, travel time and place out of plain English
// like "dentist at 8am Thursday, it's 45 minutes away" or "get my oil changed".
// Deliberately small and forgiving: anything it misses, the review sheet asks.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, 'forty-five': 45, fifty: 50, sixty: 60, half: 0.5, ninety: 90 };

function num(s) {
  if (s == null) return null;
  const k = String(s).toLowerCase().replace(/\s+/g, '');
  if (k in NUMWORDS) return NUMWORDS[k];
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const NUMPAT = '(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty[- ]five|fifty|sixty|ninety|half)';

export function parseTask(input, now = new Date()) {
  let text = ' ' + String(input || '').trim().replace(/\s+/g, ' ') + ' ';
  const out = { title: '', anchor: null, travelMin: null, location: null, deadline: null, hints: [] };
  const strip = (re) => { text = text.replace(re, ' '); };
  text = text.replace(/\bhalf an hour\b/gi, '30 minutes').replace(/\ban hour and a half\b/gi, '90 minutes').replace(/\b(\d+)\s*(?:and a half|\.5)\s*hours?\b/gi, (m, n) => `${n * 60 + 30} minutes`);

  // --- travel time: "45 minutes away", "a 30 min drive", "an hour away", "takes 20 minutes to get there"
  let m = text.match(new RegExp(`\\b(?:it'?s|its|about|around|which is|that'?s)?\\s*${NUMPAT}\\s*(?:and a half\\s*)?(hours?|hrs?|h|minutes?|mins?|m)\\s*(?:drive|away|drive away|from (?:here|home|me)|to get there|commute|ride)\\b`, 'i'));
  if (!m) m = text.match(new RegExp(`\\b(?:a|an)?\\s*${NUMPAT}[- ]?(hour|hr|minute|min)\\s*(drive|ride|walk|commute)\\b`, 'i'));
  if (!m) m = text.match(new RegExp(`\\b(?:takes|take)\\s*${NUMPAT}\\s*(hours?|hrs?|minutes?|mins?)\\b`, 'i'));
  if (m) {
    const n = num(m[1]);
    const unit = m[2].toLowerCase();
    if (n != null) {
      out.travelMin = Math.round(unit.startsWith('h') ? n * 60 + (/and a half/i.test(m[0]) ? 30 : 0) : n);
      strip(m[0]);
    }
  }

  // --- explicit time: "at 8am", "8:30 pm", "at 6", "noon", "midnight", "6 in the evening"
  let hour = null, minute = 0, hasTime = false;
  if ((m = text.match(/\b(noon|midday)\b/i))) { hour = 12; hasTime = true; strip(m[0]); }
  else if ((m = text.match(/\bmidnight\b/i))) { hour = 0; hasTime = true; strip(m[0]); }
  else if ((m = text.match(/\b(?:at|by|@|around|for)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W)/i))) {
    hour = parseInt(m[1], 10) % 12; if (/p/i.test(m[3])) hour += 12; minute = m[2] ? parseInt(m[2], 10) : 0; hasTime = true; strip(m[0]);
  } else if ((m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:o'?clock)?\s+in the (morning|afternoon|evening)\b/i))) {
    hour = parseInt(m[1], 10) % 12; if (m[3].toLowerCase() !== 'morning') hour += 12; minute = m[2] ? parseInt(m[2], 10) : 0; hasTime = true; strip(m[0]);
  } else if ((m = text.match(/\b(?:at|by|@|around)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:min|minutes|hours?|hrs?|days?|weeks?|st|nd|rd|th|\/|-|am|pm))/i))) {
    // bare "at 6" — guess: 6..11 → am if morning-ish words else pm. Heuristic: 7-11 am, 12-6 pm? ADHD-friendly guess: 1..6 → pm, 7..11 → am.
    let h = parseInt(m[1], 10); minute = m[2] ? parseInt(m[2], 10) : 0;
    if (h >= 1 && h <= 6) h += 12;
    if (h === 12) h = 12;
    hour = h; hasTime = true; strip(m[0]); out.hints.push('guessed-ampm');
  } else if ((m = text.match(/\b(\d{1,2}):(\d{2})\b/))) {
    hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); hasTime = true; strip(m[0]);
  }

  // --- vague times of day (only if no explicit time)
  if (!hasTime) {
    const vague = (re, h) => { if ((m = text.match(re))) { hour = h; out.hints.push('vague-time'); text = text.replace(new RegExp(`\\b(in the|this|tomorrow)\\s+${m[2]}\\b`, 'i'), m[1] && /tomorrow/i.test(m[1]) ? ' tomorrow ' : ' ').replace(new RegExp(`(?<!\\w)${m[2]}\\b`, 'i'), ' '); return true; } return false; };
    vague(/\b(this|tomorrow|in the)?\s*(morning)\b/i, 9) || vague(/\b(this|tomorrow|in the)?\s*(afternoon)\b/i, 14) || vague(/\b(this|tomorrow|in the)?\s*(evening)\b/i, 18) || vague(/\b(this|tomorrow|in the)?\s*(tonight)\b/i, 18);
  }

  // --- date
  let date = null;
  const base = new Date(now); base.setHours(0, 0, 0, 0);
  const addDays = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  if ((m = text.match(/\bday after tomorrow\b/i))) { date = addDays(2); strip(m[0]); }
  else if ((m = text.match(/\btomorrow\b/i))) { date = addDays(1); strip(m[0]); }
  else if ((m = text.match(/\b(today|tonight|this (?:morning|afternoon|evening))\b/i))) { date = addDays(0); strip(m[0]); }
  else if ((m = text.match(/\bin\s+(\d+|a|an|two|three|four|five|six|seven|ten)\s+(days?|weeks?)\b/i))) {
    const n = num(m[1]) || 1; date = addDays(m[2].toLowerCase().startsWith('w') ? n * 7 : n); strip(m[0]);
  } else if ((m = text.match(/\b(by\s+|on\s+|this\s+|next\s+|coming\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i))) {
    const isDeadline = /^by\s/i.test(m[1] || '') && !hasTime;
    m = [m[0], m[2]];
    const name = m[1].toLowerCase();
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(name.slice(0, 3)));
    let diff = (idx - base.getDay() + 7) % 7;
    if (/next\s/i.test(m[0])) diff = diff === 0 ? 7 : diff + (diff < 7 ? 7 : 0);
    if (diff === 0 && !/this\s/i.test(m[0]) && hasTime && hour != null) {
      // "Friday at 3" and it's Friday 5pm → next Friday
      const cand = new Date(base); cand.setHours(hour, minute, 0, 0);
      if (cand < now) diff = 7;
    } else if (diff === 0 && !/this\s/i.test(m[0]) && !hasTime) {
      diff = 7;
    }
    date = addDays(diff); strip(m[0]);
    if (isDeadline) { out.deadline = date.toISOString(); date = null; out.hints.push('deadline'); }
  } else if ((m = text.match(/\b(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    date = new Date(base.getFullYear(), mi, parseInt(m[2], 10)); if (date < base) date.setFullYear(date.getFullYear() + 1); strip(m[0]);
  } else if ((m = text.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
    date = new Date(base.getFullYear(), mi, parseInt(m[1], 10)); if (date < base) date.setFullYear(date.getFullYear() + 1); strip(m[0]);
  } else if ((m = text.match(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : base.getFullYear();
    date = new Date(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10)); if (!m[3] && date < base) date.setFullYear(y + 1); strip(m[0]);
  } else if ((m = text.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
    date = new Date(base.getFullYear(), base.getMonth(), parseInt(m[1], 10)); if (date < base) date.setMonth(date.getMonth() + 1); strip(m[0]);
  } else if ((m = text.match(/\bnext week\b/i))) { date = addDays(7); out.hints.push('vague-date'); strip(m[0]); }

  if (hasTime || hour != null) {
    if (!date) {
      date = addDays(0);
      const cand = new Date(date); cand.setHours(hour, minute, 0, 0);
      if (cand < now) date = addDays(1); // "at 8am" said at 3pm → tomorrow
    }
    date.setHours(hour, minute, 0, 0);
    out.anchor = date.toISOString();
  } else if (date) {
    date.setHours(9, 0, 0, 0);
    out.anchor = date.toISOString();
    out.hints.push('no-time');
  }
  if (!out.anchor && !out.deadline && (m = text.match(/\bby\s+(tomorrow|tonight|end of (?:the )?(?:day|week)|eod|eow)\b/i))) {
    const d = /week/i.test(m[1]) || /eow/i.test(m[1]) ? addDays((5 - base.getDay() + 7) % 7 || 7) : /tomorrow/i.test(m[1]) ? addDays(1) : addDays(0);
    d.setHours(21, 0, 0, 0); out.deadline = d.toISOString(); out.hints.push('deadline'); strip(m[0]);
  }

  // --- location: "at the dentist", "at Costco", "in Bellevue", "to the airport"
  text = text.replace(/[\s,.]+$/, '') + ' ';
  if ((m = text.match(/\b(?:at|in|to)\s+(the\s+)?([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,3})\b/))) {
    out.location = (m[1] || '') + m[2];
    // "Dinner with Sam at Canlis" → title "Dinner with Sam", place "Canlis" (only for a trailing "at X")
    if (/^\s*at\s/i.test(m[0]) && new RegExp(m[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(text.trim())) strip(m[0]);
  } else if ((m = text.match(/\b(?:at|to)\s+the\s+([a-z][\w'-]*(?:\s+[a-z][\w'-]*)?)\b/i))) {
    out.location = 'the ' + m[1];
  }

  // --- title: what's left, tidied
  let title = text.replace(/\s+/g, ' ').trim();
  title = title.replace(/^(?:i (?:have|need|want|got) to|i(?:'ve| have) got to|i gotta|gotta|need to|have to|remind me to|remember to|please)\s+/i, '');
  title = title.replace(/[,\s]+(?:at|on|by|around|for)\s*$/i, '').replace(/^[,.\s]+|[,.\s]+$/g, '');
  title = title.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ');
  if (title) title = title[0].toUpperCase() + title.slice(1);
  out.title = title || String(input || '').trim();
  return out;
}
