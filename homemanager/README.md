# Ring Home Manager

Not everything at home needs you. Home Manager links to your Ring account, handles routine
events quietly (deliveries, couriers, cars, animals, the garage closing) and only alerts you
when something needs a decision: an unknown person who stays at the door, someone lingering,
a package taken, a sensor opening while the alarm is armed, the alarm going off.

```
Ring cloud ──(unofficial ring-client-api)──▶ backend/ (your computer, always on)
                                               │  triage.js: routine or attention?
                                               ├─▶ iPhone push, attention only (APNs)
iPhone app (ios-wrapper/, TestFlight) ◀────────┘  HTTPS via Cloudflare tunnel
```

## The rules (`backend/triage.js`)

| Event | Result |
|---|---|
| Package delivered, vehicle, animal, plain motion | Logged quietly |
| Person or doorbell, then a package within 5 min | Logged as "Courier at the door" |
| Person or doorbell, no package after 30 s | **Needs attention**: "Unknown person at your door… for N seconds" (push) |
| Loitering, package picked up, alarm triggered | **Needs attention** (push) |
| Contact/tilt sensor (e.g. garage) open or closed | Logged; **attention** if it opens while the alarm is armed |

On the attention card: **Secure home** (arms Ring Alarm to Away and turns on camera lights),
**View live** (a fresh camera picture every 4 s), **I know them**, **Ask Home Manager**.

Tests: `cd backend && npm test`.

## 1. Backend (on a spare computer that stays on)

```bash
cd homemanager/backend
npm install
cp .env.example .env     # set HM_TOKEN (a password); ANTHROPIC_API_KEY optional
npm start                # Home Manager on http://localhost:8788
cloudflared tunnel --url http://localhost:8788   # gives you https://….trycloudflare.com
```

Same setup as the Runway backend; see `runway/backend/README.md` for the tunnel and
running it permanently with `pm2`. Use a named tunnel so the URL doesn't change.

## 2. Link Ring

In the app: gear → paste the tunnel URL and password → **Save & connect** → enter your Ring
email and password → enter the code Ring texts you. The server keeps only Ring's refresh token
(`backend/data/state.json`), never your password. Alternatively run `npm run ring-token` on the
server and put the token in `.env` as `RING_REFRESH_TOKEN`.

Then turn **off** motion and doorbell notifications in the Ring app; Home Manager replaces them.
Use **Try it** in settings (Delivery / Unknown person / Car / Garage) to test the flow end to end.

This uses the same unofficial API as Homebridge Ring. Ring can change it without notice.

## 3. iPhone build for TestFlight (on a Mac)

Needs Xcode, Node and CocoaPods (see `runway/SETUP.md`, Stage A).

```bash
cd homemanager/ios-wrapper
npm install
npm run setup     # copies the app in, creates the Xcode project, adds push entitlement, icons
npm run open      # opens Xcode
```

In Xcode, select the **App** target → **Signing & Capabilities** → Team: your developer account.
Bundle ID is `fyi.vaak.homemanager` (change it in `capacitor.config.json` before `setup` if
you prefer). Push Notifications is already added; Xcode registers it on the App ID.

Upload: set the device to **Any iOS Device (arm64)** → **Product → Archive** → **Distribute App →
TestFlight & App Store**. In App Store Connect create the app record first (My Apps → + → New App,
same bundle ID). The build shows up in TestFlight in ~10 minutes; add yourself as an internal tester.
Each new upload: bump **Build** in the General tab. After changing the web app: `npm run update`.

## 4. Push notifications (attention only)

1. developer.apple.com → Certificates, IDs & Profiles → **Keys** → + → enable **Apple Push
   Notifications service** → download the `.p8` (once only). Note the Key ID and your Team ID.
2. Put the `.p8` in `backend/`, then in `.env`: `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_TOPIC=fyi.vaak.homemanager`. Keep `APNS_PRODUCTION=true` for TestFlight builds
   (`false` only for builds run straight from Xcode).
3. Restart the server, open the app, allow notifications. Test with **Try it → Unknown person**.

## Notes

- "View live" is a refreshed still, not video: real streaming through the unofficial API needs
  WebRTC/ffmpeg on the server. Battery cameras may refuse frequent pictures.
- Ring has no API for "familiar faces", so "I don't recognize them" means "not a courier";
  tap **I know them** to clear it.
- App name and Ring wording are fine for internal TestFlight. Before external testing or the
  App Store, drop "Ring" from the name/branding (trademark) and expect review questions about
  using an unofficial API.
