// חיבור ל-Firebase: התחברות משתמשים (Auth) וסנכרון לענן (Realtime Database).
// מבנה הנתונים בענן — כל משתמש רואה רק את הנתונים שלו (ראה database.rules.json):
//   users/{uid}/settings          פרופיל הבקר, לוגו, נוסחים
//   users/{uid}/sites/{id}        אתרים ואנשי קשר
//   users/{uid}/reports/{id}      דוחות (בלי תוכן התמונות)
//   users/{uid}/photos/{photoId}  תוכן התמונות (dataURL) — נפרד, כדי שרשימת הדוחות תיטען מהר
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signInWithPopup, signInWithRedirect, GoogleAuthProvider, signOut, updateProfile,
} from '../vendor/firebase/firebase-auth.js';
import { getDatabase, ref, set, get, remove, update, onValue, off } from '../vendor/firebase/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = 'he';
const rtdb = getDatabase(app);

import('../vendor/firebase/firebase-analytics.js')
  .then(async ({ getAnalytics, isSupported }) => (await isSupported()) && getAnalytics(app))
  .catch(() => {});

let uid = null;
const listeners = [];
const path = (...p) => ref(rtdb, ['users', uid, ...p].join('/'));

// ---------- auth ----------
export const onUser = (cb) => onAuthStateChanged(auth, cb);
export const currentUser = () => auth.currentUser;

export async function signIn(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
export async function signUp(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name) await updateProfile(cred.user, { displayName: name });
  return cred;
}
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  try {
    return await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    throw err;
  }
}
export function logOut() {
  stopSync();
  return signOut(auth);
}

export const AUTH_ERRORS = {
  'auth/invalid-email': 'כתובת אימייל לא תקינה',
  'auth/missing-password': 'יש להזין סיסמה',
  'auth/weak-password': 'הסיסמה חלשה מדי — לפחות 6 תווים',
  'auth/email-already-in-use': 'כבר קיים חשבון עם האימייל הזה — נסה להתחבר',
  'auth/invalid-credential': 'אימייל או סיסמה שגויים',
  'auth/wrong-password': 'אימייל או סיסמה שגויים',
  'auth/user-not-found': 'לא נמצא חשבון עם האימייל הזה',
  'auth/too-many-requests': 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות',
  'auth/network-request-failed': 'אין חיבור לאינטרנט',
  'auth/popup-closed-by-user': 'החלון נסגר לפני סיום ההתחברות',
  'auth/unauthorized-domain': 'הדומיין הזה לא מאושר ב-Firebase (Authentication → Settings → Authorized domains)',
  'auth/operation-not-allowed': 'שיטת ההתחברות לא הופעלה ב-Firebase (Authentication → Sign-in method)',
  'auth/configuration-not-found': 'שירות ההתחברות לא הופעל בפרויקט ה-Firebase',
};
export const authError = (err) => AUTH_ERRORS[err?.code] || err?.message || 'שגיאה לא צפויה';

// ---------- data ----------
// שדות שמתחילים ב-"_" הם מקומיים בלבד (מצב סנכרון) ולא נשלחים לענן
const clean = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => (k.startsWith('_') ? undefined : v)));

export async function pushSettings(settings) {
  if (uid) await set(path('settings'), clean(settings));
}
export async function pushSite(s) {
  if (uid) await set(path('sites', s.id), clean(s));
}
export async function pushReport(r) {
  if (!uid) return false;
  // קודם תוכן התמונות (רק מה שעוד לא הועלה), ואז הדוח — כך מכשיר אחר לא יקבל דוח שהתמונות שלו עוד חסרות
  const pending = (r.photos || []).filter((p) => !p._up && p.src);
  if (pending.length) await update(path('photos'), Object.fromEntries(pending.map((p) => [p.id, p.src])));
  const photos = (r.photos || []).map(({ src, ...meta }) => meta);
  await set(path('reports', r.id), clean({ ...r, photos }));
  pending.forEach((p) => (p._up = true));
  return pending.length > 0; // מסמן לקורא שכדאי לשמור מקומית את דגלי ההעלאה
}
export async function removeSite(id) {
  if (uid) await remove(path('sites', id));
}
export async function removeReport(r) {
  if (!uid) return;
  const updates = { [`reports/${r.id}`]: null };
  for (const p of r.photos || []) updates[`photos/${p.id}`] = null;
  await update(path(), updates);
}
export async function removePhoto(id) {
  if (uid) await remove(path('photos', id));
}
export async function fetchPhoto(id) {
  const snap = await get(path('photos', id));
  return snap.val();
}

// מאזין לשינויים בענן. handlers: { settings(obj|null), sites(map), reports(map), connection(bool) }
export function startSync(userId, handlers) {
  stopSync();
  uid = userId;
  const watch = (r, cb) => {
    onValue(r, (snap) => cb(snap.val()), (err) => handlers.error?.(err));
    listeners.push(r);
  };
  watch(path('settings'), handlers.settings);
  watch(path('sites'), (v) => handlers.sites(v || {}));
  watch(path('reports'), (v) => handlers.reports(v || {}));
  const conn = ref(rtdb, '.info/connected');
  onValue(conn, (snap) => handlers.connection?.(snap.val() === true));
  listeners.push(conn);
}

export const isSyncing = () => !!uid;

export function stopSync() {
  listeners.splice(0).forEach((r) => off(r));
  uid = null;
}
