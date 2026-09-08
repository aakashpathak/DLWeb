# Runway — setup guide (plain English)

You do not need any of this to *use* Runway. It already works from the link in `README.md`.
This is for the two optional things: **accounts/sync** and **putting it in the App Store**.

---

## Part 1 — Accounts & sync (Firebase, ~15 minutes, free)

This turns on "Continue with Google" and email sign-in, and syncs tasks between devices.

1. Go to https://console.firebase.google.com and click **Create a project**. Name it `runway`. Turn off Google Analytics (not needed). Create.
2. In the left menu: **Build → Authentication → Get started**.
   - **Sign-in method** tab → enable **Email/Password** → Save.
   - Add provider → **Google** → enable → pick your support email → Save.
   - **Settings** tab → **Authorized domains** → Add domain: `aakashpathak.github.io`.
3. Left menu: **Build → Firestore Database → Create database** → Start in **production mode** → pick a region near you → Enable.
   - **Rules** tab → replace everything with this and click **Publish**:
     ```
     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         match /users/{uid} {
           allow read, write: if request.auth != null && request.auth.uid == uid;
         }
       }
     }
     ```
     (Each person can only read and write their own data.)
4. Project overview (gear icon → **Project settings**) → scroll to **Your apps** → click the **</>** (Web) icon → nickname `runway` → Register app. You'll see a block like:
   ```js
   const firebaseConfig = { apiKey: "AIza...", authDomain: "runway-xxxx.firebaseapp.com", projectId: "runway-xxxx", storageBucket: "...", messagingSenderId: "...", appId: "..." };
   ```
5. Open `runway/firebase-config.js` in this repo and paste those six values into the matching empty quotes. Commit and push (or edit the file directly on GitHub and hit **Commit changes**). The site redeploys itself in about a minute.
6. Open Runway → gear icon → **Account** now shows sign-in buttons.

The `apiKey` in a Firebase web config is safe to publish; the Firestore rules above are what protect the data.

---

## Part 2 — A real iOS app in the App Store

Runway's iOS app is the same code you already use, wrapped in a native shell that adds two
things the web version can't do: **native speech recognition** (the mic in a native app uses
Apple's engine) and **real notifications** that fire even when the app is closed ("Leave now",
"Wake up"). Everything is set up in the `ios-wrapper/` folder; you mostly press Run.

### What you need
- **A Mac.** Apple only allows iOS apps to be built on a Mac. If you don't own one, any friend's
  Mac works for an afternoon — nothing is stored on it that you'd miss.
- **An Apple ID.** You already have one (the one on your iPhone).
- **Apple Developer Program, $99/year.** Needed only for the App Store and TestFlight. You can
  put the app on *your own* iPhone for free without it (Stage B below), so enroll while you test.
- A **USB cable** to connect the iPhone to the Mac the first time.

### Stage A — install the tools (once, ~40 min mostly waiting)
1. On the Mac, open the **App Store**, search **Xcode**, install it (it's big — 10+ GB). Open it once and accept the license.
2. Install **Homebrew** and **Node**: open **Terminal** (Cmd+Space, type Terminal) and paste:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   brew install node cocoapods
   ```
   Homebrew will ask for your Mac password once and tell you to paste two lines at the end — paste them.
3. Get the code and build the Xcode project — paste these four lines:
   ```bash
   git clone https://github.com/aakashpathak/DLWeb.git
   cd DLWeb/runway/ios-wrapper
   npm install
   npm run setup
   ```
   `npm run setup` copies the app in, creates the Xcode project, adds the microphone/speech permission texts, and generates all the icon sizes and the launch screen. Takes 2–3 minutes.

### Stage B — run it on your own iPhone (free, ~10 min)
1. `npm run open` — Xcode opens the project.
2. In the left sidebar click the top item **App**. In the middle, click **Signing & Capabilities**.
   - Check **Automatically manage signing**.
   - **Team**: choose your name. If none is listed, click *Add an Account…* and sign in with your Apple ID — a free "Personal Team" appears.
   - If Xcode complains the bundle identifier is taken, change `fyi.vaak.runway` to something unique like `com.yourname.runway`.
3. Plug in your iPhone. On the phone, tap **Trust This Computer**. On the phone also go to **Settings → Privacy & Security → Developer Mode**, turn it on, restart the phone when asked.
4. At the top of Xcode, next to the play button, choose your iPhone from the device list. Press **▶ Run**.
5. First launch will fail on the phone with "Untrusted Developer". On the phone: **Settings → General → VPN & Device Management → your Apple ID → Trust**. Tap the Runway icon again.

You now have Runway as a real app. Tap the mic — it should ask for microphone and speech permission once. Open the gear → **Turn on reminders** — it should ask for notification permission. Plan something 5 minutes out and lock the phone: the notification should arrive.
(With a free Personal Team the app expires after 7 days and you re-run from Xcode; the paid program removes that.)

### Stage C — TestFlight (friends can install it, ~30 min + Apple wait)
1. Enroll at https://developer.apple.com/programs/enroll/ with your Apple ID. Pay the $99. Approval usually takes 24–48 h (you'll get an email).
2. Go to https://appstoreconnect.apple.com → **My Apps → + → New App**:
   - Platform iOS · Name **Runway** · Primary language English · Bundle ID: the one from Stage B (register it there if asked: *Certificates, IDs & Profiles → Identifiers → +*) · SKU `runway` · Full access.
3. Back in Xcode: device list at the top → choose **Any iOS Device (arm64)**. Menu **Product → Archive**. When the Organizer window appears: **Distribute App → App Store Connect → Upload** → keep every default → Upload.
4. In App Store Connect → your app → **TestFlight** tab: the build appears after ~10 minutes of "Processing". Answer the export-compliance question **No** (Runway uses no custom encryption). Add yourself under **Internal Testing**, and friends by email under **External Testing** (external needs a quick Apple review, ~1 day).
5. Testers get an email → install the **TestFlight** app → tap Install.

### Stage D — App Store submission (~1 hour of forms)
In App Store Connect → your app → **App Store** tab → the "1.0 Prepare for Submission" page:
1. **Screenshots**: take 3–6 on your iPhone (Stage B app): empty screen, the review sheet, a planned morning, the "Now" card, a no-time task. Apple needs the 6.7" size — iPhone 15/16 Pro Max or 14 Plus screenshots work as-is; other iPhones' screenshots get rejected for size, so borrow one or use the Xcode Simulator (Xcode → Open Developer Tool → Simulator → iPhone 16 Pro Max → run the app there and press Cmd+S).
2. **Promotional text / Description** — use the text at the end of this section. **Keywords**: `adhd,planner,time blindness,tasks,routine,on time,late,executive function,schedule`. **Support URL**: `https://aakashpathak.github.io/DLWeb/runway/`. **Marketing URL**: same.
3. **Category**: Productivity. Secondary: Health & Fitness.
4. **App Privacy**: click *Get started*. If Firebase is **not** connected: "No, we do not collect data." If it **is**: Contact Info → Email Address (for app functionality, linked to user), User Content → Other user content (tasks), both *not* used for tracking.
5. **Age rating**: answer *None* to everything → 4+.
6. **App Review Information**: your phone + email. Notes for the reviewer — paste:
   > Runway is a planner for ADHD users. Tap the mic (or +) and say a task such as "dentist Thursday at 8am, 45 minutes away". The app builds a backwards timeline (wake up, shower, leave) with transition time included, and schedules local notifications for each step. No account is required; all data is stored on device.
7. **Build**: click *Add Build* and pick the TestFlight build.
8. **Pricing**: Free. **Availability**: all countries.
9. Click **Add for Review → Submit**. Review takes 1–3 days. If they reject with guideline **4.2 (minimum functionality)** — the usual objection to web-based apps — reply in Resolution Center pointing at the native speech recognition, offline operation, and scheduled local notifications; those three are exactly what that guideline asks for.

### Updating the app later
Web changes go live instantly for the PWA. For the App Store version, on the Mac:
```bash
cd DLWeb && git pull && cd runway/ios-wrapper && npm run update && npm run open
```
then bump the version in Xcode (App → General → Version) and repeat Stage C step 3 + Stage D step 7–9.

### Store text
**Subtitle** (30 chars): `Plan backwards. Leave on time.`

**Description:**
> You plan the appointment. You forget the shower, the keys, the traffic. Then you're late again.
>
> Runway plans backwards. Say a task — "dentist Thursday at 8, 45 minutes away" — and Runway builds the honest timeline: wake up at 5:30, shower 5:55, out the door 6:45, leave 6:55, arrive with ten minutes to breathe. Transition time is baked in, not hoped for.
>
> • Say it or type it. Two buttons, nothing to learn.
> • Every step gets a time and a nudge, even when the app is closed.
> • Tap any duration to make it honest — the whole plan shifts.
> • Tasks with no date yet get their logistics broken into 2-minute steps.
> • Warns you when two plans collide on the same day.
> • Add the plan to your calendar with a "leave now" alarm.
> • Works offline. No account needed.
>
> Built for ADHD brains that plan the event but not the transitions.

## Part 3 — AI planning

Runway plans with a real model when you connect one. Two ways, in Settings → AI planning:

1. **Runway server (recommended).** Run the small server in `backend/` on any computer — your spare
   one is perfect. It holds the API key and can use **Claude** or a **local model** (free, private).
   Full step-by-step, including how the phone reaches it: `backend/README.md`.
2. **Direct key (quick test).** Paste an Anthropic API key into the app. Fine for you; not for the public.

Without either, the built-in rules make a rougher plan. Never paste API keys into the repo.
