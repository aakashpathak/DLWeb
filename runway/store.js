// Runway store — local-first (localStorage), optional Firebase sync.
import { firebaseConfig } from './firebase-config.js';
import { DEFAULT_PREFS } from './planner.js';

const KEY = 'runway-v1';
const listeners = new Set();

export const state = {
  tasks: [],
  prefs: { ...DEFAULT_PREFS },
  settings: { notifications: false, aiKey: '' },
  updatedAt: 0,
  user: null,          // { uid, email, name } when signed in
  cloud: 'off',        // off | ready | syncing | synced | error
};

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw) {
      state.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      state.prefs = { ...DEFAULT_PREFS, ...(raw.prefs || {}) };
      state.settings = { ...state.settings, ...(raw.settings || {}) };
      state.updatedAt = raw.updatedAt || 0;
    }
  } catch (e) { /* corrupted or blocked storage — start fresh */ }
}

export function save() {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify({ tasks: state.tasks, prefs: state.prefs, settings: state.settings, updatedAt: state.updatedAt }));
  } catch (e) { /* ignore */ }
  emit();
  cloudPush();
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(state); }

export function wipe() {
  state.tasks = []; state.prefs = { ...DEFAULT_PREFS }; state.settings = { notifications: false, aiKey: '' };
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  save();
}

export function exportJSON() {
  return JSON.stringify({ tasks: state.tasks, prefs: state.prefs, exportedAt: new Date().toISOString() }, null, 2);
}

// ---------------------------------------------------------------------------
// Firebase (only loaded when configured)
// ---------------------------------------------------------------------------
export const cloudEnabled = !!(firebaseConfig && firebaseConfig.apiKey);
let fb = null; // { auth, db, authFns, fsFns }
let pushTimer = null;

export async function initCloud() {
  if (!cloudEnabled) return;
  try {
    const [app, auth, fs] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const a = app.initializeApp(firebaseConfig);
    fb = { auth: auth.getAuth(a), db: fs.getFirestore(a), authFns: auth, fsFns: fs };
    state.cloud = 'ready';
    try { await auth.getRedirectResult(fb.auth); } catch (e) { /* no redirect pending */ }
    auth.onAuthStateChanged(fb.auth, async (u) => {
      state.user = u ? { uid: u.uid, email: u.email, name: u.displayName } : null;
      emit();
      if (u) await cloudPull();
    });
  } catch (e) {
    state.cloud = 'error'; state.cloudError = String(e.message || e); emit();
  }
}

export async function signInGoogle() {
  if (!fb) throw new Error('Accounts are not set up yet.');
  const provider = new fb.authFns.GoogleAuthProvider();
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return fb.authFns.signInWithRedirect(fb.auth, provider);
  try { return await fb.authFns.signInWithPopup(fb.auth, provider); }
  catch (e) { return fb.authFns.signInWithRedirect(fb.auth, provider); }
}
export async function signInEmail(email, password, create) {
  if (!fb) throw new Error('Accounts are not set up yet.');
  const f = fb.authFns;
  if (create) return f.createUserWithEmailAndPassword(fb.auth, email, password);
  return f.signInWithEmailAndPassword(fb.auth, email, password);
}
export async function resetPassword(email) {
  if (!fb) throw new Error('Accounts are not set up yet.');
  return fb.authFns.sendPasswordResetEmail(fb.auth, email);
}
export async function signOut() { if (fb) await fb.authFns.signOut(fb.auth); }

async function cloudPull() {
  if (!fb || !state.user) return;
  const { doc, getDoc } = fb.fsFns;
  try {
    state.cloud = 'syncing'; emit();
    const snap = await getDoc(doc(fb.db, 'users', state.user.uid));
    if (snap.exists()) {
      const remote = snap.data();
      // Merge task-by-task: newest updatedAt wins; union of ids.
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      for (const rt of remote.tasks || []) {
        const lt = byId.get(rt.id);
        if (!lt || (rt.updatedAt || 0) > (lt.updatedAt || 0)) byId.set(rt.id, rt);
      }
      state.tasks = [...byId.values()];
      if ((remote.updatedAt || 0) > state.updatedAt && remote.prefs) state.prefs = { ...DEFAULT_PREFS, ...remote.prefs };
    }
    state.cloud = 'synced';
    save();
  } catch (e) { state.cloud = 'error'; state.cloudError = String(e.message || e); emit(); }
}

function cloudPush() {
  if (!fb || !state.user) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const { doc, setDoc } = fb.fsFns;
    try {
      state.cloud = 'syncing'; emit();
      await setDoc(doc(fb.db, 'users', state.user.uid), { tasks: state.tasks, prefs: state.prefs, updatedAt: state.updatedAt }, { merge: true });
      state.cloud = 'synced'; emit();
    } catch (e) { state.cloud = 'error'; state.cloudError = String(e.message || e); emit(); }
  }, 800);
}
