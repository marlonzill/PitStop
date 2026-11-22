import JSZip from 'jszip';
import * as turf from '@turf/turf';

export type TrapKind = 'start' | 'split' | 'finish' | 'start_finish';
export type TrackMode = 'point-to-point' | 'circuit';

export interface VelocityTrap {
  id: string;
  name: string;
  kind: TrapKind;
  lat: number;
  lon: number;
  bearingDeg: number; // 0..360 direction of travel perpendicular to the gate line
  widthM: number; // Configurable gate width in meters (default 25m)
  unidirectional?: boolean; // Default true (accepts crossing within < 60 deg of bearingDeg)
}

export interface VelocitySample {
  lat: number;
  lon: number;
  speedKmh: number;
  accuracyM: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  timestampMs: number;
  distKm: number;
  stageElapsedMs: number;
  accelLongG?: number | null;
  accelLatG?: number | null;
}

export interface VelocityRun {
  id: string;
  trackId: string;
  runNumber: number;
  startedAtMs: number;
  finishedAtMs: number;
  totalMs: number;
  splitTimesMs: Record<string, number>; // trapId -> elapsed ms from Start
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  distanceKm: number;
  samples: VelocitySample[];
}

export interface VelocityTrack {
  id: string;
  name: string;
  mode: TrackMode;
  traps: VelocityTrap[];
  createdAtMs: number;
  referenceDistanceKm: number;
  baseTrace?: VelocitySample[];
}

export interface SectorOptimalEntry {
  sectorIndex: number;
  label: string;
  fromTrapId: string;
  toTrapId: string;
  bestMs: number | null;
  bestRunNumber: number | null;
}

export interface OptimalStageSummary {
  optimalTotalMs: number | null;
  bestRunTotalMs: number | null;
  bestRunId: string | null;
  lastRunTotalMs: number | null;
  sectors: SectorOptimalEntry[];
}

export interface TrapCrossingResult {
  crossed: boolean;
  t: number; // 0..1 interpolation factor between prev and curr
  crossTimestampMs: number;
  lateralOffsetM: number;
  headingDiffDeg: number;
}

const TRACKS_STORAGE_KEY = 'pitstop_velocity_tracks_v1';
const RUNS_STORAGE_KEY = 'pitstop_velocity_runs_v1';

export function haversineMetersVel(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function bearingBetweenDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Math.round(deg);
}

export interface MarcoGpsPonto {
  lat: number;
  lng: number;
  timestamp: number;
}

export interface MarcoDef {
  lat: number;
  lng: number;
  angulo: number; // 0..360°
  larguraM: number; // padrão 25m
  unidirecional?: boolean; // padrão true
}

export interface CruzamentoMarcoResult {
  cruzou: boolean;
  timestampCruzamento: number;
  fatorInterpolacao: number;
  pontoIntersecao: [number, number]; // [lng, lat]
  diferencaAngularDeg: number;
}

export function normalizeAngle360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

export function angleDiffDeg(a: number, b: number): number {
  const diff = ((normalizeAngle360(a) - normalizeAngle360(b) + 540) % 360) - 180;
  return Math.abs(diff);
}

/**
 * Constroi o segmento transversal LineString([P1, P2]) do Marco em metros via @turf/turf
 * com P1 em (angulo - 90°) e P2 em (angulo + 90°) a largura/2 de distância do centro.
 */
export function buildMarcoGateLineString(
  lat: number,
  lng: number,
  anguloDeg: number,
  larguraM = 25
) {
  const halfWidth = Math.max(2, Number.isFinite(larguraM) ? larguraM : 25) / 2;
  const center = turf.point([lng, lat]);
  const p1 = turf.destination(center, halfWidth, anguloDeg - 90, { units: 'meters' });
  const p2 = turf.destination(center, halfWidth, anguloDeg + 90, { units: 'meters' });
  return turf.lineString([p1.geometry.coordinates, p2.geometry.coordinates]);
}

/**
 * Constroi a haste e a ponta da seta perpendicular apontando para `anguloDeg` a partir do centro.
 */
export function buildMarcoArrowGeometry(
  lat: number,
  lng: number,
  anguloDeg: number,
  larguraM = 25
) {
  const safeWidth = Math.max(5, Number.isFinite(larguraM) ? larguraM : 25);
  const arrowLen = Math.max(14, safeWidth * 0.72);
  const barbLen = Math.max(5, safeWidth * 0.24);
  const center = turf.point([lng, lat]);
  const tip = turf.destination(center, arrowLen, anguloDeg, { units: 'meters' });
  const leftWing = turf.destination(tip, barbLen, anguloDeg + 142, { units: 'meters' });
  const rightWing = turf.destination(tip, barbLen, anguloDeg - 142, { units: 'meters' });

  return {
    shaftCoords: [center.geometry.coordinates, tip.geometry.coordinates] as [
      [number, number],
      [number, number],
    ],
    headCoords: [
      leftWing.geometry.coordinates,
      tip.geometry.coordinates,
      rightWing.geometry.coordinates,
    ] as [[number, number], [number, number], [number, number]],
  };
}

/**
 * Motor de Detecção de Cruzamento estilo RaceChrono usando @turf/turf:
 * - Cria segmento de deslocamento LineString([pontoAnterior, pontoAtual])
 * - Verifica interseção com o portão transversal via turf.lineIntersect()
 * - Valida direção (< 60° em relação a marco.angulo) quando unidirecional === true
 * - Interpola timestamp exato (ms) usando d1 / dTotal
 */
export function verificarCruzamento(
  pontoAnterior: MarcoGpsPonto,
  pontoAtual: MarcoGpsPonto,
  marco: MarcoDef
): CruzamentoMarcoResult | null {
  if (
    !Number.isFinite(pontoAnterior.lat) ||
    !Number.isFinite(pontoAnterior.lng) ||
    !Number.isFinite(pontoAtual.lat) ||
    !Number.isFinite(pontoAtual.lng)
  ) {
    return null;
  }
  if (pontoAnterior.lat === pontoAtual.lat && pontoAnterior.lng === pontoAtual.lng) {
    return null;
  }

  const ptAnterior = turf.point([pontoAnterior.lng, pontoAnterior.lat]);
  const ptAtual = turf.point([pontoAtual.lng, pontoAtual.lat]);
  const deslocamento = turf.lineString([
    [pontoAnterior.lng, pontoAnterior.lat],
    [pontoAtual.lng, pontoAtual.lat],
  ]);

  const linhaMarco = buildMarcoGateLineString(
    marco.lat,
    marco.lng,
    marco.angulo,
    marco.larguraM
  );

  const intersecoes = turf.lineIntersect(deslocamento, linhaMarco);
  if (!intersecoes.features.length) {
    return null;
  }

  const rumoVeiculo = normalizeAngle360(turf.bearing(ptAnterior, ptAtual));
  const anguloMarco = normalizeAngle360(marco.angulo);
  const diferencaAngularDeg = angleDiffDeg(rumoVeiculo, anguloMarco);

  if (marco.unidirecional !== false && diferencaAngularDeg >= 60) {
    return null;
  }

  let closestFeature = intersecoes.features[0];
  let d1 = turf.distance(ptAnterior, closestFeature, { units: 'meters' });
  for (let i = 1; i < intersecoes.features.length; i += 1) {
    const cand = intersecoes.features[i];
    const candDist = turf.distance(ptAnterior, cand, { units: 'meters' });
    if (candDist < d1) {
      d1 = candDist;
      closestFeature = cand;
    }
  }

  const dTotal = turf.distance(ptAnterior, ptAtual, { units: 'meters' });
  const fatorInterpolacao =
    dTotal > 1e-6 ? Math.max(0, Math.min(1, d1 / dTotal)) : 0;
  const timestampCruzamento = Math.round(
    pontoAnterior.timestamp +
      fatorInterpolacao * (pontoAtual.timestamp - pontoAnterior.timestamp)
  );

  const coords = closestFeature.geometry.coordinates;
  return {
    cruzou: true,
    timestampCruzamento,
    fatorInterpolacao,
    pontoIntersecao: [coords[0], coords[1]],
    diferencaAngularDeg,
  };
}

/**
 * Vector segment intersection between vehicle movement (prev -> curr)
 * and a virtual Trap gate centered at (trap.lat, trap.lon) with perpendicular width `trap.widthM`
 * and travel direction `trap.bearingDeg`, powered by `@turf/turf`.
 */
export function detectTrapCrossing(
  prev: { lat: number; lon: number; timestampMs: number },
  curr: { lat: number; lon: number; timestampMs: number },
  trap: VelocityTrap,
  options?: { hdopAccuracyM?: number | null; autoSnap?: boolean }
): TrapCrossingResult | null {
  const acc = options?.hdopAccuracyM;
  const hdopBonus =
    options?.autoSnap !== false && typeof acc === 'number' && Number.isFinite(acc) && acc > 6
      ? Math.min(22, (acc - 6) * 0.65)
      : 0;
  const effectiveWidthM = Math.max(8, (Number(trap.widthM) || 25) + hdopBonus);

  const res = verificarCruzamento(
    { lat: prev.lat, lng: prev.lon, timestamp: prev.timestampMs },
    { lat: curr.lat, lng: curr.lon, timestamp: curr.timestampMs },
    {
      lat: trap.lat,
      lng: trap.lon,
      angulo: trap.bearingDeg,
      larguraM: effectiveWidthM,
      unidirecional: trap.unidirectional !== false,
    }
  );
  if (!res) return null;

  const lateralOffsetM = turf.distance(
    turf.point([trap.lon, trap.lat]),
    turf.point(res.pontoIntersecao),
    { units: 'meters' }
  );

  return {
    crossed: true,
    t: res.fatorInterpolacao,
    crossTimestampMs: res.timestampCruzamento,
    lateralOffsetM,
    headingDiffDeg: res.diferencaAngularDeg,
  };
}

/**
 * Predictive Time Delta (Time Delta in seconds) comparing current distance & elapsed ms
 * against the reference best run saved on the same Special Stage.
 * Negative = faster than best (Green); Positive = slower than best (Red).
 */
export function computePredictiveDeltaSec(
  currentDistKm: number,
  currentElapsedMs: number,
  bestRun: VelocityRun | null
): number | null {
  if (!bestRun || bestRun.samples.length < 2) return null;
  const samples = bestRun.samples;
  if (currentDistKm <= 0.005) return 0;

  // Binary / linear search by distKm on reference trace
  for (let i = 1; i < samples.length; i += 1) {
    const s0 = samples[i - 1];
    const s1 = samples[i];
    if (currentDistKm <= s1.distKm) {
      const spanKm = s1.distKm - s0.distKm;
      const frac = spanKm > 1e-6 ? Math.max(0, Math.min(1, (currentDistKm - s0.distKm) / spanKm)) : 0;
      const refElapsedAtDist = s0.stageElapsedMs + frac * (s1.stageElapsedMs - s0.stageElapsedMs);
      return (currentElapsedMs - refElapsedAtDist) / 1000;
    }
  }

  const last = samples[samples.length - 1];
  return (currentElapsedMs - last.stageElapsedMs) / 1000;
}

export function getOrderedTrackTraps(track: VelocityTrack): VelocityTrap[] {
  const start = track.traps.filter((t) => t.kind === 'start' || t.kind === 'start_finish');
  const splits = track.traps.filter((t) => t.kind === 'split');
  const finish = track.traps.filter((t) => t.kind === 'finish');
  return [...start, ...splits, ...finish];
}

export function recalculateRunsForTrack(
  track: VelocityTrack,
  runs: VelocityRun[]
): VelocityRun[] {
  const ordered = getOrderedTrackTraps(track);
  const startTrap = ordered.find((t) => t.kind === 'start' || t.kind === 'start_finish');
  const finishTrap =
    ordered.find((t) => t.kind === 'finish') ??
    (startTrap?.kind === 'start_finish' ? startTrap : undefined);

  if (!startTrap || !finishTrap) return runs;

  return runs.map((run) => {
    if (run.trackId !== track.id || run.samples.length < 2) return run;

    let startMs: number | null = null;
    let finishMs: number | null = null;
    const splits: Record<string, number> = {};

    for (let i = 1; i < run.samples.length; i += 1) {
      const prev = run.samples[i - 1];
      const curr = run.samples[i];

      if (startMs === null) {
        const startHit = detectTrapCrossing(prev, curr, startTrap);
        if (startHit) {
          startMs = startHit.crossTimestampMs;
          continue;
        }
      }

      if (startMs === null) continue;

      for (const sp of ordered) {
        if (sp.kind !== 'split' || splits[sp.id] !== undefined) continue;
        const spHit = detectTrapCrossing(prev, curr, sp);
        if (spHit && spHit.crossTimestampMs >= startMs) {
          splits[sp.id] = spHit.crossTimestampMs - startMs;
        }
      }

      const finHit = detectTrapCrossing(prev, curr, finishTrap);
      const minLapMs = finishTrap.id === startTrap.id ? 6000 : 100;
      if (finHit && finHit.crossTimestampMs - startMs >= minLapMs) {
        finishMs = finHit.crossTimestampMs;
        splits[finishTrap.id] = finishMs - startMs;
        break;
      }
    }

    // Fallback: if run already started from index 0 and crosses Splits/Finish
    if (startMs === null && run.samples.length >= 2) {
      const fallbackStart = run.samples[0].timestampMs;
      for (let i = 1; i < run.samples.length; i += 1) {
        const prev = run.samples[i - 1];
        const curr = run.samples[i];
        for (const sp of ordered) {
          if (sp.kind !== 'split' || splits[sp.id] !== undefined) continue;
          const spHit = detectTrapCrossing(prev, curr, sp);
          if (spHit && spHit.crossTimestampMs >= fallbackStart) {
            splits[sp.id] = spHit.crossTimestampMs - fallbackStart;
          }
        }
        const finHit = detectTrapCrossing(prev, curr, finishTrap);
        if (finHit && finHit.crossTimestampMs - fallbackStart >= 1000) {
          startMs = fallbackStart;
          finishMs = finHit.crossTimestampMs;
          splits[finishTrap.id] = finishMs - startMs;
          break;
        }
      }
    }

    if (startMs !== null && finishMs !== null && finishMs > startMs) {
      return {
        ...run,
        startedAtMs: startMs,
        finishedAtMs: finishMs,
        totalMs: finishMs - startMs,
        splitTimesMs: splits,
      };
    }

    return run;
  });
}

export function computeOptimalStage(
  track: VelocityTrack,
  runs: VelocityRun[]
): OptimalStageSummary {
  const trackRuns = runs
    .filter((r) => r.trackId === track.id && r.totalMs > 0)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  if (trackRuns.length === 0) {
    return {
      optimalTotalMs: null,
      bestRunTotalMs: null,
      bestRunId: null,
      lastRunTotalMs: null,
      sectors: [],
    };
  }

  const bestRun = [...trackRuns].sort((a, b) => a.totalMs - b.totalMs)[0];
  const lastRun = trackRuns[trackRuns.length - 1];

  const ordered = getOrderedTrackTraps(track);
  const startTrap = ordered.find((t) => t.kind === 'start' || t.kind === 'start_finish');
  const finishTrap =
    ordered.find((t) => t.kind === 'finish') ??
    (startTrap?.kind === 'start_finish' ? startTrap : undefined);
  const checkpoints = [
    ...ordered.filter((t) => t.kind === 'split' || t.kind === 'finish'),
    ...(finishTrap?.kind === 'start_finish' ? [finishTrap] : []),
  ];

  const sectors: SectorOptimalEntry[] = [];
  if (startTrap && finishTrap && checkpoints.length > 0) {
    let prevTrapId = startTrap.id;
    checkpoints.forEach((cp, idx) => {
      let bestSectorMs: number | null = null;
      let bestSectorRunNum: number | null = null;
      const isFinalCp = cp.kind === 'finish' || cp.kind === 'start_finish';

      for (const r of trackRuns) {
        const endT = isFinalCp
          ? r.splitTimesMs[cp.id] ?? r.totalMs
          : r.splitTimesMs[cp.id];
        const startT = prevTrapId === startTrap.id ? 0 : r.splitTimesMs[prevTrapId];
        if (
          typeof endT === 'number' &&
          typeof startT === 'number' &&
          endT > startT
        ) {
          const dur = endT - startT;
          if (bestSectorMs === null || dur < bestSectorMs) {
            bestSectorMs = dur;
            bestSectorRunNum = r.runNumber;
          }
        }
      }

      sectors.push({
        sectorIndex: idx + 1,
        label: isFinalCp ? `S${idx + 1} (Chegada)` : `S${idx + 1} (${cp.name})`,
        fromTrapId: prevTrapId,
        toTrapId: cp.id,
        bestMs: bestSectorMs,
        bestRunNumber: bestSectorRunNum,
      });

      prevTrapId = cp.id;
    });
  }

  const allSectorsHaveBest = sectors.length > 0 && sectors.every((s) => s.bestMs !== null);
  const optimalTotalMs = allSectorsHaveBest
    ? sectors.reduce((acc, s) => acc + (s.bestMs ?? 0), 0)
    : bestRun.totalMs;

  return {
    optimalTotalMs,
    bestRunTotalMs: bestRun.totalMs,
    bestRunId: bestRun.id,
    lastRunTotalMs: lastRun.totalMs,
    sectors,
  };
}

export function formatStageDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '--:--.-';
  }
  const totalTenths = Math.floor(ms / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  if (hours > 0) {
    return `${hours}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`;
  }
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${tenths}`;
}

export function formatDeltaSeconds(deltaSec: number | null): string {
  if (deltaSec === null || !Number.isFinite(deltaSec)) return '--.-s';
  if (Math.abs(deltaSec) < 0.05) return '0.0s';
  const sign = deltaSec < 0 ? '-' : '+';
  return `${sign}${Math.abs(deltaSec).toFixed(1)}s`;
}

export function loadVelocityTracks(): VelocityTrack[] {
  try {
    const raw = localStorage.getItem(TRACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VelocityTrack[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVelocityTracks(tracks: VelocityTrack[]): void {
  try {
    localStorage.setItem(TRACKS_STORAGE_KEY, JSON.stringify(tracks));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadVelocityRuns(): VelocityRun[] {
  try {
    const raw = localStorage.getItem(RUNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VelocityRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveVelocityRuns(runs: VelocityRun[]): void {
  try {
    // Cap stored raw sample traces per run for storage safety
    localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runs.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

export function exportTrackGeoJson(track: VelocityTrack, trace: VelocitySample[]): string {
  const features: unknown[] = [];

  if (trace.length > 1) {
    features.push({
      type: 'Feature',
      properties: {
        name: track.name,
        mode: track.mode,
        kind: 'route',
      },
      geometry: {
        type: 'LineString',
        coordinates: trace.map((p) => [p.lon, p.lat, p.altitudeM ?? 0]),
      },
    });
  }

  for (const trap of track.traps) {
    features.push({
      type: 'Feature',
      properties: {
        id: trap.id,
        name: trap.name,
        trapKind: trap.kind,
        bearingDeg: trap.bearingDeg,
        widthM: trap.widthM,
        unidirectional: trap.unidirectional !== false,
      },
      geometry: {
        type: 'Point',
        coordinates: [trap.lon, trap.lat],
      },
    });
  }

  return JSON.stringify(
    {
      type: 'FeatureCollection',
      name: track.name,
      features,
    },
    null,
    2
  );
}

export function exportTrackGpx(track: VelocityTrack, trace: VelocitySample[]): string {
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const wpts = track.traps
    .map(
      (t) =>
        `  <wpt lat="${t.lat.toFixed(6)}" lon="${t.lon.toFixed(6)}">\n    <name>${escapeXml(
          t.name
        )}</name>\n    <type>${t.kind}|${t.bearingDeg}|${t.widthM}|${
          t.unidirectional !== false ? 1 : 0
        }</type>\n  </wpt>`
    )
    .join('\n');

  const trkpts = trace
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${(
          p.altitudeM ?? 0
        ).toFixed(1)}</ele><time>${new Date(p.timestampMs).toISOString()}</time></trkpt>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PitStop Sports Velocidade">
  <metadata><name>${escapeXml(track.name)}</name></metadata>
${wpts}
  <trk>
    <name>${escapeXml(track.name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function parseGpxOrGeoJsonToTrack(
  content: string,
  fileName: string
): VelocityTrack {
  const cleanName = fileName.replace(/\.(geojson|json|gpx)$/i, '');
  const traps: VelocityTrap[] = [];
  const baseTrace: VelocitySample[] = [];
  const now = Date.now();

  if (content.trim().startsWith('{')) {
    const parsed = JSON.parse(content) as {
      name?: string;
      features?: Array<{
        properties?: Record<string, unknown>;
        geometry?: { type?: string; coordinates?: unknown };
      }>;
    };
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    for (const f of features) {
      const g = f.geometry;
      const props = f.properties || {};
      if (g?.type === 'LineString' && Array.isArray(g.coordinates)) {
        let accKm = 0;
        g.coordinates.forEach((coord: unknown, idx: number) => {
          if (!Array.isArray(coord) || coord.length < 2) return;
          const lon = Number(coord[0]);
          const lat = Number(coord[1]);
          const alt = coord.length > 2 ? Number(coord[2]) : null;
          if (idx > 0 && baseTrace.length > 0) {
            const prev = baseTrace[baseTrace.length - 1];
            accKm += haversineMetersVel(prev.lat, prev.lon, lat, lon) / 1000;
          }
          baseTrace.push({
            lat,
            lon,
            speedKmh: 0,
            accuracyM: 5,
            headingDeg: null,
            altitudeM: alt,
            timestampMs: now + idx * 1000,
            distKm: accKm,
            stageElapsedMs: idx * 1000,
          });
        });
      } else if (g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
        const lon = Number(g.coordinates[0]);
        const lat = Number(g.coordinates[1]);
        const rawKind = String(props.trapKind || props.kind || 'split');
        const kind: TrapKind =
          rawKind === 'start' || rawKind === 'finish' || rawKind === 'start_finish'
            ? rawKind
            : 'split';
        traps.push({
          id: String(props.id || `trap_${traps.length + 1}_${now}`),
          name: String(props.name || `${kind.toUpperCase()} ${traps.length + 1}`),
          kind,
          lat,
          lon,
          bearingDeg: Number(props.bearingDeg) || 0,
          widthM: Number(props.widthM) || 25,
          unidirectional: props.unidirectional !== false,
        });
      }
    }

    return {
      id: `trk_${now}`,
      name: String(parsed.name || cleanName),
      mode: traps.some((t) => t.kind === 'start_finish') ? 'circuit' : 'point-to-point',
      traps,
      createdAtMs: now,
      referenceDistanceKm:
        baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0,
      baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
    };
  }

  // GPX XML parse via DOMParser
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  let accKm = 0;
  trkpts.forEach((pt, idx) => {
    const lat = Number(pt.getAttribute('lat'));
    const lon = Number(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const ele = Number(pt.querySelector('ele')?.textContent);
    if (idx > 0 && baseTrace.length > 0) {
      const prev = baseTrace[baseTrace.length - 1];
      accKm += haversineMetersVel(prev.lat, prev.lon, lat, lon) / 1000;
    }
    baseTrace.push({
      lat,
      lon,
      speedKmh: 0,
      accuracyM: 5,
      headingDeg: null,
      altitudeM: Number.isFinite(ele) ? ele : null,
      timestampMs: now + idx * 1000,
      distKm: accKm,
      stageElapsedMs: idx * 1000,
    });
  });

  const wpts = Array.from(doc.querySelectorAll('wpt'));
  wpts.forEach((wpt, idx) => {
    const lat = Number(wpt.getAttribute('lat'));
    const lon = Number(wpt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const name = wpt.querySelector('name')?.textContent?.trim() || `Trap ${idx + 1}`;
    const typeParts = (wpt.querySelector('type')?.textContent || '').split('|');
    const rawKind = typeParts[0];
    const kind: TrapKind =
      rawKind === 'start' || rawKind === 'finish' || rawKind === 'start_finish'
        ? rawKind
        : 'split';
    traps.push({
      id: `trap_${idx + 1}_${now}`,
      name,
      kind,
      lat,
      lon,
      bearingDeg: Number(typeParts[1]) || 0,
      widthM: Number(typeParts[2]) || 25,
      unidirectional: typeParts[3] !== '0',
    });
  });

  if (traps.length === 0 && baseTrace.length >= 2) {
    const first = baseTrace[0];
    const second = baseTrace[1];
    const lastPrev = baseTrace[baseTrace.length - 2];
    const last = baseTrace[baseTrace.length - 1];
    traps.push(
      {
        id: `trap_start_${now}`,
        name: 'Largada (Start)',
        kind: 'start',
        lat: first.lat,
        lon: first.lon,
        bearingDeg: bearingBetweenDeg(first.lat, first.lon, second.lat, second.lon),
        widthM: 25,
        unidirectional: true,
      },
      {
        id: `trap_finish_${now}`,
        name: 'Chegada (Finish)',
        kind: 'finish',
        lat: last.lat,
        lon: last.lon,
        bearingDeg: bearingBetweenDeg(lastPrev.lat, lastPrev.lon, last.lat, last.lon),
        widthM: 25,
        unidirectional: true,
      }
    );
  }

  return {
    id: `trk_${now}`,
    name: cleanName,
    mode: 'point-to-point',
    traps,
    createdAtMs: now,
    referenceDistanceKm:
      baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0,
    baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
  };
}

function parseCoordTuples(raw: string): Array<{ lat: number; lon: number; alt: number | null }> {
  const out: Array<{ lat: number; lon: number; alt: number | null }> = [];
  const tokens = raw.trim().split(/\s+/);
  for (const token of tokens) {
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    const alt = parts.length >= 3 && Number.isFinite(Number(parts[2])) ? Number(parts[2]) : null;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0)
    ) {
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.lat - lat) < 1e-7 && Math.abs(prev.lon - lon) < 1e-7) {
      continue;
    }
    out.push({ lat, lon, alt });
  }
  return out;
}

function inferBearingNearTrace(
  lat: number,
  lon: number,
  trace: VelocitySample[],
  fallbackDeg = 0
): number {
  if (trace.length < 2) return fallbackDeg;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < trace.length; i += 1) {
    const d = haversineMetersVel(lat, lon, trace[i].lat, trace[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  const i0 = Math.max(0, bestIdx === trace.length - 1 ? bestIdx - 1 : bestIdx);
  const i1 = Math.min(trace.length - 1, i0 + 1);
  if (i0 === i1) return fallbackDeg;
  return bearingBetweenDeg(trace[i0].lat, trace[i0].lon, trace[i1].lat, trace[i1].lon);
}

/**
 * Parses Google Earth / QGIS / GPS .KML XML into a PitStop-Sports VelocityTrack
 * extracting LineString / gx:Track route coordinates and Point placemarks as Traps.
 */
export function parseKmlToTrack(kmlXml: string, fileName: string): VelocityTrack {
  const cleanName = fileName.replace(/\.(kml|kmz)$/i, '');
  const now = Date.now();
  const doc = new DOMParser().parseFromString(kmlXml, 'application/xml');

  const docName =
    doc.querySelector('Document > name')?.textContent?.trim() ||
    doc.querySelector('Folder > name')?.textContent?.trim() ||
    cleanName;

  // 1. Extract route coordinates from LineString elements (and gx:Track if present)
  const rawRouteCoords: Array<{ lat: number; lon: number; alt: number | null }> = [];
  const lineStrings = Array.from(doc.getElementsByTagName('LineString'));
  for (const ls of lineStrings) {
    const coordEl = ls.getElementsByTagName('coordinates')[0];
    if (coordEl?.textContent) {
      rawRouteCoords.push(...parseCoordTuples(coordEl.textContent));
    }
  }

  // Google Earth gx:coord entries ("lon lat alt")
  if (rawRouteCoords.length === 0) {
    const gxCoords = Array.from(doc.getElementsByTagNameNS('*', 'coord'));
    for (const el of gxCoords) {
      const parts = (el.textContent || '').trim().split(/\s+/);
      if (parts.length < 2) continue;
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      const alt = parts.length >= 3 && Number.isFinite(Number(parts[2])) ? Number(parts[2]) : null;
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        rawRouteCoords.push({ lat, lon, alt });
      }
    }
  }

  const baseTrace: VelocitySample[] = [];
  let accKm = 0;
  rawRouteCoords.forEach((pt, idx) => {
    if (idx > 0) {
      const prev = rawRouteCoords[idx - 1];
      accKm += haversineMetersVel(prev.lat, prev.lon, pt.lat, pt.lon) / 1000;
    }
    const next = rawRouteCoords[Math.min(rawRouteCoords.length - 1, idx + 1)];
    const prev = rawRouteCoords[Math.max(0, idx - 1)];
    baseTrace.push({
      lat: pt.lat,
      lon: pt.lon,
      speedKmh: 0,
      accuracyM: 5,
      headingDeg:
        rawRouteCoords.length > 1
          ? bearingBetweenDeg(prev.lat, prev.lon, next.lat, next.lon)
          : null,
      altitudeM: pt.alt,
      timestampMs: now + idx * 1000,
      distKm: accKm,
      stageElapsedMs: idx * 1000,
    });
  });

  // 2. Extract Point Placemarks as Traps
  const traps: VelocityTrap[] = [];
  const placemarks = Array.from(doc.getElementsByTagName('Placemark'));
  const rawPoints: Array<{ name: string; lat: number; lon: number }> = [];

  for (const pm of placemarks) {
    const ptEl = pm.getElementsByTagName('Point')[0];
    if (!ptEl) continue;
    const coordEl = ptEl.getElementsByTagName('coordinates')[0];
    if (!coordEl?.textContent) continue;
    const tuples = parseCoordTuples(coordEl.textContent);
    if (tuples.length === 0) continue;
    const name =
      pm.getElementsByTagName('name')[0]?.textContent?.trim() ||
      `Ponto ${rawPoints.length + 1}`;
    rawPoints.push({ name, lat: tuples[0].lat, lon: tuples[0].lon });
  }

  rawPoints.forEach((pt, idx) => {
    const lower = pt.name.toLowerCase();
    let kind: TrapKind = 'split';
    if (/\b(largada|start|ini|inicio|início|partida)\b/i.test(lower)) {
      kind = 'start';
    } else if (/\b(chegada|finish|fim|meta)\b/i.test(lower)) {
      kind = 'finish';
    } else if (baseTrace.length === 0 && rawPoints.length >= 2) {
      if (idx === 0) kind = 'start';
      else if (idx === rawPoints.length - 1) kind = 'finish';
    }

    const fallbackBearing =
      idx < rawPoints.length - 1
        ? bearingBetweenDeg(pt.lat, pt.lon, rawPoints[idx + 1].lat, rawPoints[idx + 1].lon)
        : idx > 0
          ? bearingBetweenDeg(rawPoints[idx - 1].lat, rawPoints[idx - 1].lon, pt.lat, pt.lon)
          : 0;

    traps.push({
      id: `trap_kml_${idx + 1}_${now}`,
      name: pt.name,
      kind,
      lat: pt.lat,
      lon: pt.lon,
      bearingDeg: inferBearingNearTrace(pt.lat, pt.lon, baseTrace, fallbackBearing),
      widthM: 35,
    });
  });

  // Auto-add Start and/or Finish from trace endpoints when missing
  if (baseTrace.length >= 2) {
    const hasStart = traps.some((t) => t.kind === 'start');
    const hasFinish = traps.some((t) => t.kind === 'finish');
    if (!hasStart) {
      const first = baseTrace[0];
      const second = baseTrace[1];
      traps.unshift({
        id: `trap_kml_start_${now}`,
        name: 'Largada (Start)',
        kind: 'start',
        lat: first.lat,
        lon: first.lon,
        bearingDeg: bearingBetweenDeg(first.lat, first.lon, second.lat, second.lon),
        widthM: 35,
      });
    }
    if (!hasFinish) {
      const lastPrev = baseTrace[baseTrace.length - 2];
      const last = baseTrace[baseTrace.length - 1];
      traps.push({
        id: `trap_kml_finish_${now}`,
        name: 'Chegada (Finish)',
        kind: 'finish',
        lat: last.lat,
        lon: last.lon,
        bearingDeg: bearingBetweenDeg(lastPrev.lat, lastPrev.lon, last.lat, last.lon),
        widthM: 35,
      });
    }
  }

  if (baseTrace.length === 0 && traps.length === 0) {
    throw new Error('KML sem coordenadas válidas de rota ou pontos.');
  }

  return {
    id: `trk_${now}`,
    name: docName,
    mode: 'point-to-point',
    traps,
    createdAtMs: now,
    referenceDistanceKm:
      baseTrace.length > 0 ? baseTrace[baseTrace.length - 1].distKm : 0,
    baseTrace: baseTrace.length > 0 ? baseTrace : undefined,
  };
}

/**
 * Unified Especial Track Importer supporting .KML, .KMZ, .GPX and .GeoJSON/.JSON
 */
export async function parseTrackFileToTrack(file: File): Promise<VelocityTrack> {
  const MAX_TRACK_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_KMZ_ENTRIES = 500;
  const MAX_KML_XML_BYTES = 25 * 1024 * 1024;

  if (file.size > MAX_TRACK_FILE_BYTES) {
    throw new Error('Arquivo de pista excede o limite máximo de 50 MB.');
  }

  const lowerName = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const looksLikeZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (lowerName.endsWith('.kmz') || looksLikeZip) {
    const zip = await JSZip.loadAsync(buf);
    const allNames = Object.keys(zip.files);
    if (allNames.length > MAX_KMZ_ENTRIES) {
      throw new Error('Arquivo .KMZ excede o limite de entradas internas permitidas.');
    }
    const kmlEntries = allNames.filter(
      (k) => !zip.files[k].dir && k.toLowerCase().endsWith('.kml')
    );
    if (kmlEntries.length === 0) {
      throw new Error('Arquivo .KMZ não contém arquivo .KML interno.');
    }
    const preferred =
      kmlEntries.find((k) => k.toLowerCase().endsWith('doc.kml')) ?? kmlEntries[0];
    const rawKmlBytes = await zip.files[preferred].async('uint8array');
    if (rawKmlBytes.byteLength > MAX_KML_XML_BYTES) {
      throw new Error('Conteúdo KML descompactado excede o limite seguro (25 MB).');
    }
    const kmlText = new TextDecoder('utf-8').decode(rawKmlBytes);
    return parseKmlToTrack(kmlText, file.name);
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  if (lowerName.endsWith('.kml') || /<kml[\s>]/i.test(text)) {
    return parseKmlToTrack(text, file.name);
  }

  return parseGpxOrGeoJsonToTrack(text, file.name);
}

/**
 * Creates a realistic ~1.8km Point-to-Point Special Stage (Serra da Graciosa demo)
 * with Start, Split 1, Split 2, Finish traps and base trace for simulator / testing.
 */
export function createDemoSpecialStage(): {
  track: VelocityTrack;
  baseSamples: VelocitySample[];
  simWaypoints: { lat: number; lon: number; speedKmh: number; altM: number }[];
} {
  const waypoints: { lat: number; lon: number; speedKmh: number; altM: number }[] = [
    { lat: -25.33500, lon: -48.91200, speedKmh: 45, altM: 820 },
    { lat: -25.33410, lon: -48.91140, speedKmh: 78, altM: 826 },
    { lat: -25.33320, lon: -48.91070, speedKmh: 96, altM: 834 },
    { lat: -25.33245, lon: -48.90980, speedKmh: 68, altM: 842 },
    { lat: -25.33180, lon: -48.90870, speedKmh: 88, altM: 850 },
    { lat: -25.33105, lon: -48.90785, speedKmh: 104, altM: 858 },
    { lat: -25.33020, lon: -48.90730, speedKmh: 72, altM: 865 },
    { lat: -25.32935, lon: -48.90650, speedKmh: 84, altM: 874 },
    { lat: -25.32860, lon: -48.90555, speedKmh: 112, altM: 883 },
    { lat: -25.32775, lon: -48.90475, speedKmh: 62, altM: 890 },
    { lat: -25.32680, lon: -48.90435, speedKmh: 90, altM: 897 },
    { lat: -25.32590, lon: -48.90360, speedKmh: 108, altM: 906 },
    { lat: -25.32510, lon: -48.90265, speedKmh: 92, altM: 915 },
    { lat: -25.32435, lon: -48.90175, speedKmh: 116, altM: 922 },
  ];

  const baseSamples: VelocitySample[] = [];
  let accKm = 0;
  let elapsedMs = 0;
  const now = Date.now() - 3600000;

  waypoints.forEach((wp, idx) => {
    if (idx > 0) {
      const prev = waypoints[idx - 1];
      const segM = haversineMetersVel(prev.lat, prev.lon, wp.lat, wp.lon);
      accKm += segM / 1000;
      const avgMs = ((prev.speedKmh + wp.speedKmh) / 2) / 3.6;
      elapsedMs += Math.round((segM / Math.max(4, avgMs)) * 1000);
    }
    const nextWp = waypoints[Math.min(waypoints.length - 1, idx + 1)];
    const prevWp = waypoints[Math.max(0, idx - 1)];
    baseSamples.push({
      lat: wp.lat,
      lon: wp.lon,
      speedKmh: wp.speedKmh,
      accuracyM: 4,
      headingDeg: bearingBetweenDeg(prevWp.lat, prevWp.lon, nextWp.lat, nextWp.lon),
      altitudeM: wp.altM,
      timestampMs: now + elapsedMs,
      distKm: accKm,
      stageElapsedMs: elapsedMs,
    });
  });

  const startBearing = bearingBetweenDeg(
    waypoints[0].lat,
    waypoints[0].lon,
    waypoints[2].lat,
    waypoints[2].lon
  );
  const s1Bearing = bearingBetweenDeg(
    waypoints[4].lat,
    waypoints[4].lon,
    waypoints[6].lat,
    waypoints[6].lon
  );
  const s2Bearing = bearingBetweenDeg(
    waypoints[8].lat,
    waypoints[8].lon,
    waypoints[10].lat,
    waypoints[10].lon
  );
  const finBearing = bearingBetweenDeg(
    waypoints[11].lat,
    waypoints[11].lon,
    waypoints[13].lat,
    waypoints[13].lon
  );

  const track: VelocityTrack = {
    id: 'demo_ss_graciosa',
    name: 'SS-01 Serra Velha (Ponto-a-Ponto)',
    mode: 'point-to-point',
    createdAtMs: now,
    referenceDistanceKm: accKm,
    baseTrace: baseSamples,
    traps: [
      {
        id: 'demo_start',
        name: 'Largada SS-01',
        kind: 'start',
        lat: waypoints[1].lat,
        lon: waypoints[1].lon,
        bearingDeg: startBearing,
        widthM: 35,
      },
      {
        id: 'demo_split_1',
        name: 'Parcial 1',
        kind: 'split',
        lat: waypoints[5].lat,
        lon: waypoints[5].lon,
        bearingDeg: s1Bearing,
        widthM: 35,
      },
      {
        id: 'demo_split_2',
        name: 'Parcial 2',
        kind: 'split',
        lat: waypoints[9].lat,
        lon: waypoints[9].lon,
        bearingDeg: s2Bearing,
        widthM: 35,
      },
      {
        id: 'demo_finish',
        name: 'Chegada SS-01',
        kind: 'finish',
        lat: waypoints[12].lat,
        lon: waypoints[12].lon,
        bearingDeg: finBearing,
        widthM: 40,
      },
    ],
  };

  return { track, baseSamples, simWaypoints: waypoints };
}

/**
 * Calcula Força G longitudinal e lateral instantânea a partir de duas amostras GPS sequenciais.
 */
export function computeSampleGForces(
  prev: VelocitySample | null,
  curr: {
    speedKmh: number;
    headingDeg: number | null;
    timestampMs: number;
  }
): { accelLongG: number; accelLatG: number } {
  if (!prev) return { accelLongG: 0, accelLatG: 0 };
  const dtSec = (curr.timestampMs - prev.timestampMs) / 1000;
  if (dtSec < 0.05 || dtSec > 5) return { accelLongG: 0, accelLatG: 0 };

  const v1 = prev.speedKmh / 3.6;
  const v2 = curr.speedKmh / 3.6;
  const rawLongG = (v2 - v1) / dtSec / 9.80665;
  const accelLongG = Number(Math.max(-2.5, Math.min(2.5, rawLongG)).toFixed(2));

  let accelLatG = 0;
  if (prev.headingDeg !== null && curr.headingDeg !== null) {
    let dHdg = ((curr.headingDeg - prev.headingDeg + 540) % 360) - 180;
    if (Math.abs(dHdg) > 120) dHdg = 0;
    const omegaRadPerSec = (dHdg * Math.PI) / 180 / dtSec;
    const vAvg = (v1 + v2) / 2;
    const rawLatG = (vAvg * omegaRadPerSec) / 9.80665;
    accelLatG = Number(Math.max(-2.5, Math.min(2.5, rawLatG)).toFixed(2));
  }

  return { accelLongG, accelLatG };
}

/**
 * Garante que todas as amostras de uma volta tenham accelLongG e accelLatG preenchidos.
 */
export function ensureTraceGForces(samples: VelocitySample[]): VelocitySample[] {
  if (samples.length === 0) return samples;
  return samples.map((s, idx) => {
    if (typeof s.accelLongG === 'number' && typeof s.accelLatG === 'number') {
      return s;
    }
    const prev = idx > 0 ? samples[idx - 1] : null;
    const g = computeSampleGForces(prev, s);
    return {
      ...s,
      accelLongG: typeof s.accelLongG === 'number' ? s.accelLongG : g.accelLongG,
      accelLatG: typeof s.accelLatG === 'number' ? s.accelLatG : g.accelLatG,
    };
  });
}

/**
 * Infere o azimute (0-360°) mais próximo ao longo de um traçado base já gravado/importado.
 */
export function inferNearestBaseTraceBearing(
  lat: number,
  lon: number,
  trace?: VelocitySample[]
): number | null {
  if (!trace || trace.length < 2) return null;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < trace.length; i += 1) {
    const d = haversineMetersVel(lat, lon, trace[i].lat, trace[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  const p0 = trace[Math.max(0, bestIdx - 1)];
  const p1 = trace[Math.min(trace.length - 1, bestIdx + 2)];
  if (!p0 || !p1 || (p0.lat === p1.lat && p0.lon === p1.lon)) return null;
  return bearingBetweenDeg(p0.lat, p0.lon, p1.lat, p1.lon);
}

/**
 * Se uma pista possui traçado (baseTrace >= 2 pontos) e nenhum Marco cadastrado,
 * gera automaticamente Largada (ponto inicial) e Chegada (ponto final) ou Largada/Chegada no circuito.
 */
export function ensureAutoTrapsFromBaseTrace(track: VelocityTrack): VelocityTrack {
  if (track.traps.length > 0 || !track.baseTrace || track.baseTrace.length < 2) {
    return track;
  }
  const pts = track.baseTrace;
  const pStart = pts[0];
  const pStartNext = pts[Math.min(3, pts.length - 1)];
  const startBearing =
    pStart.lat === pStartNext.lat && pStart.lon === pStartNext.lon
      ? 0
      : bearingBetweenDeg(pStart.lat, pStart.lon, pStartNext.lat, pStartNext.lon);

  if (track.mode === 'circuit') {
    return {
      ...track,
      traps: [
        {
          id: `trap_sf_auto_${track.id}`,
          name: 'Largada / Chegada',
          kind: 'start_finish',
          lat: pStart.lat,
          lon: pStart.lon,
          bearingDeg: startBearing,
          widthM: 25,
          unidirectional: true,
        },
      ],
    };
  }

  const pEnd = pts[pts.length - 1];
  const pEndPrev = pts[Math.max(0, pts.length - 4)];
  const endBearing =
    pEndPrev.lat === pEnd.lat && pEndPrev.lon === pEnd.lon
      ? startBearing
      : bearingBetweenDeg(pEndPrev.lat, pEndPrev.lon, pEnd.lat, pEnd.lon);

  return {
    ...track,
    traps: [
      {
        id: `trap_start_auto_${track.id}`,
        name: 'Largada (Start)',
        kind: 'start',
        lat: pStart.lat,
        lon: pStart.lon,
        bearingDeg: startBearing,
        widthM: 25,
        unidirectional: true,
      },
      {
        id: `trap_finish_auto_${track.id}`,
        name: 'Chegada (Finish)',
        kind: 'finish',
        lat: pEnd.lat,
        lon: pEnd.lon,
        bearingDeg: endBearing,
        widthM: 25,
        unidirectional: true,
      },
    ],
  };
}

/**
 * Reconhece automaticamente o circuito/especial mais próximo medindo EXCLUSIVAMENTE
 * a distância até a linha de Largada (Start / Start-Finish) ou ponto inicial do traçado.
 */
export function autoDetectNearestTrack(
  lat: number,
  lon: number,
  tracks: VelocityTrack[],
  radiusM = 35
): { track: VelocityTrack; distanceM: number } | null {
  let bestTrack: VelocityTrack | null = null;
  let bestDist = Infinity;

  for (const trk of tracks) {
    const startGates = trk.traps.filter(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );

    if (startGates.length > 0) {
      for (const gate of startGates) {
        const d = haversineMetersVel(lat, lon, gate.lat, gate.lon);
        if (d <= radiusM && d < bestDist) {
          bestDist = d;
          bestTrack = trk;
        }
      }
    } else if (trk.baseTrace && trk.baseTrace.length > 0) {
      const p0 = trk.baseTrace[0];
      const d = haversineMetersVel(lat, lon, p0.lat, p0.lon);
      if (d <= radiusM && d < bestDist) {
        bestDist = d;
        bestTrack = trk;
      }
    }
  }

  return bestTrack ? { track: bestTrack, distanceM: Math.round(bestDist) } : null;
}

export interface CornerComparisonMetric {
  cornerIndex: number;
  distKm: number;
  lapABrakeStartM: number;
  lapBBrakeStartM: number;
  lapABrakeStartKmh: number;
  lapAApexDistM: number;
  lapBApexDistM: number;
  lapABrakeDistM: number;
  lapBBrakeDistM: number;
  lapAApexKmh: number;
  lapBApexKmh: number;
  lapAExitKmh: number;
  lapBExitKmh: number;
  timeDeltaSec: number;
  brakeShiftM: number;
}

export interface LapComparisonSummary {
  lapANumber: number;
  lapBNumber: number;
  totalDeltaSec: number;
  maxSpeedDeltaKmh: number;
  avgSpeedDeltaKmh: number;
  corners: CornerComparisonMetric[];
}

function interpolateSampleAtDist(
  samples: VelocitySample[],
  targetDistKm: number
): VelocitySample | null {
  if (samples.length === 0) return null;
  if (targetDistKm <= samples[0].distKm) return samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (targetDistKm <= b.distKm) {
      const span = b.distKm - a.distKm;
      const frac = span > 1e-6 ? Math.max(0, Math.min(1, (targetDistKm - a.distKm) / span)) : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * frac,
        lon: a.lon + (b.lon - a.lon) * frac,
        speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * frac,
        accuracyM: b.accuracyM,
        headingDeg: b.headingDeg,
        altitudeM: b.altitudeM,
        timestampMs: Math.round(a.timestampMs + (b.timestampMs - a.timestampMs) * frac),
        distKm: targetDistKm,
        stageElapsedMs: Math.round(
          a.stageElapsedMs + (b.stageElapsedMs - a.stageElapsedMs) * frac
        ),
      };
    }
  }
  return samples[samples.length - 1];
}

function findBrakingStartKm(samples: VelocitySample[], apexIdx: number): { distKm: number; speedKmh: number } {
  const apexDist = samples[apexIdx].distKm;
  for (let i = apexIdx; i >= 1; i -= 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (prev.speedKmh <= curr.speedKmh && apexDist - curr.distKm > 0.015) {
      return { distKm: curr.distKm, speedKmh: curr.speedKmh };
    }
    if (apexDist - curr.distKm > 0.25) {
      return { distKm: curr.distKm, speedKmh: curr.speedKmh };
    }
  }
  const first = samples[0];
  return { distKm: first?.distKm ?? apexDist, speedKmh: first?.speedKmh ?? samples[apexIdx].speedKmh };
}

/**
 * Compara duas voltas (lapA vs referência lapB) detectando curvas/frenagens reais na telemetria GPS.
 */
export function computeLapComparisonSummary(
  lapA: VelocityRun,
  lapB: VelocityRun
): LapComparisonSummary {
  const refSamples = ensureTraceGForces(lapB.samples);
  const tgtSamples = ensureTraceGForces(lapA.samples);

  const corners: CornerComparisonMetric[] = [];
  if (refSamples.length >= 4 && tgtSamples.length >= 4) {
    const apexIndices: number[] = [];
    for (let i = 1; i < refSamples.length - 1; i += 1) {
      const prev = refSamples[i - 1].speedKmh;
      const curr = refSamples[i].speedKmh;
      const next = refSamples[i + 1].speedKmh;
      if (curr <= prev && curr < next && curr < 130) {
        const lastIdx = apexIndices[apexIndices.length - 1];
        if (
          lastIdx === undefined ||
          refSamples[i].distKm - refSamples[lastIdx].distKm >= 0.1
        ) {
          apexIndices.push(i);
        }
      }
    }

    apexIndices.slice(0, 8).forEach((refApexIdx, idx) => {
      const refApex = refSamples[refApexIdx];
      const refBrake = findBrakingStartKm(refSamples, refApexIdx);
      const refExitSample =
        interpolateSampleAtDist(refSamples, refApex.distKm + 0.06) ??
        refSamples[Math.min(refSamples.length - 1, refApexIdx + 1)];

      let tgtApexIdx = 0;
      let bestDistDiff = Infinity;
      for (let j = 0; j < tgtSamples.length; j += 1) {
        const diff = Math.abs(tgtSamples[j].distKm - refApex.distKm);
        if (diff < bestDistDiff) {
          bestDistDiff = diff;
          tgtApexIdx = j;
        }
      }
      const winStart = Math.max(0, tgtApexIdx - 2);
      const winEnd = Math.min(tgtSamples.length - 1, tgtApexIdx + 2);
      let minIdx = tgtApexIdx;
      for (let j = winStart; j <= winEnd; j += 1) {
        if (tgtSamples[j].speedKmh < tgtSamples[minIdx].speedKmh) minIdx = j;
      }

      const tgtApex = tgtSamples[minIdx];
      const tgtBrake = findBrakingStartKm(tgtSamples, minIdx);
      const tgtExitSample =
        interpolateSampleAtDist(tgtSamples, tgtApex.distKm + 0.06) ??
        tgtSamples[Math.min(tgtSamples.length - 1, minIdx + 1)];

      const entryRef = interpolateSampleAtDist(refSamples, Math.max(0, refApex.distKm - 0.08));
      const entryTgt = interpolateSampleAtDist(tgtSamples, Math.max(0, tgtApex.distKm - 0.08));
      const sectorDurRefMs =
        entryRef && refExitSample
          ? refExitSample.stageElapsedMs - entryRef.stageElapsedMs
          : 0;
      const sectorDurTgtMs =
        entryTgt && tgtExitSample
          ? tgtExitSample.stageElapsedMs - entryTgt.stageElapsedMs
          : 0;

      corners.push({
        cornerIndex: idx + 1,
        distKm: Number(refApex.distKm.toFixed(2)),
        lapABrakeStartM: Math.round(tgtBrake.distKm * 1000),
        lapBBrakeStartM: Math.round(refBrake.distKm * 1000),
        lapABrakeStartKmh: Math.round(tgtBrake.speedKmh),
        lapAApexDistM: Math.round(tgtApex.distKm * 1000),
        lapBApexDistM: Math.round(refApex.distKm * 1000),
        lapABrakeDistM: Math.round((tgtApex.distKm - tgtBrake.distKm) * 1000),
        lapBBrakeDistM: Math.round((refApex.distKm - refBrake.distKm) * 1000),
        lapAApexKmh: Math.round(tgtApex.speedKmh),
        lapBApexKmh: Math.round(refApex.speedKmh),
        lapAExitKmh: Math.round(tgtExitSample.speedKmh),
        lapBExitKmh: Math.round(refExitSample.speedKmh),
        timeDeltaSec: Number(((sectorDurTgtMs - sectorDurRefMs) / 1000).toFixed(2)),
        brakeShiftM: Math.round((tgtBrake.distKm - refBrake.distKm) * 1000),
      });
    });
  }

  return {
    lapANumber: lapA.runNumber,
    lapBNumber: lapB.runNumber,
    totalDeltaSec: Number(((lapA.totalMs - lapB.totalMs) / 1000).toFixed(2)),
    maxSpeedDeltaKmh: Math.round(lapA.maxSpeedKmh - lapB.maxSpeedKmh),
    avgSpeedDeltaKmh: Math.round(lapA.avgSpeedKmh - lapB.avgSpeedKmh),
    corners,
  };
}
