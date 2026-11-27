import type { VelocitySample } from './velocityEngine';

const ELEV_CACHE_PREFIX = 'pitstop_elev_cache_v1_';
const memoryElevationCache = new Map<string, number[]>();

export type ElevationSourceKind = 'open-meteo' | 'cache' | 'kml' | 'synthetic';

function buildCoordFingerprint(samples: VelocitySample[]): string {
  if (samples.length === 0) return 'empty';
  const first = samples[0];
  const mid = samples[Math.floor(samples.length / 2)];
  const last = samples[samples.length - 1];
  return [
    samples.length,
    first.lat.toFixed(4),
    first.lon.toFixed(4),
    mid.lat.toFixed(4),
    mid.lon.toFixed(4),
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
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedElevations(cacheKey: string, altitudes: number[]): void {
  memoryElevationCache.set(cacheKey, altitudes);
  try {
    localStorage.setItem(ELEV_CACHE_PREFIX + cacheKey, JSON.stringify(altitudes));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

function applyInterpolatedAltitudes(
  samples: VelocitySample[],
  sampledIndices: number[],
  sampledAltitudes: number[]
): VelocitySample[] {
  if (samples.length === 0 || sampledIndices.length === 0) return samples;
  return samples.map((s, idx) => {
    let leftPos = 0;
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
 * com cache local permanente para reutilização 100% offline após a primeira consulta.
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

  const sampledIndices = pickEvenSampleIndices(samples.length, 72);
  const cacheKey = `${trackId}_${buildCoordFingerprint(samples)}`;
  const cached = loadCachedElevations(cacheKey);
  if (cached && cached.length === sampledIndices.length) {
    return {
      samples: applyInterpolatedAltitudes(samples, sampledIndices, cached),
      source: 'cache',
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { samples, source: 'synthetic' };
  }

  try {
    const lats = sampledIndices.map((i) => samples[i].lat.toFixed(5)).join(',');
    const lons = sampledIndices.map((i) => samples[i].lon.toFixed(5)).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      return { samples, source: 'synthetic' };
    }
    const data = (await res.json()) as { elevation?: unknown };
    if (
      !Array.isArray(data?.elevation) ||
      data.elevation.length !== sampledIndices.length ||
      !data.elevation.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return { samples, source: 'synthetic' };
    }

    const altitudes = data.elevation.map((v: number) => Number(v.toFixed(1)));
    saveCachedElevations(cacheKey, altitudes);
    return {
      samples: applyInterpolatedAltitudes(samples, sampledIndices, altitudes),
      source: 'open-meteo',
    };
  } catch {
    return { samples, source: 'synthetic' };
  }
}

/**
 * Calcula inclinação aproximada (%) em torno de uma distância (km) usando janela de ~45m.
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
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].distKm >= clamped) {
        const a = points[i - 1];
        const b = points[i];
        const span = Math.max(1e-6, b.distKm - a.distKm);
        const f = (clamped - a.distKm) / span;
        return a.altitudeM + (b.altitudeM - a.altitudeM) * f;
      }
    }
    return points[points.length - 1].altitudeM;
  };

  const k0 = Math.max(0, targetKm - halfWinKm);
  const k1 = Math.min(totalKm, targetKm + halfWinKm);
  const horizM = Math.max(8, (k1 - k0) * 1000);
  const dAlt = sampleAltAt(k1) - sampleAltAt(k0);
  return Math.max(-45, Math.min(45, Math.round((dAlt / horizM) * 100)));
}
