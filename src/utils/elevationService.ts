import type { VelocitySample } from './velocityEngine';
import { idbKvDeleteByPrefix, idbKvEntriesByPrefix, idbKvSet } from './idbCache';

const ELEV_CACHE_PREFIX = 'pitstop_elev_cache_v1_';
const DEM_GRID_PREFIX = 'pitstop_dem_grid_v1_';
const memoryElevationCache = new Map<string, number[]>();

export interface DemGridData {
  folderKey: string;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  rows: number;
  cols: number;
  elevations: number[];
  cachedAtMs: number;
}

const memoryDemGridCache = new Map<string, DemGridData>();

export type ElevationSourceKind = 'open-meteo' | 'cache' | 'kml' | 'synthetic';

let elevationHydrationPromise: Promise<void> | null = null;

function ensureElevationCacheHydrated(): Promise<void> {
  if (elevationHydrationPromise) return elevationHydrationPromise;
  elevationHydrationPromise = (async () => {
    try {
      const [elevEntries, demEntries] = await Promise.all([
        idbKvEntriesByPrefix<number[]>(ELEV_CACHE_PREFIX),
        idbKvEntriesByPrefix<DemGridData>(DEM_GRID_PREFIX),
      ]);
      for (const { key, value } of elevEntries) {
        const cacheKey = key.slice(ELEV_CACHE_PREFIX.length);
        if (Array.isArray(value) && value.length >= 2 && !memoryElevationCache.has(cacheKey)) {
          memoryElevationCache.set(cacheKey, value);
        }
      }
      for (const { key, value } of demEntries) {
        const folderKey = key.slice(DEM_GRID_PREFIX.length);
        if (
          value &&
          typeof value.rows === 'number' &&
          Array.isArray(value.elevations) &&
          !memoryDemGridCache.has(folderKey)
        ) {
          memoryDemGridCache.set(folderKey, value);
        }
      }

      // Silent one-time migration from legacy localStorage entries into IndexedDB
      if (typeof localStorage !== 'undefined') {
        const legacyElevKeys: string[] = [];
        const legacyDemKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (k.startsWith(ELEV_CACHE_PREFIX)) legacyElevKeys.push(k);
          else if (k.startsWith(DEM_GRID_PREFIX)) legacyDemKeys.push(k);
        }

        for (const k of legacyElevKeys) {
          try {
            const cacheKey = k.slice(ELEV_CACHE_PREFIX.length);
            const raw = localStorage.getItem(k);
            if (raw) {
              const parsed = JSON.parse(raw) as unknown;
              if (
                Array.isArray(parsed) &&
                parsed.length >= 2 &&
                parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
              ) {
                memoryElevationCache.set(cacheKey, parsed);
                await idbKvSet(k, parsed);
              }
            }
            localStorage.removeItem(k);
          } catch {
            // ignore corrupt legacy entry
          }
        }

        for (const k of legacyDemKeys) {
          try {
            const folderKey = k.slice(DEM_GRID_PREFIX.length);
            const raw = localStorage.getItem(k);
            if (raw) {
              const parsed = JSON.parse(raw) as Partial<DemGridData>;
              if (
                parsed &&
                typeof parsed.minLat === 'number' &&
                typeof parsed.maxLat === 'number' &&
                typeof parsed.minLon === 'number' &&
                typeof parsed.maxLon === 'number' &&
                typeof parsed.rows === 'number' &&
                typeof parsed.cols === 'number' &&
                Array.isArray(parsed.elevations) &&
                parsed.elevations.length === parsed.rows * parsed.cols
              ) {
                const grid = parsed as DemGridData;
                memoryDemGridCache.set(folderKey, grid);
                await idbKvSet(k, grid);
              }
            }
            localStorage.removeItem(k);
          } catch {
            // ignore corrupt legacy entry
          }
        }
      }
    } catch {
      // ignore hydration errors
    }
  })();
  return elevationHydrationPromise;
}

if (typeof window !== 'undefined') {
  void ensureElevationCacheHydrated();
}

export function getElevationCacheEstimatedBytes(): number {
  let bytes = 0;
  memoryElevationCache.forEach((arr) => {
    bytes += arr.length * 8 + 64;
  });
  memoryDemGridCache.forEach((grid) => {
    bytes += grid.elevations.length * 8 + 256;
  });
  return bytes;
}

function buildCoordFingerprint(samples: VelocitySample[]): string {
  if (samples.length === 0) return 'empty';
  const first = samples[0];
  const mid = Math.floor(samples.length / 2);
  const midPt = samples[mid];
  const last = samples[samples.length - 1];
  return [
    samples.length,
    first.lat.toFixed(4),
    first.lon.toFixed(4),
    midPt.lat.toFixed(4),
    midPt.lon.toFixed(4),
    last.lat.toFixed(4),
    last.lon.toFixed(4),
  ].join('_');
}

function hasValidExistingAltitude(samples: VelocitySample[]): boolean {
  let validCount = 0;
  for (const s of samples) {
    if (typeof s.altitudeM === 'number' && Number.isFinite(s.altitudeM) && Math.abs(s.altitudeM) > 0.1) {
      validCount += 1;
    }
  }
  return validCount >= Math.max(2, Math.floor(samples.length * 0.5));
}

function loadCachedElevations(cacheKey: string): number[] | null {
  const mem = memoryElevationCache.get(cacheKey);
  if (mem && mem.length >= 2) return mem;
  try {
    const raw = localStorage.getItem(ELEV_CACHE_PREFIX + cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      memoryElevationCache.set(cacheKey, parsed);
      void idbKvSet(ELEV_CACHE_PREFIX + cacheKey, parsed);
      localStorage.removeItem(ELEV_CACHE_PREFIX + cacheKey);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedElevations(cacheKey: string, altitudes: number[]): void {
  memoryElevationCache.set(cacheKey, altitudes);
  void idbKvSet(ELEV_CACHE_PREFIX + cacheKey, altitudes);
}

function loadAllDemGrids(): DemGridData[] {
  const out: DemGridData[] = [];
  const seen = new Set<string>();
  memoryDemGridCache.forEach((grid, key) => {
    seen.add(key);
    out.push(grid);
  });
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DEM_GRID_PREFIX)) continue;
      const folderKey = k.slice(DEM_GRID_PREFIX.length);
      if (seen.has(folderKey)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<DemGridData>;
      if (
        parsed &&
        typeof parsed.minLat === 'number' &&
        typeof parsed.maxLat === 'number' &&
        typeof parsed.minLon === 'number' &&
        typeof parsed.maxLon === 'number' &&
        typeof parsed.rows === 'number' &&
        typeof parsed.cols === 'number' &&
        Array.isArray(parsed.elevations) &&
        parsed.elevations.length === parsed.rows * parsed.cols
      ) {
        const grid = parsed as DemGridData;
        memoryDemGridCache.set(folderKey, grid);
        out.push(grid);
      }
    }
  } catch {
    // ignore storage errors
  }
  return out;
}

export function lookupOfflineDemElevation(lat: number, lon: number): number | null {
  const grids = loadAllDemGrids();
  for (const g of grids) {
    if (lat < g.minLat || lat > g.maxLat || lon < g.minLon || lon > g.maxLon) continue;
    const latSpan = Math.max(1e-6, g.maxLat - g.minLat);
    const lonSpan = Math.max(1e-6, g.maxLon - g.minLon);
    const rowF = ((lat - g.minLat) / latSpan) * (g.rows - 1);
    const colF = ((lon - g.minLon) / lonSpan) * (g.cols - 1);
    const r0 = Math.max(0, Math.min(g.rows - 1, Math.floor(rowF)));
    const c0 = Math.max(0, Math.min(g.cols - 1, Math.floor(colF)));
    const r1 = Math.min(g.rows - 1, r0 + 1);
    const c1 = Math.min(g.cols - 1, c0 + 1);
    const dr = rowF - r0;
    const dc = colF - c0;
    const v00 = g.elevations[r0 * g.cols + c0];
    const v01 = g.elevations[r0 * g.cols + c1];
    const v10 = g.elevations[r1 * g.cols + c0];
    const v11 = g.elevations[r1 * g.cols + c1];
    const top = v00 + (v01 - v00) * dc;
    const bot = v10 + (v11 - v10) * dc;
    const alt = top + (bot - top) * dr;
    if (Number.isFinite(alt)) return Number(alt.toFixed(1));
  }
  return null;
}

export async function saveBoundingBoxDemGrid(
  folderKey: string,
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number },
  signal?: AbortSignal
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const rows = 10;
  const cols = 10;
  const lats: string[] = [];
  const lons: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const lat = bounds.minLat + ((bounds.maxLat - bounds.minLat) * r) / (rows - 1);
    for (let c = 0; c < cols; c += 1) {
      const lon = bounds.minLon + ((bounds.maxLon - bounds.minLon) * c) / (cols - 1);
      lats.push(lat.toFixed(5));
      lons.push(lon.toFixed(5));
    }
  }
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.join(',')}&longitude=${lons.join(',')}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { elevation?: unknown };
    if (
      !Array.isArray(data?.elevation) ||
      data.elevation.length !== rows * cols ||
      !data.elevation.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return false;
    }
    const grid: DemGridData = {
      folderKey,
      minLat: bounds.minLat,
      maxLat: bounds.maxLat,
      minLon: bounds.minLon,
      maxLon: bounds.maxLon,
      rows,
      cols,
      elevations: data.elevation.map((v: number) => Number(v.toFixed(1))),
      cachedAtMs: Date.now(),
    };
    memoryDemGridCache.set(folderKey, grid);
    await idbKvSet(DEM_GRID_PREFIX + folderKey, grid);
    return true;
  } catch {
    return false;
  }
}

export function clearAllElevationAndDemCaches(): void {
  memoryElevationCache.clear();
  memoryDemGridCache.clear();
  void idbKvDeleteByPrefix(ELEV_CACHE_PREFIX);
  void idbKvDeleteByPrefix(DEM_GRID_PREFIX);
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(ELEV_CACHE_PREFIX) || k.startsWith(DEM_GRID_PREFIX))) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

function applyInterpolatedAltitudes(
  samples: VelocitySample[],
  sampledIndices: number[],
  sampledAltitudes: number[]
): VelocitySample[] {
  if (samples.length === 0 || sampledIndices.length === 0) return samples;
  let leftPos = 0;
  return samples.map((s, idx) => {
    while (leftPos + 1 < sampledIndices.length && sampledIndices[leftPos + 1] <= idx) {
      leftPos += 1;
    }
    const rightPos = Math.min(sampledIndices.length - 1, leftPos + 1);
    const i0 = sampledIndices[leftPos];
    const i1 = sampledIndices[rightPos];
    const a0 = sampledAltitudes[leftPos];
    const a1 = sampledAltitudes[rightPos];
    const frac = i1 > i0 ? (idx - i0) / (i1 - i0) : 0;
    const interpAlt = Number((a0 + (a1 - a0) * Math.max(0, Math.min(1, frac))).toFixed(1));
    return {
      ...s,
      altitudeM: interpAlt,
    };
  });
}

function pickEvenSampleIndices(length: number, maxPoints = 72): number[] {
  if (length <= 0) return [];
  if (length <= maxPoints) {
    return Array.from({ length }, (_, i) => i);
  }
  const indices: number[] = [];
  for (let k = 0; k < maxPoints; k += 1) {
    const idx = Math.round((k / (maxPoints - 1)) * (length - 1));
    if (indices[indices.length - 1] !== idx) {
      indices.push(idx);
    }
  }
  if (indices[indices.length - 1] !== length - 1) {
    indices.push(length - 1);
  }
  return indices;
}

/**
 * Busca elevação real do terreno via Open-Meteo Elevation API (~30m SRTM/Copernicus DEM)
 * com cache local permanente em IndexedDB (traçado + grade bounding-box) para reutilização 100% offline.
 */
export async function fetchTrackRealElevations(
  trackId: string,
  samples: VelocitySample[],
  signal?: AbortSignal
): Promise<{ samples: VelocitySample[]; source: ElevationSourceKind }> {
  if (samples.length < 2) {
    return { samples, source: 'synthetic' };
  }

  if (hasValidExistingAltitude(samples)) {
    return { samples, source: 'kml' };
  }

  await ensureElevationCacheHydrated();

  const sampledIndices = pickEvenSampleIndices(samples.length, 72);
  const cacheKey = `${trackId}_${buildCoordFingerprint(samples)}`;
  const cached = loadCachedElevations(cacheKey);
  if (cached && cached.length === sampledIndices.length) {
    return {
      samples: applyInterpolatedAltitudes(samples, sampledIndices, cached),
      source: 'cache',
    };
  }

  const tryDemGridFallback = (): { samples: VelocitySample[]; source: ElevationSourceKind } | null => {
    let hits = 0;
    const filled = samples.map((s) => {
      const alt = lookupOfflineDemElevation(s.lat, s.lon);
      if (alt !== null) {
        hits += 1;
        return { ...s, altitudeM: alt };
      }
      return s;
    });
    if (hits >= Math.max(2, Math.floor(samples.length * 0.5))) {
      return { samples: filled, source: 'cache' };
    }
    return null;
  };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return tryDemGridFallback() ?? { samples, source: 'synthetic' };
  }

  try {
    const lats = sampledIndices.map((i) => samples[i].lat.toFixed(5)).join(',');
    const lons = sampledIndices.map((i) => samples[i].lon.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      return tryDemGridFallback() ?? { samples, source: 'synthetic' };
    }
    const data = (await res.json()) as { elevation?: unknown };
    if (
      !Array.isArray(data?.elevation) ||
      data.elevation.length !== sampledIndices.length ||
      !data.elevation.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return tryDemGridFallback() ?? { samples, source: 'synthetic' };
    }

    const altitudes = data.elevation.map((v: number) => Number(v.toFixed(1)));
    saveCachedElevations(cacheKey, altitudes);
    return {
      samples: applyInterpolatedAltitudes(samples, sampledIndices, altitudes),
      source: 'open-meteo',
    };
  } catch {
    return tryDemGridFallback() ?? { samples, source: 'synthetic' };
  }
}

/**
 * Calcula inclinação aproximada (%) em torno de uma distância (km) usando janela de ~45m (busca binária O(log N)).
 */
export function computeTrackSlopePctAtRatio(
  points: Array<{ distKm: number; altitudeM: number }>,
  progressRatio: number
): number {
  if (points.length < 2) return 0;
  const totalKm = Math.max(0.02, points[points.length - 1].distKm);
  const targetKm = Math.max(0, Math.min(1, progressRatio)) * totalKm;
  const halfWinKm = Math.min(0.035, totalKm * 0.15);

  const sampleAltAt = (km: number): number => {
    const clamped = Math.max(0, Math.min(totalKm, km));
    if (clamped <= points[0].distKm) return points[0].altitudeM;
    const lastIdx = points.length - 1;
    if (clamped >= points[lastIdx].distKm) return points[lastIdx].altitudeM;
    let lo = 1;
    let hi = lastIdx;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].distKm < clamped) lo = mid + 1;
      else hi = mid;
    }
    const a = points[lo - 1];
    const b = points[lo];
    const span = Math.max(1e-6, b.distKm - a.distKm);
    const f = (clamped - a.distKm) / span;
    return a.altitudeM + (b.altitudeM - a.altitudeM) * f;
  };

  const k0 = Math.max(0, targetKm - halfWinKm);
  const k1 = Math.min(totalKm, targetKm + halfWinKm);
  const horizM = Math.max(8, (k1 - k0) * 1000);
  const dAlt = sampleAltAt(k1) - sampleAltAt(k0);
  return Math.max(-45, Math.min(45, Math.round((dAlt / horizM) * 100)));
}
