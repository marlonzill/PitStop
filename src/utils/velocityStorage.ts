import {
  compactRunSamplesPreservingTraps,
  compactVelocitySamples,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
} from './velocityEngine';

const DB_NAME = 'pitstop_velocity_db';
const DB_VERSION = 2;
const STORE_STATE = 'velocity_state';
const STORE_RUN_SAMPLES = 'run_samples';

const KEY_TRACKS = 'tracks_v1';
const KEY_RUNS_LEGACY = 'runs_v1';
const KEY_RUNS_META = 'runs_meta_v2';
const LEGACY_TRACKS_LS_KEY = 'pitstop_velocity_tracks_v1';
const LEGACY_RUNS_LS_KEY = 'pitstop_velocity_runs_v1';
const ACTIVE_TRACK_ID_KEY = 'pitstop_velocity_active_track_id_v1';

const MAX_MEM_SAMPLE_CACHE = 16;
const runSamplesMemCache = new Map<string, VelocitySample[]>();
const persistedSampleSigMap = new Map<string, string>();
let sharedVelocityDbPromise: Promise<IDBDatabase> | null = null;

function rememberRunSamplesInMem(runId: string, samples: VelocitySample[]) {
  if (runSamplesMemCache.has(runId)) {
    runSamplesMemCache.delete(runId);
  }
  runSamplesMemCache.set(runId, samples);
  while (runSamplesMemCache.size > MAX_MEM_SAMPLE_CACHE) {
    const oldestKey = runSamplesMemCache.keys().next().value;
    if (!oldestKey) break;
    runSamplesMemCache.delete(oldestKey);
  }
}

function openVelocityDb(): Promise<IDBDatabase> {
  if (sharedVelocityDbPromise) return sharedVelocityDbPromise;
  sharedVelocityDbPromise = new Promise((resolve, reject) => {
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
      if (!db.objectStoreNames.contains(STORE_RUN_SAMPLES)) {
        db.createObjectStore(STORE_RUN_SAMPLES);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        sharedVelocityDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      sharedVelocityDbPromise = null;
      reject(req.error ?? new Error('Erro ao abrir IndexedDB de Velocidade'));
    };
  });
  return sharedVelocityDbPromise;
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openVelocityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Falha ao ler IndexedDB'));
  });
}

async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openVelocityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Falha ao salvar IndexedDB'));
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openVelocityDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Falha ao remover IndexedDB'));
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

function stripRunToMeta(run: VelocityRun): VelocityRun {
  const count =
    run.samples.length > 0
      ? run.samples.length
      : typeof run.sampleCount === 'number'
        ? run.sampleCount
        : 0;
  return {
    ...run,
    sampleCount: count,
    samples: [],
  };
}

function getRunSampleSig(run: VelocityRun): string {
  return `${run.samples.length}:${run.totalMs}:${run.finishedAtMs}`;
}

export async function loadRunSamplesById(runId: string): Promise<VelocitySample[]> {
  if (!runId) return [];
  const cached = runSamplesMemCache.get(runId);
  if (cached) {
    rememberRunSamplesInMem(runId, cached);
    return cached;
  }
  try {
    const samples = await idbGet<VelocitySample[]>(STORE_RUN_SAMPLES, runId);
    if (Array.isArray(samples)) {
      rememberRunSamplesInMem(runId, samples);
      return samples;
    }
  } catch {
    // ignore IDB read failure
  }
  return [];
}

export async function loadRunsSamplesBatch(
  runIds: string[]
): Promise<Record<string, VelocitySample[]>> {
  const out: Record<string, VelocitySample[]> = {};
  const missingIds: string[] = [];
  for (const id of runIds) {
    if (!id) continue;
    const cached = runSamplesMemCache.get(id);
    if (cached) {
      rememberRunSamplesInMem(id, cached);
      out[id] = cached;
    } else {
      missingIds.push(id);
    }
  }
  if (missingIds.length === 0) return out;

  try {
    const db = await openVelocityDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_RUN_SAMPLES, 'readonly');
      const store = tx.objectStore(STORE_RUN_SAMPLES);
      let pending = missingIds.length;
      for (const id of missingIds) {
        const req = store.get(id);
        req.onsuccess = () => {
          const val = req.result;
          if (Array.isArray(val)) {
            rememberRunSamplesInMem(id, val);
            out[id] = val;
          } else {
            out[id] = [];
          }
          pending -= 1;
          if (pending === 0) resolve();
        };
        req.onerror = () => {
          out[id] = [];
          pending -= 1;
          if (pending === 0) resolve();
        };
      }
    });
  } catch {
    for (const id of missingIds) {
      out[id] = [];
    }
  }
  return out;
}

export async function hydrateTrackRuns(
  trackId: string,
  runs: VelocityRun[]
): Promise<VelocityRun[]> {
  const targetIds = runs
    .filter(
      (r) =>
        r.trackId === trackId &&
        r.samples.length === 0 &&
        (typeof r.sampleCount !== 'number' || r.sampleCount > 0)
    )
    .map((r) => r.id);
  if (targetIds.length === 0) return runs;

  const batch = await loadRunsSamplesBatch(targetIds);
  let changed = false;
  const next = runs.map((r) => {
    const loaded = batch[r.id];
    if (loaded && loaded.length > 0 && r.samples.length === 0) {
      changed = true;
      return { ...r, samples: loaded, sampleCount: loaded.length };
    }
    return r;
  });
  return changed ? next : runs;
}

export async function deleteRunSamples(runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  for (const id of runIds) {
    runSamplesMemCache.delete(id);
    persistedSampleSigMap.delete(id);
  }
  try {
    const db = await openVelocityDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_RUN_SAMPLES, 'readwrite');
      const store = tx.objectStore(STORE_RUN_SAMPLES);
      for (const id of runIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}

export async function loadVelocityDatabase(): Promise<{
  tracks: VelocityTrack[];
  runs: VelocityRun[];
}> {
  try {
    const [storedTracks, storedMetaRuns] = await Promise.all([
      idbGet<VelocityTrack[]>(STORE_STATE, KEY_TRACKS),
      idbGet<VelocityRun[]>(STORE_STATE, KEY_RUNS_META),
    ]);

    let tracks: VelocityTrack[] = Array.isArray(storedTracks) ? storedTracks : [];
    let metaRuns: VelocityRun[] | null = Array.isArray(storedMetaRuns) ? storedMetaRuns : null;

    // Migrate from legacy runs_v1 in IndexedDB or legacy localStorage keys transparently
    if (!metaRuns) {
      const legacyIdbRuns = await idbGet<VelocityRun[]>(STORE_STATE, KEY_RUNS_LEGACY);
      const legacyLsTracks = loadLegacyLocalStorage<VelocityTrack>(LEGACY_TRACKS_LS_KEY);
      const legacyLsRuns = loadLegacyLocalStorage<VelocityRun>(LEGACY_RUNS_LS_KEY);

      if (tracks.length === 0 && legacyLsTracks.length > 0) {
        tracks = legacyLsTracks.map((tr) =>
          tr.baseTrace && tr.baseTrace.length >= 12
            ? { ...tr, baseTrace: compactVelocitySamples(tr.baseTrace, 1.5) }
            : tr
        );
        await idbSet(STORE_STATE, KEY_TRACKS, tracks);
      }

      const sourceLegacyRuns =
        Array.isArray(legacyIdbRuns) && legacyIdbRuns.length > 0 ? legacyIdbRuns : legacyLsRuns;

      if (sourceLegacyRuns.length > 0) {
        const db = await openVelocityDb();
        const compactedList: VelocityRun[] = sourceLegacyRuns.slice(0, 60).map((r) => {
          const compacted = compactRunSamplesPreservingTraps(
            Array.isArray(r.samples) ? r.samples : [],
            r.splitTimesMs,
            1.5
          );
          rememberRunSamplesInMem(r.id, compacted);
          const nextRun: VelocityRun = {
            ...r,
            samples: compacted,
            sampleCount: compacted.length,
          };
          persistedSampleSigMap.set(r.id, getRunSampleSig(nextRun));
          return nextRun;
        });

        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_STATE, STORE_RUN_SAMPLES], 'readwrite');
          const stateStore = tx.objectStore(STORE_STATE);
          const sampleStore = tx.objectStore(STORE_RUN_SAMPLES);
          for (const run of compactedList) {
            sampleStore.put(run.samples, run.id);
          }
          stateStore.put(compactedList.map(stripRunToMeta), KEY_RUNS_META);
          stateStore.delete(KEY_RUNS_LEGACY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        metaRuns = compactedList.map(stripRunToMeta);
      } else {
        metaRuns = [];
      }

      try {
        window.localStorage.removeItem(LEGACY_TRACKS_LS_KEY);
        window.localStorage.removeItem(LEGACY_RUNS_LS_KEY);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Hydrate bestRun + lastRun for the active track immediately so predictive delta & map work at once
    const activeTrackId = loadActiveVelocityTrackId() ?? tracks[0]?.id ?? null;
    if (activeTrackId && metaRuns.length > 0) {
      const trackRuns = metaRuns
        .filter((r) => r.trackId === activeTrackId)
        .sort((a, b) => a.startedAtMs - b.startedAtMs);
      const best = [...trackRuns]
        .filter((r) => r.totalMs > 0)
        .sort((a, b) => a.totalMs - b.totalMs)[0];
      const last = trackRuns[trackRuns.length - 1];
      const idsToHydrate = Array.from(
        new Set([best?.id, last?.id].filter((x): x is string => Boolean(x)))
      );
      if (idsToHydrate.length > 0) {
        const samplesMap = await loadRunsSamplesBatch(idsToHydrate);
        metaRuns = metaRuns.map((r) => {
          const loaded = samplesMap[r.id];
          if (loaded && loaded.length > 0) {
            return { ...r, samples: loaded, sampleCount: loaded.length };
          }
          return r;
        });
      }
    }

    return { tracks, runs: metaRuns };
  } catch {
    return {
      tracks: loadLegacyLocalStorage<VelocityTrack>(LEGACY_TRACKS_LS_KEY),
      runs: loadLegacyLocalStorage<VelocityRun>(LEGACY_RUNS_LS_KEY),
    };
  }
}

export async function persistVelocityTracks(tracks: VelocityTrack[]): Promise<void> {
  const compacted = tracks.map((t) =>
    t.baseTrace && t.baseTrace.length >= 16
      ? { ...t, baseTrace: compactVelocitySamples(t.baseTrace, 1.5) }
      : t
  );
  try {
    await idbSet(STORE_STATE, KEY_TRACKS, compacted);
  } catch {
    try {
      window.localStorage.setItem(LEGACY_TRACKS_LS_KEY, JSON.stringify(compacted));
    } catch {
      // Ignore quota errors
    }
  }
}

export async function persistVelocityRuns(runs: VelocityRun[]): Promise<void> {
  const capped = runs.slice(0, 60);
  try {
    const db = await openVelocityDb();
    const toWriteSamples: Array<{ id: string; samples: VelocitySample[] }> = [];
    const metaList: VelocityRun[] = capped.map((r) => {
      if (r.samples.length > 0) {
        const compacted = compactRunSamplesPreservingTraps(r.samples, r.splitTimesMs, 1.5);
        rememberRunSamplesInMem(r.id, compacted);
        const sig = `${compacted.length}:${r.totalMs}:${r.finishedAtMs}`;
        if (persistedSampleSigMap.get(r.id) !== sig) {
          persistedSampleSigMap.set(r.id, sig);
          toWriteSamples.push({ id: r.id, samples: compacted });
        }
        return {
          ...r,
          sampleCount: compacted.length,
          samples: [],
        };
      }
      return stripRunToMeta(r);
    });

    const keepIds = new Set(capped.map((r) => r.id));

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_STATE, STORE_RUN_SAMPLES], 'readwrite');
      const stateStore = tx.objectStore(STORE_STATE);
      const sampleStore = tx.objectStore(STORE_RUN_SAMPLES);
      for (const item of toWriteSamples) {
        sampleStore.put(item.samples, item.id);
      }
      stateStore.put(metaList, KEY_RUNS_META);
      const keysReq = sampleStore.getAllKeys();
      keysReq.onsuccess = () => {
        const existingKeys = keysReq.result as IDBValidKey[];
        for (const k of existingKeys) {
          if (typeof k === 'string' && !keepIds.has(k)) {
            sampleStore.delete(k);
            runSamplesMemCache.delete(k);
            persistedSampleSigMap.delete(k);
          }
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Ensure unused old key is cleared if ever leftover
    void idbDelete(STORE_STATE, KEY_RUNS_LEGACY).catch(() => {});
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
