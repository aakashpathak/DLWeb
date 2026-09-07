# Runway — backwards planning for ADHD brains

**The insight:** people with ADHD plan the *event* but not the *transitions* — the shower,
the "where are my keys", the traffic, the arriving early. So they push getting ready
to the last minute, discover the place is 30 minutes away, and are late again.

Runway fixes that by planning **backwards** from the moment you must be somewhere:

> Doctor at 8:00 → arrive 7:50 → leave 6:55 (45 min drive + traffic pad) → out the door 6:45 →
> grab insurance card 6:40 → breakfast 6:25 → dressed 6:15 → shower 5:55 → bathroom 5:45 →
> **wake up 5:30**. Night before: lay out clothes, set the alarm.

Tasks with no time yet ("get my oil changed") get the *logistics* broken into 2–5 minute steps
(find a shop, check hours, find a window, book it), ending with "tell Runway the time".

## Use it right now (iPhone)

1. Open **https://aakashpathak.github.io/DLWeb/runway/** in Safari.
2. Tap **Share → Add to Home Screen**. It now behaves like an app (full screen, offline, its own icon).
3. Tap the **mic**, say *"Dentist Thursday at 8am, it's 45 minutes away"*, check the sheet, tap **Plan it**.

Everything is stored on the phone. No account needed. Accounts + sync switch on once Firebase
is connected (see `SETUP.md`).

## What's in the box

| File | What it does |
| --- | --- |
| `planner.js` | The rules engine. Task categories (doctor, car, flight, errand, call, chore…), what to bring, the backwards timeline, per-step duration overrides, 5-minute rounding of the times that matter, overlap detection. Pure functions, unit-tested. |
| `nlp.js` | Turns spoken/typed English into task + time + travel + place. |
| `app.js` | The UI: home list, up-next card with countdown, add/review flow, mic, tap-to-fix durations, calendar export, settings, reminders. |
| `store.js` | localStorage now; Firebase Auth + Firestore sync when configured. |
| `firebase-config.js` | Paste your Firebase web config here to turn on accounts. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app: offline shell, home-screen icon. |
| `plan-contract.js`, `ai.js` | Shared plan schema/prompt/normalizer, and the phone-side client for the server or the Claude API. |
| `backend/` | The planning server (Node, one file). Claude or local model. |
| `tests/*.test.mjs` | `node --test tests/*.test.mjs` — 26 tests on parsing, planning, the AI client and the contract. |
| `tests/make-icons.mjs` | Regenerates the icons (no dependencies). |

## Design decisions (for ADHD)

- **Two buttons.** Plus and mic. Nothing to learn.
- **The honest number.** Every plan says *wake at 5:30* not *leave at 7*. Tap any duration to fix it — the whole plan shifts, and it can remember your real number for next time.
- **Up next, always on top.** One thing, one countdown, one "Done" button.
- **Overcommit warning.** Two plans that overlap on the same day get a red pill.
- **Times you can remember.** Wake/leave times are rounded to 5-minute marks.
- **Night before.** Morning plans add a 9pm step so the morning has no decisions.
- **No time yet is fine.** The app breaks the logistics into tiny steps instead of nagging for a date.
- **Alerts even when closed.** "Calendar" adds the plan to Apple/Google Calendar with a *Leave now* alarm.

## AI planning

Three tiers, picked in Settings → AI planning:

| Tier | Where the thinking happens | Quality |
| --- | --- | --- |
| Built-in rules (`planner.js`) | On the phone, no network | Rough: keyword templates, ignores nuance |
| **Runway server** (`backend/`) | Your computer → Claude API **or** a local model via Ollama | Best. Reads every constraint you said. Key never on the phone |
| Direct API key | Phone → Claude API | Same quality as server + Claude, for quick personal tests |

The plan shape, prompt, and normalizer are shared in `plan-contract.js` so all tiers produce the same
kind of plan. See `backend/README.md` for the 15-minute setup on a spare computer.

## Development

```bash
python3 -m http.server 8000      # then open http://localhost:8000/runway/
cd runway && node --test tests/  # unit tests
```
