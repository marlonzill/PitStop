import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Box,
  Clock,
  Compass,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Flag,
  Folder,
  Gauge,
  Layers,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Mountain,
  Navigation,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Satellite,
  Settings2,
  ShieldAlert,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useNavSettings } from '../utils/navSettings';
import type { GeoWaypoint } from '../utils/geoKmlParser';
import {
  bearingBetweenDeg,
  createGpsKalmanProcessor,
  ensureAutoTrapsFromBaseTrace,
  formatImportedTrackNamesList,
  getCapacitorGpsWatchOptions,
  haversineMetersVel,
  parseTrackFileToGeoResult,
  WEB_GPS_WATCH_OPTIONS,
  type ParsedGeoImportResult,
  type VelocitySample,
  type VelocityTrack,
  type VelocityTrap,
} from '../utils/velocityEngine';
import { loadVelocityDatabase, persistVelocityTracks } from '../utils/velocityStorage';
import { idbKvDelete, idbKvGet, idbKvSet } from '../utils/idbCache';
import { VelocityMapboxView, type MapPolylineLayer } from './VelocityMapboxView';
import { uploadAllTracksToCloud } from '../services/cloudTracksService';

const VirtualRecce3D = lazy(() =>
  import('./VirtualRecce3D').then((m) => ({ default: m.VirtualRecce3D }))
);
const RallyOverviewMapModal = lazy(() =>
  import('./RallyOverviewMapModal').then((m) => ({ default: m.RallyOverviewMapModal }))
);
import {
  computeOsrmGuidanceFromRoute,
  downloadRallyOfflineBundle,
  fetchAndCacheLiveOsrmRoute,
  findBestCachedTransitRoute,
  findNearestOfflineRouteEntry,
  formatBytesCompact,
  loadOfflineRallyPacks,
  OFFLINE_MAPS_UPDATED_EVENT,
  type CachedTransitRoute,
  type OfflineDownloadProgress,
  type OfflineRallyPackMeta,
} from '../utils/offlineMapsService';

type DriveMode = 'gps' | 'simulator';

type ManeuverKind =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'slight-right'
  | 'right'
  | 'roundabout'
  | 'uturn'
  | 'finish';

interface WazeGuidance {
  kind: ManeuverKind;
  instruction: string;
  targetLabel: string;
  distToManeuverM: number;
  remainingTotalKm: number;
  progressPct: number;
  closestIdx: number;
}

interface ReccePrefs {
  enabled: boolean;
  speedLimitKmh: number;
  warningMarginKmh: number;
  soundEnabled: boolean;
}

const RECCE_PREFS_KEY = 'pitstop_recce_speed_prefs_v1';
const SURVEY_GEO_STORAGE_KEY = 'pitstop_survey_imported_geo_v1';

interface StoredSurveyGeo {
  geo: ParsedGeoImportResult;
  selectedTrackIdx: number;
}

function sanitizeStoredSurveyGeo(parsed: Partial<StoredSurveyGeo> | null | undefined): StoredSurveyGeo | null {
  if (
    !parsed?.geo ||
    !Array.isArray(parsed.geo.tracks) ||
    !Array.isArray(parsed.geo.waypoints)
  ) {
    return null;
  }
  const maxIdx = Math.max(0, parsed.geo.tracks.length - 1);
  const idx =
    typeof parsed.selectedTrackIdx === 'number' && parsed.selectedTrackIdx >= 0
      ? Math.min(maxIdx, Math.floor(parsed.selectedTrackIdx))
      : 0;
  return { geo: parsed.geo, selectedTrackIdx: idx };
}

const DEFAULT_RECCE_PREFS: ReccePrefs = {
  enabled: true,
  speedLimitKmh: 60,
  warningMarginKmh: 5,
  soundEnabled: true,
};

function loadReccePrefs(): ReccePrefs {
  try {
    const raw = localStorage.getItem(RECCE_PREFS_KEY);
    if (!raw) return DEFAULT_RECCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReccePrefs>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      speedLimitKmh:
        typeof parsed.speedLimitKmh === 'number' && parsed.speedLimitKmh >= 10
          ? Math.min(200, Math.round(parsed.speedLimitKmh))
          : 60,
      warningMarginKmh:
        typeof parsed.warningMarginKmh === 'number' && parsed.warningMarginKmh >= 1
          ? Math.min(30, Math.round(parsed.warningMarginKmh))
          : 5,
      soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
    };
  } catch {
    return DEFAULT_RECCE_PREFS;
  }
}

let sharedRecceAudioCtx: AudioContext | null = null;

function getRecceAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedRecceAudioCtx && sharedRecceAudioCtx.state !== 'closed') {
    if (sharedRecceAudioCtx.state === 'suspended') {
      sharedRecceAudioCtx.resume().catch(() => {});
    }
    return sharedRecceAudioCtx;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  sharedRecceAudioCtx = new AudioCtx();
  return sharedRecceAudioCtx;
}

function playRecceAlertTone(level: 'warning' | 'over') {
  try {
    const ctx = getRecceAudioContext();
    if (!ctx) return;

    const triggerPulse = (freq: number, startOffset: number, dur: number, gainPeak: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = level === 'over' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + startOffset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startOffset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + dur + 0.02);
    };

    if (level === 'over') {
      triggerPulse(1320, 0, 0.14, 0.22);
      triggerPulse(980, 0.16, 0.14, 0.22);
    } else {
      triggerPulse(880, 0, 0.12, 0.14);
    }
  } catch {
    // Ignore audio context restriction
  }
}

function formatClockTime(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

const SurveyClockBadge: React.FC<{ clockOffsetMs: number }> = ({ clockOffsetMs }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-xs font-bold text-[var(--ps-muted)] tabular-nums">
      <Satellite className="mr-1 inline h-3.5 w-3.5 text-emerald-500" />
      {formatClockTime(nowMs + clockOffsetMs)}
    </span>
  );
};

function signedAngleDiffDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function classifyTurn(signedDeg: number): { kind: ManeuverKind; label: string } {
  const abs = Math.abs(signedDeg);
  if (abs >= 135) return { kind: 'uturn', label: 'Faça o retorno' };
  if (signedDeg <= -30) return { kind: 'left', label: 'Vire à esquerda' };
  if (signedDeg < -12) return { kind: 'slight-left', label: 'Mantenha à esquerda' };
  if (signedDeg >= 30) return { kind: 'right', label: 'Vire à direita' };
  if (signedDeg > 12) return { kind: 'slight-right', label: 'Mantenha à direita' };
  return { kind: 'straight', label: 'Siga em frente' };
}

function renderManeuverIcon(kind: ManeuverKind, sizeClass = 'h-5 w-5 text-white shrink-0') {
  switch (kind) {
    case 'left':
      return <CornerUpLeft className={sizeClass} />;
    case 'slight-left':
      return <ArrowUpLeft className={sizeClass} />;
    case 'right':
      return <CornerUpRight className={sizeClass} />;
    case 'slight-right':
      return <ArrowUpRight className={sizeClass} />;
    case 'roundabout':
      return <RotateCw className={sizeClass} />;
    case 'uturn':
      return <RotateCcw className={sizeClass} />;
    case 'finish':
      return <Flag className={sizeClass} />;
    default:
      return <ArrowUp className={sizeClass} />;
  }
}

interface SurveyGaugeVisibility {
  total: boolean;
  trip: boolean;
  speed: boolean;
  avgSpeed: boolean;
  maxSpeed: boolean;
  officialClock: boolean;
  altitude: boolean;
  gpsAccuracy: boolean;
  heading: boolean;
}

const SURVEY_GAUGE_PREFS_KEY = 'pitstop_survey_gauge_visibility_v1';

const DEFAULT_SURVEY_GAUGE_VISIBILITY: SurveyGaugeVisibility = {
  total: true,
  trip: true,
  speed: true,
  avgSpeed: true,
  maxSpeed: true,
  officialClock: true,
  altitude: true,
  gpsAccuracy: true,
  heading: true,
};

function loadSurveyGaugePrefs(): SurveyGaugeVisibility {
  try {
    const raw = localStorage.getItem(SURVEY_GAUGE_PREFS_KEY);
    if (!raw) return DEFAULT_SURVEY_GAUGE_VISIBILITY;
    return { ...DEFAULT_SURVEY_GAUGE_VISIBILITY, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SURVEY_GAUGE_VISIBILITY;
  }
}

const SurveyOfficialClockCard: React.FC<{ clockOffsetMs: number }> = ({ clockOffsetMs }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
      <p className="ps-label truncate">Horário Oficial (CH)</p>
      <p className="mt-1 font-mono text-[clamp(1.25rem,5.4vw,1.85rem)] leading-none font-black text-[var(--ps-emerald)] tabular-nums">
        {formatClockTime(nowMs + clockOffsetMs)}
      </p>
      <p className="mt-1 inline-flex items-center justify-center gap-1 font-mono text-[10px] text-[var(--ps-muted)]">
        <Clock className="h-3 w-3 text-[var(--ps-emerald)]" />
        <span>GPS SYNC</span>
      </p>
    </div>
  );
};

const SurveyFullscreenClockPill: React.FC<{ clockOffsetMs: number }> = ({ clockOffsetMs }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-white shadow-lg backdrop-blur-sm">
      <Clock className="h-3 w-3 shrink-0 text-[#6EE7B7]" />
      <span className="text-[9px] font-bold tracking-wider text-white/80 uppercase">
        Horário Oficial (CH)
      </span>
      <span className="font-mono text-xs font-black text-[#6EE7B7] tabular-nums">
        {formatClockTime(nowMs + clockOffsetMs)}
      </span>
    </div>
  );
};

interface SurveyCockpitProps {
  isActive?: boolean;
  externalTracks?: VelocityTrack[];
  externalWaypoints?: GeoWaypoint[];
  initialSelectedTrackId?: string;
  initialTransitTargetKey?: string;
  forceOpenNavToken?: number;
  onTracksUpdated?: () => void;
}

export const SurveyCockpit: React.FC<SurveyCockpitProps> = ({
  isActive = true,
  externalTracks,
  externalWaypoints,
  initialSelectedTrackId,
  initialTransitTargetKey,
  forceOpenNavToken,
  onTracksUpdated,
}) => {
  const [settings] = useNavSettings();
  const [surveySubTab, setSurveySubTab] = useState<'survey' | 'recce3d'>('survey');
  const [standaloneTracks, setStandaloneTracks] = useState<VelocityTrack[]>([]);
  const [source, setSource] = useState<DriveMode>('gps');
  const [totalKm, setTotalKm] = useState(0);
  const [tripKm, setTripKm] = useState(0);
  const [regressive, setRegressive] = useState(false);
  const [targetKm, setTargetKm] = useState(10.0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [avgSpeedKmh, setAvgSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [simSpeedKmh, setSimSpeedKmh] = useState(50);
  const [simRunning, setSimRunning] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isCounting, setIsCounting] = useState(true);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('10.00');
  const [editingTotalOdo, setEditingTotalOdo] = useState(false);
  const [totalOdoInput, setTotalOdoInput] = useState('0');
  const [editingTripOdo, setEditingTripOdo] = useState(false);
  const [tripOdoInput, setTripOdoInput] = useState('0');
  const [odoEditUnit, setOdoEditUnit] = useState<'m' | 'km'>('m');

  // Limite de Velocidade configurável com alerta visual e sonoro
  const [reccePrefs, setReccePrefs] = useState<ReccePrefs>(() => loadReccePrefs());
  const [recceOverCount, setRecceOverCount] = useState(0);
  const [reccePeakSpeedKmh, setReccePeakSpeedKmh] = useState(0);
  const lastRecceAlertTsRef = useRef<number>(0);
  const wasOverLimitRef = useRef<boolean>(false);

  // KML / KMZ & Waze Navigation State (persistido no IndexedDB)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importedGeo, setImportedGeo] = useState<ParsedGeoImportResult | null>(null);
  const [surveyGeoHydrated, setSurveyGeoHydrated] = useState(false);
  const [selectedTrackIdOverride, setSelectedTrackIdOverride] = useState<string | null>(
    initialSelectedTrackId ?? null
  );
  const [selectedTrackIdx, setSelectedTrackIdx] = useState<number>(0);
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [wazeNavActive, setWazeNavActive] = useState(false);
  const [navSpeedFullscreen, setNavSpeedFullscreen] = useState(false);
  const [wazeVoiceEnabled, setWazeVoiceEnabled] = useState(true);
  const [drivingMapTheme, setDrivingMapTheme] = useState<'satellite' | 'dark' | 'light'>('dark');
  const [drivingHeadingUp, setDrivingHeadingUp] = useState(true);
  const [drivingMapUserPaused, setDrivingMapUserPaused] = useState(false);
  const [drivingRecenterTick, setDrivingRecenterTick] = useState(0);
  const [showDrivingSpeedLimitPopover, setShowDrivingSpeedLimitPopover] = useState(false);
  const [drivingClockNowMs, setDrivingClockNowMs] = useState(() => Date.now());
  const [showRallyOverviewModal, setShowRallyOverviewModal] = useState(false);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [showGaugeConfig, setShowGaugeConfig] = useState(false);
  const [gaugeVisibility, setGaugeVisibility] = useState<SurveyGaugeVisibility>(() =>
    loadSurveyGaugePrefs()
  );

  const kalmanRef = useRef(createGpsKalmanProcessor());
  const isCountingRef = useRef(isCounting);
  isCountingRef.current = isCounting;
  const simProgressKmRef = useRef(0);
  const lastSpokenStepKeyRef = useRef<string>('');
  const calFactorRef = useRef(settings.calibrationPct / 100);
  calFactorRef.current = settings.calibrationPct / 100;
  const avgSpeedSumRef = useRef(0);
  const avgSpeedCountRef = useRef(0);
  const totalKmRef = useRef(0);
  const tripKmRef = useRef(0);
  totalKmRef.current = totalKm;
  tripKmRef.current = tripKm;
  const speedKmhRef = useRef(0);
  speedKmhRef.current = speedKmh;
  const lastClosestRouteIdxRef = useRef<number>(-1);
  const lastClosestRouteTrackIdRef = useRef<string>('');

  // Mapas Offline + Rotas de Deslocamento OSRM pré-salvas
  const [offlinePacks, setOfflinePacks] = useState<OfflineRallyPackMeta[]>(() =>
    loadOfflineRallyPacks()
  );
  const [offlineDownloading, setOfflineDownloading] = useState(false);
  const [offlineProg, setOfflineProg] = useState<OfflineDownloadProgress | null>(null);
  const offlineAbortRef = useRef<AbortController | null>(null);
  const [activeOsrmRoute, setActiveOsrmRoute] = useState<CachedTransitRoute | null>(null);
  const [isRecalculatingRoute, setIsRecalculatingRoute] = useState(false);
  const lastOsrmFetchKeyRef = useRef<string>('');
  const lastRecalcAtMsRef = useRef<number>(0);

  useEffect(() => {
    if (!navSpeedFullscreen) return;
    setDrivingClockNowMs(Date.now());
    const id = window.setInterval(() => setDrivingClockNowMs(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [navSpeedFullscreen]);

  useEffect(() => {
    const syncPacks = () => setOfflinePacks(loadOfflineRallyPacks());
    window.addEventListener(OFFLINE_MAPS_UPDATED_EVENT, syncPacks);
    return () => window.removeEventListener(OFFLINE_MAPS_UPDATED_EVENT, syncPacks);
  }, []);

  useEffect(() => {
    if (externalTracks) return;
    let alive = true;
    loadVelocityDatabase()
      .then(({ tracks }) => {
        if (alive) setStandaloneTracks(tracks);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [externalTracks]);

  useEffect(() => {
    if (!forceOpenNavToken) return;
    setSurveySubTab('survey');
    if (initialTransitTargetKey?.startsWith('wp:')) {
      setSelectedPoiId(initialTransitTargetKey.slice(3));
    } else if (initialTransitTargetKey?.startsWith('ss:')) {
      setSelectedPoiId(null);
      setSelectedTrackIdOverride(initialTransitTargetKey.slice(3));
    } else if (initialSelectedTrackId) {
      setSelectedPoiId(null);
      setSelectedTrackIdOverride(initialSelectedTrackId);
    }
    setWazeNavActive(true);
    setNavSpeedFullscreen(true);
  }, [forceOpenNavToken, initialTransitTargetKey, initialSelectedTrackId]);

  useEffect(() => {
    try {
      localStorage.setItem(RECCE_PREFS_KEY, JSON.stringify(reccePrefs));
    } catch {
      // ignore storage errors
    }
  }, [reccePrefs]);

  useEffect(() => {
    try {
      localStorage.setItem(SURVEY_GAUGE_PREFS_KEY, JSON.stringify(gaugeVisibility));
    } catch {
      // ignore storage errors
    }
  }, [gaugeVisibility]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let saved = sanitizeStoredSurveyGeo(await idbKvGet<StoredSurveyGeo>(SURVEY_GEO_STORAGE_KEY));
        if (!saved && typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(SURVEY_GEO_STORAGE_KEY);
          if (raw) {
            saved = sanitizeStoredSurveyGeo(JSON.parse(raw) as Partial<StoredSurveyGeo>);
            if (saved) {
              await idbKvSet(SURVEY_GEO_STORAGE_KEY, saved);
            }
            localStorage.removeItem(SURVEY_GEO_STORAGE_KEY);
          }
        }
        if (alive && saved) {
          setImportedGeo(saved.geo);
          setSelectedTrackIdx(saved.selectedTrackIdx);
        }
      } catch {
        // ignore corrupt storage
      } finally {
        if (alive) setSurveyGeoHydrated(true);
      }
    })();
    return () => {
      alive = false;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!surveyGeoHydrated) return;
    if (!importedGeo) {
      void idbKvDelete(SURVEY_GEO_STORAGE_KEY);
      return;
    }
    const t = window.setTimeout(() => {
      void idbKvSet(SURVEY_GEO_STORAGE_KEY, { geo: importedGeo, selectedTrackIdx });
    }, 300);
    return () => window.clearTimeout(t);
  }, [importedGeo, selectedTrackIdx, surveyGeoHydrated]);

  const mergedTracks: VelocityTrack[] = useMemo(() => {
    const map = new Map<string, VelocityTrack>();
    for (const tr of importedGeo?.tracks ?? []) {
      map.set(tr.id, tr);
    }
    for (const tr of externalTracks ?? standaloneTracks) {
      if (!map.has(tr.id)) {
        map.set(tr.id, tr);
      }
    }
    return Array.from(map.values());
  }, [importedGeo, externalTracks, standaloneTracks]);

  const mergedWaypoints: GeoWaypoint[] = useMemo(() => {
    const byKey = new Map<string, GeoWaypoint>();
    for (const wp of externalWaypoints ?? []) {
      byKey.set(wp.name.trim().toLowerCase(), wp);
    }
    for (const tr of mergedTracks) {
      for (const wp of tr.waypoints ?? []) {
        byKey.set(wp.name.trim().toLowerCase(), wp);
      }
    }
    for (const wp of importedGeo?.waypoints ?? []) {
      byKey.set(wp.name.trim().toLowerCase(), wp);
    }
    return Array.from(byKey.values());
  }, [externalWaypoints, mergedTracks, importedGeo]);

  const loadedTrack: VelocityTrack | null = useMemo(() => {
    if (mergedTracks.length === 0) return null;
    if (selectedTrackIdOverride) {
      const matched = mergedTracks.find((t) => t.id === selectedTrackIdOverride);
      if (matched) return matched;
    }
    const clampedIdx = Math.min(selectedTrackIdx, mergedTracks.length - 1);
    return mergedTracks[clampedIdx] ?? mergedTracks[0] ?? null;
  }, [mergedTracks, selectedTrackIdOverride, selectedTrackIdx]);

  const activeTrackIndex = useMemo(() => {
    if (!loadedTrack) return 0;
    const idx = mergedTracks.findIndex((t) => t.id === loadedTrack.id);
    return idx >= 0 ? idx : 0;
  }, [mergedTracks, loadedTrack]);

  const multiTraces: MapPolylineLayer[] = useMemo(() => {
    if (mergedTracks.length === 0) return [];
    return mergedTracks
      .filter((tr) => tr.baseTrace && tr.baseTrace.length >= 2)
      .map((tr, idx) => ({
        id: tr.id,
        name: tr.name,
        description: tr.description,
        color: tr.color || '#0288D1',
        trace: tr.baseTrace ?? [],
        active: idx === activeTrackIndex,
      }));
  }, [mergedTracks, activeTrackIndex]);

  // Build ordered navigable points from KML/KMZ (either polyline trace or traps fallback)
  const routeSamples: VelocitySample[] = useMemo(() => {
    if (!loadedTrack) return [];
    if (loadedTrack.baseTrace && loadedTrack.baseTrace.length >= 2) {
      return loadedTrack.baseTrace;
    }
    if (loadedTrack.traps.length >= 2) {
      let accKm = 0;
      return loadedTrack.traps.map((t, idx) => {
        if (idx > 0) {
          const prev = loadedTrack.traps[idx - 1];
          accKm += haversineMetersVel(prev.lat, prev.lon, t.lat, t.lon) / 1000;
        }
        return {
          lat: t.lat,
          lon: t.lon,
          speedKmh: 0,
          accuracyM: 5,
          headingDeg: t.bearingDeg,
          altitudeM: null,
          timestampMs: loadedTrack.createdAtMs + idx * 1000,
          distKm: accKm,
          stageElapsedMs: idx * 1000,
        };
      });
    }
    return [];
  }, [loadedTrack]);

  const orderedTraps: VelocityTrap[] = useMemo(
    () => (loadedTrack ? loadedTrack.traps : []),
    [loadedTrack]
  );

  // Continuous High-Accuracy GPS watcher with 2D Kalman Filter + throttled UI flushes (~130ms)
  useEffect(() => {
    if (!isActive || source !== 'gps') return;
    let cancelled = false;
    let webWid: number | null = null;
    let capWid: string | null = null;
    let lastUiFlushMs = 0;
    let pendingMaxSpd = 0;
    let lastAcc: number | null = null;
    let lastPos: { lat: number; lon: number } | null = null;
    let lastHdg: number | null = null;
    let lastAlt: number | null = null;
    let lastSpd = 0;
    kalmanRef.current.reset();

    const flushGpsUi = (force = false) => {
      const now = performance.now();
      if (!force && now - lastUiFlushMs < 130) return;
      lastUiFlushMs = now;
      setGpsAccuracy(lastAcc);
      if (lastPos) setCurrentPos(lastPos);
      if (lastHdg !== null) setHeadingDeg(lastHdg);
      if (lastAlt !== null) setAltitudeM(lastAlt);
      setTotalKm(totalKmRef.current);
      setTripKm(tripKmRef.current);
      setSpeedKmh(lastSpd);
      if (pendingMaxSpd > 0) {
        const nextMax = pendingMaxSpd;
        setMaxSpeedKmh((m) => Math.max(m, nextMax));
      }
      if (avgSpeedCountRef.current > 0) {
        setAvgSpeedKmh(Math.round(avgSpeedSumRef.current / avgSpeedCountRef.current));
      }
    };

    const handlePos = (
      lat: number,
      lon: number,
      rawSpeedMs: number | null,
      rawHeading: number | null,
      accM: number | null,
      altM: number | null,
      ts: number
    ) => {
      if (cancelled) return;
      setGpsError(null);

      const filtered = kalmanRef.current.update({
        lat,
        lon,
        accuracyM: accM,
        rawSpeedMs,
        rawHeadingDeg: rawHeading,
        timestampMs: ts,
      });

      lastAcc = filtered.accuracyM;
      lastPos = { lat: filtered.lat, lon: filtered.lon };
      if (filtered.headingDeg !== null) lastHdg = filtered.headingDeg;
      if (altM !== null && Number.isFinite(altM)) lastAlt = Math.round(altM);

      if (isCountingRef.current && filtered.distStepM > 0) {
        const scaledKm = (filtered.distStepM / 1000) * calFactorRef.current;
        totalKmRef.current = Math.max(0, totalKmRef.current + scaledKm);
        tripKmRef.current = Math.max(0, tripKmRef.current + scaledKm);
      }

      const spdRounded = Math.round(filtered.speedKmh);
      lastSpd = spdRounded;
      if (isCountingRef.current && spdRounded >= 2) {
        pendingMaxSpd = Math.max(pendingMaxSpd, spdRounded);
        avgSpeedSumRef.current += spdRounded;
        avgSpeedCountRef.current += 1;
      }
      flushGpsUi(lastUiFlushMs === 0);
    };

    const start = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          await Geolocation.requestPermissions();
          if (cancelled) return;
          const wid = await Geolocation.watchPosition(
            getCapacitorGpsWatchOptions(),
            (pos, err) => {
              if (!cancelled && !err && pos) {
                handlePos(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.speed ?? null,
                  pos.coords.heading ?? null,
                  pos.coords.accuracy ?? null,
                  pos.coords.altitude ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id: wid }).catch(() => {});
            return;
          }
          capWid = wid;
        } catch {
          if (!cancelled) setGpsError('Erro ao acessar GPS nativo.');
        }
      } else if ('geolocation' in navigator) {
        webWid = navigator.geolocation.watchPosition(
          (pos) =>
            handlePos(
              pos.coords.latitude,
              pos.coords.longitude,
              pos.coords.speed ?? null,
              pos.coords.heading ?? null,
              pos.coords.accuracy ?? null,
              pos.coords.altitude ?? null,
              pos.timestamp || Date.now()
            ),
          () => {
            if (!cancelled) setGpsError('GPS aguardando sinal (ou use o Simulador).');
          },
          WEB_GPS_WATCH_OPTIONS
        );
      } else {
        setGpsError('GPS indisponível neste dispositivo.');
      }
    };

    start();
    return () => {
      cancelled = true;
      if (webWid !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(webWid);
      if (capWid !== null) Geolocation.clearWatch({ id: capWid }).catch(() => {});
    };
  }, [isActive, source]);

  // Indoor Simulator (follows KML/KMZ route trace when imported!)
  useEffect(() => {
    if (source !== 'simulator' || !simRunning) return;
    const totalRouteKm =
      routeSamples.length > 1 ? routeSamples[routeSamples.length - 1].distKm : 0;

    const id = window.setInterval(() => {
      const kmTick = (simSpeedKmh / 3600) * 0.25 * calFactorRef.current;
      if (isCountingRef.current) {
        setTotalKm((v) => v + kmTick);
        setTripKm((v) => v + kmTick);
        if (simSpeedKmh >= 2) {
          setMaxSpeedKmh((m) => Math.max(m, simSpeedKmh));
          avgSpeedSumRef.current += simSpeedKmh;
          avgSpeedCountRef.current += 1;
          setAvgSpeedKmh(Math.round(avgSpeedSumRef.current / avgSpeedCountRef.current));
        }
      }
      setSpeedKmh(simSpeedKmh);

      if (routeSamples.length >= 2 && totalRouteKm > 0.005) {
        const nextDist = simProgressKmRef.current + kmTick;
        simProgressKmRef.current = nextDist > totalRouteKm ? 0 : nextDist;
        const d = simProgressKmRef.current;

        let segIdx = 0;
        for (let i = 1; i < routeSamples.length; i += 1) {
          if (routeSamples[i].distKm >= d) {
            segIdx = i - 1;
            break;
          }
        }
        const a = routeSamples[segIdx];
        const b = routeSamples[Math.min(routeSamples.length - 1, segIdx + 1)];
        const segSpanKm = Math.max(1e-6, b.distKm - a.distKm);
        const frac = Math.max(0, Math.min(1, (d - a.distKm) / segSpanKm));
        const lat = a.lat + (b.lat - a.lat) * frac;
        const lon = a.lon + (b.lon - a.lon) * frac;
        const brg = bearingBetweenDeg(a.lat, a.lon, b.lat, b.lon);
        setCurrentPos({ lat, lon });
        setHeadingDeg(brg);
      }
    }, 250);

    return () => window.clearInterval(id);
  }, [source, simRunning, simSpeedKmh, routeSamples]);

  // Modo Recce: Evaluate speed zone + trigger audible & haptic alerts
  const warnThresholdKmh = Math.max(1, reccePrefs.speedLimitKmh - reccePrefs.warningMarginKmh);
  const recceZone: 'off' | 'ok' | 'warning' | 'over' = !reccePrefs.enabled
    ? 'off'
    : speedKmh >= reccePrefs.speedLimitKmh
      ? 'over'
      : speedKmh >= warnThresholdKmh
        ? 'warning'
        : 'ok';

  useEffect(() => {
    if (!reccePrefs.enabled) {
      wasOverLimitRef.current = false;
      return;
    }

    if (speedKmh >= reccePrefs.speedLimitKmh) {
      setReccePeakSpeedKmh((p) => Math.max(p, speedKmh));
      if (!wasOverLimitRef.current) {
        wasOverLimitRef.current = true;
        setRecceOverCount((c) => c + 1);
      }
    } else {
      wasOverLimitRef.current = false;
    }

    if (!reccePrefs.soundEnabled) return;
    if (recceZone !== 'warning' && recceZone !== 'over') return;

    const now = Date.now();
    const minIntervalMs = recceZone === 'over' ? 750 : 1800;
    if (now - lastRecceAlertTsRef.current < minIntervalMs) return;
    lastRecceAlertTsRef.current = now;

    playRecceAlertTone(recceZone);
    if (recceZone === 'over' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([120, 60, 120]);
      } catch {
        // ignore vibration error
      }
    }
  }, [reccePrefs.enabled, reccePrefs.speedLimitKmh, reccePrefs.soundEnabled, recceZone, speedKmh]);

  // Compute Waze-style turn-by-turn guidance from current position + loaded KML/KMZ (sliding window search)
  const guidance: WazeGuidance | null = useMemo(() => {
    if (!loadedTrack || routeSamples.length < 2) return null;
    if (lastClosestRouteTrackIdRef.current !== loadedTrack.id) {
      lastClosestRouteTrackIdRef.current = loadedTrack.id;
      lastClosestRouteIdxRef.current = -1;
    }
    const totalRouteKm = routeSamples[routeSamples.length - 1].distKm;
    let closestIdx = 0;

    if (currentPos) {
      let bestDistM = Infinity;
      const hintIdx = lastClosestRouteIdxRef.current;
      if (hintIdx >= 0 && hintIdx < routeSamples.length) {
        const wStart = Math.max(0, hintIdx - 25);
        const wEnd = Math.min(routeSamples.length - 1, hintIdx + 80);
        for (let i = wStart; i <= wEnd; i += 1) {
          const dM = haversineMetersVel(
            currentPos.lat,
            currentPos.lon,
            routeSamples[i].lat,
            routeSamples[i].lon
          );
          if (dM < bestDistM) {
            bestDistM = dM;
            closestIdx = i;
          }
        }
      }
      if (hintIdx < 0 || bestDistM > 350) {
        bestDistM = Infinity;
        for (let i = 0; i < routeSamples.length; i += 1) {
          const dM = haversineMetersVel(
            currentPos.lat,
            currentPos.lon,
            routeSamples[i].lat,
            routeSamples[i].lon
          );
          if (dM < bestDistM) {
            bestDistM = dM;
            closestIdx = i;
          }
        }
      }
      lastClosestRouteIdxRef.current = closestIdx;
    }

    const currentSample = routeSamples[closestIdx];
    const remainingTotalKm = Math.max(0, totalRouteKm - currentSample.distKm);
    const progressPct =
      totalRouteKm > 0.001
        ? Math.min(100, Math.max(0, (currentSample.distKm / totalRouteKm) * 100))
        : 0;

    // Look ahead along vertices to find next significant bend (>= 14 deg) or route finish
    let turnIdx = routeSamples.length - 1;
    let maneuver: { kind: ManeuverKind; label: string } = {
      kind: 'finish',
      label: 'Chegada ao final do traçado',
    };

    for (let i = Math.max(1, closestIdx + 1); i < routeSamples.length - 1; i += 1) {
      const prev = routeSamples[i - 1];
      const curr = routeSamples[i];
      const next = routeSamples[i + 1];
      const b1 = bearingBetweenDeg(prev.lat, prev.lon, curr.lat, curr.lon);
      const b2 = bearingBetweenDeg(curr.lat, curr.lon, next.lat, next.lon);
      const signed = signedAngleDiffDeg(b1, b2);
      if (Math.abs(signed) >= 14) {
        turnIdx = i;
        maneuver = classifyTurn(signed);
        break;
      }
    }

    const turnPoint = routeSamples[turnIdx];
    const distToManeuverM = currentPos
      ? Math.max(0, Math.round((turnPoint.distKm - currentSample.distKm) * 1000))
      : Math.round(turnPoint.distKm * 1000);

    // Match nearest named KML/KMZ placemark near that turn or ahead on route
    let targetLabel = loadedTrack.name;
    let nearestTrapDistM = Infinity;
    for (const tr of orderedTraps) {
      const dToTurn = haversineMetersVel(turnPoint.lat, turnPoint.lon, tr.lat, tr.lon);
      if (dToTurn < nearestTrapDistM && dToTurn <= 180) {
        nearestTrapDistM = dToTurn;
        targetLabel = tr.name;
      }
    }
    if (nearestTrapDistM === Infinity && maneuver.kind !== 'finish') {
      targetLabel = `Ponto ${turnIdx + 1} do trajeto`;
    }

    return {
      kind: maneuver.kind,
      instruction: maneuver.label,
      targetLabel,
      distToManeuverM,
      remainingTotalKm,
      progressPct,
      closestIdx,
    };
  }, [loadedTrack, routeSamples, orderedTraps, currentPos]);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportSummary(null);
    try {
      const result = await parseTrackFileToGeoResult(file);
      const preparedTracks = result.tracks.map((trk) => {
        const withTraps = ensureAutoTrapsFromBaseTrace(trk);
        return result.waypoints.length > 0 && !withTraps.waypoints
          ? { ...withTraps, waypoints: result.waypoints }
          : withTraps;
      });
      const preparedResult: ParsedGeoImportResult = {
        ...result,
        tracks: preparedTracks,
      };
      setImportedGeo(preparedResult);
      setSelectedTrackIdx(0);
      setSelectedTrackIdOverride(preparedTracks[0]?.id ?? null);
      setSelectedPoiId(null);
      simProgressKmRef.current = 0;
      if (preparedTracks.length > 0) {
        const db = await loadVelocityDatabase();
        const existingIds = new Set(preparedTracks.map((t) => t.id));
        const nextTracks = [
          ...preparedTracks,
          ...db.tracks.filter((t) => !existingIds.has(t.id)),
        ];
        await persistVelocityTracks(nextTracks);
        setStandaloneTracks(nextTracks);
        window.dispatchEvent(new Event('pitstop:velocity-db-updated'));
        onTracksUpdated?.();
        void uploadAllTracksToCloud(preparedTracks);
      }

      if (preparedTracks.length >= 2) {
        const names = formatImportedTrackNamesList(preparedTracks.map((t) => t.name));
        const wpSuffix =
          result.waypoints.length > 0
            ? ` + ${result.waypoints.length} ponto${result.waypoints.length > 1 ? 's' : ''} de apoio`
            : '';
        setImportSummary(`${preparedTracks.length} especiais importadas: ${names}${wpSuffix}.`);
      } else if (preparedTracks.length === 1) {
        const t = preparedTracks[0];
        const wpSuffix =
          result.waypoints.length > 0
            ? ` + ${result.waypoints.length} ponto${result.waypoints.length > 1 ? 's' : ''} no mapa`
            : '';
        setImportSummary(`Especial "${t.name}" importada${wpSuffix}.`);
      } else if (result.waypoints.length > 0) {
        setImportSummary(`${result.waypoints.length} pontos de interesse carregados no mapa.`);
      }

      const firstTrack = preparedTracks[0];
      const firstPt =
        firstTrack?.baseTrace?.[0] ?? firstTrack?.traps[0] ?? result.waypoints[0];
      if (firstPt && source === 'simulator') {
        setCurrentPos({ lat: firstPt.lat, lon: firstPt.lon });
        if (firstTrack?.baseTrace && firstTrack.baseTrace.length >= 2) {
          setHeadingDeg(
            bearingBetweenDeg(
              firstTrack.baseTrace[0].lat,
              firstTrack.baseTrace[0].lon,
              firstTrack.baseTrace[1].lat,
              firstTrack.baseTrace[1].lon
            )
          );
        }
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Falha ao ler KML/KMZ.');
    } finally {
      e.target.value = '';
    }
  };

  const handleClearImportedGeo = () => {
    setImportedGeo(null);
    setSelectedTrackIdx(0);
    setSelectedTrackIdOverride(null);
    setSelectedPoiId(null);
    setImportSummary(null);
    setImportError(null);
    setWazeNavActive(false);
    setNavSpeedFullscreen(false);
    simProgressKmRef.current = 0;
    void idbKvDelete(SURVEY_GEO_STORAGE_KEY);
    try {
      localStorage.removeItem(SURVEY_GEO_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const applyOdometerKeyboardValue = (which: 'total' | 'trip', rawText: string) => {
    const num = Number(rawText.replace(',', '.'));
    if (Number.isFinite(num) && num >= 0) {
      const nextKm = odoEditUnit === 'm' ? num / 1000 : num;
      if (which === 'total') {
        totalKmRef.current = nextKm;
        setTotalKm(nextKm);
      } else {
        const resolved = regressive ? Math.max(0, targetKm - nextKm) : nextKm;
        tripKmRef.current = resolved;
        setTripKm(resolved);
      }
    }
    if (which === 'total') setEditingTotalOdo(false);
    else setEditingTripOdo(false);
  };

  const handleResetAllSurvey = () => {
    totalKmRef.current = 0;
    tripKmRef.current = 0;
    setTotalKm(0);
    setTripKm(0);
    setMaxSpeedKmh(0);
    avgSpeedSumRef.current = 0;
    avgSpeedCountRef.current = 0;
    setAvgSpeedKmh(0);
    setRecceOverCount(0);
    setReccePeakSpeedKmh(0);
    simProgressKmRef.current = 0;
  };

  const displayedTripKm = regressive ? Math.max(0, targetKm - tripKm) : tripKm;
  const totalMeters = Math.round(totalKm * 1000);
  const tripMeters = Math.round(displayedTripKm * 1000);

  const transitDestination = useMemo(() => {
    if (selectedPoiId && mergedWaypoints.length > 0) {
      const wp = mergedWaypoints.find((item) => item.id === selectedPoiId);
      if (wp) {
        const distM = currentPos
          ? haversineMetersVel(currentPos.lat, currentPos.lon, wp.lat, wp.lon)
          : null;
        const absBrg = currentPos
          ? bearingBetweenDeg(currentPos.lat, currentPos.lon, wp.lat, wp.lon)
          : 0;
        const relArrowDeg =
          headingDeg !== null ? (absBrg - headingDeg + 360) % 360 : absBrg;
        return {
          id: wp.id,
          name: wp.name,
          kind: 'poi' as const,
          lat: wp.lat,
          lon: wp.lon,
          color: wp.color || '#F59E0B',
          distM,
          relArrowDeg,
        };
      }
    }
    if (loadedTrack) {
      const startTrap =
        loadedTrack.traps.find((t) => t.kind === 'start' || t.kind === 'start_finish') ??
        loadedTrack.traps[0];
      const pt = startTrap
        ? { lat: startTrap.lat, lon: startTrap.lon }
        : routeSamples[0]
          ? { lat: routeSamples[0].lat, lon: routeSamples[0].lon }
          : null;
      if (pt) {
        const distM = currentPos
          ? haversineMetersVel(currentPos.lat, currentPos.lon, pt.lat, pt.lon)
          : null;
        const absBrg = currentPos
          ? bearingBetweenDeg(currentPos.lat, currentPos.lon, pt.lat, pt.lon)
          : 0;
        const relArrowDeg =
          headingDeg !== null ? (absBrg - headingDeg + 360) % 360 : absBrg;
        return {
          id: loadedTrack.id,
          name: `${loadedTrack.name} · Largada`,
          kind: 'ss' as const,
          lat: pt.lat,
          lon: pt.lon,
          color: loadedTrack.color || '#38BDF8',
          distM,
          relArrowDeg,
        };
      }
    }
    if (mergedWaypoints.length > 0) {
      const wp = mergedWaypoints[0];
      const distM = currentPos
        ? haversineMetersVel(currentPos.lat, currentPos.lon, wp.lat, wp.lon)
        : null;
      const absBrg = currentPos
        ? bearingBetweenDeg(currentPos.lat, currentPos.lon, wp.lat, wp.lon)
        : 0;
      const relArrowDeg =
        headingDeg !== null ? (absBrg - headingDeg + 360) % 360 : absBrg;
      return {
        id: wp.id,
        name: wp.name,
        kind: 'poi' as const,
        lat: wp.lat,
        lon: wp.lon,
        color: wp.color || '#F59E0B',
        distM,
        relArrowDeg,
      };
    }
    return null;
  }, [selectedPoiId, mergedWaypoints, loadedTrack, routeSamples, currentPos, headingDeg]);

  // Busca rota real pelas ruas/rodovias (OSRM online ou Cache Offline pré-salvo) sempre que houver destino e GPS
  useEffect(() => {
    if (!currentPos || !transitDestination) {
      setActiveOsrmRoute(null);
      return;
    }

    const cached = findBestCachedTransitRoute(
      currentPos.lat,
      currentPos.lon,
      transitDestination.lat,
      transitDestination.lon
    );
    if (cached) {
      const check = computeOsrmGuidanceFromRoute(
        cached,
        currentPos.lat,
        currentPos.lon,
        speedKmhRef.current
      );
      if (check.distanceFromRouteM <= 40 || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        setActiveOsrmRoute(cached);
        return;
      }
    }

    const fetchKey = `${currentPos.lat.toFixed(2)},${currentPos.lon.toFixed(2)}->${transitDestination.lat.toFixed(4)},${transitDestination.lon.toFixed(4)}`;
    if (lastOsrmFetchKeyRef.current === fetchKey) return;
    lastOsrmFetchKeyRef.current = fetchKey;

    const ctrl = new AbortController();
    void fetchAndCacheLiveOsrmRoute(
      currentPos.lat,
      currentPos.lon,
      transitDestination.lat,
      transitDestination.lon,
      'Posição Atual',
      transitDestination.name,
      ctrl.signal
    ).then((route) => {
      if (ctrl.signal.aborted) return;
      if (route) {
        setActiveOsrmRoute(route);
      } else {
        const offlineNearest = findNearestOfflineRouteEntry(
          currentPos.lat,
          currentPos.lon,
          transitDestination.lat,
          transitDestination.lon
        );
        if (offlineNearest) setActiveOsrmRoute(offlineNearest);
      }
    });
    return () => ctrl.abort();
  }, [currentPos, transitDestination]);

  const osrmGuidance = useMemo(() => {
    if (!activeOsrmRoute || !currentPos) return null;
    return computeOsrmGuidanceFromRoute(activeOsrmRoute, currentPos.lat, currentPos.lon, speedKmh);
  }, [activeOsrmRoute, currentPos, speedKmh]);

  // Recálculo automático se o veículo sair da rota planejada (> 40 metros)
  useEffect(() => {
    if (!currentPos || !transitDestination || !activeOsrmRoute || !osrmGuidance) return;
    if (osrmGuidance.distanceFromRouteM <= 40) return;

    const nowMs = Date.now();
    if (nowMs - lastRecalcAtMsRef.current < 6000) return;
    lastRecalcAtMsRef.current = nowMs;

    const ctrl = new AbortController();
    setIsRecalculatingRoute(true);

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const nearestOffline = findNearestOfflineRouteEntry(
        currentPos.lat,
        currentPos.lon,
        transitDestination.lat,
        transitDestination.lon
      );
      if (nearestOffline && nearestOffline.id !== activeOsrmRoute.id) {
        setActiveOsrmRoute(nearestOffline);
      }
      setIsRecalculatingRoute(false);
      return () => ctrl.abort();
    }

    void fetchAndCacheLiveOsrmRoute(
      currentPos.lat,
      currentPos.lon,
      transitDestination.lat,
      transitDestination.lon,
      'Posição Atual',
      transitDestination.name,
      ctrl.signal
    ).then((recalculated) => {
      if (ctrl.signal.aborted) return;
      if (recalculated) {
        setActiveOsrmRoute(recalculated);
      } else {
        const nearestOffline = findNearestOfflineRouteEntry(
          currentPos.lat,
          currentPos.lon,
          transitDestination.lat,
          transitDestination.lon
        );
        if (nearestOffline && nearestOffline.id !== activeOsrmRoute.id) {
          setActiveOsrmRoute(nearestOffline);
        }
      }
      setIsRecalculatingRoute(false);
    });

    return () => ctrl.abort();
  }, [currentPos, transitDestination, activeOsrmRoute, osrmGuidance]);

  // Optional pt-BR Waze Voice Guidance (prioritizes OSRM turn-by-turn street instructions)
  useEffect(() => {
    if (!wazeNavActive || !wazeVoiceEnabled) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const dM = osrmGuidance ? osrmGuidance.distToManeuverM : guidance?.distToManeuverM;
    const rawInstr = osrmGuidance ? osrmGuidance.nextInstruction : guidance?.instruction;
    const rawTarget = osrmGuidance
      ? osrmGuidance.nextRoadName || transitDestination?.name || 'destino'
      : guidance?.targetLabel;
    const kindKey = osrmGuidance ? osrmGuidance.nextKind : guidance?.kind;

    if (dM === undefined || !rawInstr || !kindKey) return;
    const bucket = dM <= 45 ? 'now' : dM <= 180 ? '150m' : dM <= 500 ? '400m' : '';
    if (!bucket) return;
    const key = `${rawTarget}-${kindKey}-${bucket}`;
    if (lastSpokenStepKeyRef.current === key) return;
    lastSpokenStepKeyRef.current = key;

    const spokenText =
      bucket === 'now'
        ? rawInstr
        : `Em ${Math.round(dM / 10) * 10} metros, ${rawInstr.toLowerCase()}`;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(spokenText);
      utter.lang = 'pt-BR';
      utter.rate = 1.08;
      window.speechSynthesis.speak(utter);
    } catch {
      // ignore speech errors
    }
  }, [wazeNavActive, wazeVoiceEnabled, osrmGuidance, guidance, transitDestination]);

  const activeRallyFolderKey = useMemo(() => {
    const first = mergedTracks[0];
    if (first?.folderId) return `folder:${first.folderId}`;
    if (first?.folderName) return `name:${first.folderName.trim().toLowerCase()}`;
    if (importedGeo?.documentName) return `name:${importedGeo.documentName.trim().toLowerCase()}`;
    return 'rally-survey-default';
  }, [mergedTracks, importedGeo]);

  const activeRallyFolderName = useMemo(() => {
    return (
      mergedTracks[0]?.folderName ||
      importedGeo?.documentName ||
      loadedTrack?.name ||
      'Mapa da Prova'
    );
  }, [mergedTracks, importedGeo, loadedTrack]);

  const activeOfflinePack = useMemo(
    () => offlinePacks.find((p) => p.folderKey === activeRallyFolderKey) ?? null,
    [offlinePacks, activeRallyFolderKey]
  );

  const handleDownloadSurveyOfflineMap = async () => {
    if (offlineDownloading || (mergedTracks.length === 0 && mergedWaypoints.length === 0)) return;
    const ctrl = new AbortController();
    offlineAbortRef.current = ctrl;
    setOfflineDownloading(true);
    setOfflineProg({
      phase: 'tiles',
      completed: 0,
      total: 1,
      bytesDownloaded: 0,
      label: 'Preparando quadrantes...',
    });
    try {
      const meta = await downloadRallyOfflineBundle({
        folderKey: activeRallyFolderKey,
        folderName: activeRallyFolderName,
        tracks: mergedTracks,
        waypoints: mergedWaypoints,
        signal: ctrl.signal,
        onProgress: (p) => setOfflineProg(p),
      });
      setOfflinePacks(loadOfflineRallyPacks());
      if (!ctrl.signal.aborted) {
        setImportSummary(
          `✅ Mapa Offline pronto (${formatBytesCompact(meta.estimatedBytes)} · ${meta.tileCount} quadrantes · ${meta.routesCount} rotas).`
        );
      }
    } catch {
      setImportError('Falha parcial ao baixar mapa offline. Tente novamente com conexão estável.');
    } finally {
      offlineAbortRef.current = null;
      setOfflineDownloading(false);
      setOfflineProg(null);
    }
  };

  const startSpeedNavigation = () => {
    setWazeNavActive(true);
    setDrivingHeadingUp(true);
    setDrivingMapUserPaused(false);
    setShowDrivingSpeedLimitPopover(false);
    setDrivingRecenterTick((t) => t + 1);
    if (!currentPos && routeSamples.length > 1) {
      setCurrentPos({ lat: routeSamples[0].lat, lon: routeSamples[0].lon });
      setHeadingDeg(
        bearingBetweenDeg(
          routeSamples[0].lat,
          routeSamples[0].lon,
          routeSamples[1].lat,
          routeSamples[1].lon
        )
      );
    }
    setNavSpeedFullscreen(true);
  };

  const exitSpeedNavigation = () => {
    setNavSpeedFullscreen(false);
    setWazeNavActive(false);
    setShowDrivingSpeedLimitPopover(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore speech cancel errors
      }
    }
  };

  const speedPctOfLimit = Math.min(
    100,
    Math.max(0, (speedKmh / Math.max(1, reccePrefs.speedLimitKmh)) * 100)
  );

  return (
    <div
      className={`mx-auto max-w-5xl space-y-2.5 text-[var(--ps-text)] rounded-2xl transition-all ${
        surveySubTab === 'survey' && recceZone === 'over'
          ? 'ring-2 ring-red-500 bg-red-950/20 p-1.5 shadow-[0_0_32px_rgba(239,68,68,0.45)]'
          : ''
      }`}
    >
      {/* Unified Sub-Tabs: 1) Levantamento & Deslocamento  2) Reconhecimento Virtual 3D */}
      <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-1.5">
        <button
          type="button"
          onClick={() => setSurveySubTab('survey')}
          className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-extrabold tracking-wide uppercase transition-colors ${
            surveySubTab === 'survey'
              ? 'pitstop-btn-red'
              : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
          }`}
        >
          <Compass className="h-4 w-4 shrink-0" />
          <span className="truncate">Levantamento &amp; Deslocamento</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setNavSpeedFullscreen(false);
            setWazeNavActive(false);
            setSurveySubTab('recce3d');
          }}
          className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-extrabold tracking-wide uppercase transition-colors ${
            surveySubTab === 'recce3d'
              ? 'pitstop-btn-red'
              : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
          }`}
        >
          <Box className="h-4 w-4 shrink-0" />
          <span className="truncate">Reconhecimento Virtual 3D</span>
        </button>
      </div>

      {surveySubTab === 'recce3d' ? (
        <Suspense
          fallback={
            <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-8 text-center text-xs text-[var(--ps-muted)]">
              Carregando motor 3D de terreno...
            </div>
          }
        >
          <VirtualRecce3D
            track={loadedTrack}
            availableTracks={mergedTracks}
            onSelectTrackId={(id) => {
              setSelectedTrackIdOverride(id);
              const idx = mergedTracks.findIndex((t) => t.id === id);
              if (idx >= 0) setSelectedTrackIdx(idx);
            }}
            waypoints={mergedWaypoints}
          />
        </Suspense>
      ) : (
        <>
      {/* Top Header: Levantamento & Deslocamento + GPS/Simulador + Importar KML/KMZ */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Compass className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
          <h1 className="truncate font-['Barlow_Condensed'] text-lg font-extrabold italic tracking-wide uppercase">
            Levantamento &amp; Deslocamento
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
            <button
              type="button"
              onClick={() => {
                setSource('gps');
                setSimRunning(false);
              }}
              className={`min-h-[34px] rounded-lg px-2.5 text-xs font-bold whitespace-nowrap ${
                source === 'gps'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              GPS {gpsAccuracy !== null ? `±${gpsAccuracy}m` : ''}
            </button>
            <button
              type="button"
              onClick={() => setSource('simulator')}
              className={`min-h-[34px] rounded-lg px-2.5 text-xs font-bold whitespace-nowrap ${
                source === 'simulator'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              Sim
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".kml,.kmz,.gpx,.geojson,.json"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)] whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
            <span>KML/KMZ</span>
          </button>

          <button
            type="button"
            onClick={() => setShowGaugeConfig((v) => !v)}
            className={`inline-flex min-h-[34px] items-center gap-1 rounded-xl border px-2.5 text-xs font-bold whitespace-nowrap transition-colors ${
              showGaugeConfig
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
            }`}
            title="Configurar campos visíveis"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>Campos</span>
          </button>

          <SurveyClockBadge clockOffsetMs={settings.clockOffsetMs} />
        </div>
      </section>

      {showGaugeConfig && (
        <section className="grid grid-cols-2 gap-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-[11px] sm:grid-cols-3">
          {(
            [
              ['total', 'Odômetro Total'],
              ['trip', 'Hodômetro Trip'],
              ['speed', 'Vel. Atual'],
              ['avgSpeed', 'Vel. Média'],
              ['maxSpeed', 'Vel. Máxima'],
              ['officialClock', 'Horário CH (GPS)'],
              ['altitude', 'Altitude'],
              ['gpsAccuracy', 'Sinal GPS'],
              ['heading', 'Rumo (CAP)'],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex cursor-pointer items-center justify-between gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5 text-[var(--ps-text)]"
            >
              <span className="truncate font-semibold">{label}</span>
              <input
                type="checkbox"
                checked={gaugeVisibility[key]}
                onChange={(e) =>
                  setGaugeVisibility((prev) => ({
                    ...prev,
                    [key]: e.target.checked,
                  }))
                }
                className="h-3.5 w-3.5 accent-[var(--ps-accent)]"
              />
            </label>
          ))}
        </section>
      )}

      {/* Compact Top Alert Strip (only shown when warning/exceeding limit) */}
      {(recceZone === 'over' || recceZone === 'warning') && (
        <section
          className={`flex items-center justify-between gap-2 rounded-2xl border px-3 py-2 text-xs font-bold ${
            recceZone === 'over'
              ? 'animate-pulse border-red-500 bg-red-950/90 text-red-100'
              : 'border-amber-400 bg-amber-950/80 text-amber-100'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="truncate">
              {recceZone === 'over'
                ? `ACIMA DO LIMITE: ${speedKmh} / ${reccePrefs.speedLimitKmh} km/h — REDUZA!`
                : `Próximo do limite: ${speedKmh} / ${reccePrefs.speedLimitKmh} km/h`}
            </span>
          </div>
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            Pico {Math.max(reccePeakSpeedKmh, speedKmh)}
          </span>
        </section>
      )}

      {importError && (
        <div className="rounded-xl border border-red-500/40 bg-red-950/30 px-3.5 py-2 text-xs text-red-400">
          {importError}
        </div>
      )}

      {importSummary && !importError && (
        <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-300">
          {importSummary}
        </div>
      )}

      {source === 'simulator' && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSimRunning((v) => !v)}
              className={`min-h-[38px] rounded-xl px-4 text-xs font-extrabold uppercase ${
                simRunning
                  ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)]'
                  : 'pitstop-btn-red'
              }`}
            >
              {simRunning ? 'Pausar Simulador' : 'Iniciar Simulador'}
            </button>
            <span className="font-mono text-xs font-bold text-[var(--ps-amber)] tabular-nums">
              {simSpeedKmh} km/h
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={140}
            step={2}
            value={simSpeedKmh}
            onChange={(e) => setSimSpeedKmh(Number(e.target.value))}
            className="flex-1 min-w-[160px] accent-[var(--ps-accent)]"
            aria-label="Velocidade do simulador"
          />
        </section>
      )}

      {gpsError && source === 'gps' && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs text-[var(--ps-amber)]">
          {gpsError}
        </div>
      )}

      {/* Compact Map & Navegar HUD */}
      <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3">
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--ps-border)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
            <p className="truncate text-xs font-bold text-[var(--ps-text)]">
              {loadedTrack
                ? `${loadedTrack.name} · ${loadedTrack.referenceDistanceKm.toFixed(1).replace('.', ',')} km${
                    loadedTrack.description &&
                    loadedTrack.description.replace(/\s+/g, '') !==
                      `${loadedTrack.referenceDistanceKm.toFixed(1).replace('.', ',')}km`
                      ? ` · ${loadedTrack.description}`
                      : ''
                  }`
                : importedGeo && importedGeo.waypoints.length > 0
                  ? `${importedGeo.documentName} · ${importedGeo.waypoints.length} pontos`
                  : 'Mapa (Erechim / GPS)'}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {importedGeo && (
              <button
                type="button"
                onClick={handleClearImportedGeo}
                title="Remover arquivo KML/GPX salvo"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border)] bg-transparent px-2 text-[10px] font-bold text-[var(--ps-muted)] hover:border-[var(--ps-border-strong)] hover:text-[var(--ps-text)] transition-colors"
              >
                <X className="h-3 w-3 shrink-0" />
                <span>Limpar Arquivo</span>
              </button>
            )}

            {wazeNavActive && (
              <button
                type="button"
                onClick={() => setWazeVoiceEnabled((v) => !v)}
                title={wazeVoiceEnabled ? 'Silenciar voz' : 'Ativar voz'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                {wazeVoiceEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            {(mergedTracks.length > 0 || mergedWaypoints.length > 0) && (
              <>
                <span
                  className={`inline-flex h-8 items-center rounded-lg border px-2 font-mono text-[10px] font-extrabold ${
                    activeOfflinePack
                      ? 'border-emerald-500/45 bg-emerald-500/15 text-[var(--ps-emerald)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                  }`}
                >
                  {activeOfflinePack
                    ? `✅ Offline Pronto (${formatBytesCompact(activeOfflinePack.estimatedBytes)})`
                    : 'Online'}
                </span>

                <button
                  type="button"
                  disabled={offlineDownloading}
                  onClick={() => {
                    void handleDownloadSurveyOfflineMap();
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-emerald-500/45 bg-emerald-500/15 px-2.5 text-[10px] font-extrabold text-emerald-300 uppercase hover:bg-emerald-500/25 disabled:opacity-50"
                  title="Baixar mapa offline (Satélite/Ruas, Elevação e Rotas de Deslocamento)"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>{activeOfflinePack ? 'Atualizar Offline' : 'Baixar Mapa Offline'}</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={startSpeedNavigation}
              className="pitstop-btn-red inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[11px] font-extrabold uppercase transition-colors"
            >
              <Navigation className="h-3.5 w-3.5" />
              <span>Navegar em Tela Cheia</span>
            </button>
          </div>
        </div>

        {offlineDownloading && offlineProg && (
          <div className="mt-2 rounded-xl border border-emerald-500/35 bg-[var(--ps-card-deep)] px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
              <span className="truncate font-bold text-emerald-300">
                {offlineProg.label} ({formatBytesCompact(offlineProg.bytesDownloaded)})
              </span>
              <button
                type="button"
                onClick={() => offlineAbortRef.current?.abort()}
                className="shrink-0 rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-[10px] font-extrabold text-red-300 uppercase"
              >
                Cancelar
              </button>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/50">
              <div
                className="h-full rounded-full bg-emerald-400 transition-all duration-150"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((offlineProg.completed / Math.max(1, offlineProg.total)) * 100)
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Card de Navegação Curva a Curva (Ruas / Rodovias / Offline) */}
        {(wazeNavActive || Boolean(transitDestination && (osrmGuidance || activeOsrmRoute))) && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-sky-400/40 bg-[#081A2E] px-2.5 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-500/20 border border-sky-400/30">
                {osrmGuidance
                  ? renderManeuverIcon(osrmGuidance.nextKind)
                  : guidance
                    ? renderManeuverIcon(guidance.kind)
                    : <Navigation className="h-4 w-4 text-sky-300" />}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-xs font-extrabold text-white">
                  <span className="font-mono text-sky-300 mr-1.5 tabular-nums">
                    {osrmGuidance
                      ? osrmGuidance.distToManeuverM >= 1000
                        ? `${(osrmGuidance.distToManeuverM / 1000).toFixed(1).replace('.', ',')}km`
                        : `${osrmGuidance.distToManeuverM}m`
                      : guidance
                        ? guidance.distToManeuverM >= 1000
                          ? `${(guidance.distToManeuverM / 1000).toFixed(1).replace('.', ',')}km`
                          : `${guidance.distToManeuverM}m`
                        : 'GPS'}
                  </span>
                  {isRecalculatingRoute
                    ? 'Recalculando rota...'
                    : osrmGuidance
                      ? osrmGuidance.nextInstruction
                      : guidance
                        ? guidance.instruction
                        : 'Calculando rota pelas vias...'}
                </p>
                {(osrmGuidance || guidance || transitDestination) && (
                  <p className="truncate font-mono text-[10px] text-sky-200/75">
                    {osrmGuidance?.nextRoadName
                      ? `${osrmGuidance.nextRoadName} · ${transitDestination?.name ?? ''}`
                      : transitDestination?.name ?? guidance?.targetLabel}
                  </p>
                )}
              </div>
            </div>

            {(osrmGuidance || guidance) && (
              <div className="shrink-0 text-right font-mono text-[11px] leading-tight tabular-nums">
                <div className="flex items-center justify-end gap-1.5">
                  {osrmGuidance && (
                    <span className="font-black text-emerald-300">
                      {osrmGuidance.etaMin} min
                    </span>
                  )}
                  <span className="font-bold text-white">
                    {(osrmGuidance ? osrmGuidance.remainingTotalKm : guidance!.remainingTotalKm)
                      .toFixed(1)
                      .replace('.', ',')} km
                  </span>
                </div>
                {headingDeg !== null && (
                  <span className="text-[10px] text-amber-300">{headingDeg}°</span>
                )}
              </div>
            )}
          </div>
        )}

        {(mergedTracks.length >= 1 || mergedWaypoints.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {loadedTrack?.folderName && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2 py-1 text-[10px] font-extrabold text-amber-300">
                <Folder className="h-3 w-3 shrink-0" />
                <span className="max-w-[160px] truncate">{loadedTrack.folderName}</span>
              </span>
            )}
            {mergedTracks.length >= 1 && (
              <button
                type="button"
                onClick={() => setShowRallyOverviewModal(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-sky-400/45 bg-sky-500/15 px-2.5 py-1 text-[10px] font-extrabold text-sky-300 uppercase hover:bg-sky-500/25 active:scale-95"
              >
                <MapIcon className="h-3 w-3 shrink-0" />
                <span>Ver Mapa da Prova</span>
              </button>
            )}
            {mergedTracks.map((tr, idx) => {
              const isSelected = !selectedPoiId && loadedTrack?.id === tr.id;
              return (
                <button
                  key={tr.id}
                  type="button"
                  onClick={() => {
                    setSelectedPoiId(null);
                    setSelectedTrackIdOverride(tr.id);
                    setSelectedTrackIdx(idx);
                    simProgressKmRef.current = 0;
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                    isSelected
                      ? 'border-[var(--ps-accent)] bg-[var(--ps-card)] text-[var(--ps-text)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tr.color || '#0288D1' }}
                  />
                  <span className="truncate max-w-[160px]">{tr.name}</span>
                  <span className="font-mono text-[10px] opacity-75">
                    {tr.referenceDistanceKm.toFixed(1).replace('.', ',')}km
                  </span>
                </button>
              );
            })}
            {mergedWaypoints.map((wp) => {
              const isSelected = selectedPoiId === wp.id;
              return (
                <button
                  key={wp.id}
                  type="button"
                  onClick={() => setSelectedPoiId(wp.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                    isSelected
                      ? 'border-amber-400 bg-amber-500/15 text-[var(--ps-text)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <MapPin
                    className="h-3 w-3 shrink-0"
                    style={{ color: wp.color || '#F59E0B' }}
                  />
                  <span className="truncate max-w-[160px]">{wp.name}</span>
                </button>
              );
            })}
          </div>
        )}

        <VelocityMapboxView
          trackId={
            loadedTrack?.id ??
            (importedGeo ? `geo-${importedGeo.documentName}` : 'levantamento-erechim')
          }
          editableTrace={routeSamples}
          traceColor={loadedTrack?.color}
          multiTraces={multiTraces.length > 0 ? multiTraces : undefined}
          waypoints={
            mergedWaypoints.length > 0 || (loadedTrack?.detectedSplitPoints?.length ?? 0) > 0
              ? [
                  ...mergedWaypoints,
                  ...(loadedTrack?.detectedSplitPoints ?? []).map((pt) => ({
                    id: pt.id,
                    name: pt.originalName,
                    lat: pt.lat,
                    lon: pt.lon,
                    color: '#F59E0B',
                  })),
                ]
              : undefined
          }
          orderedTraps={orderedTraps}
          postEditIdx={guidance ? guidance.closestIdx : 0}
          currentPos={currentPos}
          navigationMode={wazeNavActive || navSpeedFullscreen}
          driving3dMode={navSpeedFullscreen || wazeNavActive}
          headingUp={navSpeedFullscreen ? drivingHeadingUp : undefined}
          drivingTheme={navSpeedFullscreen ? drivingMapTheme : undefined}
          recenterTrigger={drivingRecenterTick}
          onUserPanChanged={setDrivingMapUserPaused}
          hideBuiltInTopControls={navSpeedFullscreen}
          navHeadingDeg={headingDeg}
          transitRoute={
            transitDestination && currentPos
              ? {
                  toLat: transitDestination.lat,
                  toLon: transitDestination.lon,
                  label: transitDestination.name,
                  color: transitDestination.color,
                  routeLatLngs: osrmGuidance?.remainingGeometry ?? activeOsrmRoute?.geometryLatLng,
                }
              : null
          }
          onSelectWaypoint={(wp) => {
            setSelectedPoiId(wp.id);
          }}
          forceFullscreen={navSpeedFullscreen ? true : undefined}
          onFullscreenToggle={navSpeedFullscreen ? exitSpeedNavigation : undefined}
          fullscreenTopOverlay={
            navSpeedFullscreen ? (
              (() => {
                const distM =
                  osrmGuidance?.distToManeuverM ??
                  guidance?.distToManeuverM ??
                  (transitDestination?.distM !== null && transitDestination?.distM !== undefined
                    ? Math.round(transitDestination.distM)
                    : null);
                const formattedDist =
                  distM === null
                    ? 'GPS'
                    : distM >= 1000
                      ? `${(distM / 1000).toFixed(1).replace('.', ',')} km`
                      : `${distM} m`;
                const primaryHeadline = isRecalculatingRoute
                  ? 'Recalculando rota...'
                  : osrmGuidance?.nextRoadName
                    ? osrmGuidance.nextRoadName
                    : osrmGuidance
                      ? osrmGuidance.nextInstruction
                      : transitDestination?.name || guidance?.instruction || 'Siga pela rota';
                const primarySubtitle = isRecalculatingRoute
                  ? 'Buscando novo trajeto pelas vias'
                  : osrmGuidance?.nextRoadName
                    ? osrmGuidance.nextInstruction
                    : transitDestination
                      ? `Rumo a ${transitDestination.name}`
                      : guidance?.targetLabel || '';
                const hasFollowing = Boolean(
                  osrmGuidance?.followingRoadName || osrmGuidance?.followingInstruction
                );

                return (
                  <div className="pointer-events-auto mx-auto w-full max-w-xl">
                    {/* Banner Principal Turn-by-Turn Estilo Google Maps / Waze */}
                    <div
                      className={`flex items-center gap-3 px-3.5 py-2.5 text-white shadow-2xl border ${
                        isRecalculatingRoute
                          ? 'border-amber-400/50 bg-[#78350F]'
                          : 'border-emerald-400/40 bg-[#0A3D28]'
                      } ${hasFollowing ? 'rounded-t-2xl' : 'rounded-2xl'}`}
                    >
                      <div className="flex min-w-[74px] shrink-0 flex-col items-center justify-center rounded-xl bg-black/25 px-2 py-1.5 text-center">
                        {osrmGuidance ? (
                          renderManeuverIcon(osrmGuidance.nextKind, 'h-9 w-9 text-white')
                        ) : guidance ? (
                          renderManeuverIcon(guidance.kind, 'h-9 w-9 text-white')
                        ) : (
                          <ArrowUp
                            className="h-9 w-9 text-white transition-transform duration-200"
                            style={{
                              transform: transitDestination
                                ? `rotate(${Math.round(transitDestination.relArrowDeg)}deg)`
                                : undefined,
                            }}
                          />
                        )}
                        <span className="mt-1 font-mono text-lg font-black leading-none tracking-tight text-white tabular-nums">
                          {formattedDist}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1 leading-tight">
                        <p className="line-clamp-2 text-lg font-black tracking-tight text-white sm:text-xl">
                          {primaryHeadline}
                        </p>
                        {primarySubtitle && (
                          <p className="mt-0.5 truncate text-xs font-bold text-emerald-100/85">
                            {primarySubtitle}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Faixa Secundária "Depois:" */}
                    {hasFollowing && osrmGuidance && (
                      <div className="flex items-center gap-2 rounded-b-2xl border-x border-b border-emerald-400/30 bg-[#062619] px-3.5 py-1.5 text-xs font-bold text-emerald-100 shadow-lg">
                        <span className="font-mono text-[10px] font-extrabold tracking-wider text-emerald-300 uppercase">
                          Depois:
                        </span>
                        {osrmGuidance.followingKind &&
                          renderManeuverIcon(osrmGuidance.followingKind, 'h-4 w-4 text-white shrink-0')}
                        <span className="truncate text-white">
                          {osrmGuidance.followingRoadName || osrmGuidance.followingInstruction}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              <SurveyFullscreenClockPill clockOffsetMs={settings.clockOffsetMs} />
            )
          }
          fullscreenZoomBottomClass={
            navSpeedFullscreen ? 'bottom-[104px] sm:bottom-[108px]' : 'bottom-[88px] sm:bottom-[92px]'
          }
          fullscreenOverlayFullWidth={navSpeedFullscreen}
          fullscreenOverlay={
            navSpeedFullscreen ? (
              (() => {
                const etaMinutes = osrmGuidance
                  ? osrmGuidance.etaMin
                  : transitDestination?.distM !== null && transitDestination?.distM !== undefined
                    ? Math.max(1, Math.round((transitDestination.distM / 1000 / 50) * 60))
                    : guidance
                      ? Math.max(1, Math.round((guidance.remainingTotalKm / 50) * 60))
                      : null;
                const remainingKmVal = osrmGuidance
                  ? osrmGuidance.remainingTotalKm
                  : transitDestination?.distM !== null && transitDestination?.distM !== undefined
                    ? transitDestination.distM / 1000
                    : guidance
                      ? guidance.remainingTotalKm
                      : null;
                const etaArrivalDate =
                  etaMinutes !== null
                    ? new Date(drivingClockNowMs + settings.clockOffsetMs + etaMinutes * 60_000)
                    : null;
                const etaClockLabel = etaArrivalDate
                  ? `${String(etaArrivalDate.getHours()).padStart(2, '0')}:${String(
                      etaArrivalDate.getMinutes()
                    ).padStart(2, '0')}`
                  : '--:--';
                const themeLabel =
                  drivingMapTheme === 'satellite'
                    ? 'Satélite'
                    : drivingMapTheme === 'dark'
                      ? 'Escuro'
                      : 'Claro';

                return (
                  <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
                    {/* Popover Rápido de Limite de Velocidade (quando aberto) */}
                    {showDrivingSpeedLimitPopover && (
                      <div className="ml-auto w-full max-w-xs rounded-2xl border border-white/20 bg-[#0B0E14]/95 px-3 py-2.5 text-white shadow-2xl">
                        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
                          <span className="text-[10px] font-extrabold tracking-wider text-white/85 uppercase">
                            Alerta de Velocidade
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setReccePrefs((prev) => ({ ...prev, enabled: !prev.enabled }))
                            }
                            className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${
                              reccePrefs.enabled
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                                : 'bg-white/10 text-white/60 border border-white/15'
                            }`}
                          >
                            {reccePrefs.enabled ? 'Ativo' : 'Desligado'}
                          </button>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-1.5 font-mono tabular-nums">
                          <button
                            type="button"
                            onClick={() =>
                              setReccePrefs((prev) => ({
                                ...prev,
                                enabled: true,
                                speedLimitKmh: Math.max(10, prev.speedLimitKmh - 5),
                              }))
                            }
                            className="inline-flex h-10 w-11 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-xs font-extrabold text-white active:scale-95"
                          >
                            -5
                          </button>
                          <div className="flex items-baseline justify-center gap-1 rounded-xl border border-white/20 bg-black/60 px-2.5 py-1">
                            <input
                              type="number"
                              inputMode="numeric"
                              min={10}
                              max={200}
                              value={reccePrefs.speedLimitKmh}
                              onChange={(e) => {
                                const val = Number(e.target.value);
                                if (Number.isFinite(val)) {
                                  setReccePrefs((prev) => ({
                                    ...prev,
                                    enabled: true,
                                    speedLimitKmh: Math.max(10, Math.min(200, Math.round(val))),
                                  }));
                                }
                              }}
                              aria-label="Limite de Velocidade em km/h"
                              className="w-14 bg-transparent text-center font-mono text-lg font-black text-white focus:outline-none"
                            />
                            <span className="text-[10px] font-bold text-white/70 uppercase">km/h</span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setReccePrefs((prev) => ({
                                ...prev,
                                enabled: true,
                                speedLimitKmh: Math.min(200, prev.speedLimitKmh + 5),
                              }))
                            }
                            className="inline-flex h-10 w-11 items-center justify-center rounded-xl border border-white/20 bg-white/10 text-xs font-extrabold text-white active:scale-95"
                          >
                            +5
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowDrivingSpeedLimitPopover(false)}
                            className="inline-flex h-10 items-center justify-center rounded-xl border border-white/20 bg-white/10 px-2.5 text-[11px] font-extrabold text-white uppercase active:scale-95"
                          >
                            OK
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Linha Flutuante: Velocímetro Circular (Esq) + Botões Discretos (Dir) */}
                    <div className="flex items-end justify-between gap-3">
                      {/* Velocímetro Circular Flutuante Estilo Waze */}
                      <div
                        className={`flex h-[76px] w-[76px] shrink-0 flex-col items-center justify-center rounded-full border-[3.5px] bg-[#090C12]/95 text-center shadow-2xl transition-colors ${
                          recceZone === 'over'
                            ? 'animate-pulse border-[#EF233C] ring-4 ring-[#EF233C]/40'
                            : recceZone === 'warning'
                              ? 'border-amber-400 ring-2 ring-amber-400/35'
                              : 'border-white/30'
                        }`}
                      >
                        <span
                          className={`font-mono text-[26px] font-black leading-none tracking-tight tabular-nums ${
                            recceZone === 'over'
                              ? 'text-[#FF4D62]'
                              : recceZone === 'warning'
                                ? 'text-amber-300'
                                : 'text-white'
                          }`}
                        >
                          {speedKmh}
                        </span>
                        <span className="mt-0.5 text-[10px] font-bold tracking-wider text-white/70 uppercase">
                          km/h
                        </span>
                      </div>

                      {/* Controles Laterais Limpos no Canto Direito */}
                      <div className="flex flex-col items-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setDrivingHeadingUp(true);
                            setDrivingMapUserPaused(false);
                            setDrivingRecenterTick((t) => t + 1);
                          }}
                          className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-[11px] font-extrabold shadow-xl transition-all active:scale-95 ${
                            drivingMapUserPaused
                              ? 'border-sky-400 bg-sky-500 text-slate-950'
                              : 'border-white/20 bg-[#0D1118]/92 text-white/90 hover:border-white/40'
                          }`}
                          title="Recentralizar câmera 3D no carro"
                        >
                          <LocateFixed className="h-4 w-4 shrink-0" />
                          <span>Recentralizar</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setDrivingMapTheme((prev) =>
                              prev === 'satellite' ? 'dark' : prev === 'dark' ? 'light' : 'satellite'
                            )
                          }
                          className="inline-flex h-10 items-center gap-1.5 rounded-full border border-white/20 bg-[#0D1118]/92 px-3 text-[11px] font-extrabold text-white shadow-xl transition-all hover:border-white/40 active:scale-95"
                          title="Alternar camada do mapa (Satélite / Escuro / Claro)"
                        >
                          <Layers className="h-4 w-4 shrink-0 text-amber-400" />
                          <span>{themeLabel}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setShowDrivingSpeedLimitPopover((v) => !v)}
                          className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-[11px] font-extrabold shadow-xl transition-all active:scale-95 ${
                            recceZone === 'over'
                              ? 'border-[#EF233C] bg-[#EF233C]/90 text-white'
                              : 'border-white/20 bg-[#0D1118]/92 text-white hover:border-white/40'
                          }`}
                          title="Ajustar Limite de Velocidade"
                        >
                          <Gauge className="h-4 w-4 shrink-0 text-emerald-400" />
                          <span className="font-mono tabular-nums">
                            {reccePrefs.enabled ? `${reccePrefs.speedLimitKmh} km/h` : 'Limite'}
                          </span>
                        </button>
                      </div>
                    </div>

                    {/* Barra Inferior de Navegação Estilo Waze/Maps (Voz · ETA & Distância · Sair) */}
                    <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/15 bg-[#0C0F16]/95 px-2.5 py-2 text-white shadow-2xl">
                      <button
                        type="button"
                        onClick={() => {
                          setWazeVoiceEnabled((prev) => {
                            const next = !prev;
                            if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
                              try {
                                window.speechSynthesis.cancel();
                                if (next) {
                                  const utter = new SpeechSynthesisUtterance(
                                    'Instruções por voz ativadas'
                                  );
                                  utter.lang = 'pt-BR';
                                  utter.rate = 1.08;
                                  window.speechSynthesis.speak(utter);
                                }
                              } catch {
                                // ignore speech restrictions
                              }
                            }
                            return next;
                          });
                        }}
                        aria-label={wazeVoiceEnabled ? 'Silenciar voz' : 'Ativar voz'}
                        className={`inline-flex min-h-[44px] min-w-[54px] shrink-0 flex-col items-center justify-center rounded-xl border px-2 transition-colors active:scale-95 ${
                          wazeVoiceEnabled
                            ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-300'
                            : 'border-white/15 bg-white/5 text-white/60'
                        }`}
                      >
                        {wazeVoiceEnabled ? (
                          <Volume2 className="h-4 w-4 shrink-0" />
                        ) : (
                          <VolumeX className="h-4 w-4 shrink-0" />
                        )}
                        <span className="mt-0.5 text-[9px] font-extrabold uppercase">Voz</span>
                      </button>

                      <div className="min-w-0 flex-1 text-center leading-tight">
                        <p className="font-mono text-2xl font-black tracking-tight text-white tabular-nums">
                          {etaClockLabel}
                        </p>
                        <p className="truncate font-mono text-xs font-bold text-emerald-300 tabular-nums">
                          {etaMinutes !== null ? `${etaMinutes} min` : '-- min'}
                          {' • '}
                          {remainingKmVal !== null
                            ? `${remainingKmVal.toFixed(1).replace('.', ',')} km`
                            : '-- km'}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={exitSpeedNavigation}
                        className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#EF233C] px-4 text-xs font-black tracking-wider text-white uppercase shadow-lg transition-colors hover:bg-[#d61d34] active:scale-95"
                      >
                        <X className="h-4 w-4 stroke-[2.75]" />
                        <span>Sair</span>
                      </button>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="rounded-2xl border border-white/15 bg-black/45 px-2.5 py-2 text-white shadow-xl backdrop-blur-sm">
                <div className="grid grid-cols-3 items-center gap-1.5 font-mono tabular-nums">
                  {/* Bloco 1: TRIP (Laranja #F59E0B) + Zerar */}
                  <div className="flex min-w-0 items-center justify-between gap-1.5 pr-1 border-r border-white/10">
                    <div className="min-w-0 leading-tight">
                      <p className="text-[9px] font-extrabold tracking-wider text-[#F59E0B] uppercase">
                        TRIP {regressive ? 'REG' : ''}
                      </p>
                      <p className="truncate text-sm font-black text-[#F59E0B] sm:text-base">
                        {displayedTripKm.toFixed(2).replace('.', ',')}
                        <span className="ml-0.5 text-[10px] font-bold opacity-80">km</span>
                      </p>
                      <p className="truncate text-[10px] font-semibold text-amber-200/80">
                        {tripMeters.toLocaleString('pt-BR')} m
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTripKm(0)}
                      className="inline-flex min-h-[34px] shrink-0 items-center justify-center rounded-lg border border-amber-400/40 bg-amber-500/15 px-2 text-[10px] font-extrabold tracking-wide text-[#F59E0B] uppercase active:scale-95"
                    >
                      Zerar
                    </button>
                  </div>

                  {/* Bloco 2: VELOCIDADE (Branco) + Média */}
                  <div className="min-w-0 text-center leading-tight px-1 border-r border-white/10">
                    <p className="text-[9px] font-extrabold tracking-wider text-white/70 uppercase">
                      Velocidade
                    </p>
                    <p
                      className={`text-lg font-black leading-none sm:text-xl ${
                        recceZone === 'over'
                          ? 'text-red-400'
                          : recceZone === 'warning'
                            ? 'text-amber-300'
                            : 'text-white'
                      }`}
                    >
                      {speedKmh}{' '}
                      <span className="text-[10px] font-bold text-white/75">KM/H</span>
                    </p>
                    <p className="mt-0.5 truncate text-[10px] font-semibold text-[#6EE7B7]">
                      Méd: {avgSpeedKmh} km/h
                    </p>
                  </div>

                  {/* Bloco 3: ODÔMETRO TOTAL & GPS */}
                  <div className="min-w-0 pl-1 text-right leading-tight">
                    <p className="truncate text-[9px] font-extrabold tracking-wider text-white/70 uppercase">
                      Odôm. Total
                    </p>
                    <p className="truncate text-sm font-black text-white sm:text-base">
                      {totalKm.toFixed(2).replace('.', ',')}
                      <span className="ml-0.5 text-[10px] font-bold text-white/75">km</span>
                    </p>
                    <p className="truncate text-[10px] font-semibold text-emerald-300/90">
                      {gpsAccuracy !== null ? `±${gpsAccuracy}m` : 'GPS --'}
                      {altitudeM !== null ? ` · ${altitudeM}m` : ''}
                    </p>
                  </div>
                </div>
              </div>
            )
          }
          containerClassName="relative mt-2 h-72 w-full overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[#000000] sm:h-96"
        />
      </section>

      {/* Primary Controls: PLAY / PAUSE & ZERAR */}
      <section className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setIsCounting((prev) => {
              const next = !prev;
              if (source === 'simulator') setSimRunning(next);
              return next;
            });
          }}
          className={`flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border px-3 text-xs sm:text-sm font-extrabold tracking-wider uppercase transition-colors ${
            isCounting
              ? 'border-amber-500/60 bg-amber-500/15 text-[var(--ps-amber)] hover:bg-amber-500/25'
              : 'border-emerald-500/60 bg-emerald-500/15 text-[var(--ps-emerald)] hover:bg-emerald-500/25'
          }`}
        >
          {isCounting ? (
            <>
              <Pause className="h-4 w-4 fill-current shrink-0" />
              <span className="truncate">Pausar Contagem</span>
            </>
          ) : (
            <>
              <Play className="h-4 w-4 fill-current shrink-0" />
              <span className="truncate">Play Contagem</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleResetAllSurvey}
          className="pitstop-btn-metal flex min-h-[48px] items-center justify-center gap-2 rounded-2xl px-3 text-xs sm:text-sm font-extrabold tracking-wider uppercase"
        >
          <RotateCcw className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
          <span className="truncate">Zerar Tudo</span>
        </button>
      </section>

      {/* Unified Odometer Total & Trip Blocks (Meters + KM, Tap-to-Edit Keyboard Input) */}
      {(gaugeVisibility.total || gaugeVisibility.trip) && (
        <section
          className={`grid grid-cols-1 gap-3 ${
            gaugeVisibility.total && gaugeVisibility.trip ? 'sm:grid-cols-2' : ''
          }`}
        >
          {gaugeVisibility.total && (
            <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <span className="ps-label">Odômetro Total</span>
            <button
              type="button"
              onClick={() => {
                setTotalKm(0);
                simProgressKmRef.current = 0;
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1 text-[11px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Zerar</span>
            </button>
          </div>

          {editingTotalOdo ? (
            <div className="my-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={totalOdoInput}
                  onChange={(e) => setTotalOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdometerKeyboardValue('total', totalOdoInput);
                    if (e.key === 'Escape') setEditingTotalOdo(false);
                  }}
                  aria-label="Editar Odômetro Total"
                  className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-3 text-center font-mono text-2xl font-black text-[var(--ps-text)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextUnit = odoEditUnit === 'm' ? 'km' : 'm';
                    setOdoEditUnit(nextUnit);
                    setTotalOdoInput(
                      nextUnit === 'm' ? String(totalMeters) : totalKm.toFixed(3)
                    );
                  }}
                  className="min-h-[44px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-amber)] uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTotalOdo(false)}
                  className="min-h-[38px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-xs font-bold text-[var(--ps-muted)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdometerKeyboardValue('total', totalOdoInput)}
                  className="pitstop-btn-red min-h-[38px] rounded-xl text-xs font-extrabold"
                >
                  Confirmar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTotalOdoInput(odoEditUnit === 'm' ? String(totalMeters) : totalKm.toFixed(3));
                setEditingTotalOdo(true);
              }}
              title="Toque para digitar a metragem desejada"
              className="group my-2 flex min-w-0 flex-col items-center justify-center rounded-xl border border-transparent py-1.5 transition-colors hover:border-[var(--ps-border-strong)] hover:bg-[var(--ps-card)]"
            >
              <span className="max-w-full truncate font-mono text-[clamp(1.75rem,8.5vw,3rem)] leading-none font-black tracking-tight text-[var(--ps-text)] tabular-nums">
                {totalMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-base sm:text-lg font-bold text-[var(--ps-muted)]">m</span>
              </span>
              <span className="mt-1 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-[var(--ps-muted)] tabular-nums">
                <span>{totalKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 opacity-60 group-hover:text-[var(--ps-accent)]" />
              </span>
            </button>
            )}
          </div>
          )}

          {gaugeVisibility.trip && (
            <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRegressive((v) => !v)}
              className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] font-bold uppercase ${
                regressive
                  ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                  : 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-amber)]'
              }`}
            >
              Trip: {regressive ? 'Regressivo' : 'Progressivo'}
            </button>

            <div className="flex items-center gap-1.5">
              {regressive &&
                (editingTarget ? (
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    autoFocus
                    value={targetInput}
                    onChange={(e) => setTargetInput(e.target.value)}
                    onBlur={() => {
                      const n = Number(targetInput.replace(',', '.'));
                      if (Number.isFinite(n) && n > 0) setTargetKm(n);
                      setEditingTarget(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const n = Number(targetInput.replace(',', '.'));
                        if (Number.isFinite(n) && n > 0) setTargetKm(n);
                        setEditingTarget(false);
                      }
                    }}
                    className="w-24 rounded-lg border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-2 py-0.5 text-center font-mono text-xs font-bold text-[var(--ps-text)] focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setTargetInput(targetKm.toFixed(2));
                      setEditingTarget(true);
                    }}
                    className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 py-0.5 font-mono text-[11px] font-bold text-[var(--ps-muted)]"
                  >
                    Alvo: {targetKm.toFixed(2)} km
                  </button>
                ))}

              <button
                type="button"
                onClick={() => setTripKm(0)}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1 text-[11px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Zerar Trip</span>
              </button>
            </div>
          </div>

          {editingTripOdo ? (
            <div className="my-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={tripOdoInput}
                  onChange={(e) => setTripOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdometerKeyboardValue('trip', tripOdoInput);
                    if (e.key === 'Escape') setEditingTripOdo(false);
                  }}
                  aria-label="Editar Trip Parcial"
                  className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-3 text-center font-mono text-2xl font-black text-[var(--ps-amber)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextUnit = odoEditUnit === 'm' ? 'km' : 'm';
                    setOdoEditUnit(nextUnit);
                    setTripOdoInput(
                      nextUnit === 'm' ? String(tripMeters) : displayedTripKm.toFixed(3)
                    );
                  }}
                  className="min-h-[44px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-amber)] uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTripOdo(false)}
                  className="min-h-[38px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-xs font-bold text-[var(--ps-muted)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdometerKeyboardValue('trip', tripOdoInput)}
                  className="pitstop-btn-red min-h-[38px] rounded-xl text-xs font-extrabold"
                >
                  Confirmar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTripOdoInput(
                  odoEditUnit === 'm' ? String(tripMeters) : displayedTripKm.toFixed(3)
                );
                setEditingTripOdo(true);
              }}
              title="Toque para digitar a metragem do Trip"
              className="group my-2 flex min-w-0 flex-col items-center justify-center rounded-xl border border-transparent py-1.5 transition-colors hover:border-[var(--ps-border-strong)] hover:bg-[var(--ps-card)]"
            >
              <span className="max-w-full truncate font-mono text-[clamp(1.75rem,8.5vw,3rem)] leading-none font-black tracking-tight text-[var(--ps-amber)] tabular-nums">
                {tripMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-base sm:text-lg font-bold opacity-75">m</span>
              </span>
              <span className="mt-1 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-[var(--ps-amber)] opacity-85 tabular-nums">
                <span>{displayedTripKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 opacity-60 group-hover:text-[var(--ps-accent)]" />
              </span>
            </button>
          )}
        </div>
          )}
      </section>
      )}

      {/* Live Speed & Basic Gauge Metrics Unified in Levantamento */}
      <section className="space-y-3">
        {(gaugeVisibility.speed || gaugeVisibility.avgSpeed || gaugeVisibility.maxSpeed) && (
          <div className="grid grid-cols-3 gap-2 sm:gap-2.5 font-mono tabular-nums">
            {gaugeVisibility.speed && (
              <div
                className={`min-w-0 rounded-2xl border p-2.5 sm:p-3 text-center transition-colors ${
                  recceZone === 'over'
                    ? 'animate-pulse border-red-500 bg-red-950/80'
                    : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
                }`}
              >
                <p className="ps-label truncate">Vel. Atual</p>
                <p
                  className={`mt-1 text-[clamp(1.6rem,7.2vw,2.35rem)] leading-none font-black ${
                    recceZone === 'over'
                      ? 'text-[#FF2A2A]'
                      : recceZone === 'warning'
                        ? 'text-[var(--ps-amber)]'
                        : 'text-[var(--ps-text)]'
                  }`}
                >
                  {speedKmh}
                </p>
                <p className="mt-1 text-[10px] font-bold text-[var(--ps-accent)]">KM/H</p>
              </div>
            )}

            {gaugeVisibility.avgSpeed && (
              <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
                <p className="ps-label truncate">Vel. Média</p>
                <p className="mt-1 text-[clamp(1.6rem,7.2vw,2.35rem)] leading-none font-black text-[var(--ps-emerald)]">
                  {avgSpeedKmh}
                </p>
                <p className="mt-1 text-[10px] text-[var(--ps-muted)]">KM/H</p>
              </div>
            )}

            {gaugeVisibility.maxSpeed && (
              <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
                <p className="ps-label truncate">Vel. Máxima</p>
                <p className="mt-1 text-[clamp(1.6rem,7.2vw,2.35rem)] leading-none font-black text-[var(--ps-amber)]">
                  {maxSpeedKmh}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setMaxSpeedKmh(0);
                    setAvgSpeedSamples([]);
                  }}
                  className="mt-1 text-[10px] text-[var(--ps-muted)] hover:text-[var(--ps-text)] underline"
                >
                  limpar
                </button>
              </div>
            )}
          </div>
        )}

        {(gaugeVisibility.officialClock ||
          gaugeVisibility.altitude ||
          gaugeVisibility.gpsAccuracy ||
          gaugeVisibility.heading) && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 font-mono tabular-nums">
            {gaugeVisibility.officialClock && (
              <SurveyOfficialClockCard clockOffsetMs={settings.clockOffsetMs} />
            )}

            {gaugeVisibility.altitude && (
              <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
                <p className="ps-label truncate">Altitude</p>
                <p className="mt-1 text-[clamp(1.25rem,5.4vw,1.85rem)] leading-none font-black text-[var(--ps-text)]">
                  {altitudeM !== null ? `${altitudeM}m` : '--'}
                </p>
                <p className="mt-1 inline-flex items-center justify-center gap-1 text-[10px] text-[var(--ps-muted)]">
                  <Mountain className="h-3 w-3" />
                  <span>Elevação</span>
                </p>
              </div>
            )}

            {gaugeVisibility.gpsAccuracy && (
              <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
                <p className="ps-label truncate">Sinal GPS</p>
                <p className="mt-1 text-[clamp(1.25rem,5.4vw,1.85rem)] leading-none font-black text-[var(--ps-emerald)]">
                  {gpsAccuracy !== null ? `±${gpsAccuracy}m` : '--'}
                </p>
                <p className="mt-1 text-[10px] text-[var(--ps-muted)]">
                  {source === 'simulator' ? 'Simulador' : 'Receptor'}
                </p>
              </div>
            )}

            {gaugeVisibility.heading && (
              <div className="min-w-0 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 text-center">
                <p className="ps-label truncate">Rumo (CAP)</p>
                <p className="mt-1 text-[clamp(1.25rem,5.4vw,1.85rem)] leading-none font-black text-[var(--ps-text)]">
                  {headingDeg !== null ? `${headingDeg}°` : '--'}
                </p>
                <p className="mt-1 text-[10px] text-[var(--ps-muted)]">Direção</p>
              </div>
            )}
          </div>
        )}

        {/* Limite de Velocidade (Clean & Simples) */}
        <div
          className={`rounded-2xl border p-3 transition-colors ${
            recceZone === 'over'
              ? 'border-red-500 bg-red-950/80 text-red-100'
              : recceZone === 'warning'
                ? 'border-amber-400 bg-amber-950/45'
                : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {recceZone === 'over' || recceZone === 'warning' ? (
                <AlertTriangle
                  className={`h-4 w-4 shrink-0 ${
                    recceZone === 'over' ? 'text-red-300' : 'text-[var(--ps-amber)]'
                  }`}
                />
              ) : (
                <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
              )}
              <span className="truncate text-xs font-extrabold tracking-wide uppercase">
                Limite de Velocidade
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {reccePrefs.enabled && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setReccePrefs((p) => ({
                        ...p,
                        speedLimitKmh: Math.max(10, p.speedLimitKmh - 5),
                      }))
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] font-mono text-sm font-black text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                    aria-label="Diminuir limite em 5 km/h"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={10}
                    max={200}
                    step={5}
                    value={reccePrefs.speedLimitKmh}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) {
                        setReccePrefs((p) => ({
                          ...p,
                          speedLimitKmh: Math.min(200, Math.max(10, Math.round(n))),
                        }));
                      }
                    }}
                    aria-label="Limite de velocidade em km/h"
                    className="h-8 w-14 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-center font-mono text-xs font-extrabold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setReccePrefs((p) => ({
                        ...p,
                        speedLimitKmh: Math.min(200, p.speedLimitKmh + 5),
                      }))
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] font-mono text-sm font-black text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                    aria-label="Aumentar limite em 5 km/h"
                  >
                    +
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() =>
                  setReccePrefs((p) => ({ ...p, soundEnabled: !p.soundEnabled }))
                }
                title={reccePrefs.soundEnabled ? 'Silenciar alerta' : 'Ativar alerta'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                {reccePrefs.soundEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
                )}
              </button>

              <button
                type="button"
                onClick={() =>
                  setReccePrefs((p) => ({ ...p, enabled: !p.enabled }))
                }
                className={`h-8 rounded-lg px-2.5 text-[11px] font-extrabold uppercase ${
                  reccePrefs.enabled
                    ? 'pitstop-btn-red'
                    : 'border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                }`}
              >
                {reccePrefs.enabled ? 'Ativo' : 'Off'}
              </button>
            </div>
          </div>

          {reccePrefs.enabled && (
            <div className="mt-2.5 space-y-1.5">
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--ps-card-deep)]">
                <div
                  className={`h-full transition-all duration-150 ${
                    recceZone === 'over'
                      ? 'bg-[#FF2A2A]'
                      : recceZone === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${speedPctOfLimit}%` }}
                />
              </div>

              <div className="flex items-center justify-between font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                <span>
                  {speedKmh} / {reccePrefs.speedLimitKmh} km/h
                </span>
                {recceOverCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setRecceOverCount(0);
                      setReccePeakSpeedKmh(0);
                    }}
                    className="text-red-400 underline hover:text-[var(--ps-text)]"
                  >
                    {recceOverCount}x acima (Pico {reccePeakSpeedKmh}) · limpar
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
        </>
      )}

      {(() => {
        const activeFolderId = loadedTrack?.folderId;
        const activeFolderName = loadedTrack?.folderName || importedGeo?.documentName;
        const folderTracks =
          activeFolderId || activeFolderName
            ? mergedTracks.filter(
                (t) =>
                  (activeFolderId && t.folderId === activeFolderId) ||
                  (activeFolderName && t.folderName === activeFolderName)
              )
            : mergedTracks;
        const overviewTracks = folderTracks.length > 0 ? folderTracks : mergedTracks;
        const folderWps =
          activeFolderId || activeFolderName
            ? mergedWaypoints.filter(
                (wp) =>
                  (activeFolderId && wp.folderId === activeFolderId) ||
                  (activeFolderName && wp.folderName === activeFolderName)
              )
            : mergedWaypoints;
        const overviewWps = folderWps.length > 0 ? folderWps : mergedWaypoints;
        return (
          <Suspense fallback={null}>
            <RallyOverviewMapModal
              isOpen={showRallyOverviewModal}
              rallyName={activeFolderName || 'Mapa da Prova'}
              tracks={overviewTracks}
              waypoints={overviewWps}
              activeTrackId={loadedTrack?.id}
              currentPos={currentPos}
              onClose={() => setShowRallyOverviewModal(false)}
              onSelectStage={(tr) => {
                setSelectedPoiId(null);
                setSelectedTrackIdOverride(tr.id);
                const idx = mergedTracks.findIndex((item) => item.id === tr.id);
                if (idx >= 0) setSelectedTrackIdx(idx);
                simProgressKmRef.current = 0;
                setShowRallyOverviewModal(false);
              }}
              onNavigateToStage={(tr) => {
                setSelectedPoiId(null);
                setSelectedTrackIdOverride(tr.id);
                const idx = mergedTracks.findIndex((item) => item.id === tr.id);
                if (idx >= 0) setSelectedTrackIdx(idx);
                simProgressKmRef.current = 0;
                setShowRallyOverviewModal(false);
                setWazeNavActive(true);
                setNavSpeedFullscreen(true);
              }}
              onNavigateToWaypoint={(wp) => {
                setSelectedPoiId(wp.id);
                setShowRallyOverviewModal(false);
                setWazeNavActive(true);
                setNavSpeedFullscreen(true);
              }}
            />
          </Suspense>
        );
      })()}
    </div>
  );
};
