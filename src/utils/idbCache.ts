const KV_DB_NAME = 'pitstop_kv_cache_v1';
const KV_DB_VERSION = 1;
const KV_STORE = 'kv';

let sharedDbPromise: Promise<IDBDatabase> | null = null;

function openKvDb(): Promise<IDBDatabase> {
  if (sharedDbPromise) return sharedDbPromise;
  sharedDbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = window.indexedDB.open(KV_DB_NAME, KV_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        sharedDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      sharedDbPromise = null;
      reject(req.error ?? new Error('Failed to open KV IndexedDB'));
    };
  });
  return sharedDbPromise;
}

export async function idbKvGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openKvDb();
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function idbKvSet<T>(key: string, value: T): Promise<boolean> {
  try {
    const db = await openKvDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const req = tx.objectStore(KV_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbKvDelete(key: string): Promise<void> {
  try {
    const db = await openKvDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const req = tx.objectStore(KV_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

export async function idbKvDeleteByPrefix(prefix: string): Promise<void> {
  try {
    const db = await openKvDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      const store = tx.objectStore(KV_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

export async function idbKvEntriesByPrefix<T>(
  prefix: string
): Promise<Array<{ key: string; value: T }>> {
  try {
    const db = await openKvDb();
    return await new Promise((resolve, reject) => {
      const out: Array<{ key: string; value: T }> = [];
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          out.push({ key: cursor.key, value: cursor.value as T });
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
