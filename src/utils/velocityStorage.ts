import type { VelocityRun, VelocityTrack } from './velocityEngine';

const DB_NAME = 'pitstop_velocity_db';
const DB_VERSION = 1;
const STORE_STATE = 'velocity_state';

const KEY_TRACKS = 'tracks_v1';
const KEY_RUNS = 'runs_v1';
const LEGACY_TRACKS_LS_KEY = 'pitstop_velocity_tracks_v1';
const LEGACY_RUNS_LS_KEY = 'pitstop_velocity_runs_v1';
const ACTIVE_TRACK_ID_KEY = 'pitstop_velocity_active_track_id_v1';

function openVelocityDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB indisponível'));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Erro ao abrir IndexedDB de Velocidade'));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openVelocityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, 'readonly');
    const store = tx.objectStore(STORE_STATE);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Falha ao ler IndexedDB'));
    tx.oncomplete = () => db.close();
  });
}

async function idbSet<T>(key: string, value: T): Promise<void> {
  const db = await openVelocityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_STATE, 'readwrite');
    const store = tx.objectStore(STORE_STATE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Falha ao salvar IndexedDB'));
    tx.oncomplete = () => db.close();
  });
}

function loadLegacyLocalStorage<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function loadVelocityDatabase(): Promise<{
  tracks: VelocityTrack[];
  runs: VelocityRun[];
}> {
  try {
    const [storedTracks, storedRuns] = await Promise.all([
      idbGet<VelocityTrack[]>(KEY_TRACKS),
      idbGet<VelocityRun[]>(KEY_RUNS),
    ]);

    if (Array.isArray(storedTracks) || Array.isArray(storedRuns)) {
      return {
        tracks: Array.isArray(storedTracks) ? storedTracks : [],
        runs: Array.isArray(storedRuns) ? storedRuns : [],
      };
    }

    // One-time migration from legacy localStorage keys
    const legacyTracks = loadLegacyLocalStorage<VelocityTrack>(LEGACY_TRACKS_LS_KEY);
    const legacyRuns = loadLegacyLocalStorage<VelocityRun>(LEGACY_RUNS_LS_KEY);
    if (legacyTracks.length > 0 || legacyRuns.length > 0) {
      await Promise.all([
        idbSet(KEY_TRACKS, legacyTracks),
        idbSet(KEY_RUNS, legacyRuns),
      ]);
      try {
        window.localStorage.removeItem(LEGACY_TRACKS_LS_KEY);
        window.localStorage.removeItem(LEGACY_RUNS_LS_KEY);
      } catch {
        // Ignore cleanup errors
      }
    }
    return { tracks: legacyTracks, runs: legacyRuns };
  } catch {
    return {
      tracks: loadLegacyLocalStorage<VelocityTrack>(LEGACY_TRACKS_LS_KEY),
      runs: loadLegacyLocalStorage<VelocityRun>(LEGACY_RUNS_LS_KEY),
    };
  }
}

export async function persistVelocityTracks(tracks: VelocityTrack[]): Promise<void> {
  try {
    await idbSet(KEY_TRACKS, tracks);
  } catch {
    try {
      window.localStorage.setItem(LEGACY_TRACKS_LS_KEY, JSON.stringify(tracks));
    } catch {
      // Ignore quota errors
    }
  }
}

export async function persistVelocityRuns(runs: VelocityRun[]): Promise<void> {
  const capped = runs.slice(0, 60);
  try {
    await idbSet(KEY_RUNS, capped);
  } catch {
    try {
      window.localStorage.setItem(LEGACY_RUNS_LS_KEY, JSON.stringify(capped.slice(0, 20)));
    } catch {
      // Ignore quota errors
    }
  }
}

export function loadActiveVelocityTrackId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_TRACK_ID_KEY);
  } catch {
    return null;
  }
}

export function saveActiveVelocityTrackId(trackId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_TRACK_ID_KEY, trackId);
  } catch {
    // Ignore storage errors
  }
}
