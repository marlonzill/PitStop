import type { GeoWaypoint } from './geoKmlParser';
import {
  clearAllElevationAndDemCaches,
  fetchTrackRealElevations,
  getElevationCacheEstimatedBytes,
  saveBoundingBoxDemGrid,
} from './elevationService';
import { idbKvDelete, idbKvGet, idbKvSet } from './idbCache';
import { haversineMetersVel, type VelocityTrack } from './velocityEngine';

export const OFFLINE_TILES_CACHE_NAME = 'rally-offline-tiles-v1';
export const OFFLINE_MAPS_UPDATED_EVENT = 'pitstop:offline-maps-updated';

const OFFLINE_PACKS_STORAGE_KEY = 'pitstop_offline_rally_packs_v1';
const OFFLINE_TRANSIT_ROUTES_KEY = 'pitstop_offline_transit_routes_v1';

export type OfflineTileLayerKind = 'satellite' | 'labels' | 'streets';

export interface OfflineRallyPackMeta {
  folderKey: string;
  folderName: string;
  tileCount: number;
  estimatedBytes: number;
  routesCount: number;
  elevationsReady: boolean;
  downloadedAtMs: number;
  stageCount: number;
  waypointCount: number;
}

export interface OfflineDownloadProgress {
  phase: 'tiles' | 'elevation' | 'routes';
  completed: number;
  total: number;
  bytesDownloaded: number;
  label: string;
}

export type OfflineTransitManeuverKind =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'slight-right'
  | 'right'
  | 'roundabout'
  | 'uturn'
  | 'finish';

export interface CachedTransitStep {
  instruction: string;
  lat: number;
  lon: number;
  distanceM: number;
  kind: OfflineTransitManeuverKind;
  roadName?: string;
}

export interface CachedTransitRoute {
  id: string;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  fromLabel?: string;
  toLabel?: string;
  geometryLatLng: [number, number][];
  distanceM: number;
  durationSec: number;
  steps: CachedTransitStep[];
  cachedAtMs: number;
}

export interface OfflineMapsStorageSummary {
  totalBytes: number;
  cachedTilesCount: number;
  packsCount: number;
  routesCount: number;
  packs: OfflineRallyPackMeta[];
}

interface TileCoordItem {
  layer: OfflineTileLayerKind;
  z: number;
  x: number;
  y: number;
  url: string;
}

export function buildTileUrl(
  layer: OfflineTileLayerKind,
  z: number,
  x: number,
  y: number
): string {
  const maxIdx = Math.pow(2, z);
  const wx = ((x % maxIdx) + maxIdx) % maxIdx;
  const cy = Math.max(0, Math.min(maxIdx - 1, y));
  if (layer === 'satellite') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${cy}/${wx}`;
  }
  if (layer === 'labels') {
    return `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${cy}/${wx}`;
  }
  return `https://tile.openstreetmap.org/${z}/${wx}/${cy}.png`;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(0.1, bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

function computeGeoBoundsWithMarginKm(
  tracks: VelocityTrack[],
  waypoints: GeoWaypoint[],
  marginKm: number
): GeoBounds | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let count = 0;

  const pushPt = (lat: number, lon: number) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    count += 1;
  };

  tracks.forEach((tr) => {
    tr.baseTrace?.forEach((s) => pushPt(s.lat, s.lon));
    tr.traps?.forEach((tp) => pushPt(tp.lat, tp.lon));
    tr.waypoints?.forEach((wp) => pushPt(wp.lat, wp.lon));
  });
  waypoints.forEach((wp) => pushPt(wp.lat, wp.lon));

  if (count === 0) return null;

  const centerLat = (minLat + maxLat) / 2;
  const dLat = marginKm / 111.32;
  const dLon = marginKm / (111.32 * Math.max(0.2, Math.cos((centerLat * Math.PI) / 180)));
  return {
    minLat: minLat - dLat,
    maxLat: maxLat + dLat,
    minLon: minLon - dLon,
    maxLon: maxLon + dLon,
  };
}

function addBboxTiles(
  set: Map<string, TileCoordItem>,
  bounds: GeoBounds,
  zoom: number,
  layers: OfflineTileLayerKind[],
  maxAdd = 900
): number {
  const maxIdx = Math.pow(2, zoom) - 1;
  const xMin = Math.max(0, Math.min(maxIdx, lonToTileX(bounds.minLon, zoom)));
  const xMax = Math.max(0, Math.min(maxIdx, lonToTileX(bounds.maxLon, zoom)));
  const yMin = Math.max(0, Math.min(maxIdx, latToTileY(bounds.maxLat, zoom)));
  const yMax = Math.max(0, Math.min(maxIdx, latToTileY(bounds.minLat, zoom)));

  let added = 0;
  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      if (added >= maxAdd) return added;
      for (const layer of layers) {
        const key = `${layer}:${zoom}:${x}:${y}`;
        if (!set.has(key)) {
          set.set(key, { layer, z: zoom, x, y, url: buildTileUrl(layer, zoom, x, y) });
          added += 1;
        }
      }
    }
  }
  return added;
}

function addCorridorTiles(
  set: Map<string, TileCoordItem>,
  tracks: VelocityTrack[],
  waypoints: GeoWaypoint[],
  zoom: number,
  radiusKm: number,
  layers: OfflineTileLayerKind[],
  maxAdd = 900
): void {
  const anchors: Array<{ lat: number; lon: number }> = [];
  tracks.forEach((tr) => {
    const trace = tr.baseTrace ?? [];
    let lastPushLat = 0;
    let lastPushLon = 0;
    for (let i = 0; i < trace.length; i += 1) {
      const pt = trace[i];
      if (
        i === 0 ||
        i === trace.length - 1 ||
        haversineMetersVel(lastPushLat, lastPushLon, pt.lat, pt.lon) >= 140
      ) {
        anchors.push({ lat: pt.lat, lon: pt.lon });
        lastPushLat = pt.lat;
        lastPushLon = pt.lon;
      }
    }
    tr.traps?.forEach((tp) => anchors.push({ lat: tp.lat, lon: tp.lon }));
  });
  waypoints.forEach((wp) => anchors.push({ lat: wp.lat, lon: wp.lon }));

  const maxIdx = Math.pow(2, zoom) - 1;
  let added = 0;
  for (const pt of anchors) {
    if (added >= maxAdd) break;
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos((pt.lat * Math.PI) / 180)));
    const xMin = Math.max(0, Math.min(maxIdx, lonToTileX(pt.lon - dLon, zoom)));
    const xMax = Math.max(0, Math.min(maxIdx, lonToTileX(pt.lon + dLon, zoom)));
    const yMin = Math.max(0, Math.min(maxIdx, latToTileY(pt.lat + dLat, zoom)));
    const yMax = Math.max(0, Math.min(maxIdx, latToTileY(pt.lat - dLat, zoom)));

    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        if (added >= maxAdd) break;
        for (const layer of layers) {
          const key = `${layer}:${zoom}:${x}:${y}`;
          if (!set.has(key)) {
            set.set(key, { layer, z: zoom, x, y, url: buildTileUrl(layer, zoom, x, y) });
            added += 1;
          }
        }
      }
    }
  }
}

export function buildRallyOfflineTilePlan(
  tracks: VelocityTrack[],
  waypoints: GeoWaypoint[]
): TileCoordItem[] {
  const bounds = computeGeoBoundsWithMarginKm(tracks, waypoints, 3.0);
  if (!bounds) return [];

  const layers: OfflineTileLayerKind[] = ['satellite', 'streets'];
  const tileMap = new Map<string, TileCoordItem>();

  // Zoom 12..15 across entire 3 km bounding box (satellite, streets + hybrid labels)
  for (let z = 12; z <= 15; z += 1) {
    addBboxTiles(tileMap, bounds, z, ['satellite', 'streets', 'labels'], 500);
  }

  // Zoom 16: full bbox if compact, otherwise 1.2 km corridor around stages & POIs
  const xMin16 = lonToTileX(bounds.minLon, 16);
  const xMax16 = lonToTileX(bounds.maxLon, 16);
  const yMin16 = latToTileY(bounds.maxLat, 16);
  const yMax16 = latToTileY(bounds.minLat, 16);
  const z16Count = Math.max(1, (xMax16 - xMin16 + 1) * (yMax16 - yMin16 + 1));
  if (z16Count <= 220) {
    addBboxTiles(tileMap, bounds, 16, layers, 450);
  } else {
    addCorridorTiles(tileMap, tracks, waypoints, 16, 1.2, layers, 500);
  }

  // Zoom 17: exact corridor (300 m) along special stages & POIs
  addCorridorTiles(tileMap, tracks, waypoints, 17, 0.3, layers, 650);

  return Array.from(tileMap.values());
}

let offlinePacksMemoryCache: OfflineRallyPackMeta[] | null = null;
let cachedTransitRoutesMemoryCache: CachedTransitRoute[] | null = null;
let offlineMapsHydrationPromise: Promise<void> | null = null;

function ensureOfflineMapsHydrated(): Promise<void> {
  if (offlineMapsHydrationPromise) return offlineMapsHydrationPromise;
  offlineMapsHydrationPromise = (async () => {
    try {
      const [idbPacks, idbRoutes] = await Promise.all([
        idbKvGet<OfflineRallyPackMeta[]>(OFFLINE_PACKS_STORAGE_KEY),
        idbKvGet<CachedTransitRoute[]>(OFFLINE_TRANSIT_ROUTES_KEY),
      ]);
      let updated = false;

      if (Array.isArray(idbPacks)) {
        offlinePacksMemoryCache = idbPacks;
        updated = true;
      } else if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(OFFLINE_PACKS_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
              offlinePacksMemoryCache = parsed as OfflineRallyPackMeta[];
              await idbKvSet(OFFLINE_PACKS_STORAGE_KEY, offlinePacksMemoryCache);
              localStorage.removeItem(OFFLINE_PACKS_STORAGE_KEY);
              updated = true;
            }
          }
        } catch {
          // ignore
        }
      }

      if (Array.isArray(idbRoutes)) {
        cachedTransitRoutesMemoryCache = idbRoutes;
        updated = true;
      } else if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(OFFLINE_TRANSIT_ROUTES_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
              cachedTransitRoutesMemoryCache = parsed as CachedTransitRoute[];
              await idbKvSet(OFFLINE_TRANSIT_ROUTES_KEY, cachedTransitRoutesMemoryCache);
              localStorage.removeItem(OFFLINE_TRANSIT_ROUTES_KEY);
              updated = true;
            }
          }
        } catch {
          // ignore
        }
      }

      if (offlinePacksMemoryCache === null) offlinePacksMemoryCache = [];
      if (cachedTransitRoutesMemoryCache === null) cachedTransitRoutesMemoryCache = [];

      if (updated && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(OFFLINE_MAPS_UPDATED_EVENT));
      }
    } catch {
      if (offlinePacksMemoryCache === null) offlinePacksMemoryCache = [];
      if (cachedTransitRoutesMemoryCache === null) cachedTransitRoutesMemoryCache = [];
    }
  })();
  return offlineMapsHydrationPromise;
}

if (typeof window !== 'undefined') {
  void ensureOfflineMapsHydrated();
}

export function loadOfflineRallyPacks(): OfflineRallyPackMeta[] {
  if (offlinePacksMemoryCache !== null) return offlinePacksMemoryCache;
  try {
    const raw = localStorage.getItem(OFFLINE_PACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      offlinePacksMemoryCache = parsed as OfflineRallyPackMeta[];
      return offlinePacksMemoryCache;
    }
    return [];
  } catch {
    return [];
  }
}

function saveOfflineRallyPacks(packs: OfflineRallyPackMeta[]): void {
  offlinePacksMemoryCache = packs;
  void idbKvSet(OFFLINE_PACKS_STORAGE_KEY, packs);
  try {
    localStorage.removeItem(OFFLINE_PACKS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getOfflineRallyPack(folderKey: string): OfflineRallyPackMeta | null {
  const packs = loadOfflineRallyPacks();
  return packs.find((p) => p.folderKey === folderKey) ?? null;
}

export function loadCachedTransitRoutes(): CachedTransitRoute[] {
  if (cachedTransitRoutesMemoryCache !== null) return cachedTransitRoutesMemoryCache;
  try {
    const raw = localStorage.getItem(OFFLINE_TRANSIT_ROUTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      cachedTransitRoutesMemoryCache = parsed as CachedTransitRoute[];
      return cachedTransitRoutesMemoryCache;
    }
    return [];
  } catch {
    return [];
  }
}

function saveCachedTransitRoutes(routes: CachedTransitRoute[]): void {
  const trimmed = routes.slice(-120);
  cachedTransitRoutesMemoryCache = trimmed;
  void idbKvSet(OFFLINE_TRANSIT_ROUTES_KEY, trimmed);
  try {
    localStorage.removeItem(OFFLINE_TRANSIT_ROUTES_KEY);
  } catch {
    // ignore
  }
}

function mapOsrmManeuverKind(
  type?: string,
  modifier?: string
): OfflineTransitManeuverKind {
  if (type === 'arrive') return 'finish';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout';
  if (modifier === 'uturn') return 'uturn';
  if (modifier === 'slight left') return 'slight-left';
  if (modifier === 'left' || modifier === 'sharp left') return 'left';
  if (modifier === 'slight right') return 'slight-right';
  if (modifier === 'right' || modifier === 'sharp right') return 'right';
  return 'straight';
}

function translateOsrmStepToPtBr(step: {
  name?: string;
  distance?: number;
  maneuver?: {
    type?: string;
    modifier?: string;
    exit?: number;
    location?: [number, number];
  };
}): CachedTransitStep | null {
  const loc = step.maneuver?.location;
  if (!Array.isArray(loc) || loc.length < 2) return null;
  const lon = loc[0];
  const lat = loc[1];
  const type = step.maneuver?.type ?? '';
  const mod = step.maneuver?.modifier ?? '';
  const road = (step.name ?? '').trim();
  const roadSuffix = road ? ` em ${road}` : '';

  let instruction = `Siga em frente${roadSuffix}`;
  if (type === 'depart') {
    instruction = `Siga${roadSuffix}`;
  } else if (type === 'arrive') {
    instruction = 'Chegada ao destino';
  } else if (type === 'roundabout' || type === 'rotary') {
    const exitNum = step.maneuver?.exit;
    instruction = exitNum
      ? `Rotatória · pegue a ${exitNum}ª saída${roadSuffix}`
      : `Entre na rotatória${roadSuffix}`;
  } else if (type === 'fork') {
    instruction = mod.includes('left')
      ? `Mantenha-se à esquerda na bifurcação${roadSuffix}`
      : `Mantenha-se à direita na bifurcação${roadSuffix}`;
  } else if (mod === 'uturn') {
    instruction = `Faça o retorno${roadSuffix}`;
  } else if (mod === 'sharp left') {
    instruction = `Vire fechado à esquerda${roadSuffix}`;
  } else if (mod === 'left') {
    instruction = `Vire à esquerda${roadSuffix}`;
  } else if (mod === 'slight left') {
    instruction = `Mantenha-se à esquerda${roadSuffix}`;
  } else if (mod === 'sharp right') {
    instruction = `Vire fechado à direita${roadSuffix}`;
  } else if (mod === 'right') {
    instruction = `Vire à direita${roadSuffix}`;
  } else if (mod === 'slight right') {
    instruction = `Mantenha-se à direita${roadSuffix}`;
  }

  return {
    instruction,
    lat,
    lon,
    distanceM: Math.round(step.distance ?? 0),
    kind: mapOsrmManeuverKind(type, mod),
    roadName: road || undefined,
  };
}

export async function fetchAndCacheLiveOsrmRoute(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  fromLabel?: string,
  toLabel?: string,
  signal?: AbortSignal
): Promise<CachedTransitRoute | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  if (haversineMetersVel(fromLat, fromLon, toLat, toLon) < 60) return null;

  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fromLon.toFixed(5)},${fromLat.toFixed(5)};${toLon.toFixed(5)},${toLat.toFixed(5)}` +
      `?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
        legs?: Array<{
          steps?: Array<{
            name?: string;
            distance?: number;
            maneuver?: {
              type?: string;
              modifier?: string;
              exit?: number;
              location?: [number, number];
            };
          }>;
        }>;
      }>;
    };
    const route = data?.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (!route || !Array.isArray(coords) || coords.length < 2) return null;

    const geometryLatLng: [number, number][] = coords.map(([lon, lat]) => [
      Number(lat.toFixed(6)),
      Number(lon.toFixed(6)),
    ]);
    const steps: CachedTransitStep[] = [];
    route.legs?.forEach((leg) => {
      leg.steps?.forEach((st) => {
        const translated = translateOsrmStepToPtBr(st);
        if (translated) steps.push(translated);
      });
    });

    const id = `${fromLat.toFixed(3)},${fromLon.toFixed(3)}->${toLat.toFixed(3)},${toLon.toFixed(3)}`;
    const entry: CachedTransitRoute = {
      id,
      fromLat: Number(fromLat.toFixed(6)),
      fromLon: Number(fromLon.toFixed(6)),
      toLat: Number(toLat.toFixed(6)),
      toLon: Number(toLon.toFixed(6)),
      fromLabel,
      toLabel,
      geometryLatLng,
      distanceM: Math.round(route.distance ?? 0),
      durationSec: Math.round(route.duration ?? 0),
      steps,
      cachedAtMs: Date.now(),
    };

    await ensureOfflineMapsHydrated();
    const existing = loadCachedTransitRoutes().filter((r) => r.id !== id);
    existing.push(entry);
    saveCachedTransitRoutes(existing);
    return entry;
  } catch {
    return null;
  }
}

export function findBestCachedTransitRoute(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): CachedTransitRoute | null {
  const routes = loadCachedTransitRoutes();
  if (routes.length === 0) return null;

  let best: CachedTransitRoute | null = null;
  let bestScore = Infinity;

  for (const r of routes) {
    const destErrM = haversineMetersVel(r.toLat, r.toLon, toLat, toLon);
    if (destErrM > 380) continue;

    // Measure shortest distance from currentPos to anywhere on route geometry
    let minRouteDistM = haversineMetersVel(fromLat, fromLon, r.fromLat, r.fromLon);
    const step = Math.max(1, Math.floor(r.geometryLatLng.length / 40));
    for (let i = 0; i < r.geometryLatLng.length; i += step) {
      const [rlat, rlon] = r.geometryLatLng[i];
      const d = haversineMetersVel(fromLat, fromLon, rlat, rlon);
      if (d < minRouteDistM) minRouteDistM = d;
    }

    if (minRouteDistM > 3200) continue;
    const score = destErrM + minRouteDistM;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
}

function pointToSegmentMeters(
  pLat: number,
  pLon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): number {
  const cosLat = Math.cos(((pLat + aLat + bLat) / 3) * (Math.PI / 180));
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.max(0.2, cosLat);
  const ax = (aLon - pLon) * mPerDegLon;
  const ay = (aLat - pLat) * mPerDegLat;
  const bx = (bLon - pLon) * mPerDegLon;
  const by = (bLat - pLat) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) return Math.hypot(ax, ay);
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function findNearestOfflineRouteEntry(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): CachedTransitRoute | null {
  const routes = loadCachedTransitRoutes();
  if (routes.length === 0) return null;

  let best: CachedTransitRoute | null = null;
  let bestScore = Infinity;

  for (const r of routes) {
    const destErrM = haversineMetersVel(r.toLat, r.toLon, toLat, toLon);
    if (destErrM > 900) continue;

    let minRouteDistM = haversineMetersVel(fromLat, fromLon, r.fromLat, r.fromLon);
    const step = Math.max(1, Math.floor(r.geometryLatLng.length / 50));
    for (let i = 0; i < r.geometryLatLng.length; i += step) {
      const [rlat, rlon] = r.geometryLatLng[i];
      const d = haversineMetersVel(fromLat, fromLon, rlat, rlon);
      if (d < minRouteDistM) minRouteDistM = d;
    }

    const score = destErrM * 1.5 + minRouteDistM;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }

  return best;
}

interface RouteGuidanceIndex {
  suffixMeters: Float64Array;
  stepGeomIndices: Int32Array;
  lastClosestIdx: number;
  lastHintLat: number;
  lastHintLon: number;
}

const routeGuidanceIndexCache = new WeakMap<CachedTransitRoute, RouteGuidanceIndex>();

function getOrBuildRouteGuidanceIndex(route: CachedTransitRoute): RouteGuidanceIndex {
  const existing = routeGuidanceIndexCache.get(route);
  if (existing) return existing;

  const geom = route.geometryLatLng;
  const n = geom.length;
  const suffixMeters = new Float64Array(n);
  for (let i = n - 2; i >= 0; i -= 1) {
    suffixMeters[i] =
      suffixMeters[i + 1] +
      haversineMetersVel(geom[i][0], geom[i][1], geom[i + 1][0], geom[i + 1][1]);
  }

  const stepGeomIndices = new Int32Array(route.steps.length);
  let searchFrom = 0;
  for (let sIdx = 0; sIdx < route.steps.length; sIdx += 1) {
    const st = route.steps[sIdx];
    let bestG = searchFrom;
    let minD = Infinity;
    for (let g = searchFrom; g < n; g += 1) {
      const d = haversineMetersVel(st.lat, st.lon, geom[g][0], geom[g][1]);
      if (d < minD) {
        minD = d;
        bestG = g;
        if (d < 8) break;
      }
    }
    stepGeomIndices[sIdx] = bestG;
    searchFrom = bestG;
  }

  const index: RouteGuidanceIndex = {
    suffixMeters,
    stepGeomIndices,
    lastClosestIdx: -1,
    lastHintLat: 0,
    lastHintLon: 0,
  };
  routeGuidanceIndexCache.set(route, index);
  return index;
}

export function computeOsrmGuidanceFromRoute(
  route: CachedTransitRoute,
  currentLat: number,
  currentLon: number,
  speedKmh = 0
): {
  remainingGeometry: [number, number][];
  nextInstruction: string;
  nextRoadName: string | null;
  nextKind: OfflineTransitManeuverKind;
  distToManeuverM: number;
  followingInstruction: string | null;
  followingRoadName: string | null;
  followingKind: OfflineTransitManeuverKind | null;
  remainingTotalKm: number;
  etaMin: number;
  distanceFromRouteM: number;
  progressPct: number;
} {
  const geom = route.geometryLatLng;
  const index = getOrBuildRouteGuidanceIndex(route);
  let closestIdx = 0;
  let bestVertexD = Infinity;

  const canUseWindow =
    index.lastClosestIdx >= 0 &&
    index.lastClosestIdx < geom.length &&
    haversineMetersVel(index.lastHintLat, index.lastHintLon, currentLat, currentLon) <= 600;

  if (canUseWindow && geom.length > 0) {
    const winStart = Math.max(0, index.lastClosestIdx - 25);
    const winEnd = Math.min(geom.length - 1, index.lastClosestIdx + 90);
    for (let i = winStart; i <= winEnd; i += 1) {
      const d = haversineMetersVel(currentLat, currentLon, geom[i][0], geom[i][1]);
      if (d < bestVertexD) {
        bestVertexD = d;
        closestIdx = i;
      }
    }
  }

  // Fallback to full scan on cold start, big position jump, or off-window detection
  if (!canUseWindow || bestVertexD > 350) {
    bestVertexD = Infinity;
    for (let i = 0; i < geom.length; i += 1) {
      const d = haversineMetersVel(currentLat, currentLon, geom[i][0], geom[i][1]);
      if (d < bestVertexD) {
        bestVertexD = d;
        closestIdx = i;
      }
    }
  }

  index.lastClosestIdx = closestIdx;
  index.lastHintLat = currentLat;
  index.lastHintLon = currentLon;

  let distanceFromRouteM = bestVertexD;
  if (geom.length >= 2) {
    const segStart = Math.max(0, closestIdx - 3);
    const segEnd = Math.min(geom.length - 2, closestIdx + 3);
    let minSegD = Infinity;
    for (let i = segStart; i <= segEnd; i += 1) {
      const d = pointToSegmentMeters(
        currentLat,
        currentLon,
        geom[i][0],
        geom[i][1],
        geom[i + 1][0],
        geom[i + 1][1]
      );
      if (d < minSegD) minSegD = d;
    }
    if (Number.isFinite(minSegD)) distanceFromRouteM = minSegD;
  }

  const remainingGeometry: [number, number][] =
    geom.length > 0
      ? [[currentLat, currentLon], ...geom.slice(closestIdx)]
      : [[currentLat, currentLon]];

  const remainingM =
    geom.length > 0
      ? haversineMetersVel(
          currentLat,
          currentLon,
          geom[closestIdx][0],
          geom[closestIdx][1]
        ) + (index.suffixMeters[closestIdx] ?? 0)
      : 0;

  const totalM = Math.max(1, route.distanceM || remainingM);
  const progressPct = Math.min(100, Math.max(0, ((totalM - remainingM) / totalM) * 100));

  const baseDurationSec =
    route.durationSec > 0 ? route.durationSec * (remainingM / totalM) : (remainingM / 1000 / 50) * 3600;
  const liveSpeedMs = speedKmh >= 15 ? speedKmh / 3.6 : 0;
  const blendedDurationSec =
    liveSpeedMs > 0 ? baseDurationSec * 0.65 + (remainingM / liveSpeedMs) * 0.35 : baseDurationSec;
  const etaMin = remainingM < 60 ? 0 : Math.max(1, Math.round(blendedDurationSec / 60));

  // Find the first upcoming maneuver step whose pre-indexed geometry index > closestIdx
  let chosenStep: CachedTransitStep | null = null;
  let chosenStepIdx = -1;
  let chosenStepDistM = Math.round(remainingM);

  if (route.steps.length > 0) {
    for (let sIdx = 0; sIdx < route.steps.length; sIdx += 1) {
      if (index.stepGeomIndices[sIdx] > closestIdx) {
        const st = route.steps[sIdx];
        const dToCar = haversineMetersVel(currentLat, currentLon, st.lat, st.lon);
        if (dToCar >= 12) {
          chosenStep = st;
          chosenStepIdx = sIdx;
          chosenStepDistM = Math.round(dToCar);
          break;
        }
      }
    }
    if (!chosenStep) {
      chosenStepIdx = route.steps.length - 1;
      chosenStep = route.steps[chosenStepIdx];
      chosenStepDistM = Math.round(
        haversineMetersVel(currentLat, currentLon, route.toLat, route.toLon)
      );
    }
  }

  const followingStep =
    chosenStepIdx >= 0 && chosenStepIdx + 1 < route.steps.length
      ? route.steps[chosenStepIdx + 1]
      : null;

  return {
    remainingGeometry,
    nextInstruction: chosenStep?.instruction || 'Siga pela rota pré-salva',
    nextRoadName: chosenStep?.roadName ?? null,
    nextKind: chosenStep?.kind || 'finish',
    distToManeuverM: Math.max(0, chosenStepDistM),
    followingInstruction: followingStep?.instruction ?? null,
    followingRoadName: followingStep?.roadName ?? null,
    followingKind: followingStep?.kind ?? null,
    remainingTotalKm: remainingM / 1000,
    etaMin,
    distanceFromRouteM: Math.round(distanceFromRouteM),
    progressPct,
  };
}

async function preFetchRallyOsrmRoutes(
  tracks: VelocityTrack[],
  waypoints: GeoWaypoint[],
  signal?: AbortSignal
): Promise<number> {
  interface NavNode {
    label: string;
    lat: number;
    lon: number;
    kind: 'poi' | 'start' | 'finish';
  }
  const nodes: NavNode[] = [];
  waypoints.forEach((wp) => {
    nodes.push({ label: wp.name, lat: wp.lat, lon: wp.lon, kind: 'poi' });
  });
  tracks.forEach((tr) => {
    const startTrap =
      tr.traps.find((t) => t.kind === 'start' || t.kind === 'start_finish') ?? tr.traps[0];
    const finishTrap = tr.traps.find((t) => t.kind === 'finish');
    if (startTrap) {
      nodes.push({ label: `${tr.name} Largada`, lat: startTrap.lat, lon: startTrap.lon, kind: 'start' });
    } else if (tr.baseTrace?.[0]) {
      nodes.push({
        label: `${tr.name} Largada`,
        lat: tr.baseTrace[0].lat,
        lon: tr.baseTrace[0].lon,
        kind: 'start',
      });
    }
    if (finishTrap) {
      nodes.push({ label: `${tr.name} Chegada`, lat: finishTrap.lat, lon: finishTrap.lon, kind: 'finish' });
    } else if (tr.baseTrace && tr.baseTrace.length >= 2) {
      const last = tr.baseTrace[tr.baseTrace.length - 1];
      nodes.push({ label: `${tr.name} Chegada`, lat: last.lat, lon: last.lon, kind: 'finish' });
    }
  });

  const pairs: Array<{ from: NavNode; to: NavNode }> = [];
  const seen = new Set<string>();
  const addPair = (from: NavNode, to: NavNode) => {
    if (haversineMetersVel(from.lat, from.lon, to.lat, to.lon) < 120) return;
    const key = `${from.lat.toFixed(3)},${from.lon.toFixed(3)}->${to.lat.toFixed(3)},${to.lon.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ from, to });
    }
  };

  const pois = nodes.filter((n) => n.kind === 'poi');
  const starts = nodes.filter((n) => n.kind === 'start');
  const finishes = nodes.filter((n) => n.kind === 'finish');

  // Connect POIs (Parque de Serviços) <-> Stage Starts & Finishes
  pois.forEach((poi) => {
    starts.forEach((st) => {
      addPair(poi, st);
      addPair(st, poi);
    });
    finishes.forEach((fn) => {
      addPair(fn, poi);
      addPair(poi, fn);
    });
  });

  // Connect sequential stage finishes -> next stage start
  for (let i = 0; i < finishes.length; i += 1) {
    for (let j = 0; j < starts.length; j += 1) {
      if (i !== j) {
        addPair(finishes[i], starts[j]);
      }
    }
  }

  let savedCount = 0;
  for (const pair of pairs.slice(0, 18)) {
    if (signal?.aborted) break;
    const res = await fetchAndCacheLiveOsrmRoute(
      pair.from.lat,
      pair.from.lon,
      pair.to.lat,
      pair.to.lon,
      pair.from.label,
      pair.to.label,
      signal
    );
    if (res) savedCount += 1;
  }
  return savedCount;
}

export async function downloadRallyOfflineBundle(params: {
  folderKey: string;
  folderName: string;
  tracks: VelocityTrack[];
  waypoints: GeoWaypoint[];
  signal?: AbortSignal;
  onProgress?: (progress: OfflineDownloadProgress) => void;
}): Promise<OfflineRallyPackMeta> {
  const { folderKey, folderName, tracks, waypoints, signal, onProgress } = params;
  const plan = buildRallyOfflineTilePlan(tracks, waypoints);
  const totalTiles = plan.length;
  let completedTiles = 0;
  let totalBytes = 0;

  if (typeof caches !== 'undefined' && totalTiles > 0) {
    const cache = await caches.open(OFFLINE_TILES_CACHE_NAME);
    let cursor = 0;
    const CONCURRENCY = 4;

    const worker = async () => {
      while (cursor < plan.length) {
        if (signal?.aborted) return;
        const idx = cursor;
        cursor += 1;
        const item = plan[idx];

        try {
          const existing = await cache.match(item.url);
          if (existing) {
            const blob = await existing.blob();
            totalBytes += blob.size || 24000;
          } else {
            let res: Response | null = null;
            try {
              res = await fetch(item.url, { mode: 'cors', signal });
            } catch {
              if (!signal?.aborted) {
                try {
                  res = await fetch(item.url, { mode: 'no-cors', signal });
                } catch {
                  res = null;
                }
              }
            }
            if (res && (res.ok || res.type === 'opaque')) {
              const cloned = res.clone();
              await cache.put(item.url, res);
              if (cloned.type === 'opaque') {
                totalBytes += 24000;
              } else {
                const blob = await cloned.blob();
                totalBytes += blob.size || 24000;
              }
            }
          }
        } catch {
          // Skip transient tile fetch error safely
        } finally {
          completedTiles += 1;
          onProgress?.({
            phase: 'tiles',
            completed: completedTiles,
            total: totalTiles,
            bytesDownloaded: totalBytes,
            label: `Baixando quadrantes: ${completedTiles} / ${totalTiles}`,
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, Math.max(1, plan.length)) }, () => worker())
    );
  }

  if (signal?.aborted) {
    throw new DOMException('Download cancelado pelo usuário.', 'AbortError');
  }

  // Phase 2: SRTM/DEM Elevation cache (bounding-box grid + stage profiles) for 3D Recce & Profile offline
  onProgress?.({
    phase: 'elevation',
    completed: 0,
    total: Math.max(1, tracks.length) + 1,
    bytesDownloaded: totalBytes,
    label: 'Salvando grade SRTM/DEM e altimetria...',
  });

  const bounds = computeGeoBoundsWithMarginKm(tracks, waypoints, 3.0);
  const demGridSaved = bounds
    ? await saveBoundingBoxDemGrid(folderKey, bounds, signal)
    : false;

  let elevationsReady = demGridSaved;
  for (let i = 0; i < tracks.length; i += 1) {
    if (signal?.aborted) break;
    const tr = tracks[i];
    if (tr.baseTrace && tr.baseTrace.length >= 2) {
      const elevRes = await fetchTrackRealElevations(tr.id, tr.baseTrace, signal);
      if (elevRes.source !== 'synthetic') elevationsReady = true;
    }
    onProgress?.({
      phase: 'elevation',
      completed: i + 2,
      total: Math.max(1, tracks.length) + 1,
      bytesDownloaded: totalBytes,
      label: `Altimetria DEM salva (${i + 1}/${Math.max(1, tracks.length)})`,
    });
  }

  if (signal?.aborted) {
    throw new DOMException('Download cancelado pelo usuário.', 'AbortError');
  }

  // Phase 3: OSRM pre-saved driving routes between Parque de Serviços & Stages
  onProgress?.({
    phase: 'routes',
    completed: 0,
    total: 1,
    bytesDownloaded: totalBytes,
    label: 'Pré-salvando rotas de deslocamento OSRM...',
  });
  const routesCount = await preFetchRallyOsrmRoutes(tracks, waypoints, signal);

  const meta: OfflineRallyPackMeta = {
    folderKey,
    folderName,
    tileCount: completedTiles,
    estimatedBytes: totalBytes,
    routesCount,
    elevationsReady,
    downloadedAtMs: Date.now(),
    stageCount: tracks.length,
    waypointCount: waypoints.length,
  };

  const existingPacks = loadOfflineRallyPacks().filter((p) => p.folderKey !== folderKey);
  existingPacks.push(meta);
  saveOfflineRallyPacks(existingPacks);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_MAPS_UPDATED_EVENT));
  }
  return meta;
}

async function decodeResponseToDrawable(
  res: Response
): Promise<ImageBitmap | HTMLImageElement | null> {
  if (res.type === 'opaque') return null;
  try {
    const blob = await res.blob();
    if (!blob || blob.size === 0) return null;
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(blob);
    }
    const objUrl = URL.createObjectURL(blob);
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve(null);
      };
      img.src = objUrl;
    });
  } catch {
    return null;
  }
}

/**
 * Resolve um tile (Cache API -> Rede -> Parent-Zoom Upscale no Canvas).
 * Funciona 100% offline usando `rally-offline-tiles-v1`.
 */
export async function drawCachedOrUpscaledTileOnCanvas(
  layer: OfflineTileLayerKind,
  z: number,
  x: number,
  y: number,
  canvas: HTMLCanvasElement,
  maxNativeZoom = 18
): Promise<boolean> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  let cache: Cache | null = null;
  if (typeof caches !== 'undefined') {
    try {
      cache = await caches.open(OFFLINE_TILES_CACHE_NAME);
    } catch {
      cache = null;
    }
  }

  const drawSubQuadrant = (
    drawable: ImageBitmap | HTMLImageElement,
    dz: number
  ) => {
    const w = 'width' in drawable ? drawable.width : 256;
    const h = 'height' in drawable ? drawable.height : 256;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (dz <= 0) {
      ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    } else {
      const scale = 1 << dz;
      const subX = ((x % scale) + scale) % scale;
      const subY = ((y % scale) + scale) % scale;
      const sw = w / scale;
      const sh = h / scale;
      const sx = subX * sw;
      const sy = subY * sh;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(drawable, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    if ('close' in drawable && typeof drawable.close === 'function') drawable.close();
  };

  // 1. Check Cache API first at exact zoom (if within native range)
  if (cache && z <= maxNativeZoom) {
    try {
      const exactUrl = buildTileUrl(layer, z, x, y);
      const cached = await cache.match(exactUrl);
      if (cached) {
        const drawable = await decodeResponseToDrawable(cached);
        if (drawable) {
          drawSubQuadrant(drawable, 0);
          return true;
        }
      }
    } catch {
      // continue to network / upscale fallback
    }
  }

  // 2. Check Cache API at ancestor levels BEFORE hitting network when z > maxNativeZoom,
  // or immediately when offline, so already-downloaded high-res z17 tiles render instantly
  const checkAncestorCache = async (minDz = 1, maxDz = 10): Promise<boolean> => {
    if (!cache || (layer !== 'satellite' && layer !== 'streets')) return false;
    const upperDz = Math.min(maxDz, Math.max(0, z - 1));
    for (let dz = minDz; dz <= upperDz; dz += 1) {
      const pz = z - dz;
      const scale = 1 << dz;
      const px = Math.floor(x / scale);
      const py = Math.floor(y / scale);
      const parentUrl = buildTileUrl(layer, pz, px, py);

      try {
        const parentRes = await cache.match(parentUrl);
        if (!parentRes) continue;
        const drawable = await decodeResponseToDrawable(parentRes);
        if (!drawable) continue;
        drawSubQuadrant(drawable, dz);
        return true;
      } catch {
        // try higher ancestor zoom
      }
    }
    return false;
  };

  // If zoomed deeper than native (e.g. z=18..21) and offline z=17 is cached, check cache first when offline
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return checkAncestorCache(0, 10);
  }

  // 3. Try network at min(z, maxNativeZoom) when online (and silently cache Satellite/Streets)
  const fetchDz = Math.max(0, z - maxNativeZoom);
  const fetchZ = Math.min(z, maxNativeZoom);
  const fetchScale = 1 << fetchDz;
  const fetchX = Math.floor(x / fetchScale);
  const fetchY = Math.floor(y / fetchScale);
  const fetchUrl = buildTileUrl(layer, fetchZ, fetchX, fetchY);

  if (cache && fetchDz > 0) {
    try {
      const cachedNative = await cache.match(fetchUrl);
      if (cachedNative) {
        const drawable = await decodeResponseToDrawable(cachedNative);
        if (drawable) {
          drawSubQuadrant(drawable, fetchDz);
          return true;
        }
      }
    } catch {
      // continue
    }
  }

  let timeoutId: number | null = null;
  try {
    const ctrl = new AbortController();
    timeoutId = window.setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(fetchUrl, { mode: 'cors', signal: ctrl.signal });
    if (res.ok) {
      if (cache && (layer === 'satellite' || layer === 'streets')) {
        void cache.put(fetchUrl, res.clone()).catch(() => {});
      }
      const drawable = await decodeResponseToDrawable(res);
      if (drawable) {
        drawSubQuadrant(drawable, fetchDz);
        return true;
      }
    }
  } catch {
    // fall through to parent-zoom upscale fallback
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }

  // 4. Parent-zoom upscale fallback from cached tiles (z-1 down to z-10)
  return checkAncestorCache(1, 10);
}

export async function getOfflineMapsStorageSummary(): Promise<OfflineMapsStorageSummary> {
  await ensureOfflineMapsHydrated();
  const packs = loadOfflineRallyPacks();
  const routes = loadCachedTransitRoutes();
  let cachedTilesCount = 0;
  let cacheBytes = 0;

  if (typeof caches !== 'undefined') {
    try {
      const hasCache = await caches.has(OFFLINE_TILES_CACHE_NAME);
      if (hasCache) {
        const cache = await caches.open(OFFLINE_TILES_CACHE_NAME);
        const keys = await cache.keys();
        cachedTilesCount = keys.length;
        // Sample or sum response sizes quickly
        const sampleLimit = Math.min(keys.length, 400);
        let measured = 0;
        for (let i = 0; i < sampleLimit; i += 1) {
          const res = await cache.match(keys[i]);
          if (res) {
            if (res.type === 'opaque') {
              measured += 24000;
            } else {
              const lenHdr = Number(res.headers.get('content-length') || 0);
              if (lenHdr > 0) {
                measured += lenHdr;
              } else {
                const b = await res.blob();
                measured += b.size;
              }
            }
          }
        }
        cacheBytes =
          sampleLimit > 0 && keys.length > sampleLimit
            ? Math.round((measured / sampleLimit) * keys.length)
            : measured;
      }
    } catch {
      cacheBytes = packs.reduce((acc, p) => acc + p.estimatedBytes, 0);
    }
  }

  // Estimate route + elevation/DEM grid storage from memory/IDB instead of localStorage
  let localBytes = getElevationCacheEstimatedBytes();
  routes.forEach((r) => {
    localBytes += r.geometryLatLng.length * 24 + r.steps.length * 160 + 200;
  });

  return {
    totalBytes: cacheBytes + localBytes,
    cachedTilesCount,
    packsCount: packs.length,
    routesCount: routes.length,
    packs,
  };
}

export async function clearOfflineMapsCache(): Promise<void> {
  if (typeof caches !== 'undefined') {
    try {
      await caches.delete(OFFLINE_TILES_CACHE_NAME);
    } catch {
      // ignore
    }
  }
  offlinePacksMemoryCache = [];
  cachedTransitRoutesMemoryCache = [];
  await Promise.all([
    idbKvDelete(OFFLINE_PACKS_STORAGE_KEY),
    idbKvDelete(OFFLINE_TRANSIT_ROUTES_KEY),
  ]);
  try {
    localStorage.removeItem(OFFLINE_PACKS_STORAGE_KEY);
    localStorage.removeItem(OFFLINE_TRANSIT_ROUTES_KEY);
  } catch {
    // ignore
  }
  clearAllElevationAndDemCaches();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_MAPS_UPDATED_EVENT));
  }
}
