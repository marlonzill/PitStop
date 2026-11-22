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

export const WEB_GPS_WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 3000,
} as const;

export function getCapacitorGpsWatchOptions(): {
  enableHighAccuracy: boolean;
  maximumAge: number;
  timeout: number;
} {
  return {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 3000,
    interval: 250,
    fastestInterval: 200,
  } as unknown as {
    enableHighAccuracy: boolean;
    maximumAge: number;
    timeout: number;
  };
}

export interface GpsKalmanInput {
  lat: number;
  lon: number;
  accuracyM: number | null;
  rawSpeedMs: number | null;
  rawHeadingDeg: number | null;
  timestampMs: number;
}

export interface GpsKalmanOutput {
  lat: number;
  lon: number;
  distStepM: number;
  speedKmh: number;
  headingDeg: number | null;
  accuracyM: number | null;
  movementDetected: boolean;
}

interface AxisKalmanState {
  x: number; // meters from local origin
  v: number; // m/s
  p00: number;
  p01: number;
  p10: number;
  p11: number;
}

/**
 * 2D Kalman Filter (East/North local tangent plane in meters) calibrated by coords.accuracy.
 * Eliminates stationary GPS jitter while reacting immediately to walking steps (>= 0.45m or >= 0.5 m/s).
 */
export function createGpsKalmanProcessor() {
  let origin: { lat: number; lon: number; cosLat: number } | null = null;
  let eastState: AxisKalmanState | null = null;
  let northState: AxisKalmanState | null = null;
  let lastTsMs = 0;
  let lastFilteredPos: { lat: number; lon: number } | null = null;
  let odoAnchor: { lat: number; lon: number } | null = null;
  let headingAnchor: { lat: number; lon: number } | null = null;
  let currentHeadingDeg: number | null = null;
  let emaSpeedKmh = 0;

  const METERS_PER_DEG_LAT = 111320;

  const toLocalMeters = (lat: number, lon: number) => {
    if (!origin) {
      origin = {
        lat,
        lon,
        cosLat: Math.max(0.1, Math.cos((lat * Math.PI) / 180)),
      };
    }
    return {
      eastM: (lon - origin.lon) * METERS_PER_DEG_LAT * origin.cosLat,
      northM: (lat - origin.lat) * METERS_PER_DEG_LAT,
    };
  };

  const toLatLon = (eastM: number, northM: number) => {
    if (!origin) return { lat: 0, lon: 0 };
    return {
      lat: origin.lat + northM / METERS_PER_DEG_LAT,
      lon: origin.lon + eastM / (METERS_PER_DEG_LAT * origin.cosLat),
    };
  };

  const stepAxis = (
    st: AxisKalmanState,
    z: number,
    dt: number,
    rVar: number,
    qAccelVar: number
  ): AxisKalmanState => {
    // Predict
    const xPred = st.x + st.v * dt;
    const vPred = st.v;

    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;

    const q00 = 0.25 * dt4 * qAccelVar;
    const q01 = 0.5 * dt3 * qAccelVar;
    const q11 = dt2 * qAccelVar;

    const p00 = st.p00 + dt * (st.p10 + st.p01) + dt2 * st.p11 + q00;
    const p01 = st.p01 + dt * st.p11 + q01;
    const p10 = st.p10 + dt * st.p11 + q01;
    const p11 = st.p11 + q11;

    // Update with position measurement z
    const y = z - xPred;
    const s = p00 + rVar;
    const k0 = s > 1e-9 ? p00 / s : 0;
    const k1 = s > 1e-9 ? p10 / s : 0;

    return {
      x: xPred + k0 * y,
      v: vPred + k1 * y,
      p00: Math.max(0.01, (1 - k0) * p00),
      p01: (1 - k0) * p01,
      p10: p10 - k1 * p00,
      p11: Math.max(0.01, p11 - k1 * p01),
    };
  };

  const reset = () => {
    origin = null;
    eastState = null;
    northState = null;
    lastTsMs = 0;
    lastFilteredPos = null;
    odoAnchor = null;
    headingAnchor = null;
    currentHeadingDeg = null;
    emaSpeedKmh = 0;
  };

  const update = (input: GpsKalmanInput): GpsKalmanOutput => {
    const ts = Number.isFinite(input.timestampMs) && input.timestampMs > 0 ? input.timestampMs : Date.now();
    const accM =
      input.accuracyM !== null && Number.isFinite(input.accuracyM)
        ? Math.max(1, input.accuracyM)
        : null;
    const dopplerMs =
      input.rawSpeedMs !== null && Number.isFinite(input.rawSpeedMs) && input.rawSpeedMs >= 0
        ? input.rawSpeedMs
        : 0;
    const dopplerKmh = dopplerMs * 3.6;

    const needsReset =
      !origin ||
      !eastState ||
      !northState ||
      !lastFilteredPos ||
      ts - lastTsMs > 15000 ||
      haversineMetersVel(lastFilteredPos.lat, lastFilteredPos.lon, input.lat, input.lon) > 500;

    if (needsReset) {
      origin = {
        lat: input.lat,
        lon: input.lon,
        cosLat: Math.max(0.1, Math.cos((input.lat * Math.PI) / 180)),
      };
      const initR = Math.pow(Math.min(25, Math.max(2.5, accM ?? 6)), 2);
      eastState = { x: 0, v: 0, p00: initR, p01: 0, p10: 0, p11: 4 };
      northState = { x: 0, v: 0, p00: initR, p01: 0, p10: 0, p11: 4 };
      lastTsMs = ts;
      lastFilteredPos = { lat: input.lat, lon: input.lon };
      odoAnchor = { lat: input.lat, lon: input.lon };
      headingAnchor = { lat: input.lat, lon: input.lon };
      if (input.rawHeadingDeg !== null && Number.isFinite(input.rawHeadingDeg)) {
        currentHeadingDeg = Math.round(((input.rawHeadingDeg % 360) + 360) % 360);
      }
      emaSpeedKmh = dopplerKmh >= 1.5 ? dopplerKmh : 0;
      return {
        lat: input.lat,
        lon: input.lon,
        distStepM: 0,
        speedKmh: emaSpeedKmh,
        headingDeg: currentHeadingDeg,
        accuracyM: accM !== null ? Math.round(accM) : null,
        movementDetected: dopplerMs >= 0.5,
      };
    }

    const dtSec = Math.min(5, Math.max(0.08, (ts - lastTsMs) / 1000));
    const local = toLocalMeters(input.lat, input.lon);
    const innovationM = Math.hypot(local.eastM - eastState!.x, local.northM - northState!.x);

    // Calibrate measurement variance R from GPS horizontal accuracy
    const sigmaM = Math.min(35, Math.max(2.5, accM ?? 7)) * 0.72;
    const rVar = sigmaM * sigmaM;

    // Adaptive process noise Q: responsive when walking/driving, tight when stationary
    const activeMotionSignal =
      dopplerMs >= 0.5 ||
      innovationM >= Math.max(0.75, Math.min(2.2, sigmaM * 0.45));
    const qAccelVar = activeMotionSignal ? 12.0 : 0.08;

    eastState = stepAxis(eastState!, local.eastM, dtSec, rVar, qAccelVar);
    northState = stepAxis(northState!, local.northM, dtSec, rVar, qAccelVar);

    const filt = toLatLon(eastState.x, northState.x);
    const instStepM = haversineMetersVel(
      lastFilteredPos!.lat,
      lastFilteredPos!.lon,
      filt.lat,
      filt.lon
    );

    // Odometer anchor accumulates filtered sub-steps (e.g. 250ms ticks at walking pace) until >= 0.45m
    const anchorDistM = odoAnchor
      ? haversineMetersVel(odoAnchor.lat, odoAnchor.lon, filt.lat, filt.lon)
      : 0;
    const movementDetected =
      (anchorDistM >= 0.45 && anchorDistM < 500) ||
      (dopplerMs >= 0.5 && anchorDistM >= 0.15 && anchorDistM < 500);

    let distStepM = 0;
    if (movementDetected && odoAnchor) {
      distStepM = anchorDistM;
      odoAnchor = { lat: filt.lat, lon: filt.lon };
    }

    // Heading updates only after >= 1.2m of accumulated directional displacement
    if (headingAnchor) {
      const hdgDistM = haversineMetersVel(headingAnchor.lat, headingAnchor.lon, filt.lat, filt.lon);
      if (hdgDistM >= 1.2 && hdgDistM < 500) {
        const calcBearing = bearingBetweenDeg(headingAnchor.lat, headingAnchor.lon, filt.lat, filt.lon);
        currentHeadingDeg =
          input.rawHeadingDeg !== null && Number.isFinite(input.rawHeadingDeg) && dopplerKmh >= 6
            ? Math.round(((input.rawHeadingDeg % 360) + 360) % 360)
            : calcBearing;
        headingAnchor = { lat: filt.lat, lon: filt.lon };
      }
    }

    // EMA speed blending (alpha = 0.65) between chip Doppler and filtered geometric speed
    const geomSpeedKmh = dtSec >= 0.08 && instStepM < 500 ? (instStepM / dtSec) * 3.6 : 0;
    const kalmanVelKmh = Math.hypot(eastState.v, northState.v) * 3.6;
    const bestGeomKmh = geomSpeedKmh > 0.5 ? geomSpeedKmh : kalmanVelKmh;
    const instSpeedKmh =
      dopplerKmh >= 1.5
        ? bestGeomKmh >= 1.0
          ? 0.65 * dopplerKmh + 0.35 * bestGeomKmh
          : dopplerKmh
        : bestGeomKmh;

    const EMA_ALPHA = 0.65;
    emaSpeedKmh = EMA_ALPHA * instSpeedKmh + (1 - EMA_ALPHA) * emaSpeedKmh;

    // Zero speed ONLY when speed < 1.5 km/h AND filtered displacement < 0.45m
    let finalSpeedKmh = emaSpeedKmh;
    if (finalSpeedKmh < 1.5 && anchorDistM < 0.45 && dopplerMs < 0.5) {
      finalSpeedKmh = 0;
      emaSpeedKmh = 0;
    }

    lastTsMs = ts;
    lastFilteredPos = { lat: filt.lat, lon: filt.lon };

    return {
      lat: filt.lat,
      lon: filt.lon,
      distStepM,
      speedKmh: finalSpeedKmh,
      headingDeg: currentHeadingDeg,
      accuracyM: accM !== null ? Math.round(accM) : null,
      movementDetected,
    };
  };

  return { update, reset };
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

export function interpolateSampleAtDist(
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
      const aLongG = typeof a.accelLongG === 'number' ? a.accelLongG : 0;
      const bLongG = typeof b.accelLongG === 'number' ? b.accelLongG : 0;
      const aLatG = typeof a.accelLatG === 'number' ? a.accelLatG : 0;
      const bLatG = typeof b.accelLatG === 'number' ? b.accelLatG : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * frac,
        lon: a.lon + (b.lon - a.lon) * frac,
        speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * frac,
        accuracyM: b.accuracyM,
        headingDeg: b.headingDeg,
        altitudeM:
          a.altitudeM !== null && b.altitudeM !== null
            ? a.altitudeM + (b.altitudeM - a.altitudeM) * frac
            : b.altitudeM,
        timestampMs: Math.round(a.timestampMs + (b.timestampMs - a.timestampMs) * frac),
        distKm: targetDistKm,
        stageElapsedMs: Math.round(
          a.stageElapsedMs + (b.stageElapsedMs - a.stageElapsedMs) * frac
        ),
        accelLongG: Number((aLongG + (bLongG - aLongG) * frac).toFixed(2)),
        accelLatG: Number((aLatG + (bLatG - aLatG) * frac).toFixed(2)),
      };
    }
  }
  return samples[samples.length - 1];
}

export function interpolateSampleAtElapsedMs(
  samples: VelocitySample[],
  targetElapsedMs: number
): VelocitySample | null {
  if (samples.length === 0) return null;
  if (targetElapsedMs <= samples[0].stageElapsedMs) return samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (targetElapsedMs <= b.stageElapsedMs) {
      const span = b.stageElapsedMs - a.stageElapsedMs;
      const frac =
        span > 1 ? Math.max(0, Math.min(1, (targetElapsedMs - a.stageElapsedMs) / span)) : 0;
      const aLongG = typeof a.accelLongG === 'number' ? a.accelLongG : 0;
      const bLongG = typeof b.accelLongG === 'number' ? b.accelLongG : 0;
      const aLatG = typeof a.accelLatG === 'number' ? a.accelLatG : 0;
      const bLatG = typeof b.accelLatG === 'number' ? b.accelLatG : 0;
      let interpHeading: number | null = b.headingDeg ?? a.headingDeg;
      if (typeof a.headingDeg === 'number' && typeof b.headingDeg === 'number') {
        const deltaH = ((b.headingDeg - a.headingDeg + 540) % 360) - 180;
        interpHeading = Math.round((((a.headingDeg + deltaH * frac) % 360) + 360) % 360);
      }
      return {
        lat: a.lat + (b.lat - a.lat) * frac,
        lon: a.lon + (b.lon - a.lon) * frac,
        speedKmh: a.speedKmh + (b.speedKmh - a.speedKmh) * frac,
        accuracyM: b.accuracyM,
        headingDeg: interpHeading,
        altitudeM:
          a.altitudeM !== null && b.altitudeM !== null
            ? a.altitudeM + (b.altitudeM - a.altitudeM) * frac
            : b.altitudeM,
        timestampMs: Math.round(a.timestampMs + (b.timestampMs - a.timestampMs) * frac),
        distKm: a.distKm + (b.distKm - a.distKm) * frac,
        stageElapsedMs: Math.round(targetElapsedMs),
        accelLongG: Number((aLongG + (bLongG - aLongG) * frac).toFixed(2)),
        accelLatG: Number((aLatG + (bLatG - aLatG) * frac).toFixed(2)),
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

export interface TrackSectorDef {
  index: number;
  key: string;
  label: string;
  shortLabel: string;
  fromDistKm: number;
  toDistKm: number;
  fromTrapId?: string;
  toTrapId?: string;
  isTrapBased: boolean;
}

export interface SectorRunMetrics {
  sectorIndex: number;
  label: string;
  shortLabel: string;
  durationMs: number | null;
  maxSpeedKmh: number | null;
  minSpeedKmh: number | null;
  avgSpeedKmh: number | null;
  exitSpeedKmh: number | null;
  peakBrakeG: number | null;
  peakAccelG: number | null;
  fromDistKm: number;
  toDistKm: number;
}

export interface SectorComparisonRow {
  index: number;
  label: string;
  shortLabel: string;
  fromDistM: number;
  toDistM: number;
  isTrapBased: boolean;
  lapA: SectorRunMetrics;
  lapB: SectorRunMetrics;
  timeDeltaSec: number | null;
  maxSpeedDeltaKmh: number | null;
  minSpeedDeltaKmh: number | null;
  avgSpeedDeltaKmh: number | null;
  exitSpeedDeltaKmh: number | null;
}

export interface MultiLapSectorEntry {
  slot: 1 | 2 | 3;
  runId: string;
  runNumber: number;
  metrics: SectorRunMetrics;
  timeDeltaSec: number | null;
  maxSpeedDeltaKmh: number | null;
  minSpeedDeltaKmh: number | null;
  avgSpeedDeltaKmh: number | null;
  exitSpeedDeltaKmh: number | null;
}

export interface MultiLapSectorRow {
  index: number;
  label: string;
  shortLabel: string;
  fromDistM: number;
  toDistM: number;
  isTrapBased: boolean;
  entries: MultiLapSectorEntry[];
}

export interface LiveSectorCardStatus {
  index: number;
  shortLabel: string;
  label: string;
  status: 'completed' | 'active' | 'future';
  currentMaxKmh: number | null;
  refMaxKmh: number | null;
  deltaKmh: number | null;
}

function findNearestTraceDistKm(trace: VelocitySample[], lat: number, lon: number): number | null {
  if (trace.length === 0) return null;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < trace.length; i += 1) {
    const d = haversineMetersVel(lat, lon, trace[i].lat, trace[i].lon);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return trace[bestIdx].distKm;
}

/**
 * Divide a pista pelos marcos (traps) intermediários cadastrados
 * ou automaticamente em 4 trechos iguais de distância caso não haja parciais.
 */
export function buildTrackSectors(
  track: VelocityTrack | null,
  referenceRuns: VelocityRun[] = [],
  fallbackDistKm = 0
): TrackSectorDef[] {
  const maxRunDist = referenceRuns.reduce((acc, r) => {
    const lastSampleDist =
      r.samples.length > 0 ? r.samples[r.samples.length - 1].distKm : 0;
    return Math.max(acc, r.distanceKm || 0, lastSampleDist);
  }, 0);

  const totalDistKm = Math.max(
    0.2,
    fallbackDistKm,
    track?.referenceDistanceKm || 0,
    maxRunDist
  );

  if (track) {
    const ordered = getOrderedTrackTraps(track);
    const startTrap = ordered.find(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    const splits = ordered.filter((t) => t.kind === 'split');
    const finishTrap =
      ordered.find((t) => t.kind === 'finish') ??
      (startTrap?.kind === 'start_finish' ? startTrap : undefined);

    if (startTrap && splits.length > 0 && finishTrap) {
      const checkpoints = [...splits, finishTrap];
      const trace =
        referenceRuns.find((r) => r.samples.length >= 2)?.samples ??
        track.baseTrace ??
        [];

      const resolveTrapDist = (trap: VelocityTrap, isFinal: boolean): number => {
        if (isFinal) return totalDistKm;
        for (const run of referenceRuns) {
          const tMs = run.splitTimesMs[trap.id];
          if (typeof tMs === 'number' && tMs > 0 && run.samples.length >= 2) {
            const s = interpolateSampleAtElapsedMs(run.samples, tMs);
            if (s && s.distKm > 0) return s.distKm;
          }
        }
        const nearDist = findNearestTraceDistKm(trace, trap.lat, trap.lon);
        if (nearDist !== null && nearDist > 0 && nearDist < totalDistKm) {
          return nearDist;
        }
        return 0;
      };

      const rawBoundaries: number[] = [0];
      checkpoints.forEach((cp, idx) => {
        const isFinal = idx === checkpoints.length - 1;
        let d = resolveTrapDist(cp, isFinal);
        const prevD = rawBoundaries[rawBoundaries.length - 1];
        if (!isFinal && (d <= prevD + 0.02 || d >= totalDistKm - 0.02)) {
          d = ((idx + 1) / checkpoints.length) * totalDistKm;
        }
        rawBoundaries.push(isFinal ? totalDistKm : Math.max(prevD + 0.01, Math.min(totalDistKm - 0.01, d)));
      });

      let prevTrapId = startTrap.id;
      return checkpoints.map((cp, idx) => {
        const isFinal = idx === checkpoints.length - 1;
        const fromDistKm = rawBoundaries[idx];
        const toDistKm = rawBoundaries[idx + 1];
        const sectorDef: TrackSectorDef = {
          index: idx + 1,
          key: `trap_sec_${idx + 1}_${cp.id}`,
          label: `Setor ${idx + 1}`,
          shortLabel: `S${idx + 1}`,
          fromDistKm,
          toDistKm,
          fromTrapId: prevTrapId,
          toTrapId: isFinal ? finishTrap.id : cp.id,
          isTrapBased: true,
        };
        prevTrapId = cp.id;
        return sectorDef;
      });
    }
  }

  // Fallback automático em 4 trechos iguais de distância
  const sectorCount = 4;
  return Array.from({ length: sectorCount }, (_, idx) => {
    const fromDistKm = (idx / sectorCount) * totalDistKm;
    const toDistKm = ((idx + 1) / sectorCount) * totalDistKm;
    return {
      index: idx + 1,
      key: `auto_sec_${idx + 1}`,
      label: `Setor ${idx + 1}`,
      shortLabel: `S${idx + 1}`,
      fromDistKm,
      toDistKm,
      isTrapBased: false,
    };
  });
}

export function computeRunSectorMetrics(
  run: VelocityRun,
  sectors: TrackSectorDef[]
): SectorRunMetrics[] {
  const samples = ensureTraceGForces(run.samples);
  const runEndDistKm =
    samples.length > 0 ? samples[samples.length - 1].distKm : run.distanceKm;

  return sectors.map((sec, idx) => {
    const isLast = idx === sectors.length - 1;
    let startElapsedMs: number | null = null;
    let endElapsedMs: number | null = null;

    if (sec.isTrapBased && sec.fromTrapId && sec.toTrapId) {
      const fromT =
        idx === 0
          ? 0
          : typeof run.splitTimesMs[sec.fromTrapId] === 'number'
            ? run.splitTimesMs[sec.fromTrapId]
            : null;
      const toT = isLast
        ? run.splitTimesMs[sec.toTrapId] ?? run.totalMs
        : typeof run.splitTimesMs[sec.toTrapId] === 'number'
          ? run.splitTimesMs[sec.toTrapId]
          : null;
      if (fromT !== null && toT !== null && toT > fromT) {
        startElapsedMs = fromT;
        endElapsedMs = toT;
      }
    }

    if (samples.length < 2) {
      return {
        sectorIndex: sec.index,
        label: sec.label,
        shortLabel: sec.shortLabel,
        durationMs:
          startElapsedMs !== null && endElapsedMs !== null
            ? endElapsedMs - startElapsedMs
            : null,
        maxSpeedKmh: null,
        minSpeedKmh: null,
        avgSpeedKmh: null,
        exitSpeedKmh: null,
        peakBrakeG: null,
        peakAccelG: null,
        fromDistKm: sec.fromDistKm,
        toDistKm: sec.toDistKm,
      };
    }

    const startSample =
      startElapsedMs !== null
        ? interpolateSampleAtElapsedMs(samples, startElapsedMs)
        : interpolateSampleAtDist(samples, Math.min(runEndDistKm, sec.fromDistKm));
    const endSample =
      endElapsedMs !== null
        ? interpolateSampleAtElapsedMs(samples, endElapsedMs)
        : interpolateSampleAtDist(
            samples,
            isLast ? runEndDistKm : Math.min(runEndDistKm, sec.toDistKm)
          );

    if (!startSample || !endSample) {
      return {
        sectorIndex: sec.index,
        label: sec.label,
        shortLabel: sec.shortLabel,
        durationMs: null,
        maxSpeedKmh: null,
        minSpeedKmh: null,
        avgSpeedKmh: null,
        exitSpeedKmh: null,
        peakBrakeG: null,
        peakAccelG: null,
        fromDistKm: sec.fromDistKm,
        toDistKm: sec.toDistKm,
      };
    }

    const sStartMs = startElapsedMs ?? startSample.stageElapsedMs;
    const sEndMs = endElapsedMs ?? endSample.stageElapsedMs;
    const durationMs = sEndMs > sStartMs ? Math.round(sEndMs - sStartMs) : null;

    const inside = samples.filter(
      (s) => s.stageElapsedMs >= sStartMs && s.stageElapsedMs <= sEndMs
    );
    const pool = [startSample, ...inside, endSample];

    const maxSpeedKmh = Math.round(
      pool.reduce((m, s) => Math.max(m, s.speedKmh || 0), 0)
    );
    const minSpeedKmh = Math.round(
      pool.reduce((m, s) => Math.min(m, Number.isFinite(s.speedKmh) ? s.speedKmh : m), Infinity)
    );

    const longGs = pool.map((s) => (typeof s.accelLongG === 'number' ? s.accelLongG : 0));
    const peakBrakeG = Number(Math.min(0, ...longGs).toFixed(2));
    const peakAccelG = Number(Math.max(0, ...longGs).toFixed(2));

    const spanDistKm = Math.max(0, endSample.distKm - startSample.distKm);
    const avgSpeedKmh =
      durationMs && durationMs > 0 && spanDistKm > 0.005
        ? Math.round(spanDistKm / (durationMs / 3600000))
        : Math.round(
            pool.reduce((sum, s) => sum + (s.speedKmh || 0), 0) / Math.max(1, pool.length)
          );

    const exitSpeedKmh = Math.round(endSample.speedKmh || 0);

    return {
      sectorIndex: sec.index,
      label: sec.label,
      shortLabel: sec.shortLabel,
      durationMs,
      maxSpeedKmh,
      minSpeedKmh: Number.isFinite(minSpeedKmh) ? minSpeedKmh : null,
      avgSpeedKmh,
      exitSpeedKmh,
      peakBrakeG,
      peakAccelG,
      fromDistKm: startSample.distKm,
      toDistKm: endSample.distKm,
    };
  });
}

export function computeSectorComparisonRows(
  track: VelocityTrack | null,
  lapA: VelocityRun,
  lapB: VelocityRun
): { sectors: TrackSectorDef[]; rows: SectorComparisonRow[] } {
  const sectors = buildTrackSectors(
    track,
    [lapA, lapB],
    Math.max(lapA.distanceKm || 0, lapB.distanceKm || 0)
  );
  const metricsA = computeRunSectorMetrics(lapA, sectors);
  const metricsB = computeRunSectorMetrics(lapB, sectors);

  const rows: SectorComparisonRow[] = sectors.map((sec, idx) => {
    const a = metricsA[idx];
    const b = metricsB[idx];
    const timeDeltaSec =
      a.durationMs !== null && b.durationMs !== null
        ? Number(((a.durationMs - b.durationMs) / 1000).toFixed(2))
        : null;
    const maxSpeedDeltaKmh =
      a.maxSpeedKmh !== null && b.maxSpeedKmh !== null
        ? Math.round(a.maxSpeedKmh - b.maxSpeedKmh)
        : null;
    const minSpeedDeltaKmh =
      a.minSpeedKmh !== null && b.minSpeedKmh !== null
        ? Math.round(a.minSpeedKmh - b.minSpeedKmh)
        : null;
    const avgSpeedDeltaKmh =
      a.avgSpeedKmh !== null && b.avgSpeedKmh !== null
        ? Math.round(a.avgSpeedKmh - b.avgSpeedKmh)
        : null;
    const exitSpeedDeltaKmh =
      a.exitSpeedKmh !== null && b.exitSpeedKmh !== null
        ? Math.round(a.exitSpeedKmh - b.exitSpeedKmh)
        : null;

    return {
      index: sec.index,
      label: sec.label,
      shortLabel: sec.shortLabel,
      fromDistM: Math.round(sec.fromDistKm * 1000),
      toDistM: Math.round(sec.toDistKm * 1000),
      isTrapBased: sec.isTrapBased,
      lapA: a,
      lapB: b,
      timeDeltaSec,
      maxSpeedDeltaKmh,
      minSpeedDeltaKmh,
      avgSpeedDeltaKmh,
      exitSpeedDeltaKmh,
    };
  });

  return { sectors, rows };
}

export function computeMultiLapSectorComparison(
  track: VelocityTrack | null,
  laps: Array<{ slot: 1 | 2 | 3; run: VelocityRun }>
): { sectors: TrackSectorDef[]; rows: MultiLapSectorRow[] } {
  if (laps.length === 0) return { sectors: [], rows: [] };
  const runsList = laps.map((l) => l.run);
  const maxDistKm = runsList.reduce((m, r) => Math.max(m, r.distanceKm || 0), 0);
  const sectors = buildTrackSectors(track, runsList, maxDistKm);
  const metricsBySlot = laps.map((l) => ({
    slot: l.slot,
    run: l.run,
    metrics: computeRunSectorMetrics(l.run, sectors),
  }));

  const refSlot = metricsBySlot[0];
  const rows: MultiLapSectorRow[] = sectors.map((sec, idx) => {
    const refMetrics = refSlot.metrics[idx];
    const entries: MultiLapSectorEntry[] = metricsBySlot.map((item, itemIdx) => {
      const m = item.metrics[idx];
      const isRef = itemIdx === 0;
      const timeDeltaSec =
        !isRef && m.durationMs !== null && refMetrics.durationMs !== null
          ? Number(((m.durationMs - refMetrics.durationMs) / 1000).toFixed(2))
          : null;
      const maxSpeedDeltaKmh =
        !isRef && m.maxSpeedKmh !== null && refMetrics.maxSpeedKmh !== null
          ? Math.round(m.maxSpeedKmh - refMetrics.maxSpeedKmh)
          : null;
      const minSpeedDeltaKmh =
        !isRef && m.minSpeedKmh !== null && refMetrics.minSpeedKmh !== null
          ? Math.round(m.minSpeedKmh - refMetrics.minSpeedKmh)
          : null;
      const avgSpeedDeltaKmh =
        !isRef && m.avgSpeedKmh !== null && refMetrics.avgSpeedKmh !== null
          ? Math.round(m.avgSpeedKmh - refMetrics.avgSpeedKmh)
          : null;
      const exitSpeedDeltaKmh =
        !isRef && m.exitSpeedKmh !== null && refMetrics.exitSpeedKmh !== null
          ? Math.round(m.exitSpeedKmh - refMetrics.exitSpeedKmh)
          : null;

      return {
        slot: item.slot,
        runId: item.run.id,
        runNumber: item.run.runNumber,
        metrics: m,
        timeDeltaSec,
        maxSpeedDeltaKmh,
        minSpeedDeltaKmh,
        avgSpeedDeltaKmh,
        exitSpeedDeltaKmh,
      };
    });

    return {
      index: sec.index,
      label: sec.label,
      shortLabel: sec.shortLabel,
      fromDistM: Math.round(sec.fromDistKm * 1000),
      toDistM: Math.round(sec.toDistKm * 1000),
      isTrapBased: sec.isTrapBased,
      entries,
    };
  });

  return { sectors, rows };
}

export function computeLiveSectorCards(params: {
  track: VelocityTrack | null;
  bestRun: VelocityRun | null;
  stageState: 'idle' | 'armed' | 'running' | 'finished';
  totalDistKm: number;
  liveSamples: VelocitySample[];
  currentSplitTimesMs: Record<string, number>;
  currentSpeedKmh: number;
}): LiveSectorCardStatus[] {
  const {
    track,
    bestRun,
    stageState,
    totalDistKm,
    liveSamples,
    currentSplitTimesMs,
    currentSpeedKmh,
  } = params;

  const sectors = buildTrackSectors(
    track,
    bestRun ? [bestRun] : [],
    Math.max(totalDistKm, bestRun?.distanceKm || 0, track?.referenceDistanceKm || 0)
  );
  const bestMetrics = bestRun ? computeRunSectorMetrics(bestRun, sectors) : [];

  let activeIdx = -1;
  if (stageState === 'running') {
    if (sectors.some((s) => s.isTrapBased)) {
      activeIdx = sectors.findIndex(
        (s, idx) =>
          idx === sectors.length - 1 ||
          !s.toTrapId ||
          currentSplitTimesMs[s.toTrapId] === undefined
      );
    } else {
      activeIdx = sectors.findIndex(
        (s, idx) => idx === sectors.length - 1 || totalDistKm < s.toDistKm
      );
    }
    if (activeIdx < 0) activeIdx = sectors.length - 1;
  }

  return sectors.map((sec, idx) => {
    const refMaxKmh = bestMetrics[idx]?.maxSpeedKmh ?? null;

    if (stageState === 'idle' || stageState === 'armed') {
      return {
        index: sec.index,
        shortLabel: sec.shortLabel,
        label: sec.label,
        status: 'future',
        currentMaxKmh: null,
        refMaxKmh,
        deltaKmh: null,
      };
    }

    const isCompleted =
      stageState === 'finished' || (stageState === 'running' && idx < activeIdx);
    const isActive = stageState === 'running' && idx === activeIdx;

    if (!isCompleted && !isActive) {
      return {
        index: sec.index,
        shortLabel: sec.shortLabel,
        label: sec.label,
        status: 'future',
        currentMaxKmh: null,
        refMaxKmh,
        deltaKmh: null,
      };
    }

    let sectorSamples: VelocitySample[] = [];
    if (sec.isTrapBased) {
      const startMs =
        idx === 0
          ? 0
          : sec.fromTrapId && typeof currentSplitTimesMs[sec.fromTrapId] === 'number'
            ? currentSplitTimesMs[sec.fromTrapId]
            : 0;
      const endMs =
        sec.toTrapId && typeof currentSplitTimesMs[sec.toTrapId] === 'number'
          ? currentSplitTimesMs[sec.toTrapId]
          : Infinity;
      sectorSamples = liveSamples.filter(
        (s) => s.stageElapsedMs >= startMs && s.stageElapsedMs <= endMs
      );
    } else {
      sectorSamples = liveSamples.filter(
        (s) => s.distKm >= sec.fromDistKm && (idx === sectors.length - 1 || s.distKm <= sec.toDistKm)
      );
    }

    let peak = sectorSamples.reduce((m, s) => Math.max(m, s.speedKmh || 0), 0);
    if (isActive) {
      peak = Math.max(peak, currentSpeedKmh);
    }
    const currentMaxKmh =
      sectorSamples.length > 0 || isActive ? Math.round(peak) : null;
    const deltaKmh =
      currentMaxKmh !== null && refMaxKmh !== null
        ? Math.round(currentMaxKmh - refMaxKmh)
        : null;

    return {
      index: sec.index,
      shortLabel: sec.shortLabel,
      label: sec.label,
      status: isActive ? 'active' : 'completed',
      currentMaxKmh,
      refMaxKmh,
      deltaKmh,
    };
  });
}

export interface TelemetryCriticalPoint {
  type: 'TOP' | 'BRK' | 'APEX';
  distM: number;
  speedKmh: number;
  longG: number;
}

/**
 * Detecta automaticamente os pontos críticos de telemetria sobre a curva:
 * - TOP: pico de velocidade máxima
 * - BRK: início de frenagem forte (accelLongG < -0.35G)
 * - APEX: menor velocidade no fundo de cada curva
 */
export function detectTelemetryCriticalPoints(
  rawSamples: VelocitySample[]
): TelemetryCriticalPoint[] {
  const samples = ensureTraceGForces(rawSamples);
  if (samples.length < 4) return [];

  const totalDistM = Math.max(100, samples[samples.length - 1].distKm * 1000);
  const minSpacingM = Math.max(70, totalDistM * 0.08);
  const points: TelemetryCriticalPoint[] = [];

  // 1. TOP SPEED
  let topIdx = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i].speedKmh || 0) > (samples[topIdx].speedKmh || 0)) {
      topIdx = i;
    }
  }
  const topSample = samples[topIdx];
  if ((topSample.speedKmh || 0) >= 20) {
    points.push({
      type: 'TOP',
      distM: Math.round(topSample.distKm * 1000),
      speedKmh: Math.round(topSample.speedKmh),
      longG: Number((topSample.accelLongG ?? 0).toFixed(2)),
    });
  }

  // 2. BRK (Strong Braking Onset: accelLongG < -0.35G)
  const brkCandidates: Array<{ distM: number; speedKmh: number; longG: number; severity: number }> = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prevG = samples[i - 1].accelLongG ?? 0;
    const currG = samples[i].accelLongG ?? 0;
    if (currG < -0.35 && prevG >= -0.35) {
      // Scan forward slightly for peak deceleration within this braking zone
      let minG = currG;
      for (let k = i; k < Math.min(samples.length, i + 6); k += 1) {
        const g = samples[k].accelLongG ?? 0;
        if (g >= -0.15) break;
        if (g < minG) minG = g;
      }
      brkCandidates.push({
        distM: Math.round(samples[i].distKm * 1000),
        speedKmh: Math.round(samples[i].speedKmh),
        longG: Number(minG.toFixed(2)),
        severity: Math.abs(minG),
      });
    }
  }

  const chosenBrk: TelemetryCriticalPoint[] = [];
  for (const cand of brkCandidates.sort((a, b) => b.severity - a.severity)) {
    if (chosenBrk.length >= 5) break;
    const tooClose =
      chosenBrk.some((p) => Math.abs(p.distM - cand.distM) < minSpacingM) ||
      points.some((p) => p.type === 'TOP' && Math.abs(p.distM - cand.distM) < totalDistM * 0.035);
    if (!tooClose) {
      chosenBrk.push({
        type: 'BRK',
        distM: cand.distM,
        speedKmh: cand.speedKmh,
        longG: cand.longG,
      });
    }
  }
  points.push(...chosenBrk);

  // 3. APEX (Local curve speed minima after noticeable deceleration)
  const apexCandidates: Array<{ distM: number; speedKmh: number; longG: number; drop: number }> = [];
  for (let i = 2; i < samples.length - 2; i += 1) {
    const curr = samples[i].speedKmh || 0;
    const prev = samples[i - 1].speedKmh || 0;
    const next = samples[i + 1].speedKmh || 0;
    if (curr <= prev && curr < next && curr >= 8) {
      let localMaxBefore = curr;
      for (let b = Math.max(0, i - 12); b < i; b += 1) {
        localMaxBefore = Math.max(localMaxBefore, samples[b].speedKmh || 0);
      }
      const drop = localMaxBefore - curr;
      if (drop >= 10) {
        apexCandidates.push({
          distM: Math.round(samples[i].distKm * 1000),
          speedKmh: Math.round(curr),
          longG: Number((samples[i].accelLongG ?? 0).toFixed(2)),
          drop,
        });
      }
    }
  }

  const chosenApex: TelemetryCriticalPoint[] = [];
  for (const cand of apexCandidates.sort((a, b) => b.drop - a.drop)) {
    if (chosenApex.length >= 5) break;
    const tooClose =
      chosenApex.some((p) => Math.abs(p.distM - cand.distM) < minSpacingM) ||
      points.some((p) => Math.abs(p.distM - cand.distM) < totalDistM * 0.03);
    if (!tooClose) {
      chosenApex.push({
        type: 'APEX',
        distM: cand.distM,
        speedKmh: cand.speedKmh,
        longG: cand.longG,
      });
    }
  }
  points.push(...chosenApex);

  return points.sort((a, b) => a.distM - b.distM);
}

export interface LapDeltaSample {
  distM: number;
  timeDeltaSec: number; // < 0 = ganho (mais rápido), > 0 = atraso (mais lento)
  speedDeltaKmh: number;
}

export function computeLapDeltaSeries(
  refSamples: VelocitySample[],
  targetSamples: VelocitySample[],
  stepCount = 130
): LapDeltaSample[] {
  if (refSamples.length < 2 || targetSamples.length < 2) return [];
  const refMaxKm = refSamples[refSamples.length - 1].distKm;
  const tgtMaxKm = targetSamples[targetSamples.length - 1].distKm;
  const commonMaxKm = Math.min(refMaxKm, tgtMaxKm);
  if (commonMaxKm <= 0.02) return [];

  const out: LapDeltaSample[] = [];
  for (let i = 0; i <= stepCount; i += 1) {
    const dKm = (i / stepCount) * commonMaxKm;
    const sRef = interpolateSampleAtDist(refSamples, dKm);
    const sTgt = interpolateSampleAtDist(targetSamples, dKm);
    if (!sRef || !sTgt) continue;
    out.push({
      distM: Math.round(dKm * 1000),
      timeDeltaSec: Number(((sTgt.stageElapsedMs - sRef.stageElapsedMs) / 1000).toFixed(2)),
      speedDeltaKmh: Math.round(sTgt.speedKmh - sRef.speedKmh),
    });
  }
  return out;
}

export interface LapTelemetrySummaryCard {
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  bestAdvantageSec: number | null;
  worstDelaySec: number | null;
  accelPct: number;
  brakePct: number;
}

export function computeLapTelemetrySummary(
  run: VelocityRun,
  deltaSeries?: LapDeltaSample[]
): LapTelemetrySummaryCard {
  const samples = ensureTraceGForces(run.samples);
  let totalTimeMs = 0;
  let accelTimeMs = 0;
  let brakeTimeMs = 0;

  for (let i = 1; i < samples.length; i += 1) {
    const dt = Math.max(10, samples[i].stageElapsedMs - samples[i - 1].stageElapsedMs);
    const g = samples[i].accelLongG ?? 0;
    totalTimeMs += dt;
    if (g > 0.05) accelTimeMs += dt;
    else if (g < -0.05) brakeTimeMs += dt;
  }

  const accelPct = totalTimeMs > 0 ? Math.round((accelTimeMs / totalTimeMs) * 100) : 0;
  const brakePct = totalTimeMs > 0 ? Math.round((brakeTimeMs / totalTimeMs) * 100) : 0;

  let bestAdvantageSec: number | null = null;
  let worstDelaySec: number | null = null;
  if (deltaSeries && deltaSeries.length > 0) {
    let minD = 0;
    let maxD = 0;
    for (const pt of deltaSeries) {
      if (pt.timeDeltaSec < minD) minD = pt.timeDeltaSec;
      if (pt.timeDeltaSec > maxD) maxD = pt.timeDeltaSec;
    }
    bestAdvantageSec = Number(minD.toFixed(2));
    worstDelaySec = Number(maxD.toFixed(2));
  }

  const maxSpeedKmh =
    run.maxSpeedKmh > 0
      ? Math.round(run.maxSpeedKmh)
      : Math.round(samples.reduce((m, s) => Math.max(m, s.speedKmh || 0), 0));
  const avgSpeedKmh =
    run.avgSpeedKmh > 0
      ? Math.round(run.avgSpeedKmh)
      : samples.length > 0
        ? Math.round(samples.reduce((sum, s) => sum + (s.speedKmh || 0), 0) / samples.length)
        : 0;

  return {
    maxSpeedKmh,
    avgSpeedKmh,
    bestAdvantageSec,
    worstDelaySec,
    accelPct,
    brakePct,
  };
}

export interface BrakingPointOffset {
  refBrakeM: number;
  cmpBrakeM: number;
  offsetM: number; // > 0 = freou mais tarde; < 0 = freou antes
}

function extractBrakingOnsetsM(rawSamples: VelocitySample[]): number[] {
  const samples = ensureTraceGForces(rawSamples);
  if (samples.length < 4) return [];
  const onsets: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prevG = samples[i - 1].accelLongG ?? 0;
    const currG = samples[i].accelLongG ?? 0;
    if (currG < -0.25 && prevG >= -0.25) {
      const dM = Math.round(samples[i].distKm * 1000);
      const last = onsets[onsets.length - 1];
      if (last === undefined || dM - last >= 55) {
        onsets.push(dM);
      }
    }
  }
  return onsets;
}

/**
 * Calcula quantos metros antes (-) ou depois (+) a volta comparada iniciou a frenagem
 * em relação à volta de referência próximo à posição atual do cursor.
 */
export function computeBrakePointOffsetNearDist(
  refSamples: VelocitySample[],
  cmpSamples: VelocitySample[],
  cursorDistM: number
): BrakingPointOffset | null {
  const refOnsets = extractBrakingOnsetsM(refSamples);
  const cmpOnsets = extractBrakingOnsetsM(cmpSamples);
  if (refOnsets.length === 0 || cmpOnsets.length === 0) return null;

  let nearestRef: number | null = null;
  let bestRefDist = Infinity;
  for (const rM of refOnsets) {
    const diff = Math.abs(rM - cursorDistM);
    if (diff <= 220 && diff < bestRefDist) {
      bestRefDist = diff;
      nearestRef = rM;
    }
  }
  if (nearestRef === null) return null;

  let nearestCmp: number | null = null;
  let bestCmpDiff = Infinity;
  for (const cM of cmpOnsets) {
    const diff = Math.abs(cM - nearestRef);
    if (diff <= 95 && diff < bestCmpDiff) {
      bestCmpDiff = diff;
      nearestCmp = cM;
    }
  }
  if (nearestCmp === null) return null;

  return {
    refBrakeM: nearestRef,
    cmpBrakeM: nearestCmp,
    offsetM: Math.round(nearestCmp - nearestRef),
  };
}

