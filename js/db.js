// אחסון מקומי בדפדפן (IndexedDB) — הנתונים לא יוצאים מהמכשיר.
const DB_NAME = 'bakar';
const DB_VERSION = 1;
const STORES = ['sites', 'reports', 'kv'];

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: s === 'kv' ? 'key' : 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
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

export async function importBackup(data) {
  if (!data || data.app !== 'bakar') throw new Error('קובץ גיבוי לא תקין');
  for (const store of STORES) {
    for (const row of data[store] || []) await db.put(store, row);
  }
}
