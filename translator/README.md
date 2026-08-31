# VoiceBridge — hands-free two-way voice translator

A zero-dependency web app for talking to someone who speaks a different
language. Pick the two languages, tap **Start conversation** once, and just
talk — no other taps, ever:

- Someone speaks **English** → the phone speaks the **Hindi** translation aloud.
- Someone replies in **Hindi** → the phone speaks the **English** translation aloud.

The app works out *who is talking* on its own. Starting languages: **English,
Hindi, Spanish** (any pair of them).

## Using it

1. Open `translator/index.html` from an HTTPS host (e.g. GitHub Pages:
   `https://<user>.github.io/DLWeb/translator/`) or locally via
   `python3 -m http.server` → `http://localhost:8000/translator/`.
   The mic requires a secure page, so opening the raw file may not work.
2. Best in **Chrome** (Android or desktop); Edge and Safari also work.
   Needs internet (speech recognition and translation are online services).
3. Pick the pair, tap **Start conversation**, allow the microphone, and put
   the phone between the two speakers. Tap a bubble to replay its audio.

## How the hands-free part works

- **Continuous listening.** Web Speech API recognition runs in a loop and is
  restarted automatically whenever the browser ends a session (silence,
  timeouts, tab switches). A screen wake-lock keeps the phone awake.
- **Who spoke?** The recognizer is tuned to the language the *next* speaker is
  expected to use (after Hindi audio plays, a Hindi reply is expected). Every
  utterance is then verified: Devanagari script means Hindi, and the
  translation API's language auto-detection catches everything else — including
  *romanized* Hindi picked up by the English recognizer. If the "wrong" person
  spoke, the direction flips and the text is re-translated automatically. For
  English+Hindi the app starts on `hi-IN`, whose speech model transcribes both
  languages.
- **No feedback loops.** The mic is paused while the app is speaking, and an
  echo guard drops any transcript that matches the audio just played, so the
  app never translates its own voice.
- **Translation.** Google's public translate endpoint (no key needed), with
  MyMemory as a fallback. If both fail, the bubble says so and listening
  continues.

## Adding a language

Add an entry to `LANGS` in `app.js` (name, native name, flag, preferred TTS
voices) and, if it needs a specific recognition locale, a line in
`recTagFor()`. Everything else — selectors, detection, speech — picks it up.

## Privacy

Audio is processed by the browser's built-in speech service (Google's servers
in Chrome), and recognized text is sent to the translation endpoint. Nothing
is stored anywhere except the language pair, remembered in `localStorage`.
