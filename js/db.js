// אחסון מקומי בדפדפן (IndexedDB). משמש כעותק מקומי של הנתונים מהענן — כך האפליקציה נפתחת מיד
// ועובדת גם בלי קליטה באתר. לכל משתמש מסד נפרד, כך שמשתמשים שונים על אותו מכשיר לא מתערבבים.
const LEGACY_DB = 'bakar';
const DB_VERSION = 1;
const STORES = ['sites', 'reports', 'kv'];

let dbName = LEGACY_DB;
let dbPromise;

function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function open() {
  return (dbPromise ??= openDb(dbName));
}

export async function useDatabase(userId) {
  const name = userId ? `bakar-${userId}` : LEGACY_DB;
  if (name === dbName && dbPromise) return;
  if (dbPromise) (await dbPromise).close();
  dbName = name;
  dbPromise = null;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  put: (store, obj) => tx(store, 'readwrite', (s) => s.put(obj)),
  del: (store, id) => tx(store, 'readwrite', (s) => s.delete(id)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  async getKV(key, fallback) {
    const row = await this.get('kv', key);
    return row ? row.value : fallback;
  },
  setKV: (key, value) => db.put('kv', { key, value }),
};

// נתונים שנשמרו במכשיר לפני שהיה חיבור לענן (גרסה ללא התחברות) — מועברים פעם אחת לחשבון הראשון שמתחבר
export async function takeLegacyData() {
  if (!indexedDB.databases) return null;
  const list = await indexedDB.databases();
  if (!list.some((d) => d.name === LEGACY_DB)) return null;
  const legacy = await openDb(LEGACY_DB);
  const read = (store) =>
    new Promise((res, rej) => {
      const r = legacy.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const data = { sites: await read('sites'), reports: await read('reports'), kv: await read('kv') };
  legacy.close();
  if (!data.sites.length && !data.reports.length) return null;
  return data;
}
export const dropLegacyData = () => new Promise((res) => {
  const r = indexedDB.deleteDatabase(LEGACY_DB);
  r.onsuccess = r.onerror = r.onblocked = () => res();
});

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function exportBackup() {
  return {
    app: 'bakar',
    version: 1,
    exportedAt: new Date().toISOString(),
    sites: await db.all('sites'),
    reports: await db.all('reports'),
    kv: await db.all('kv'),
  };
}

export function parseBackup(data) {
  if (!data || data.app !== 'bakar') throw new Error('קובץ גיבוי לא תקין');
  return data;
}
