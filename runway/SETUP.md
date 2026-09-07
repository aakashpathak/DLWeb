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

## Part 2 — App Store (native iOS wrapper)

Runway is a web app, so the App Store version is the same code inside a thin native shell. This part needs a Mac with Xcode and an Apple Developer account ($99/year). If you don't have a Mac, hand this section to anyone who does — it's about an hour.

**Apple side (one-time, you):**
1. Enroll at https://developer.apple.com/programs/ (Apple ID + payment). Approval can take a day or two.
2. In https://appstoreconnect.apple.com → **My Apps → +** → name **Runway**, bundle ID `fyi.vaak.runway` (or anything unique), SKU `runway`.

**Build side (on a Mac):**
```bash
git clone https://github.com/aakashpathak/DLWeb.git && cd DLWeb/runway/ios-wrapper
npm install
npx cap add ios
npx cap sync
npx cap open ios          # opens Xcode
```
In Xcode: select your Team under **Signing & Capabilities**, set the bundle ID from step 2, pick **Any iOS Device**, then **Product → Archive → Distribute App → App Store Connect**.
The wrapper is configured to load the live site (`server.url` in `ios-wrapper/capacitor.config.json`), so you never rebuild for content changes — only for icon/name changes.

**Back in App Store Connect:** add the screenshots (take them on your iPhone from the installed app), the description below, the privacy answers (data is stored on device; if Firebase is on: email + tasks, used only to sync), and submit for review.

Suggested description:
> Runway plans backwards. Say a task — "dentist Thursday at 8, 45 minutes away" — and Runway builds the honest timeline: when to wake up, when to shower, when to leave, with traffic and "find my keys" time baked in. Built for ADHD brains that plan the event but not the transitions.

---

## Part 3 — AI planning (later)

Settings has an API key field that is saved on the phone and currently unused. When you're ready,
send the key and we'll point `planner.js` at a small server that calls Claude to break down unusual tasks.
Do **not** paste API keys into the repo.
