import * as turf from '@turf/turf';
import {
  DEFAULT_TRACK_PALETTE,
  extractTrackKmOnlyDescription,
  formatImportedTrackNamesList,
  parseGpxOrGeoJsonToGeoResult,
  parseKmlColorToHex,
  parseKmlToGeoResult,
  parseTrackFileToGeoResult,
  type GeoWaypoint,
  type ParsedGeoImportResult,
} from './geoKmlParser';

export {
  DEFAULT_TRACK_PALETTE,
  extractTrackKmOnlyDescription,
  formatImportedTrackNamesList,
  parseGpxOrGeoJsonToGeoResult,
  parseKmlColorToHex,
  parseKmlToGeoResult,
  parseTrackFileToGeoResult,
  type GeoWaypoint,
  type ParsedGeoImportResult,
};

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
  description?: string;
  color?: string;
  waypoints?: GeoWaypoint[];
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

export const MIN_TRAP_HALF_WIDTH_M = 20; // Mínimo 20m para cada lado do eixo da pista (40m total)
export const DEFAULT_TRAP_WIDTH_M = 40; // Padrão 40m total (20m para cada lado do eixo)

export interface TrapCrossingResult {
  crossed: boolean;
  t: number; // 0..1 interpolation factor between prev and curr
  crossTimestampMs: number;
  crossLat: number;
  crossLon: number;
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
  imu?: { longG: number; latG: number } | null;
}

export interface GpsKalmanOutput {
  lat: number;
  lon: number;
  distStepM: number;
  speedKmh: number;
  headingDeg: number | null;
  accuracyM: number | null;
  movementDetected: boolean;
  zeroSpeedLocked?: boolean;
}

export interface GpsKalman10HzPrediction {
  lat: number;
  lon: number;
  speedKmh: number;
  headingDeg: number | null;
  zeroSpeedLocked: boolean;
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
 * 2D Kalman Filter (East/North local tangent plane in meters) with IMU Fusion,
 * 10 Hz visual kinematic propagation, and Zero-Speed Anti-Drift Lock (< 2.0 km/h within accuracy).
 */
export function createGpsKalmanProcessor() {
  let origin: { lat: number; lon: number; cosLat: number } | null = null;
  let eastState: AxisKalmanState | null = null;
  let northState: AxisKalmanState | null = null;
  let lastTsMs = 0;
  let lastFilteredPos: { lat: number; lon: number } | null = null;
  let zeroLockAnchor: { lat: number; lon: number } | null = null;
  let odoAnchor: { lat: number; lon: number } | null = null;
  let headingAnchor: { lat: number; lon: number } | null = null;
  let currentHeadingDeg: number | null = null;
  let emaSpeedKmh = 0;
  let zeroSpeedLocked = true;

  const METERS_PER_DEG_LAT = 111320;
  const G_TO_MS2 = 9.80665;

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

  const projectImuEnu = (
    imu?: { longG: number; latG: number } | null,
    headingDeg?: number | null
  ): { aEast: number; aNorth: number } => {
    if (!imu || headingDeg === null || headingDeg === undefined || !Number.isFinite(headingDeg)) {
      return { aEast: 0, aNorth: 0 };
    }
    const longMs2 =
      Math.abs(imu.longG) > 0.04 ? Math.max(-20, Math.min(20, imu.longG * G_TO_MS2)) : 0;
    const latMs2 =
      Math.abs(imu.latG) > 0.04 ? Math.max(-20, Math.min(20, imu.latG * G_TO_MS2)) : 0;
    const rad = (headingDeg * Math.PI) / 180;
    const fwdX = Math.sin(rad);
    const fwdY = Math.cos(rad);
    const rightX = Math.cos(rad);
    const rightY = -Math.sin(rad);
    return {
      aEast: longMs2 * fwdX + latMs2 * rightX,
      aNorth: longMs2 * fwdY + latMs2 * rightY,
    };
  };

  const stepAxis = (
    st: AxisKalmanState,
    z: number,
    dt: number,
    rVar: number,
    qAccelVar: number,
    accelMs2 = 0
  ): AxisKalmanState => {
    // Predict with IMU acceleration control input
    const dt2 = dt * dt;
    const xPred = st.x + st.v * dt + 0.5 * accelMs2 * dt2;
    const vPred = st.v + accelMs2 * dt;

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
    zeroLockAnchor = null;
    odoAnchor = null;
    headingAnchor = null;
    currentHeadingDeg = null;
    emaSpeedKmh = 0;
    zeroSpeedLocked = true;
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
      !zeroLockAnchor ||
      ts - lastTsMs > 15000 ||
      haversineMetersVel(lastFilteredPos.lat, lastFilteredPos.lon, input.lat, input.lon) > 500;

    if (needsReset) {
      origin = {
        lat: input.lat,
        lon: input.lon,
        cosLat: Math.max(0.1, Math.cos((input.lat * Math.PI) / 180)),
      };
      const initR = Math.pow(Math.min(25, Math.max(1.5, accM ?? 5)), 2);
      eastState = { x: 0, v: 0, p00: initR, p01: 0, p10: 0, p11: 4 };
      northState = { x: 0, v: 0, p00: initR, p01: 0, p10: 0, p11: 4 };
      lastTsMs = ts;
      lastFilteredPos = { lat: input.lat, lon: input.lon };
      zeroLockAnchor = { lat: input.lat, lon: input.lon };
      odoAnchor = { lat: input.lat, lon: input.lon };
      headingAnchor = { lat: input.lat, lon: input.lon };
      if (input.rawHeadingDeg !== null && Number.isFinite(input.rawHeadingDeg)) {
        currentHeadingDeg = Math.round(((input.rawHeadingDeg % 360) + 360) % 360);
      }
      zeroSpeedLocked = dopplerKmh < 2.0;
      emaSpeedKmh = zeroSpeedLocked ? 0 : dopplerKmh;
      return {
        lat: input.lat,
        lon: input.lon,
        distStepM: 0,
        speedKmh: emaSpeedKmh,
        headingDeg: currentHeadingDeg,
        accuracyM: accM !== null ? Math.round(accM) : null,
        movementDetected: !zeroSpeedLocked,
        zeroSpeedLocked,
      };
    }

    const dtSec = Math.min(5, Math.max(0.03, (ts - lastTsMs) / 1000));
    const local = toLocalMeters(input.lat, input.lon);
    const innovationM = Math.hypot(local.eastM - eastState!.x, local.northM - northState!.x);

    const sigmaM = Math.min(35, Math.max(1.5, accM ?? 6)) * 0.68;
    const rVar = sigmaM * sigmaM;

    const imuEnu = !zeroSpeedLocked
      ? projectImuEnu(input.imu, currentHeadingDeg ?? input.rawHeadingDeg)
      : { aEast: 0, aNorth: 0 };

    const activeMotionSignal =
      dopplerKmh >= 2.0 ||
      innovationM >= Math.max(1.2, Math.min(8, (accM ?? 5) * 0.75));
    const qAccelVar = activeMotionSignal ? 14.0 : 0.05;

    eastState = stepAxis(eastState!, local.eastM, dtSec, rVar, qAccelVar, imuEnu.aEast);
    northState = stepAxis(northState!, local.northM, dtSec, rVar, qAccelVar, imuEnu.aNorth);

    const filtRaw = toLatLon(eastState.x, northState.x);

    // Zero-Speed Anti-Drift Lock:
    // Se speed < 2.0 km/h e deslocamento dentro da margem de erro de accuracy,
    // trava velocidade em 0.0 km/h e impede acúmulo de distância fantasma.
    const accuracyMarginM = Math.max(1.5, Math.min(18, (accM ?? 5) * 0.85));
    const zeroAnchorDistM = haversineMetersVel(
      zeroLockAnchor!.lat,
      zeroLockAnchor!.lon,
      input.lat,
      input.lon
    );
    const kalmanVelKmh = Math.hypot(eastState.v, northState.v) * 3.6;

    const shouldLockZero =
      dopplerKmh < 2.0 &&
      kalmanVelKmh < 2.2 &&
      zeroAnchorDistM <= accuracyMarginM;

    if (shouldLockZero) {
      zeroSpeedLocked = true;
      emaSpeedKmh = 0;
      const lockedLocal = toLocalMeters(zeroLockAnchor!.lat, zeroLockAnchor!.lon);
      eastState = { ...eastState, x: lockedLocal.eastM, v: 0 };
      northState = { ...northState, x: lockedLocal.northM, v: 0 };
      lastTsMs = ts;
      lastFilteredPos = { ...zeroLockAnchor! };
      odoAnchor = { ...zeroLockAnchor! };
      return {
        lat: zeroLockAnchor!.lat,
        lon: zeroLockAnchor!.lon,
        distStepM: 0,
        speedKmh: 0,
        headingDeg: currentHeadingDeg,
        accuracyM: accM !== null ? Math.round(accM) : null,
        movementDetected: false,
        zeroSpeedLocked: true,
      };
    }

    zeroSpeedLocked = false;
    zeroLockAnchor = { lat: filtRaw.lat, lon: filtRaw.lon };

    const instStepM = haversineMetersVel(
      lastFilteredPos!.lat,
      lastFilteredPos!.lon,
      filtRaw.lat,
      filtRaw.lon
    );
    const anchorDistM = odoAnchor
      ? haversineMetersVel(odoAnchor.lat, odoAnchor.lon, filtRaw.lat, filtRaw.lon)
      : 0;
    const movementDetected =
      (anchorDistM >= 0.35 && anchorDistM < 500) ||
      (dopplerKmh >= 2.0 && anchorDistM >= 0.1 && anchorDistM < 500);

    let distStepM = 0;
    if (movementDetected && odoAnchor) {
      distStepM = anchorDistM;
      odoAnchor = { lat: filtRaw.lat, lon: filtRaw.lon };
    }

    if (headingAnchor) {
      const hdgDistM = haversineMetersVel(headingAnchor.lat, headingAnchor.lon, filtRaw.lat, filtRaw.lon);
      if (hdgDistM >= 1.2 && hdgDistM < 500) {
        const calcBearing = bearingBetweenDeg(headingAnchor.lat, headingAnchor.lon, filtRaw.lat, filtRaw.lon);
        currentHeadingDeg =
          input.rawHeadingDeg !== null && Number.isFinite(input.rawHeadingDeg) && dopplerKmh >= 5
            ? Math.round(((input.rawHeadingDeg % 360) + 360) % 360)
            : calcBearing;
        headingAnchor = { lat: filtRaw.lat, lon: filtRaw.lon };
      } else if (input.rawHeadingDeg !== null && Number.isFinite(input.rawHeadingDeg) && dopplerKmh >= 6) {
        currentHeadingDeg = Math.round(((input.rawHeadingDeg % 360) + 360) % 360);
      }
    }

    const geomSpeedKmh = dtSec >= 0.03 && instStepM < 500 ? (instStepM / dtSec) * 3.6 : 0;
    const bestGeomKmh = geomSpeedKmh > 0.8 ? geomSpeedKmh : kalmanVelKmh;
    const instSpeedKmh =
      dopplerKmh >= 2.0
        ? bestGeomKmh >= 1.5
          ? 0.68 * dopplerKmh + 0.32 * bestGeomKmh
          : dopplerKmh
        : bestGeomKmh;

    // Higher responsiveness on 10Hz/25Hz receivers, smooth blend on 1Hz
    const emaAlpha = dtSec <= 0.18 ? 0.78 : 0.65;
    emaSpeedKmh = emaAlpha * instSpeedKmh + (1 - emaAlpha) * emaSpeedKmh;

    let finalSpeedKmh = emaSpeedKmh;
    if (finalSpeedKmh < 2.0 && dopplerKmh < 2.0 && zeroAnchorDistM <= accuracyMarginM) {
      finalSpeedKmh = 0;
      emaSpeedKmh = 0;
      zeroSpeedLocked = true;
    }

    lastTsMs = ts;
    lastFilteredPos = { lat: filtRaw.lat, lon: filtRaw.lon };

    return {
      lat: filtRaw.lat,
      lon: filtRaw.lon,
      distStepM: zeroSpeedLocked ? 0 : distStepM,
      speedKmh: finalSpeedKmh,
      headingDeg: currentHeadingDeg,
      accuracyM: accM !== null ? Math.round(accM) : null,
      movementDetected: !zeroSpeedLocked && movementDetected,
      zeroSpeedLocked,
    };
  };

  /**
   * 10 Hz IMU-Kalman kinematic propagation for smooth visual speedometer & live map marker
   * between 1 Hz GPS fixes while preserving Zero-Speed Anti-Drift Lock.
   */
  const predictAt10Hz = (
    nowMs = Date.now(),
    imu?: { longG: number; latG: number } | null
  ): GpsKalman10HzPrediction | null => {
    if (!origin || !eastState || !northState || !lastFilteredPos || lastTsMs <= 0) {
      return null;
    }
    if (zeroSpeedLocked) {
      return {
        lat: (zeroLockAnchor ?? lastFilteredPos).lat,
        lon: (zeroLockAnchor ?? lastFilteredPos).lon,
        speedKmh: 0,
        headingDeg: currentHeadingDeg,
        zeroSpeedLocked: true,
      };
    }

    const elapsedMs = nowMs - lastTsMs;
    if (elapsedMs < 20 || elapsedMs > 2200) {
      return null;
    }
    const dt = Math.min(1.2, elapsedMs / 1000);
    const { aEast, aNorth } = projectImuEnu(imu, currentHeadingDeg);
    const predEast = eastState.x + eastState.v * dt + 0.5 * aEast * dt * dt;
    const predNorth = northState.x + northState.v * dt + 0.5 * aNorth * dt * dt;
    const predPos = toLatLon(predEast, predNorth);

    const vEast = eastState.v + aEast * dt;
    const vNorth = northState.v + aNorth * dt;
    const predSpeedKmh = Math.hypot(vEast, vNorth) * 3.6;
    const blendedSpeed =
      emaSpeedKmh >= 2.0 ? 0.6 * emaSpeedKmh + 0.4 * predSpeedKmh : emaSpeedKmh;

    return {
      lat: predPos.lat,
      lon: predPos.lon,
      speedKmh: blendedSpeed < 2.0 ? 0 : blendedSpeed,
      headingDeg: currentHeadingDeg,
      zeroSpeedLocked: blendedSpeed < 2.0,
    };
  };

  return { update, predictAt10Hz, reset };
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
  larguraM: number; // padrão 40m (20m para cada lado)
  unidirecional?: boolean; // padrão true (±65°)
  rumoVeiculoDeg?: number | null;
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
 * com P1 em (angulo - 90°) e P2 em (angulo + 90°) a pelo menos 20m..25m de cada lado do eixo.
 */
export function buildMarcoGateLineString(
  lat: number,
  lng: number,
  anguloDeg: number,
  larguraM = DEFAULT_TRAP_WIDTH_M
) {
  const halfWidth = Math.max(40, Number.isFinite(larguraM) ? larguraM : DEFAULT_TRAP_WIDTH_M) / 2;
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
  larguraM = DEFAULT_TRAP_WIDTH_M
) {
  const safeWidth = Math.max(40, Number.isFinite(larguraM) ? larguraM : DEFAULT_TRAP_WIDTH_M);
  const arrowLen = Math.max(16, safeWidth * 0.52);
  const barbLen = Math.max(6, safeWidth * 0.18);
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
 * Motor de Detecção de Cruzamento por Interseção Exata de Segmentos de Reta (Plano Tangente ENU):
 * - Verifica se o segmento [pontoAnterior -> pontoAtual] cruza o segmento transversal do Marco [G1 -> G2]
 * - Garante tolerância mínima de 22.5m para cada lado do eixo da pista (>= 45m total)
 * - Valida direção (< 65° em relação a marco.angulo) quando unidirecional === true
 * - Interpola linearmente o timestamp exato (ms) e a coordenada do cruzamento entre os dois pontos GPS
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
    !Number.isFinite(pontoAtual.lng) ||
    !Number.isFinite(marco.lat) ||
    !Number.isFinite(marco.lng)
  ) {
    return null;
  }
  if (pontoAnterior.lat === pontoAtual.lat && pontoAnterior.lng === pontoAtual.lng) {
    return null;
  }

  // Projeção local tangente WGS84 em metros centrada no Marco
  const latRad = (marco.lat * Math.PI) / 180;
  const mPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
  const mPerDegLon = Math.max(
    1,
    111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad)
  );

  const ax = (pontoAnterior.lng - marco.lng) * mPerDegLon;
  const ay = (pontoAnterior.lat - marco.lat) * mPerDegLat;
  const bx = (pontoAtual.lng - marco.lng) * mPerDegLon;
  const by = (pontoAtual.lat - marco.lat) * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const segLenM = Math.hypot(dx, dy);
  if (segLenM < 1e-6) {
    return null;
  }

  const anguloMarco = normalizeAngle360(marco.angulo);
  const angRad = (anguloMarco * Math.PI) / 180;

  // Base ortonormal da linha/portal: fwd = sentido da pista, right = transversal (+90°)
  const fwdX = Math.sin(angRad);
  const fwdY = Math.cos(angRad);
  const rightX = Math.cos(angRad);
  const rightY = -Math.sin(angRad);

  const alongA = ax * fwdX + ay * fwdY;
  const latA = ax * rightX + ay * rightY;
  const alongB = bx * fwdX + by * fwdY;
  const latB = bx * rightX + by * rightY;

  // Tolerância mínima garantida de 22.5m para cada lado do eixo da pista (45m total)
  const halfWidthM = Math.max(
    MIN_TRAP_HALF_WIDTH_M,
    (Number.isFinite(marco.larguraM) ? marco.larguraM : DEFAULT_TRAP_WIDTH_M) / 2
  );

  // Interseção algébrica entre segmento A->B e linha do portal (along = 0, lateral ∈ [-halfWidthM, +halfWidthM])
  const dAlong = alongB - alongA;
  let fatorInterpolacao: number;

  if (Math.abs(dAlong) > 1e-7) {
    const tRaw = -alongA / dAlong;
    if (tRaw < -1e-6 || tRaw > 1 + 1e-6) {
      return null;
    }
    fatorInterpolacao = Math.max(0, Math.min(1, tRaw));
  } else {
    // Caso degenerado: deslocamento colinear sobre a própria linha (along ≈ 0)
    if (Math.abs(alongA) > 0.05) {
      return null;
    }
    const minSegLat = Math.min(latA, latB);
    const maxSegLat = Math.max(latA, latB);
    if (maxSegLat < -halfWidthM || minSegLat > halfWidthM) {
      return null;
    }
    fatorInterpolacao = 0.5;
  }

  const latCross = latA + fatorInterpolacao * (latB - latA);
  if (Math.abs(latCross) > halfWidthM + 1e-4) {
    return null;
  }

  const geomBearing = normalizeAngle360((Math.atan2(dx, dy) * 180) / Math.PI);
  const rumoVeiculo =
    segLenM < 0.6 &&
    marco.rumoVeiculoDeg !== null &&
    marco.rumoVeiculoDeg !== undefined &&
    Number.isFinite(marco.rumoVeiculoDeg)
      ? normalizeAngle360(marco.rumoVeiculoDeg)
      : geomBearing;
  const diferencaAngularDeg = angleDiffDeg(rumoVeiculo, anguloMarco);
  if (marco.unidirecional !== false) {
    if (diferencaAngularDeg > 65) {
      return null;
    }
    // Garante cruzamento real no sentido da pista (de antes da linha para depois da linha)
    if (alongA > 0.25 || alongB < -0.25) {
      return null;
    }
  }

  const dtMs = pontoAtual.timestamp - pontoAnterior.timestamp;
  const timestampCruzamento = Math.round(pontoAnterior.timestamp + fatorInterpolacao * dtMs);
  const crossLng =
    pontoAnterior.lng + fatorInterpolacao * (pontoAtual.lng - pontoAnterior.lng);
  const crossLat =
    pontoAnterior.lat + fatorInterpolacao * (pontoAtual.lat - pontoAnterior.lat);

  return {
    cruzou: true,
    timestampCruzamento,
    fatorInterpolacao,
    pontoIntersecao: [crossLng, crossLat],
    diferencaAngularDeg,
  };
}

/**
 * Vector segment intersection between vehicle movement (prev -> curr)
 * and a virtual Trap gate centered at (trap.lat, trap.lon) with perpendicular width >= 45m
 * (>= 22.5m per side of track axis) and travel direction `trap.bearingDeg`.
 */
export function detectTrapCrossing(
  prev: { lat: number; lon: number; timestampMs: number },
  curr: { lat: number; lon: number; timestampMs: number },
  trap: VelocityTrap,
  options?: {
    hdopAccuracyM?: number | null;
    autoSnap?: boolean;
    vehicleHeadingDeg?: number | null;
  }
): TrapCrossingResult | null {
  const acc = options?.hdopAccuracyM;
  const hdopBonus =
    options?.autoSnap !== false && typeof acc === 'number' && Number.isFinite(acc) && acc > 8
      ? Math.min(10, (acc - 8) * 0.45)
      : 0;
  // Garante mínimo absoluto de 20m para cada lado (40m total) sem alargamento excessivo por HDOP
  const baseTotalWidthM = Math.max(
    MIN_TRAP_HALF_WIDTH_M * 2,
    Number(trap.widthM) || DEFAULT_TRAP_WIDTH_M
  );
  const effectiveWidthM = baseTotalWidthM + hdopBonus;

  const res = verificarCruzamento(
    { lat: prev.lat, lng: prev.lon, timestamp: prev.timestampMs },
    { lat: curr.lat, lng: curr.lon, timestamp: curr.timestampMs },
    {
      lat: trap.lat,
      lng: trap.lon,
      angulo: trap.bearingDeg,
      larguraM: effectiveWidthM,
      unidirecional: trap.unidirectional !== false,
      rumoVeiculoDeg: options?.vehicleHeadingDeg ?? null,
    }
  );
  if (!res) return null;

  const lateralOffsetM = haversineMetersVel(
    trap.lat,
    trap.lon,
    res.pontoIntersecao[1],
    res.pontoIntersecao[0]
  );

  return {
    crossed: true,
    t: res.fatorInterpolacao,
    crossTimestampMs: res.timestampCruzamento,
    crossLat: res.pontoIntersecao[1],
    crossLon: res.pontoIntersecao[0],
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
        const startHit = detectTrapCrossing(prev, curr, startTrap, {
          hdopAccuracyM: 25,
          autoSnap: true,
        });
        if (startHit) {
          startMs = startHit.crossTimestampMs;
          continue;
        }
      }

      if (startMs === null) continue;

      for (const sp of ordered) {
        if (sp.kind !== 'split' || splits[sp.id] !== undefined) continue;
        const spHit = detectTrapCrossing(prev, curr, sp, {
          hdopAccuracyM: 30,
          autoSnap: true,
        });
        if (spHit && spHit.crossTimestampMs >= startMs) {
          splits[sp.id] = spHit.crossTimestampMs - startMs;
        }
      }

      const finHit = detectTrapCrossing(prev, curr, finishTrap, {
        hdopAccuracyM: 30,
        autoSnap: true,
      });
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
          const spHit = detectTrapCrossing(prev, curr, sp, {
            hdopAccuracyM: 30,
            autoSnap: true,
          });
          if (spHit && spHit.crossTimestampMs >= fallbackStart) {
            splits[sp.id] = spHit.crossTimestampMs - fallbackStart;
          }
        }
        const finHit = detectTrapCrossing(prev, curr, finishTrap, {
          hdopAccuracyM: 30,
          autoSnap: true,
        });
        if (finHit && finHit.crossTimestampMs - fallbackStart >= 1000) {
          startMs = fallbackStart;
          finishMs = finHit.crossTimestampMs;
          splits[finishTrap.id] = finishMs - startMs;
          break;
        }
      }
    }

    // Nearest-sample fallback for any intermediate split still missing when run completed cleanly
    const resolvedTotalMs =
      startMs !== null && finishMs !== null && finishMs > startMs ? finishMs - startMs : run.totalMs;
    if (resolvedTotalMs > 0) {
      const baseStart = startMs ?? run.startedAtMs ?? run.samples[0].timestampMs;
      for (const sp of ordered) {
        if (sp.kind !== 'split' || splits[sp.id] !== undefined) continue;
        let minDistM = Infinity;
        let nearestElapsedMs: number | null = null;
        for (let i = 1; i < run.samples.length; i += 1) {
          const s = run.samples[i];
          const dM = haversineMetersVel(s.lat, s.lon, sp.lat, sp.lon);
          if (dM < minDistM) {
            minDistM = dM;
            nearestElapsedMs =
              Number.isFinite(s.stageElapsedMs) && s.stageElapsedMs > 0
                ? s.stageElapsedMs
                : Math.max(0, s.timestampMs - baseStart);
          }
        }
        if (minDistM <= 140 && nearestElapsedMs !== null) {
          splits[sp.id] = nearestElapsedMs;
        }
      }
      if (splits[finishTrap.id] === undefined) {
        splits[finishTrap.id] = resolvedTotalMs;
      }
    }

    if (startMs !== null && finishMs !== null && finishMs > startMs) {
      let updatedSamples = run.samples;
      // Garante ponto final interpolado exatamente sobre a linha de chegada C quando o último ponto passar do portal
      const lastRaw = run.samples[run.samples.length - 1];
      if (lastRaw && lastRaw.timestampMs > finishMs) {
        const preFinIdx = run.samples.findIndex((s) => s.timestampMs >= finishMs!);
        if (preFinIdx > 0) {
          const prevS = run.samples[preFinIdx - 1];
          const currS = run.samples[preFinIdx];
          const finCross = detectTrapCrossing(prevS, currS, finishTrap, {
            hdopAccuracyM: 12,
            autoSnap: true,
          });
          if (finCross) {
            const segFinKm =
              haversineMetersVel(prevS.lat, prevS.lon, finCross.crossLat, finCross.crossLon) /
              1000;
            const finSample: VelocitySample = {
              ...prevS,
              lat: finCross.crossLat,
              lon: finCross.crossLon,
              speedKmh: prevS.speedKmh + finCross.t * (currS.speedKmh - prevS.speedKmh),
              timestampMs: finCross.crossTimestampMs,
              distKm: Math.max(prevS.distKm, prevS.distKm + segFinKm),
              stageElapsedMs: finishMs - startMs,
            };
            updatedSamples = [...run.samples.slice(0, preFinIdx), finSample];
          }
        }
      }
      return {
        ...run,
        startedAtMs: startMs,
        finishedAtMs: finishMs,
        totalMs: finishMs - startMs,
        splitTimesMs: splits,
        samples: updatedSamples,
      };
    }

    if (Object.keys(splits).length > Object.keys(run.splitTimesMs ?? {}).length) {
      return {
        ...run,
        splitTimesMs: { ...run.splitTimesMs, ...splits },
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
    return '--:--.--';
  }
  const totalHundredths = Math.floor(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSec = Math.floor(totalHundredths / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);
  if (hours > 0) {
    return `${hours}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

export function formatDeltaSeconds(deltaSec: number | null): string {
  if (deltaSec === null || !Number.isFinite(deltaSec)) return '--.--s';
  if (Math.abs(deltaSec) < 0.005) return '0.00s';
  const sign = deltaSec < 0 ? '-' : '+';
  return `${sign}${Math.abs(deltaSec).toFixed(2)}s`;
}

export function formatCleanTrackName(rawName: string): string {
  if (!rawName) return '';
  return rawName
    .replace(/\s*\((?:ponto-a-ponto|circuito)\)\s*/gi, ' ')
    .replace(/\s*[-–·]?\s*ponto-a-ponto\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function loadVelocityTracks(): VelocityTrack[] {
  try {
    const raw = localStorage.getItem(TRACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as VelocityTrack[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => ({
      ...t,
      name: formatCleanTrackName(t.name) || t.name,
    }));
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

function geoImportToSingleTrack(
  res: ParsedGeoImportResult,
  fallbackName: string
): VelocityTrack {
  if (res.tracks.length > 0) {
    return res.tracks[0];
  }
  if (res.waypoints.length >= 2) {
    const traps: VelocityTrap[] = res.waypoints.map((wp, idx) => ({
      id: wp.id,
      name: wp.name,
      kind:
        idx === 0
          ? 'start'
          : idx === res.waypoints.length - 1
            ? 'finish'
            : 'split',
      lat: wp.lat,
      lon: wp.lon,
      bearingDeg:
        idx < res.waypoints.length - 1
          ? bearingBetweenDeg(
              wp.lat,
              wp.lon,
              res.waypoints[idx + 1].lat,
              res.waypoints[idx + 1].lon
            )
          : bearingBetweenDeg(
              res.waypoints[idx - 1].lat,
              res.waypoints[idx - 1].lon,
              wp.lat,
              wp.lon
            ),
      widthM: 40,
      unidirectional: true,
    }));
    return {
      id: `trk_${Date.now()}`,
      name: res.documentName || fallbackName,
      mode: 'point-to-point',
      traps,
      createdAtMs: Date.now(),
      referenceDistanceKm: 0,
    };
  }
  throw new Error('Arquivo sem trilha (<LineString> / <trk>) válida para criação de pista.');
}

export function parseGpxOrGeoJsonToTrack(
  content: string,
  fileName: string
): VelocityTrack {
  const res = parseGpxOrGeoJsonToGeoResult(content, fileName);
  return geoImportToSingleTrack(res, fileName.replace(/\.(geojson|json|gpx)$/i, ''));
}

/**
 * Parses Google Earth / QGIS / GPS .KML XML into a PitStop-Sports VelocityTrack
 */
export function parseKmlToTrack(kmlXml: string, fileName: string): VelocityTrack {
  const res = parseKmlToGeoResult(kmlXml, fileName);
  return geoImportToSingleTrack(res, fileName.replace(/\.(kml|kmz)$/i, ''));
}

/**
 * Unified Especial Track Importer supporting .KML, .KMZ, .GPX and .GeoJSON/.JSON
 */
export async function parseTrackFileToTrack(file: File): Promise<VelocityTrack> {
  const res = await parseTrackFileToGeoResult(file);
  return geoImportToSingleTrack(res, file.name.replace(/\.(kml|kmz|gpx|geojson|json)$/i, ''));
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
    name: 'SS-01 Serra Velha',
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
        widthM: 50,
      },
      {
        id: 'demo_split_1',
        name: 'Parcial 1',
        kind: 'split',
        lat: waypoints[5].lat,
        lon: waypoints[5].lon,
        bearingDeg: s1Bearing,
        widthM: 50,
      },
      {
        id: 'demo_split_2',
        name: 'Parcial 2',
        kind: 'split',
        lat: waypoints[9].lat,
        lon: waypoints[9].lon,
        bearingDeg: s2Bearing,
        widthM: 50,
      },
      {
        id: 'demo_finish',
        name: 'Chegada SS-01',
        kind: 'finish',
        lat: waypoints[12].lat,
        lon: waypoints[12].lon,
        bearingDeg: finBearing,
        widthM: 50,
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
          widthM: 50,
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
        widthM: 50,
        unidirectional: true,
      },
      {
        id: `trap_finish_auto_${track.id}`,
        name: 'Chegada (Finish)',
        kind: 'finish',
        lat: pEnd.lat,
        lon: pEnd.lon,
        bearingDeg: endBearing,
        widthM: 50,
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

export interface MapSpeedBadgePoint {
  lat: number;
  lon: number;
  distM: number;
  speedKmh: number;
  kind: 'peak' | 'apex';
}

/**
 * Extrai etiquetas numéricas de velocidade críticas para plotagem no mapa estilo RaceChrono:
 * - peak (verde): picos de velocidade máxima antes de zonas de frenagem
 * - apex (vermelho): pontos de menor velocidade no ápice de curvas
 */
export function extractMapSpeedBadges(
  rawSamples: VelocitySample[]
): MapSpeedBadgePoint[] {
  const samples = ensureTraceGForces(rawSamples);
  if (samples.length < 6) return [];

  const totalDistM = Math.max(100, samples[samples.length - 1].distKm * 1000);
  const minPeakSpacingM = Math.max(65, totalDistM * 0.085);
  const badges: MapSpeedBadgePoint[] = [];

  const peakCandidates: Array<{ idx: number; distM: number; speedKmh: number }> = [];
  const apexCandidates: Array<{ idx: number; distM: number; speedKmh: number; drop: number }> = [];

  for (let i = 2; i < samples.length - 2; i += 1) {
    const curr = samples[i].speedKmh || 0;
    const prev = samples[i - 1].speedKmh || 0;
    const next = samples[i + 1].speedKmh || 0;

    // Local peak before deceleration
    if (curr >= prev && curr > next && curr >= 22) {
      let minAfter = curr;
      for (let f = i + 1; f < Math.min(samples.length, i + 14); f += 1) {
        minAfter = Math.min(minAfter, samples[f].speedKmh || 0);
      }
      if (curr - minAfter >= 7) {
        peakCandidates.push({
          idx: i,
          distM: Math.round(samples[i].distKm * 1000),
          speedKmh: Math.round(curr),
        });
      }
    }

    // Local corner apex minimum after deceleration
    if (curr <= prev && curr < next && curr >= 6) {
      let maxBefore = curr;
      for (let b = Math.max(0, i - 14); b < i; b += 1) {
        maxBefore = Math.max(maxBefore, samples[b].speedKmh || 0);
      }
      const drop = maxBefore - curr;
      if (drop >= 9) {
        apexCandidates.push({
          idx: i,
          distM: Math.round(samples[i].distKm * 1000),
          speedKmh: Math.round(curr),
          drop,
        });
      }
    }
  }

  // Always include global top speed if not already captured
  let globalTopIdx = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i].speedKmh || 0) > (samples[globalTopIdx].speedKmh || 0)) {
      globalTopIdx = i;
    }
  }
  if ((samples[globalTopIdx].speedKmh || 0) >= 20) {
    peakCandidates.push({
      idx: globalTopIdx,
      distM: Math.round(samples[globalTopIdx].distKm * 1000),
      speedKmh: Math.round(samples[globalTopIdx].speedKmh),
    });
  }

  const chosenPeaks: MapSpeedBadgePoint[] = [];
  for (const cand of peakCandidates.sort((a, b) => b.speedKmh - a.speedKmh)) {
    if (chosenPeaks.length >= 6) break;
    const s = samples[cand.idx];
    const tooClose = chosenPeaks.some(
      (p) => haversineMetersVel(p.lat, p.lon, s.lat, s.lon) < minPeakSpacingM
    );
    if (!tooClose) {
      chosenPeaks.push({
        lat: s.lat,
        lon: s.lon,
        distM: cand.distM,
        speedKmh: cand.speedKmh,
        kind: 'peak',
      });
    }
  }

  const chosenApexes: MapSpeedBadgePoint[] = [];
  for (const cand of apexCandidates.sort((a, b) => b.drop - a.drop)) {
    if (chosenApexes.length >= 6) break;
    const s = samples[cand.idx];
    const tooClose =
      chosenApexes.some(
        (p) => haversineMetersVel(p.lat, p.lon, s.lat, s.lon) < minPeakSpacingM
      ) ||
      chosenPeaks.some((p) => haversineMetersVel(p.lat, p.lon, s.lat, s.lon) < 35);
    if (!tooClose) {
      chosenApexes.push({
        lat: s.lat,
        lon: s.lon,
        distM: cand.distM,
        speedKmh: cand.speedKmh,
        kind: 'apex',
      });
    }
  }

  badges.push(...chosenPeaks, ...chosenApexes);
  return badges.sort((a, b) => a.distM - b.distM);
}

export interface FrictionCircleMetrics {
  peakBrakeG: number;
  peakAccelG: number;
  peakLatG: number;
  peakCombinedG: number;
  trailBrakingPct: number;
}

/**
 * Calcula picos e eficiência do Círculo de Atrito (Diagrama G-G) para uma volta.
 */
export function computeFrictionCircleMetrics(
  rawSamples: VelocitySample[]
): FrictionCircleMetrics {
  const samples = ensureTraceGForces(rawSamples);
  if (samples.length === 0) {
    return {
      peakBrakeG: 0,
      peakAccelG: 0,
      peakLatG: 0,
      peakCombinedG: 0,
      trailBrakingPct: 0,
    };
  }

  let peakBrakeG = 0;
  let peakAccelG = 0;
  let peakLatG = 0;
  let peakCombinedG = 0;
  let cornerSamples = 0;
  let trailBrakeSamples = 0;

  for (const s of samples) {
    const longG = s.accelLongG ?? 0;
    const latG = s.accelLatG ?? 0;
    const absLat = Math.abs(latG);
    const combined = Math.hypot(latG, longG);

    if (longG < peakBrakeG) peakBrakeG = longG;
    if (longG > peakAccelG) peakAccelG = longG;
    if (absLat > peakLatG) peakLatG = absLat;
    if (combined > peakCombinedG) peakCombinedG = combined;

    if (absLat >= 0.25 || longG <= -0.25) {
      cornerSamples += 1;
      if (absLat >= 0.2 && longG <= -0.15) {
        trailBrakeSamples += 1;
      }
    }
  }

  return {
    peakBrakeG: Number(peakBrakeG.toFixed(2)),
    peakAccelG: Number(peakAccelG.toFixed(2)),
    peakLatG: Number(peakLatG.toFixed(2)),
    peakCombinedG: Number(peakCombinedG.toFixed(2)),
    trailBrakingPct:
      cornerSamples > 0 ? Math.round((trailBrakeSamples / cornerSamples) * 100) : 0,
  };
}

export interface CornerBrakingLapEntry {
  slot: 1 | 2 | 3;
  runNumber: number;
  brakeStartDistM: number;
  entrySpeedKmh: number;
  apexDistM: number;
  apexSpeedKmh: number;
  exitSpeedKmh: number;
  deltaEntryKmh: number | null;
  deltaApexKmh: number | null;
  deltaExitKmh: number | null;
  brakeShiftM: number | null; // >0 = freou mais tarde, <0 = freou antes
}

export interface TrackCornerAnalysis {
  cornerIndex: number;
  label: string;
  refApexDistM: number;
  refBrakeStartM: number;
  entries: CornerBrakingLapEntry[];
}

function measureCornerWindowForSamples(
  samples: VelocitySample[],
  refApexDistKm: number,
  maxLapDistKm: number
): {
  brakeStartDistM: number;
  entrySpeedKmh: number;
  apexDistM: number;
  apexSpeedKmh: number;
  exitSpeedKmh: number;
} | null {
  if (samples.length < 4) return null;

  // 1. Ápice (velocidade mínima dentro de ±45m do ápice de referência)
  const apexWinStartKm = Math.max(0, refApexDistKm - 0.045);
  const apexWinEndKm = Math.min(maxLapDistKm, refApexDistKm + 0.045);

  let apexSample = interpolateSampleAtDist(samples, refApexDistKm);
  let apexMinSpd = apexSample ? apexSample.speedKmh : Infinity;

  for (const s of samples) {
    if (s.distKm >= apexWinStartKm && s.distKm <= apexWinEndKm) {
      if (s.speedKmh < apexMinSpd) {
        apexMinSpd = s.speedKmh;
        apexSample = s;
      }
    }
  }
  if (!apexSample) return null;

  const actualApexKm = apexSample.distKm;
  const apexDistM = Math.round(actualApexKm * 1000);
  const apexSpeedKmh = Math.round(apexSample.speedKmh);

  // 2. Entrada / Início da Frenagem (busca até 180m antes do ápice)
  const entryScanStartKm = Math.max(0, actualApexKm - 0.18);
  const preCornerSamples = samples.filter(
    (s) => s.distKm >= entryScanStartKm && s.distKm <= actualApexKm
  );

  let entryPeakSample = preCornerSamples[0] ?? apexSample;
  for (const s of preCornerSamples) {
    if (s.speedKmh > entryPeakSample.speedKmh) {
      entryPeakSample = s;
    }
  }

  // Procura onde a desaceleração forte começa após o pico de velocidade de entrada
  let brakeStartSample = entryPeakSample;
  for (const s of preCornerSamples) {
    if (s.distKm >= entryPeakSample.distKm && (s.accelLongG ?? 0) <= -0.18) {
      brakeStartSample = s;
      break;
    }
  }

  const brakeStartDistM = Math.round(brakeStartSample.distKm * 1000);
  const entrySpeedKmh = Math.round(
    Math.max(entryPeakSample.speedKmh, brakeStartSample.speedKmh)
  );

  // 3. Saída de Curva (velocidade atingida entre +35m e +85m após o ápice)
  const exitTargetKm = Math.min(maxLapDistKm, actualApexKm + 0.065);
  const exitWindowSamples = samples.filter(
    (s) => s.distKm >= actualApexKm + 0.015 && s.distKm <= Math.min(maxLapDistKm, actualApexKm + 0.09)
  );
  let exitSpeedVal = interpolateSampleAtDist(samples, exitTargetKm)?.speedKmh ?? apexSample.speedKmh;
  for (const s of exitWindowSamples) {
    if (s.speedKmh > exitSpeedVal) {
      exitSpeedVal = s.speedKmh;
    }
  }

  return {
    brakeStartDistM,
    entrySpeedKmh,
    apexDistM,
    apexSpeedKmh,
    exitSpeedKmh: Math.round(exitSpeedVal),
  };
}

/**
 * Identifica automaticamente as principais curvas e zonas de frenagem da volta de referência
 * e compara Entrada (Início Frenagem), Ápice (Mínima) e Saída entre V1, V2 e V3.
 */
export function analyzeTrackCornersAndBraking(
  laps: Array<{ slot: 1 | 2 | 3; runNumber: number; samples: VelocitySample[] }>
): TrackCornerAnalysis[] {
  const refLap = laps.find((l) => l.slot === 1) ?? laps[0];
  if (!refLap || refLap.samples.length < 6) return [];

  const normalizedLaps = laps.map((l) => ({
    ...l,
    samples: ensureTraceGForces(l.samples),
  }));
  const refSamples = normalizedLaps[0].samples;
  const maxRefDistKm = refSamples[refSamples.length - 1].distKm;
  const totalRefDistM = Math.max(100, maxRefDistKm * 1000);
  const minCornerSpacingM = Math.max(60, totalRefDistM * 0.075);

  // Detectar mínimos locais de velocidade (ápices reais de curva após desaceleração)
  const rawApexes: Array<{ distKm: number; distM: number; drop: number }> = [];
  for (let i = 2; i < refSamples.length - 2; i += 1) {
    const curr = refSamples[i].speedKmh || 0;
    const prev = refSamples[i - 1].speedKmh || 0;
    const next = refSamples[i + 1].speedKmh || 0;
    if (curr <= prev && curr < next && curr >= 6) {
      let maxBefore = curr;
      for (let b = Math.max(0, i - 14); b < i; b += 1) {
        maxBefore = Math.max(maxBefore, refSamples[b].speedKmh || 0);
      }
      let maxAfter = curr;
      for (let f = i + 1; f < Math.min(refSamples.length, i + 12); f += 1) {
        maxAfter = Math.max(maxAfter, refSamples[f].speedKmh || 0);
      }
      const drop = maxBefore - curr;
      const recovery = maxAfter - curr;
      if (drop >= 8 && recovery >= 5) {
        rawApexes.push({
          distKm: refSamples[i].distKm,
          distM: Math.round(refSamples[i].distKm * 1000),
          drop,
        });
      }
    }
  }

  // Fallback suave se o traçado tiver poucas curvas fortes
  if (rawApexes.length === 0) {
    for (let i = 2; i < refSamples.length - 2; i += 1) {
      const curr = refSamples[i].speedKmh || 0;
      const prev = refSamples[i - 1].speedKmh || 0;
      const next = refSamples[i + 1].speedKmh || 0;
      if (curr <= prev && curr < next && curr >= 6) {
        let maxBefore = curr;
        for (let b = Math.max(0, i - 12); b < i; b += 1) {
          maxBefore = Math.max(maxBefore, refSamples[b].speedKmh || 0);
        }
        const drop = maxBefore - curr;
        if (drop >= 5) {
          rawApexes.push({
            distKm: refSamples[i].distKm,
            distM: Math.round(refSamples[i].distKm * 1000),
            drop,
          });
        }
      }
    }
  }

  // Selecionar até 8 curvas principais sem sobreposição
  const chosen: Array<{ distKm: number; distM: number; drop: number }> = [];
  for (const cand of [...rawApexes].sort((a, b) => b.drop - a.drop)) {
    if (chosen.length >= 8) break;
    if (chosen.every((c) => Math.abs(c.distM - cand.distM) >= minCornerSpacingM)) {
      chosen.push(cand);
    }
  }
  chosen.sort((a, b) => a.distM - b.distM);

  return chosen.map((corner, idx) => {
    const refMeasured = measureCornerWindowForSamples(
      refSamples,
      corner.distKm,
      maxRefDistKm
    );

    const entries: CornerBrakingLapEntry[] = normalizedLaps
      .map((lap) => {
        const lapMaxKm =
          lap.samples.length > 0 ? lap.samples[lap.samples.length - 1].distKm : maxRefDistKm;
        const measured = measureCornerWindowForSamples(
          lap.samples,
          corner.distKm,
          lapMaxKm
        );
        if (!measured) return null;

        const isRef = lap.slot === normalizedLaps[0].slot;
        return {
          slot: lap.slot,
          runNumber: lap.runNumber,
          brakeStartDistM: measured.brakeStartDistM,
          entrySpeedKmh: measured.entrySpeedKmh,
          apexDistM: measured.apexDistM,
          apexSpeedKmh: measured.apexSpeedKmh,
          exitSpeedKmh: measured.exitSpeedKmh,
          deltaEntryKmh:
            !isRef && refMeasured
              ? measured.entrySpeedKmh - refMeasured.entrySpeedKmh
              : null,
          deltaApexKmh:
            !isRef && refMeasured
              ? measured.apexSpeedKmh - refMeasured.apexSpeedKmh
              : null,
          deltaExitKmh:
            !isRef && refMeasured
              ? measured.exitSpeedKmh - refMeasured.exitSpeedKmh
              : null,
          brakeShiftM:
            !isRef && refMeasured
              ? measured.brakeStartDistM - refMeasured.brakeStartDistM
              : null,
        };
      })
      .filter((e): e is CornerBrakingLapEntry => e !== null);

    return {
      cornerIndex: idx + 1,
      label: `Curva ${idx + 1}`,
      refApexDistM: refMeasured?.apexDistM ?? corner.distM,
      refBrakeStartM: refMeasured?.brakeStartDistM ?? Math.max(0, corner.distM - 60),
      entries,
    };
  });
}



