'use strict';

/* ============================================================
   VoiceBridge — continuous, hands-free two-way voice translator
   ------------------------------------------------------------
   How it stays hands-free:

   1. Speech recognition runs continuously and auto-restarts
      whenever the browser ends a session. It listens in the
      language the *next* speaker is expected to use (after a
      Hindi translation is played, a Hindi reply is expected).
      When Hindi is in the pair it starts with hi-IN, whose
      model transcribes both Hindi and English speech.

   2. Every final utterance is language-verified: Devanagari
      script means Hindi, and Google's translate endpoint
      (sl=auto) reports the detected source language — even for
      romanized Hindi. If the "wrong" person spoke, direction
      flips automatically and the text is re-translated.

   3. The translation is spoken aloud. While the app is
      speaking, the mic is paused so it never translates its
      own voice, then listening resumes automatically. An echo
      guard drops any transcript that matches what was just
      spoken.
   ============================================================ */

// ------------------------------------------------------------
// Languages
// ------------------------------------------------------------

const LANGS = {
  en: { code: 'en', name: 'English', native: 'English', flag: '🇬🇧', ttsPrefs: ['en-us', 'en-gb', 'en-in'] },
  hi: { code: 'hi', name: 'Hindi',   native: 'हिन्दी',   flag: '🇮🇳', ttsPrefs: ['hi-in'] },
  es: { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸', ttsPrefs: ['es-us', 'es-es', 'es-mx'] },
};

const DEVANAGARI = /[ऀ-ॿ]/;

// Recognition locale for a language, given the active pair.
// en-IN is used alongside Hindi: that model copes with Hinglish
// and tends to romanize Hindi speech, which auto-detect catches.
function recTagFor(code, pair) {
  if (code === 'hi') return 'hi-IN';
  if (code === 'en') return pair.includes('hi') ? 'en-IN' : 'en-US';
  if (code === 'es') return 'es-US';
  return code;
}

// ------------------------------------------------------------
// State + elements
// ------------------------------------------------------------

const state = {
  running: false,
  starting: false,
  a: 'en',
  b: 'hi',
  listenLang: 'hi',     // language code the recognizer is tuned to
  rec: null,
  recGen: 0,            // invalidates handlers of replaced recognizers
  recTag: '',
  recActive: false,
  micPaused: false,     // true while the app itself is speaking
  restartTimer: 0,
  queue: [],
  pumping: false,
  speaking: false,
  lastFinal: { text: '', t: 0 },
  lastTTS: { text: '', until: 0 },
  netErrors: 0,
  ttsWarned: {},
  wakeLock: null,
};

const els = {};
['langA', 'langB', 'swapBtn', 'banner', 'feed', 'empty', 'interim',
 'status', 'statusText', 'mainBtn', 'clearBtn'].forEach((id) => {
  els[id] = document.getElementById(id);
});

function pair() { return [state.a, state.b]; }
function other(code) { return code === state.a ? state.b : state.a; }
function getRecCtor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
function getSynth() { return window.speechSynthesis || null; }

// ------------------------------------------------------------
// Environment detection (used for actionable error messages)
// ------------------------------------------------------------

const UA = navigator.userAgent || '';
const IS_IOS = /iPad|iPhone|iPod/.test(UA)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);

// In-app browsers (links opened inside WhatsApp, Instagram, Gmail, the
// Google app, …) usually cannot show a microphone permission prompt at all.
function isInAppBrowser() {
  if (IS_ANDROID && /\bwv\b/.test(UA)) return true; // Android WebView
  return /(FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|musical_ly|TikTok|GSA\/|OKApp|Twitter)/i.test(UA);
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------

function setStatus(kind, text) {
  els.status.dataset.kind = kind;
  els.statusText.textContent = text;
}

function listeningText() {
  return `Listening — speak ${LANGS[state.a].native} or ${LANGS[state.b].native}`;
}

function showBanner(msg) {
  els.banner.textContent = msg;
  els.banner.hidden = false;
}

// Banner with several lines of guidance plus action buttons. A line may be
// a string or {diag: true, text} for the small technical-details line.
function showBannerRich(lines, actions) {
  els.banner.textContent = '';
  for (const t of lines) {
    const p = document.createElement('div');
    if (typeof t === 'object' && t && t.diag) {
      p.className = 'banner-line banner-diag';
      p.textContent = t.text;
    } else {
      p.className = 'banner-line';
      p.textContent = t;
    }
    els.banner.appendChild(p);
  }
  if (actions && actions.length) {
    const row = document.createElement('div');
    row.className = 'banner-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'banner-btn';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      row.appendChild(b);
    }
    els.banner.appendChild(row);
  }
  els.banner.hidden = false;
}

function hideBanner() { els.banner.hidden = true; }

function unsupportedBrowserMessage() {
  if (isInAppBrowser()) {
    return 'This page is open inside another app\'s built-in browser, which cannot do live speech recognition. Open the link in ' + (IS_IOS ? 'Safari' : 'Chrome') + ' instead.';
  }
  if (IS_IOS) return 'On iPhone and iPad, live speech recognition only works in Safari. Open this page in Safari.';
  return 'This browser cannot do live speech recognition. Please open this page in Google Chrome (or Microsoft Edge).';
}

// Explains exactly why the microphone is unavailable and always offers a
// button that re-requests permission on a fresh tap. `source` says which
// stage failed ('mic request' or 'speech recognition') for the details line.
async function showMicHelp(err, source) {
  const name = (err && err.name) || '';
  const errMsg = String((err && err.message) || '');
  let perm = '';
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'microphone' });
      perm = st.state || '';
    }
  } catch (e) { /* permission not queryable here */ }

  // Readable in the banner so the exact failure can be reported.
  const diag = 'Details: [' + (source || 'mic') + '] ' + (name || 'unknown')
    + (errMsg ? ' — ' + errMsg : '')
    + (perm ? ' · site permission: ' + perm : '')
    + (IS_ANDROID ? ' · Android' : IS_IOS ? ' · iOS' : '');
  try { console.warn('[VoiceBridge] mic failure', { source, name, errMsg, perm }); } catch (e) { /* no-op */ }

  const askAgain = {
    label: '🎙 Ask for microphone permission',
    onClick: () => { hideBanner(); startConversation(); },
  };
  const copyLink = {
    label: '📋 Copy link',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast('Link copied — paste it into ' + (IS_IOS ? 'Safari.' : 'Chrome.'));
      } catch (e) {
        toast('Could not copy automatically — copy the link from the address bar.');
      }
    },
  };
  const show = (lines, actions) => showBannerRich(lines.concat([{ diag: true, text: diag }]), actions);

  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    show(['No microphone was found on this device. Connect one and try again.'], [askAgain]);
    return;
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    show(['The microphone is busy or unavailable. Close anything recording (a call, voice notes, another tab using the mic) and try again.'], [askAgain]);
    return;
  }
  if (isInAppBrowser()) {
    show([
      'This page is open inside another app\'s built-in browser, which cannot ask for microphone permission.',
      IS_IOS
        ? 'Open it in Safari instead: tap the share or menu icon and choose "Open in Safari" — or copy the link below and paste it there.'
        : 'Open it in Chrome instead: tap the ⋮ menu and choose "Open in Chrome" (or "Open in browser") — or copy the link below and paste it there.',
    ], [copyLink, askAgain]);
    return;
  }

  // The site has permission (or the OS reported a system-level denial) yet
  // the mic still failed: the *device* is blocking the browser app's mic.
  const sysDenied = /system/i.test(errMsg);
  if (perm === 'granted' || sysDenied) {
    const steps = IS_ANDROID
      ? ['This site has microphone permission, but Android is blocking Chrome\'s own mic access.',
         'Open Android Settings → Apps → Chrome → Permissions → Microphone → Allow. Then come back and tap the button below.']
      : IS_IOS
        ? ['This site has microphone permission, but iOS is blocking the browser\'s mic access.',
           'Open iOS Settings → Apps → Safari → Microphone and turn it on, then come back and tap the button below.']
        : ['This site has microphone permission, but your operating system is blocking the browser\'s mic access.',
           'Windows: Settings → Privacy & security → Microphone → allow microphone access, including for desktop apps. macOS: System Settings → Privacy & Security → Microphone → turn on your browser. Then fully restart the browser.'];
    show(steps, [askAgain]);
    return;
  }
  if (perm === 'denied') {
    const steps = IS_ANDROID
      ? 'The microphone is blocked for this site. Tap the icon just left of the address bar → Permissions (or Site settings) → Microphone → Allow, then reload this page. If it is already Allow, also check Android Settings → Apps → Chrome → Permissions → Microphone.'
      : IS_IOS
        ? 'The microphone is blocked. In Safari tap "AA" in the address bar → Website Settings → Microphone → Allow. Also check iOS Settings → Apps → Safari → Microphone.'
        : 'The microphone is blocked for this site. Click the icon just left of the address bar, set Microphone to Allow, then reload this page. Also make sure your system settings let this browser use the microphone.';
    show([steps], [askAgain]);
    return;
  }
  show([
    'The browser did not grant microphone access — the permission prompt may have been dismissed.',
    'Tap the button below to ask again. If nothing happens, also check your device settings: ' + (IS_ANDROID
      ? 'Android Settings → Apps → Chrome → Permissions → Microphone → Allow.'
      : IS_IOS
        ? 'iOS Settings → Apps → Safari → Microphone.'
        : 'your system privacy settings must allow this browser to use the microphone.'),
  ], [askAgain]);
}

let toastTimer = 0;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

function showInterim(text) {
  const t = (text || '').trim();
  if (!t) { clearInterim(); return; }
  els.interim.hidden = false;
  els.interim.textContent = '🎧 ' + (t.length > 140 ? '…' + t.slice(-140) : t);
}

function clearInterim() {
  els.interim.hidden = true;
  els.interim.textContent = '';
}

function scrollFeed() {
  els.feed.scrollTop = els.feed.scrollHeight;
}

function updateMainBtn() {
  els.mainBtn.textContent = state.running ? 'End conversation' : 'Start conversation';
  els.mainBtn.classList.toggle('running', state.running);
}

// Creates the bubble immediately (translation pending), returns a
// handle used to fill it in once the translation arrives.
function addBubble(src, target, originalText) {
  els.empty.hidden = true;
  els.clearBtn.hidden = false;

  // Keep very long conversations light in the DOM.
  const msgs = els.feed.querySelectorAll('.msg');
  if (msgs.length >= 200) msgs[0].remove();

  const el = document.createElement('div');
  el.className = 'msg ' + (src === state.a ? 'side-a' : 'side-b');

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const trans = document.createElement('div');
  trans.className = 'msg-trans pending';
  trans.textContent = 'translating…';

  const orig = document.createElement('div');
  orig.className = 'msg-orig';
  orig.textContent = originalText;

  el.append(meta, trans, orig);
  els.feed.appendChild(el);
  scrollFeed();

  const handle = {
    el,
    spokenText: '',
    spokenLang: target,
    setMeta(s, t) {
      meta.textContent = `${LANGS[s].flag} ${LANGS[s].name} → ${LANGS[t].name} ${LANGS[t].flag}`;
      el.className = 'msg ' + (s === state.a ? 'side-a' : 'side-b');
    },
    fill(text, t) {
      trans.className = 'msg-trans';
      trans.textContent = text;
      handle.spokenText = text;
      handle.spokenLang = t;
      scrollFeed();
    },
    fail() {
      trans.className = 'msg-trans failed';
      trans.textContent = '⚠ translation failed';
      scrollFeed();
    },
  };
  handle.setMeta(src, target);

  // Tap any bubble to replay its audio.
  el.addEventListener('click', async () => {
    if (!handle.spokenText || state.speaking || state.pumping) return;
    const wasRunning = state.running;
    if (wasRunning) pauseMic();
    await speak(handle.spokenText, handle.spokenLang);
    if (wasRunning && state.running) resumeMic();
  });

  return handle;
}

// ------------------------------------------------------------
// Translation (Google endpoint, MyMemory fallback)
// ------------------------------------------------------------

async function fetchTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function googleTranslate(text, target) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dj=1&dt=t&sl=auto'
    + '&tl=' + encodeURIComponent(target)
    + '&q=' + encodeURIComponent(text);
  const res = await fetchTimeout(url, 9000);
  if (!res.ok) throw new Error('translate http ' + res.status);
  const data = await res.json();
  const out = (data.sentences || [])
    .map((s) => (s && s.trans ? s.trans : ''))
    .join('')
    .trim();
  if (!out) throw new Error('empty translation');
  const detected = typeof data.src === 'string' ? data.src.split('-')[0].toLowerCase() : null;
  return { text: out, detected };
}

function decodeEntities(s) {
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

async function myMemoryTranslate(text, src, target) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
    + '&langpair=' + encodeURIComponent(src + '|' + target);
  const res = await fetchTimeout(url, 9000);
  if (!res.ok) throw new Error('mymemory http ' + res.status);
  const data = await res.json();
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out || (data.responseStatus && Number(data.responseStatus) !== 200)) {
    throw new Error('mymemory failed');
  }
  return { text: decodeEntities(String(out)).trim(), detected: null };
}

async function translateAuto(text, target, srcHint) {
  try {
    return await googleTranslate(text, target);
  } catch (e) {
    return await myMemoryTranslate(text, srcHint, target);
  }
}

// ------------------------------------------------------------
// Text-to-speech
// ------------------------------------------------------------

let voiceCache = [];
let ttsToken = 0; // bumped to abandon any in-flight chunk chain

function cancelTTS() {
  ttsToken++;
  try { const s = getSynth(); if (s) s.cancel(); } catch (e) { /* no-op */ }
}

function refreshVoices() {
  try {
    const synth = getSynth();
    voiceCache = (synth && synth.getVoices && synth.getVoices()) || [];
  } catch (e) {
    voiceCache = [];
  }
}

try {
  const synth = getSynth();
  if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', refreshVoices);
  else if (synth) synth.onvoiceschanged = refreshVoices;
} catch (e) { /* no-op */ }

function pickVoice(code) {
  if (!voiceCache.length) refreshVoices();
  const prefs = LANGS[code].ttsPrefs;
  const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
  const cands = voiceCache.filter((v) => norm(v).startsWith(code));
  if (!cands.length) return null;
  const score = (v) => {
    let s = 0;
    const idx = prefs.indexOf(norm(v));
    if (idx >= 0) s += (prefs.length - idx) * 20;
    if (/google/i.test(v.name || '')) s += 8;
    if (/natural|neural|online|premium|enhanced/i.test(v.name || '')) s += 4;
    if (v.localService === false) s += 2;
    if (v.default) s += 1;
    return s;
  };
  return cands.sort((x, y) => score(y) - score(x))[0];
}

function chunkText(text, max) {
  const t = text.trim();
  if (t.length <= max) return [t];
  const out = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    if (cur && (cur.length + 1 + w.length) > max) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [t];
}

// Speaks text; resolves when done. Watchdogs make sure a broken
// TTS engine can never freeze the conversation loop.
function ttsSpeak(text, langCode) {
  return new Promise((resolve) => {
    const synth = getSynth();
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      warnNoTTS(langCode);
      resolve();
      return;
    }
    state.lastTTS = { text, until: Date.now() + 60000 };
    const token = ttsToken;
    const chunks = chunkText(text, 170);
    let i = 0;
    let settled = false;
    let watchdog = 0;
    const keepAlive = setInterval(() => {
      try { if (synth.paused) synth.resume(); } catch (e) { /* no-op */ }
    }, 4000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      clearTimeout(watchdog);
      state.lastTTS = { text, until: Date.now() + 2500 };
      resolve();
    };
    const arm = (ms, fn) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(fn, ms);
    };
    const next = () => {
      if (settled) return;
      if (token !== ttsToken || i >= chunks.length) { finish(); return; }
      const chunk = chunks[i++];
      let u;
      try { u = new SpeechSynthesisUtterance(chunk); } catch (e) { finish(); return; }
      const voice = pickVoice(langCode);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = LANGS[langCode].ttsPrefs[0];
      }
      u.rate = 1;
      u.pitch = 1;
      u.volume = 1;
      let started = false;
      u.onstart = () => {
        started = true;
        arm(Math.min(30000, 4000 + chunk.length * 250), () => {
          try { synth.cancel(); } catch (e) { /* no-op */ }
          finish();
        });
      };
      u.onend = () => next();
      u.onerror = () => next();
      // If speech never starts (missing voice/engine), move on fast.
      arm(3000, () => {
        if (!started) {
          warnNoTTS(langCode);
          try { synth.cancel(); } catch (e) { /* no-op */ }
          finish();
        }
      });
      try { synth.speak(u); } catch (e) { finish(); }
    };
    try { if (synth.speaking || synth.pending) synth.cancel(); } catch (e) { /* no-op */ }
    setTimeout(next, 60);
  });
}

function warnNoTTS(langCode) {
  if (state.ttsWarned[langCode]) return;
  state.ttsWarned[langCode] = true;
  toast(`No ${LANGS[langCode].name} voice is available on this device — showing text only.`);
}

async function speak(text, langCode) {
  state.speaking = true;
  setStatus('speaking', `Speaking ${LANGS[langCode].native}…`);
  try {
    await ttsSpeak(text, langCode);
  } finally {
    state.speaking = false;
    if (state.running) setStatus('listening', listeningText());
  }
}

// ------------------------------------------------------------
// Echo guard — never translate our own loudspeaker output
// ------------------------------------------------------------

function tokens(s) {
  // \p{M} keeps combining marks (Devanagari matras) attached to words.
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isEcho(text) {
  const lt = state.lastTTS;
  if (!lt.text || Date.now() > lt.until) return false;
  const heard = tokens(text);
  const spoken = new Set(tokens(lt.text));
  if (!heard.length || !spoken.size) return false;
  let hits = 0;
  for (const w of heard) if (spoken.has(w)) hits++;
  if (heard.length === 1) return spoken.has(heard[0]) && heard[0].length > 3;
  return hits / heard.length >= 0.66;
}

// ------------------------------------------------------------
// Utterance pipeline
// ------------------------------------------------------------

function queueFinal(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return;
  const now = Date.now();
  if (text === state.lastFinal.text && now - state.lastFinal.t < 2500) return; // duplicate final
  state.lastFinal = { text, t: now };
  if (isEcho(text)) return;
  state.netErrors = 0;
  state.queue.push({ text, assumed: state.listenLang });
  pump();
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (state.running && state.queue.length) {
      const job = state.queue.shift();
      const res = await handleJob(job); // mic keeps listening while translating
      if (res && state.running) {
        pauseMic(); // never hear our own voice
        await speak(res.translated, res.target);
        state.listenLang = res.target; // expect the reply in the language just spoken
      }
    }
  } finally {
    state.pumping = false;
    if (state.running) resumeMic();
  }
}

// Works out who actually spoke, translates the right way around,
// and renders the bubble. Returns {translated, target} or null.
async function handleJob(job) {
  const p = pair();
  let src = job.assumed;

  // Script check: hi-IN emits Hindi in Devanagari, so a Latin
  // transcript from the Hindi recognizer means the other language
  // was spoken (and vice versa).
  if (p.includes('hi')) {
    if (DEVANAGARI.test(job.text)) src = 'hi';
    else if (src === 'hi') src = other('hi');
  }
  if (!p.includes(src)) src = state.a; // pair changed mid-flight

  let target = other(src);
  const bubble = addBubble(src, target, job.text);

  let out;
  try {
    out = await translateAuto(job.text, target, src);
  } catch (e) {
    bubble.fail();
    toast('Translation failed — check your internet connection.');
    return null;
  }

  // Auto-detect verification: if the detected source is the other
  // language of the pair (e.g. romanized Hindi picked up by the
  // English recognizer), flip direction and re-translate.
  if (out.detected && out.detected !== src && p.includes(out.detected)) {
    src = out.detected;
    target = other(src);
    bubble.setMeta(src, target);
    try {
      out = await translateAuto(job.text, target, src);
    } catch (e) {
      bubble.fail();
      toast('Translation failed — check your internet connection.');
      return null;
    }
  }

  bubble.fill(out.text, target);
  return { translated: out.text, target };
}

// ------------------------------------------------------------
// Speech recognition lifecycle
// ------------------------------------------------------------

function initialListenLang() {
  return pair().includes('hi') ? 'hi' : state.a;
}

function ensureListening() {
  if (!state.running || state.micPaused) return;
  if (!pair().includes(state.listenLang)) state.listenLang = initialListenLang();
  const tag = recTagFor(state.listenLang, pair());
  if (state.rec && state.recActive && state.recTag === tag) return;
  startRecognition(tag);
}

function startRecognition(tag) {
  stopRecognition();
  const Ctor = getRecCtor();
  if (!Ctor) return;
  const gen = ++state.recGen;
  let rec;
  try { rec = new Ctor(); } catch (e) { return; }
  state.rec = rec;
  state.recTag = tag;
  rec.lang = tag;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    if (gen !== state.recGen) return;
    state.recActive = true;
    if (state.running && !state.speaking) setStatus('listening', listeningText());
  };

  rec.onresult = (e) => {
    if (gen !== state.recGen || !state.running) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const alt = r && r[0];
      if (!alt) continue;
      if (r.isFinal) queueFinal(alt.transcript);
      else interim += alt.transcript;
    }
    showInterim(interim);
  };

  rec.onerror = (e) => {
    if (gen !== state.recGen) return;
    handleRecError(e && e.error);
  };

  rec.onend = () => {
    if (gen !== state.recGen) return;
    state.recActive = false;
    clearInterim();
    if (state.running && !state.micPaused) scheduleRestart();
  };

  try {
    rec.start();
  } catch (e) {
    // InvalidStateError: a previous session hasn't fully released yet.
    setTimeout(() => {
      if (gen !== state.recGen || !state.running || state.micPaused) return;
      try { rec.start(); } catch (e2) { scheduleRestart(); }
    }, 300);
  }
}

function stopRecognition() {
  const rec = state.rec;
  state.recGen++;
  state.rec = null;
  state.recActive = false;
  state.recTag = '';
  if (rec) {
    try {
      rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
      rec.abort();
    } catch (e) { /* no-op */ }
  }
}

function scheduleRestart(delay) {
  clearTimeout(state.restartTimer);
  const ms = typeof delay === 'number' ? delay : (state.netErrors > 0 ? 1400 : 250);
  state.restartTimer = setTimeout(ensureListening, ms);
}

function pauseMic() {
  state.micPaused = true;
  clearTimeout(state.restartTimer);
  stopRecognition();
  clearInterim();
}

function resumeMic() {
  state.micPaused = false;
  scheduleRestart(250); // small gap so the tail of our own audio isn't caught
}

function handleRecError(code) {
  switch (code) {
    case 'not-allowed':
      stopConversation();
      showMicHelp({ name: 'NotAllowedError' }, 'speech recognition');
      break;
    case 'service-not-allowed':
      stopConversation();
      showBanner('This browser\'s speech recognition service is unavailable. Use regular Google Chrome (privacy browsers like Brave disable it); on Android also make sure the Google app and "Speech Services by Google" are enabled and Chrome is up to date.');
      break;
    case 'audio-capture':
      stopConversation();
      showMicHelp({ name: 'NotFoundError' }, 'speech recognition');
      break;
    case 'language-not-supported':
      stopConversation();
      showBanner('This browser\'s speech service does not support one of the selected languages. Try Google Chrome, where all three languages are supported.');
      break;
    case 'network':
      state.netErrors++;
      if (state.netErrors === 3) {
        toast('Speech service unreachable — check your internet connection (Chrome works best).');
      }
      break;
    default:
      // 'no-speech' / 'aborted' etc.: onend fires next and we auto-restart.
      break;
  }
}

// ------------------------------------------------------------
// Wake lock — keep the phone screen (and mic) alive
// ------------------------------------------------------------

async function requestWakeLock() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not critical */ }
}

function releaseWakeLock() {
  try {
    if (state.wakeLock) state.wakeLock.release();
  } catch (e) { /* no-op */ }
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) {
    requestWakeLock();
    if (!state.micPaused) scheduleRestart(150);
  }
});

// ------------------------------------------------------------
// Start / stop
// ------------------------------------------------------------

async function startConversation() {
  if (state.running || state.starting) return;
  state.starting = true;
  try {
    await doStart();
  } finally {
    state.starting = false;
  }
}

async function doStart() {
  hideBanner();

  if (!getRecCtor()) {
    showBanner(unsupportedBrowserMessage());
    return;
  }
  if (!window.isSecureContext) {
    showBanner('The microphone only works on a secure page. Open this app over HTTPS (e.g. GitHub Pages) or from localhost.');
    return;
  }

  // Unlock speech output on iOS/Safari: TTS must first be triggered by a
  // user gesture, so do it synchronously with the Start tap, before any await.
  try {
    const synth = getSynth();
    if (synth && typeof window.SpeechSynthesisUtterance === 'function') {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    }
  } catch (e) { /* no-op */ }

  // Ask for the mic up front so permission errors are clear.
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      await showMicHelp(e, 'mic request');
      return;
    }
  }

  refreshVoices();
  state.running = true;
  state.micPaused = false;
  state.queue.length = 0;
  state.netErrors = 0;
  state.listenLang = initialListenLang();
  updateMainBtn();
  setStatus('listening', listeningText());
  requestWakeLock();
  ensureListening();
}

function stopConversation() {
  state.running = false;
  state.micPaused = false;
  state.queue.length = 0;
  clearTimeout(state.restartTimer);
  stopRecognition();
  cancelTTS();
  state.speaking = false;
  releaseWakeLock();
  clearInterim();
  updateMainBtn();
  setStatus('idle', 'Tap Start to begin');
}

// ------------------------------------------------------------
// Language pair UI
// ------------------------------------------------------------

const STORE_KEY = 'voicebridge-pair';

function buildSelects() {
  for (const sel of [els.langA, els.langB]) {
    sel.innerHTML = '';
    for (const code of Object.keys(LANGS)) {
      const opt = document.createElement('option');
      opt.value = code;
      const L = LANGS[code];
      opt.textContent = L.name === L.native ? `${L.flag} ${L.name}` : `${L.flag} ${L.name} · ${L.native}`;
      sel.appendChild(opt);
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (Array.isArray(saved) && LANGS[saved[0]] && LANGS[saved[1]] && saved[0] !== saved[1]) {
      state.a = saved[0];
      state.b = saved[1];
    }
  } catch (e) { /* ignore */ }
  els.langA.value = state.a;
  els.langB.value = state.b;
}

function applyPairChange() {
  state.a = els.langA.value;
  state.b = els.langB.value;
  try { localStorage.setItem(STORE_KEY, JSON.stringify([state.a, state.b])); } catch (e) { /* ignore */ }
  state.listenLang = initialListenLang();
  if (state.running) {
    setStatus('listening', listeningText());
    if (!state.micPaused) ensureListening();
  }
}

function onSelectChange(which) {
  // Never allow the same language on both sides — swap instead.
  if (els.langA.value === els.langB.value) {
    if (which === 'a') els.langB.value = state.a;
    else els.langA.value = state.b;
  }
  applyPairChange();
}

els.langA.addEventListener('change', () => onSelectChange('a'));
els.langB.addEventListener('change', () => onSelectChange('b'));

els.swapBtn.addEventListener('click', () => {
  const a = els.langA.value;
  els.langA.value = els.langB.value;
  els.langB.value = a;
  applyPairChange();
});

els.mainBtn.addEventListener('click', () => {
  if (state.running) stopConversation();
  else startConversation();
});

els.clearBtn.addEventListener('click', () => {
  for (const m of Array.from(els.feed.querySelectorAll('.msg'))) m.remove();
  els.empty.hidden = false;
  els.clearBtn.hidden = true;
});

window.addEventListener('beforeunload', () => {
  try { stopRecognition(); } catch (e) { /* no-op */ }
  cancelTTS();
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------

buildSelects();
refreshVoices();
updateMainBtn();
setStatus('idle', 'Tap Start to begin');
if (!getRecCtor()) {
  showBanner('Heads-up: ' + unsupportedBrowserMessage());
}
