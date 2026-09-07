// Runway — Firebase configuration.
//
// The app works fully offline/local without this. To turn on accounts
// (email + Google sign-in) and sync between devices, create a free Firebase
// project and paste its web config here. Step-by-step: see SETUP.md.
//
// Leave apiKey empty to keep accounts disabled.
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// Optional, for later: an Anthropic API key connector lives in Settings → AI.
export const ai = {
  // Where the app should send "plan this task" requests once AI planning is on.
  // Empty = on-device rules only (the default).
  endpoint: '',
};
