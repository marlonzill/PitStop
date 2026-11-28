import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  ArrowLeft,
  Bluetooth,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Compass,
  Copy,
  Download,
  Film,
  Flag,
  Folder,
  FolderOpen,
  History,
  Layers,
  Map as MapIcon,
  Navigation,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  Satellite,
  Save,
  Settings,
  Settings2,
  Square,
  Trash2,
  TrendingUp,
  Trophy,
  Upload,
  X,
} from 'lucide-react';
import { CockpitSelect } from './CockpitSelect';
import { FuelTechAnalysisPanel } from './FuelTechAnalysisPanel';
import { GoProBlePanel } from './GoProBlePanel';
import { RallyOverviewMapModal } from './RallyOverviewMapModal';
import { SatcronLivePanel } from './SatcronLivePanel';
import {
  StartTimeCalculatorModal,
  parseStartTimeClock,
} from './StartTimeCalculatorModal';
import { SurveyCockpit } from './SurveyCockpit';
import { LayoutMiniSchematic } from './VelocityCockpitLayoutEditor';
import { VelocityStartTachButton } from './VelocityStartTachButton';
import { VelocityLivePresetScreen } from './VelocityLiveLayouts';
import { VelocityMapboxView } from './VelocityMapboxView';
import { VideoHudOverlayPanel } from './VideoHudOverlayPanel';
import {
  uploadAllTracksToCloud,
  uploadVelocityTrackToCloud,
} from '../services/cloudTracksService';
import { openProUpgradeModal, useAuthSession } from '../utils/authSubscription';
import { useNavSettings } from '../utils/navSettings';
import {
  VELOCITY_COCKPIT_READY_PRESETS,
  useVelocityCockpitLayout,
} from '../utils/velocityCockpitLayout';
import {
  type VelDriveSource,
  type VelSimMultiplier,
  useVelocityEngineConfig,
} from '../utils/velocityPrefs';
import {
  disconnectExternalGps,
  forgetSavedExternalGps,
  reconnectSavedExternalGps,
  scanAndConnectExternalGps,
  subscribeExternalGpsFixes,
  useExternalGpsBle,
} from '../utils/externalGpsBle';
import {
  addGoProHiLightTag,
  clearGoProFleetError,
  getGoProDisplayName,
  renameGoProInFleet,
  shutterAllGoPro,
  shutterSingleGoPro,
  sleepAllGoPro,
  sleepSingleGoPro,
  toggleSingleGoProPower,
  useGoProFleet,
  wakeAllGoPro,
  wakeSavedGoProInFleet,
  wakeSingleGoPro,
} from '../utils/goproBle';
import {
  autoDetectNearestTrack,
  bearingBetweenDeg,
  computeOptimalStage,
  computePredictiveDeltaSec,
  computeSafeAverageSpeedKmh,
  computeSampleGForces,
  convertDetectedPointsToSplitTraps,
  createDemoSpecialStage,
  createGpsKalmanProcessor,
  detectTrapCrossing,
  ensureAutoTrapsFromBaseTrace,
  ensureTraceGForces,
  exportTrackGeoJson,
  exportTrackGpx,
  extractTrackKmOnlyDescription,
  formatCleanTrackName,
  formatDeltaSeconds,
  formatImportedTrackNamesList,
  formatStageDuration,
  generateEqualSplitTraps,
  getCapacitorGpsWatchOptions,
  getOrderedTrackTraps,
  haversineMetersVel,
  inferNearestBaseTraceBearing,
  parseTrackFileToGeoResult,
  recalculateRunsForTrack,
  WEB_GPS_WATCH_OPTIONS,
  type GeoWaypoint,
  type OptimalStageSummary,
  type TrackMode,
  type TrapKind,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
  type VelocityTrap,
} from '../utils/velocityEngine';
import {
  loadActiveVelocityTrackId,
  loadVelocityDatabase,
  persistVelocityRuns,
  persistVelocityTracks,
  saveActiveVelocityTrackId,
} from '../utils/velocityStorage';
import {
  downloadRallyOfflineBundle,
  formatBytesCompact,
  loadOfflineRallyPacks,
  OFFLINE_MAPS_UPDATED_EVENT,
  type OfflineDownloadProgress,
  type OfflineRallyPackMeta,
} from '../utils/offlineMapsService';

type VelocityScreen =
  | 'home'
  | 'live'
  | 'sessions'
  | 'session-detail'
  | 'tracks'
  | 'track-editor'
  | 'settings'
  | 'odometer'
  | 'survey'
  | 'satcron';

type LivePanelMode = 'timer' | 'gauges';

const GAUGE_PREFS_KEY = 'pitstop_velocity_gauges_v1';
const LAST_GPS_POS_KEY = 'pitstop_last_gps_pos_v1';
const RALLY_WAYPOINTS_KEY = 'pitstop_velocity_waypoints_v1';
const CARTELA_TIMES_KEY = 'pitstop_velocity_cartela_v1';

function loadRallyWaypoints(): GeoWaypoint[] {
  try {
    const raw = localStorage.getItem(RALLY_WAYPOINTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeoWaypoint[]) : [];
  } catch {
    return [];
  }
}

function saveRallyWaypoints(wps: GeoWaypoint[]): void {
  try {
    localStorage.setItem(RALLY_WAYPOINTS_KEY, JSON.stringify(wps));
  } catch {
    // Ignore storage error
  }
}

function loadCartelaTimes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CARTELA_TIMES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveCartelaTimes(map: Record<string, string>): void {
  try {
    localStorage.setItem(CARTELA_TIMES_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage error
  }
}

function loadLastGpsPos(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(LAST_GPS_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lat?: unknown; lon?: unknown };
    if (
      typeof parsed?.lat === 'number' &&
      typeof parsed?.lon === 'number' &&
      Number.isFinite(parsed.lat) &&
      Number.isFinite(parsed.lon)
    ) {
      return { lat: parsed.lat, lon: parsed.lon };
    }
    return null;
  } catch {
    return null;
  }
}

function saveLastGpsPos(lat: number, lon: number): void {
  try {
    localStorage.setItem(
      LAST_GPS_POS_KEY,
      JSON.stringify({ lat, lon, updatedAtMs: Date.now() })
    );
  } catch {
    // Ignore storage error
  }
}

interface GaugeVisibility {
  speed: boolean;
  trip: boolean;
  officialClock: boolean;
  stageTime: boolean;
  maxSpeed: boolean;
  altitude: boolean;
  gpsAccuracy: boolean;
  heading: boolean;
}

const DEFAULT_GAUGES: GaugeVisibility = {
  speed: true,
  trip: true,
  officialClock: true,
  stageTime: true,
  maxSpeed: true,
  altitude: true,
  gpsAccuracy: true,
  heading: true,
};

function loadGaugePrefs(): GaugeVisibility {
  try {
    const raw = localStorage.getItem(GAUGE_PREFS_KEY);
    if (!raw) return DEFAULT_GAUGES;
    return { ...DEFAULT_GAUGES, ...(JSON.parse(raw) as Partial<GaugeVisibility>) };
  } catch {
    return DEFAULT_GAUGES;
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

function formatGoProRecTimer(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatShortDateTime(tsMs: number): string {
  const d = new Date(tsMs);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function formatSessionDurationCompact(totalMs: number): string {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

function estimateSatellites(accuracyM: number | null, gpsActive: boolean): number {
  if (!gpsActive) return 0;
  if (accuracyM === null) return 6;
  if (accuracyM <= 4) return 14;
  if (accuracyM <= 7) return 11;
  if (accuracyM <= 12) return 9;
  if (accuracyM <= 25) return 7;
  return 4;
}

interface FinishSummaryModalData {
  trackName: string;
  runNumber: number;
  totalMs: number;
  deltaVsBestMs: number | null;
  isFaster: boolean;
  splits: Array<{
    id: string;
    label: string;
    timeMs: number | null;
    deltaMs: number | null;
  }>;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  distanceKm: number;
  bestSectorLabel: string | null;
  bestSectorMs: number | null;
  bestSectorDeltaMs: number | null;
  tracePoints: Array<{ lat: number; lon: number }>;
}

function formatFinishDeltaMs(deltaMs: number | null): string {
  if (deltaMs === null || !Number.isFinite(deltaMs)) return 'REFERÊNCIA';
  const sign = deltaMs <= 0 ? '-' : '+';
  return `${sign}${(Math.abs(deltaMs) / 1000).toFixed(2)}s`;
}

function buildMiniTraceSvg(
  points: Array<{ lat: number; lon: number }>,
  width = 96,
  height = 48,
  pad = 6
): { pathD: string; startPt: { x: number; y: number }; endPt: { x: number; y: number } } | null {
  if (!points || points.length < 2) return null;
  const step = Math.max(1, Math.floor(points.length / 72));
  const sampled: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < points.length; i += step) sampled.push(points[i]);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of sampled) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const cosLat = Math.max(0.2, Math.cos(midLatRad));
  const spanX = Math.max(1e-6, (maxLon - minLon) * cosLat);
  const spanY = Math.max(1e-6, maxLat - minLat);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = pad + (innerW - drawnW) / 2;
  const offsetY = pad + (innerH - drawnH) / 2;

  const projected = sampled.map((p) => ({
    x: Number((offsetX + (p.lon - minLon) * cosLat * scale).toFixed(1)),
    y: Number((offsetY + (maxLat - p.lat) * scale).toFixed(1)),
  }));
  const pathD = projected
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x} ${pt.y}`)
    .join(' ');
  return {
    pathD,
    startPt: projected[0],
    endPt: projected[projected.length - 1],
  };
}

function downsampleTraceLatLon(
  points: Array<{ lat: number; lon: number }> | undefined,
  maxPoints = 80
): Array<{ lat: number; lon: number }> {
  if (!points || points.length === 0) return [];
  if (points.length <= maxPoints) return points.map((p) => ({ lat: p.lat, lon: p.lon }));
  const step = Math.max(1, Math.floor(points.length / maxPoints));
  const out: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < points.length; i += step) {
    out.push({ lat: points[i].lat, lon: points[i].lon });
  }
  const last = points[points.length - 1];
  const lastOut = out[out.length - 1];
  if (!lastOut || lastOut.lat !== last.lat || lastOut.lon !== last.lon) {
    out.push({ lat: last.lat, lon: last.lon });
  }
  return out;
}

function shiftClockHhMm(hhmm: string, deltaMinutes: number): string {
  const parsed = parseStartTimeClock(hhmm);
  const now = new Date();
  let totalSec = parsed
    ? parsed.hh * 3600 + parsed.mm * 60 + parsed.ss
    : now.getHours() * 3600 + now.getMinutes() * 60;
  totalSec = ((totalSec + deltaMinutes * 60) % 86400 + 86400) % 86400;
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatCountdownMinSec(totalSec: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(totalSec)));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

let sharedPreStartAudioCtx: AudioContext | null = null;

function playPreStartCountdownBeep(isZeroGo: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedPreStartAudioCtx || sharedPreStartAudioCtx.state === 'closed') {
      sharedPreStartAudioCtx = new AudioCtx();
    }
    const ctx = sharedPreStartAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const trigger = (freq: number, offset: number, dur: number, gainPeak: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = isZeroGo ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + offset + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + dur + 0.02);
    };
    if (isZeroGo) {
      trigger(1320, 0, 0.16, 0.24);
      trigger(1560, 0.18, 0.26, 0.26);
    } else {
      trigger(920, 0, 0.1, 0.16);
    }
  } catch {
    // Ignore audio context restriction
  }
}

const OfficialGpsClockPill: React.FC<{ clockOffsetMs: number }> = ({ clockOffsetMs }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      aria-label="Hora Oficial sincronizada com GPS"
      className="inline-flex flex-col items-center justify-center rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)]/95 px-5 py-2 shadow-sm"
    >
      <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--ps-muted)] uppercase leading-none">
        HORA OFICIAL / GPS
      </span>
      <span className="mt-1 font-mono text-xl font-black tracking-[0.1em] text-[var(--ps-text)] tabular-nums leading-none sm:text-2xl">
        {formatClockTime(nowMs + clockOffsetMs)}
      </span>
    </div>
  );
};

const VelocityGaugeClockCards: React.FC<{
  showOfficialClock: boolean;
  showStageTime: boolean;
  stageState: 'idle' | 'armed' | 'running' | 'finished';
  stageStartMs: number | null;
  lastFinishedMs: number | null;
  clockOffsetMs: number;
  totalDistKm: number;
  bestRun: VelocityRun | null;
}> = ({
  showOfficialClock,
  showStageTime,
  stageState,
  stageStartMs,
  lastFinishedMs,
  clockOffsetMs,
  totalDistKm,
  bestRun,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalMs = stageState === 'running' ? 100 : 500;
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [stageState]);

  const elapsed =
    stageState === 'running' && stageStartMs !== null
      ? Math.max(0, nowMs - stageStartMs)
      : stageState === 'finished' && lastFinishedMs !== null
        ? lastFinishedMs
        : 0;

  const delta =
    stageState === 'running' && bestRun
      ? computePredictiveDeltaSec(totalDistKm, elapsed, bestRun)
      : null;

  return (
    <>
      {showOfficialClock && (
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3.5 text-center">
          <p className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
            Horário Oficial (CH)
          </p>
          <p className="mt-1.5 font-mono text-2xl font-extrabold text-[var(--ps-emerald)] tabular-nums sm:text-4xl">
            {formatClockTime(nowMs + clockOffsetMs)}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[var(--ps-muted)]">GPS SYNC</p>
        </div>
      )}

      {showStageTime && (
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3.5 text-center">
          <p className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
            Tempo Especial
          </p>
          <p className="mt-1.5 font-mono text-2xl font-extrabold text-[var(--ps-text)] tabular-nums sm:text-4xl">
            {formatStageDuration(elapsed)}
          </p>
          <p className="mt-1 font-mono text-[10px] text-[var(--ps-muted)]">
            Delta {formatDeltaSeconds(delta)}
          </p>
        </div>
      )}
    </>
  );
};

interface VelocityCockpitProps {
  isActive?: boolean;
}

export const VelocityCockpit: React.FC<VelocityCockpitProps> = ({ isActive = true }) => {
  const [navSettings, updateNavSettings] = useNavSettings();
  const { isPro } = useAuthSession();
  const [screen, setScreen] = useState<VelocityScreen>('home');
  const [liveMode, setLiveMode] = useState<LivePanelMode>('timer');
  const [tachSweepTrigger, setTachSweepTrigger] = useState<number>(1);
  const prevTachVisibleRef = useRef<boolean>(false);

  useEffect(() => {
    const visible = Boolean(isActive && screen === 'home');
    if (visible && !prevTachVisibleRef.current) {
      setTachSweepTrigger((n) => n + 1);
    }
    prevTachVisibleRef.current = visible;
  }, [isActive, screen]);
  const [velPrefs, updateVelEngine] = useVelocityEngineConfig();
  const source = velPrefs.source;
  const simMultiplier = velPrefs.simMultiplier;
  const setSource = useCallback(
    (next: VelDriveSource) => updateVelEngine({ source: next }),
    [updateVelEngine]
  );
  const setSimMultiplier = useCallback(
    (next: VelSimMultiplier) => updateVelEngine({ simMultiplier: next }),
    [updateVelEngine]
  );

  const [dbLoaded, setDbLoaded] = useState(false);
  const [tracks, setTracks] = useState<VelocityTrack[]>([]);
  const [runs, setRuns] = useState<VelocityRun[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string>(
    () => loadActiveVelocityTrackId() ?? ''
  );
  const [userPickedTrackManually, setUserPickedTrackManually] = useState(false);
  const [autoDetectedNotice, setAutoDetectedNotice] = useState<string | null>(null);

  // Active recording / stage session state
  const [isRecording, setIsRecording] = useState(false);
  const [stageState, setStageState] = useState<'idle' | 'armed' | 'running' | 'finished'>('idle');
  const [stageStartMs, setStageStartMs] = useState<number | null>(null);
  const [lastFinishedMs, setLastFinishedMs] = useState<number | null>(null);
  const [currentSplitTimesMs, setCurrentSplitTimesMs] = useState<Record<string, number>>({});
  const [liveSamples, setLiveSamples] = useState<VelocitySample[]>([]);

  // Live telemetry values
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [altitudeM, setAltitudeM] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [gpsAccuracyM, setGpsAccuracyM] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [measuredGpsHz, setMeasuredGpsHz] = useState(0);
  const [zeroSpeedLocked, setZeroSpeedLocked] = useState(false);
  const [totalDistKm, setTotalDistKm] = useState(0);
  const [tripDistKm, setTripDistKm] = useState(0);
  const [tripTargetKm, setTripTargetKm] = useState<number | null>(null);
  const [tripRegressive, setTripRegressive] = useState(false);
  const [editingGaugeTrip, setEditingGaugeTrip] = useState(false);
  const [gaugeTripInput, setGaugeTripInput] = useState('');
  const [gaugeTripUnit, setGaugeTripUnit] = useState<'m' | 'km'>('m');
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(() =>
    loadLastGpsPos()
  );
  const [liveLongG, setLiveLongG] = useState(0);

  // Simulator & Track Map Editor state
  const [simPlaying, setSimPlaying] = useState(false);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackMode, setNewTrackMode] = useState<TrackMode>('circuit');
  const [showNewTrackModal, setShowNewTrackModal] = useState(false);
  const [newTrapWidthM, setNewTrapWidthM] = useState(40);
  const [newTrapUnidirectional, setNewTrapUnidirectional] = useState(true);
  const [draftBearingDeg, setDraftBearingDeg] = useState(0);
  const [placementKind, setPlacementKind] = useState<TrapKind | null>(null);
  const [selectedTrapId, setSelectedTrapId] = useState<string | null>(null);
  const [postEditIdx, setPostEditIdx] = useState(0);
  const [showGaugeConfig, setShowGaugeConfig] = useState(false);
  const [gaugeVisibility, setGaugeVisibility] = useState<GaugeVisibility>(() => loadGaugePrefs());
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [pendingDeleteTrack, setPendingDeleteTrack] = useState<VelocityTrack | null>(null);
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<{
    key: string;
    name: string;
    trackIds: string[];
  } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [surveyNavTrigger, setSurveyNavTrigger] = useState<{
    targetKey: string;
    token: number;
  } | null>(null);
  const [pendingImportDecision, setPendingImportDecision] = useState<{
    readyTracks: VelocityTrack[];
    decisionQueue: VelocityTrack[];
    waypoints: GeoWaypoint[];
    totalCount: number;
  } | null>(null);
  const [mapTrackNameDraft, setMapTrackNameDraft] = useState('');
  const [justSavedTrack, setJustSavedTrack] = useState(false);
  const [gpsMappingOpen, setGpsMappingOpen] = useState(false);
  const [gpsMappingPhase, setGpsMappingPhase] = useState<'ready' | 'recording' | 'finished'>('ready');
  const [gpsMappingTrace, setGpsMappingTrace] = useState<VelocitySample[]>([]);
  const [gpsMappingHeadingUp, setGpsMappingHeadingUp] = useState(true);
  const [gpsMappingPulse, setGpsMappingPulse] = useState<string | null>(null);
  const [gpsMappingStyleIdx, setGpsMappingStyleIdx] = useState(0);

  // Session Analysis Detail (Pure 3-Lap Telemetry & Video HUD)
  const [selectedSessionTrackId, setSelectedSessionTrackId] = useState<string>('');
  const [detailTab, setDetailTab] = useState<'analysis' | 'video'>('analysis');
  const [lap1Id, setLap1Id] = useState<string>('');
  const [lap2Id, setLap2Id] = useState<string>('');
  const [lap3Id, setLap3Id] = useState<string>('');

  const extGps = useExternalGpsBle();
  const goproFleet = useGoProFleet();
  const cockpitLayout = useVelocityCockpitLayout();
  const activeReadyLayoutId =
    cockpitLayout.config.layoutId === 'custom' ? 'classic' : cockpitLayout.config.layoutId;
  const activeReadyPreset =
    VELOCITY_COCKPIT_READY_PRESETS.find((item) => item.id === activeReadyLayoutId) ??
    VELOCITY_COCKPIT_READY_PRESETS[0];
  const [showGpsSettingsModal, setShowGpsSettingsModal] = useState(false);
  const [showLayoutSelectorModal, setShowLayoutSelectorModal] = useState(false);
  const [showTrackPickerDropdown, setShowTrackPickerDropdown] = useState(false);
  const [showGoProControlModal, setShowGoProControlModal] = useState(false);
  const [goproDrawerOpen, setGoproDrawerOpen] = useState(false);
  const [editingGoProId, setEditingGoProId] = useState<string | null>(null);
  const [editingGoProName, setEditingGoProName] = useState('');
  const [showLiveMap, setShowLiveMap] = useState(false);
  const [liveHeadingUp, setLiveHeadingUp] = useState(true);
  const [liveHeatmapMode, setLiveHeatmapMode] = useState<'accel' | 'speed'>('accel');
  const [finishSummaryModal, setFinishSummaryModal] = useState<FinishSummaryModalData | null>(
    null
  );
  const [finishGoProStopped, setFinishGoProStopped] = useState(false);

  // Pré-Largada Floating Card & Cartela por Especial
  const [preStartModalOpen, setPreStartModalOpen] = useState(false);
  const [startTimeCalcModalOpen, setStartTimeCalcModalOpen] = useState(false);
  const [startTimeCalcContext, setStartTimeCalcContext] = useState<'track-picker' | 'prestart'>(
    'prestart'
  );
  const [startTimeCalcTrackId, setStartTimeCalcTrackId] = useState<string | null>(null);
  const [preStartNowMs, setPreStartNowMs] = useState(() => Date.now());
  const [cartelaTimesByTrack, setCartelaTimesByTrack] = useState<Record<string, string>>(() =>
    loadCartelaTimes()
  );
  const [overviewFolderKey, setOverviewFolderKey] = useState<string | null>(null);
  const lastPreStartBeepKeyRef = useRef<string>('');

  // POIs persistidos (ex: Parque de Serviços) compartilhados com Levantamento & Deslocamento
  const [rallyWaypoints, setRallyWaypoints] = useState<GeoWaypoint[]>(() => loadRallyWaypoints());

  // Mapas Offline por Pasta de Rali (Cache API + Elevação + Rotas OSRM)
  const [offlinePacks, setOfflinePacks] = useState<OfflineRallyPackMeta[]>(() =>
    loadOfflineRallyPacks()
  );
  const [offlineDownloadingKey, setOfflineDownloadingKey] = useState<string | null>(null);
  const [offlineDownloadProg, setOfflineDownloadProg] = useState<OfflineDownloadProgress | null>(
    null
  );
  const offlineAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const syncPacks = () => setOfflinePacks(loadOfflineRallyPacks());
    window.addEventListener(OFFLINE_MAPS_UPDATED_EVENT, syncPacks);
    return () => window.removeEventListener(OFFLINE_MAPS_UPDATED_EVENT, syncPacks);
  }, []);

  const handleStartFolderOfflineDownload = async (
    folderKey: string,
    folderName: string,
    folderTracks: VelocityTrack[],
    folderWaypoints: GeoWaypoint[]
  ) => {
    if (offlineDownloadingKey) return;
    const ctrl = new AbortController();
    offlineAbortRef.current = ctrl;
    setOfflineDownloadingKey(folderKey);
    setOfflineDownloadProg({
      phase: 'tiles',
      completed: 0,
      total: 1,
      bytesDownloaded: 0,
      label: 'Preparando mapa offline...',
    });
    try {
      const meta = await downloadRallyOfflineBundle({
        folderKey,
        folderName,
        tracks: folderTracks,
        waypoints: folderWaypoints,
        signal: ctrl.signal,
        onProgress: (p) => setOfflineDownloadProg(p),
      });
      setOfflinePacks(loadOfflineRallyPacks());
      if (!ctrl.signal.aborted) {
        showToast(
          `Mapa Offline "${folderName}" salvo (${formatBytesCompact(meta.estimatedBytes)} · ${meta.tileCount} quadrantes).`
        );
      } else {
        showToast('Download do mapa offline cancelado.');
      }
    } catch {
      showToast('Falha parcial ao baixar mapa offline. Verifique sua conexão.');
    } finally {
      offlineAbortRef.current = null;
      setOfflineDownloadingKey(null);
      setOfflineDownloadProg(null);
    }
  };

  const handleCancelFolderOfflineDownload = () => {
    offlineAbortRef.current?.abort();
  };

  useEffect(() => {
    saveCartelaTimes(cartelaTimesByTrack);
  }, [cartelaTimesByTrack]);

  useEffect(() => {
    saveRallyWaypoints(rallyWaypoints);
  }, [rallyWaypoints]);

  useEffect(() => {
    const cartelaKey = activeTrackId || 'live_free';
    const hasCartelaForActive = Boolean(cartelaTimesByTrack[cartelaKey]);
    if (stageState !== 'armed' || (!preStartModalOpen && !hasCartelaForActive)) return;
    setPreStartNowMs(Date.now());
    const id = window.setInterval(() => setPreStartNowMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [preStartModalOpen, stageState, activeTrackId, cartelaTimesByTrack]);

  useEffect(() => {
    const cartelaKey = activeTrackId || 'live_free';
    if (stageState !== 'armed') {
      lastPreStartBeepKeyRef.current = '';
      return;
    }
    const rawClock = cartelaTimesByTrack[cartelaKey] ?? '';
    const parsed = parseStartTimeClock(rawClock);
    if (!parsed) return;
    const adjustedNowMs = preStartNowMs + navSettings.clockOffsetMs;
    const targetDate = new Date(adjustedNowMs);
    targetDate.setHours(parsed.hh, parsed.mm, parsed.ss, 0);
    let targetMs = targetDate.getTime();
    if (targetMs - adjustedNowMs < -300_000) {
      targetMs += 86_400_000;
    }
    const diffSec = Math.ceil((targetMs - adjustedNowMs) / 1000);
    if (diffSec <= 10 && diffSec >= 0) {
      const key = `${cartelaKey}:${rawClock}:${diffSec}`;
      if (lastPreStartBeepKeyRef.current !== key) {
        lastPreStartBeepKeyRef.current = key;
        playPreStartCountdownBeep(diffSec === 0);
      }
    }
  }, [stageState, activeTrackId, cartelaTimesByTrack, preStartNowMs, navSettings.clockOffsetMs]);

  useEffect(() => {
    if (stageState !== 'armed' && preStartModalOpen) {
      setPreStartModalOpen(false);
    }
  }, [stageState, preStartModalOpen]);

  const tracksRef = useRef<VelocityTrack[]>(tracks);
  tracksRef.current = tracks;
  const calFactorRef = useRef(navSettings.calibrationPct / 100);
  calFactorRef.current = navSettings.calibrationPct / 100;
  const velPrefsRef = useRef(velPrefs);
  velPrefsRef.current = velPrefs;
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const kalmanRef = useRef(createGpsKalmanProcessor());
  const prevSampleRef = useRef<VelocitySample | null>(null);
  const imuAccelRef = useRef<{ longG: number; latG: number } | null>(null);
  const fixTimestampsRef = useRef<number[]>([]);
  const stageStateRef = useRef(stageState);
  stageStateRef.current = stageState;
  const stageStartMsRef = useRef(stageStartMs);
  stageStartMsRef.current = stageStartMs;
  const finishGateArmedRef = useRef(false);
  const currentSplitTimesRef = useRef(currentSplitTimesMs);
  currentSplitTimesRef.current = currentSplitTimesMs;
  const liveSamplesRef = useRef(liveSamples);
  liveSamplesRef.current = liveSamples;
  const maxSpeedRef = useRef(maxSpeedKmh);
  maxSpeedRef.current = maxSpeedKmh;
  const totalDistRef = useRef(totalDistKm);
  totalDistRef.current = totalDistKm;
  const simProgressRef = useRef(0);
  const webWatchRef = useRef<number | null>(null);
  const capWatchRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const currentPosRef = useRef(currentPos);
  currentPosRef.current = currentPos;
  const lastValidHeadingRef = useRef<number | null>(null);
  const lastSavedGpsAtRef = useRef<number>(0);
  const gpsMappingOpenRef = useRef(gpsMappingOpen);
  gpsMappingOpenRef.current = gpsMappingOpen;
  const gpsMappingPhaseRef = useRef(gpsMappingPhase);
  gpsMappingPhaseRef.current = gpsMappingPhase;
  const gpsMappingTraceRef = useRef(gpsMappingTrace);
  gpsMappingTraceRef.current = gpsMappingTrace;
  const gpsMappingStartNeedsBearingRef = useRef(false);
  const gpsMappingTrackIdRef = useRef<string>('');

  useEffect(() => {
    let alive = true;
    const syncDb = () => {
      loadVelocityDatabase().then(({ tracks: loadedTracks, runs: loadedRuns }) => {
        if (!alive) return;
        const normalizedTracks = loadedTracks.map((t) => ensureAutoTrapsFromBaseTrace(t));
        setTracks(normalizedTracks);
        setRuns(loadedRuns);
        setActiveTrackId((prev) => {
          if (prev && normalizedTracks.some((t) => t.id === prev)) return prev;
          return normalizedTracks[0]?.id ?? '';
        });
        setDbLoaded(true);
      });
    };
    syncDb();
    window.addEventListener('pitstop:velocity-db-updated', syncDb);
    return () => {
      alive = false;
      window.removeEventListener('pitstop:velocity-db-updated', syncDb);
    };
  }, []);

  useEffect(() => {
    if (!dbLoaded) return;
    const t = window.setTimeout(() => {
      persistVelocityTracks(tracks).catch(() => {});
    }, 350);
    return () => window.clearTimeout(t);
  }, [tracks, dbLoaded]);

  useEffect(() => {
    if (!dbLoaded) return;
    const t = window.setTimeout(() => {
      persistVelocityRuns(runs).catch(() => {});
    }, 450);
    return () => window.clearTimeout(t);
  }, [runs, dbLoaded]);

  useEffect(() => {
    if (activeTrackId) {
      saveActiveVelocityTrackId(activeTrackId);
    }
  }, [activeTrackId]);

  useEffect(() => {
    try {
      localStorage.setItem(GAUGE_PREFS_KEY, JSON.stringify(gaugeVisibility));
    } catch {
      // Ignore storage error
    }
  }, [gaugeVisibility]);

  useEffect(() => {
    if (!isActive || !velPrefs.useDeviceImu || screen !== 'live') return;
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;

    const handler = (ev: DeviceMotionEvent) => {
      const acc = ev.acceleration;
      if (!acc) return;
      const ax = typeof acc.x === 'number' ? acc.x / 9.80665 : 0;
      const ay = typeof acc.y === 'number' ? acc.y / 9.80665 : 0;
      imuAccelRef.current = {
        latG: Number(Math.max(-2.5, Math.min(2.5, ax)).toFixed(2)),
        longG: Number(Math.max(-2.5, Math.min(2.5, ay)).toFixed(2)),
      };
    };

    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }, [isActive, velPrefs.useDeviceImu, screen]);

  useEffect(() => {
    if (!gpsMappingOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [gpsMappingOpen]);

  useEffect(() => {
    if (
      !isActive ||
      (!isRecording && stageState !== 'running' && stageState !== 'armed' && !gpsMappingOpen)
    ) {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      setWakeLockActive(false);
      return;
    }
    if ('wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((s) => {
          wakeLockRef.current = s;
          setWakeLockActive(true);
        })
        .catch(() => setWakeLockActive(false));
    }
    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [isActive, isRecording, stageState, gpsMappingOpen]);

  const activeTrack = useMemo(
    () => tracks.find((t) => t.id === activeTrackId) ?? null,
    [tracks, activeTrackId]
  );

  useEffect(() => {
    setMapTrackNameDraft(activeTrack ? formatCleanTrackName(activeTrack.name) : '');
  }, [activeTrack?.id, activeTrack?.name]);

  const trackRuns = useMemo(() => {
    if (!activeTrack) return [];
    return runs
      .filter((r) => r.trackId === activeTrack.id)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }, [runs, activeTrack]);

  const optimalSummary = useMemo(() => {
    if (!activeTrack) {
      return {
        optimalTotalMs: null,
        bestRunTotalMs: null,
        bestRunId: null,
        lastRunTotalMs: null,
        sectors: [],
      };
    }
    return computeOptimalStage(activeTrack, runs);
  }, [activeTrack, runs]);

  const bestRun = useMemo(() => {
    if (!optimalSummary.bestRunId) return null;
    return trackRuns.find((r) => r.id === optimalSummary.bestRunId) ?? null;
  }, [trackRuns, optimalSummary.bestRunId]);

  const lastRun = useMemo(() => {
    return trackRuns.length > 0 ? trackRuns[trackRuns.length - 1] : null;
  }, [trackRuns]);

  const groupedSessions = useMemo(() => {
    const byTrack = new Map<
      string,
      {
        trackId: string;
        trackName: string;
        runs: VelocityRun[];
        latestAtMs: number;
        bestTotalMs: number;
        totalDurationMs: number;
        totalDistanceKm: number;
        approxSizeKb: number;
      }
    >();

    for (const run of runs) {
      const trk = tracks.find((t) => t.id === run.trackId);
      const trackName = formatCleanTrackName(trk?.name || 'Especial Avulsa');
      const existing = byTrack.get(run.trackId);
      const runSizeKb = Math.max(12, Math.round((run.samples.length * 140) / 1024));
      if (!existing) {
        byTrack.set(run.trackId, {
          trackId: run.trackId,
          trackName,
          runs: [run],
          latestAtMs: run.finishedAtMs || run.startedAtMs,
          bestTotalMs: run.totalMs,
          totalDurationMs: run.totalMs,
          totalDistanceKm: run.distanceKm,
          approxSizeKb: runSizeKb,
        });
      } else {
        existing.runs.push(run);
        existing.latestAtMs = Math.max(
          existing.latestAtMs,
          run.finishedAtMs || run.startedAtMs
        );
        existing.bestTotalMs = Math.min(existing.bestTotalMs, run.totalMs);
        existing.totalDurationMs += run.totalMs;
        existing.totalDistanceKm += run.distanceKm;
        existing.approxSizeKb += runSizeKb;
      }
    }

    return Array.from(byTrack.values()).sort((a, b) => b.latestAtMs - a.latestAtMs);
  }, [runs, tracks]);

  const showToast = useCallback((msg: string) => {
    setStatusFeedback(msg);
    window.setTimeout(() => {
      setStatusFeedback((curr) => (curr === msg ? null : curr));
    }, 3500);
  }, []);

  const finalizeRun = useCallback(
    (
      finishedAtMs: number,
      splitsOverride?: Record<string, number>,
      continueNextLap = false,
      rearmAfterFinish = false,
      samplesOverride?: VelocitySample[],
      distKmOverride?: number,
      openFinishModal = false
    ) => {
      const startMs = stageStartMsRef.current;
      if (!startMs) return;
      const elapsedTotal = Math.max(100, finishedAtMs - startMs);
      const samples = ensureTraceGForces(samplesOverride ?? [...liveSamplesRef.current]);
      const distKm = distKmOverride ?? totalDistRef.current;
      const sampleMaxSpeed = samples.reduce(
        (m, s) => Math.max(m, Number.isFinite(s.speedKmh) ? s.speedKmh : 0),
        0
      );
      const resolvedMaxSpeed = Math.max(
        Math.round(maxSpeedRef.current),
        Math.round(sampleMaxSpeed)
      );
      const resolvedAvgSpeed = computeSafeAverageSpeedKmh({
        distanceKm: distKm,
        totalMs: elapsedTotal,
        maxSpeedKmh: resolvedMaxSpeed,
        samples,
      });

      const targetTrackId = activeTrack?.id || 'free_stage';
      const priorRuns = runs.filter((r) => r.trackId === targetTrackId);
      const nextNum = priorRuns.length + 1;
      const bestBefore = priorRuns.reduce<VelocityRun | null>((best, r) => {
        if (r.totalMs <= 0) return best;
        if (!best || r.totalMs < best.totalMs) return r;
        return best;
      }, null);
      const resolvedSplits = splitsOverride ?? currentSplitTimesRef.current;

      const newRun: VelocityRun = {
        id: `run_${Date.now()}_${nextNum}`,
        trackId: targetTrackId,
        runNumber: nextNum,
        startedAtMs: startMs,
        finishedAtMs,
        totalMs: elapsedTotal,
        splitTimesMs: resolvedSplits,
        maxSpeedKmh: resolvedMaxSpeed,
        avgSpeedKmh: resolvedAvgSpeed,
        distanceKm: Number(distKm.toFixed(3)),
        samples,
      };
      setRuns((prev) => [newRun, ...prev]);

      if (openFinishModal) {
        const deltaVsBestMs = bestBefore ? elapsedTotal - bestBefore.totalMs : null;
        const isFaster = deltaVsBestMs === null ? true : deltaVsBestMs <= 0;
        const splitTraps = activeTrack
          ? getOrderedTrackTraps(activeTrack).filter((t) => t.kind === 'split')
          : [];
        const splitCards = splitTraps.map((trap, idx) => {
          const curSplit =
            typeof resolvedSplits[trap.id] === 'number' ? resolvedSplits[trap.id] : null;
          const bestSplit =
            bestBefore && typeof bestBefore.splitTimesMs?.[trap.id] === 'number'
              ? bestBefore.splitTimesMs[trap.id]
              : null;
          return {
            id: trap.id,
            label: `P${idx + 1}`,
            timeMs: curSplit,
            deltaMs:
              curSplit !== null && bestSplit !== null ? curSplit - bestSplit : null,
          };
        });

        let bestSectorLabel: string | null = null;
        let bestSectorMs: number | null = null;
        let bestSectorDeltaMs: number | null = null;
        if (splitTraps.length > 0) {
          const boundaryIds = [...splitTraps.map((t) => t.id), '__finish__'];
          let prevCurMs = 0;
          let prevBestMs = 0;
          let bestScore = Infinity;
          for (let sIdx = 0; sIdx < boundaryIds.length; sIdx += 1) {
            const bId = boundaryIds[sIdx];
            const curCum = bId === '__finish__' ? elapsedTotal : resolvedSplits[bId];
            if (typeof curCum !== 'number' || !Number.isFinite(curCum) || curCum <= prevCurMs) {
              continue;
            }
            const curSecMs = curCum - prevCurMs;
            prevCurMs = curCum;

            let secDeltaMs: number | null = null;
            if (bestBefore) {
              const bestCum =
                bId === '__finish__' ? bestBefore.totalMs : bestBefore.splitTimesMs?.[bId];
              if (
                typeof bestCum === 'number' &&
                Number.isFinite(bestCum) &&
                bestCum > prevBestMs
              ) {
                const bestSecMs = bestCum - prevBestMs;
                prevBestMs = bestCum;
                secDeltaMs = curSecMs - bestSecMs;
              }
            }

            const score = secDeltaMs !== null ? secDeltaMs : curSecMs;
            if (score < bestScore) {
              bestScore = score;
              bestSectorLabel = `S${sIdx + 1}`;
              bestSectorMs = curSecMs;
              bestSectorDeltaMs = secDeltaMs;
            }
          }
        }

        const traceSrc =
          samples.length >= 2 ? samples : activeTrack?.baseTrace ?? [];
        const modalDistKm =
          activeTrack?.referenceDistanceKm && activeTrack.referenceDistanceKm > 0.05
            ? activeTrack.referenceDistanceKm
            : distKm;

        setFinishSummaryModal({
          trackName: formatCleanTrackName(activeTrack?.name || 'Especial Livre'),
          runNumber: nextNum,
          totalMs: elapsedTotal,
          deltaVsBestMs,
          isFaster,
          splits: splitCards,
          maxSpeedKmh: resolvedMaxSpeed,
          avgSpeedKmh: resolvedAvgSpeed,
          distanceKm: Number(modalDistKm.toFixed(2)),
          bestSectorLabel,
          bestSectorMs,
          bestSectorDeltaMs,
          tracePoints: downsampleTraceLatLon(traceSrc, 80),
        });
        setFinishGoProStopped(false);
      }

      if (activeTrack) {
        setTracks((prev) =>
          prev.map((t) =>
            t.id === activeTrack.id && (!t.baseTrace || t.baseTrace.length === 0)
              ? ensureAutoTrapsFromBaseTrace({
                  ...t,
                  referenceDistanceKm: distKm,
                  baseTrace: samples,
                })
              : t
          )
        );
      }

      void addGoProHiLightTag();

      setLastFinishedMs(elapsedTotal);
      if (continueNextLap) {
        stageStartMsRef.current = finishedAtMs;
        stageStateRef.current = 'running';
        finishGateArmedRef.current = true;
        totalDistRef.current = 0;
        maxSpeedRef.current = 0;
        currentSplitTimesRef.current = {};
        liveSamplesRef.current = [];
        setStageStartMs(finishedAtMs);
        setStageState('running');
        setIsRecording(true);
        setTotalDistKm(0);
        setTripDistKm(0);
        setMaxSpeedKmh(0);
        setCurrentSplitTimesMs({});
        setLiveSamples([]);
        showToast(`Volta #${nextNum}: ${formatStageDuration(elapsedTotal)}`);
      } else if (rearmAfterFinish) {
        stageStartMsRef.current = null;
        stageStateRef.current = 'armed';
        finishGateArmedRef.current = false;
        totalDistRef.current = 0;
        maxSpeedRef.current = 0;
        currentSplitTimesRef.current = {};
        liveSamplesRef.current = [];
        setStageStartMs(null);
        setStageState('armed');
        setIsRecording(false);
        setTotalDistKm(0);
        setTripDistKm(0);
        setMaxSpeedKmh(0);
        setCurrentSplitTimesMs({});
        setLiveSamples([]);
        showToast(
          `Chegada #${nextNum}: ${formatStageDuration(elapsedTotal)} · Armado para próxima!`
        );
      } else {
        stageStateRef.current = 'finished';
        finishGateArmedRef.current = false;
        setStageState('finished');
        setIsRecording(false);
        setSimPlaying(false);
        showToast(`Sessão salva (#${nextNum}): ${formatStageDuration(elapsedTotal)}`);
      }
    },
    [activeTrack, runs, showToast]
  );

  const processIncomingFix = useCallback(
    (fix: {
      lat: number;
      lon: number;
      speedKmh: number;
      rawDopplerSpeedMs?: number | null;
      accuracyM: number | null;
      headingDeg: number | null;
      altitudeM: number | null;
      timestampMs: number;
      satellites?: number | null;
      imuAccel?: { longG: number; latG: number } | null;
    }) => {
      setGpsAccuracyM(fix.accuracyM);
      setGpsActive(true);

      const nowPerf = Date.now();
      const tsList = fixTimestampsRef.current;
      tsList.push(nowPerf);
      while (tsList.length > 0 && nowPerf - tsList[0] > 2000) {
        tsList.shift();
      }
      if (tsList.length >= 2) {
        const spanSec = Math.max(0.25, (tsList[tsList.length - 1] - tsList[0]) / 1000);
        setMeasuredGpsHz(Math.max(1, Math.round((tsList.length - 1) / spanSec)));
      } else {
        setMeasuredGpsHz(1);
      }

      // Descarta apenas saltos absurdos (> 45m) para permitir leitura normal caminhando
      if ((source === 'gps' || source === 'ble_gps') && fix.accuracyM !== null && fix.accuracyM > 45) {
        setGpsError(`Sinal GPS fraco (±${fix.accuracyM}m) — aguardando satélite.`);
        return;
      }

      let resolvedLat = fix.lat;
      let resolvedLon = fix.lon;
      let resolvedSpeedKmh = fix.speedKmh;
      let resolvedHeading: number | null = prevSampleRef.current?.headingDeg ?? null;
      let deltaDistKm = 0;
      let isZeroLocked = false;

      const prev = prevSampleRef.current;
      const activeImu =
        fix.imuAccel ?? (velPrefsRef.current.useDeviceImu ? imuAccelRef.current : null);

      if (source === 'gps' || source === 'ble_gps') {
        const filtered = kalmanRef.current.update({
          lat: fix.lat,
          lon: fix.lon,
          accuracyM: fix.accuracyM,
          rawSpeedMs: fix.rawDopplerSpeedMs ?? (fix.speedKmh > 0 ? fix.speedKmh / 3.6 : null),
          rawHeadingDeg: fix.headingDeg,
          timestampMs: fix.timestampMs,
          imu: activeImu,
        });
        resolvedLat = filtered.lat;
        resolvedLon = filtered.lon;
        resolvedSpeedKmh = filtered.speedKmh;
        isZeroLocked = Boolean(filtered.zeroSpeedLocked);
        if (filtered.headingDeg !== null) {
          resolvedHeading = filtered.headingDeg;
        }
        if (filtered.distStepM > 0 && !isZeroLocked) {
          deltaDistKm = (filtered.distStepM / 1000) * calFactorRef.current;
        }
      } else {
        const stepM = prev ? haversineMetersVel(prev.lat, prev.lon, fix.lat, fix.lon) : 0;
        if (fix.headingDeg !== null && resolvedSpeedKmh >= 2) {
          resolvedHeading = fix.headingDeg;
        } else if (prev && stepM >= 1.2 && stepM < 500) {
          resolvedHeading = bearingBetweenDeg(prev.lat, prev.lon, fix.lat, fix.lon);
        }
        if (prev && stepM >= 0.45 && stepM < 500 && resolvedSpeedKmh > 0) {
          deltaDistKm = (stepM / 1000) * calFactorRef.current;
        }
        isZeroLocked = resolvedSpeedKmh < 2.0;
      }

      setZeroSpeedLocked(isZeroLocked);
      setCurrentPos({ lat: resolvedLat, lon: resolvedLon });
      setAltitudeM(fix.altitudeM);
      setGpsError(null);
      setSpeedKmh(resolvedSpeedKmh);
      if (resolvedHeading !== null) {
        const roundedH = Math.round(resolvedHeading);
        setHeadingDeg(roundedH);
        if (resolvedSpeedKmh >= 2) {
          lastValidHeadingRef.current = roundedH;
        }
      }
      if (source === 'gps' || source === 'ble_gps') {
        const nowSave = Date.now();
        if (nowSave - lastSavedGpsAtRef.current >= 2500) {
          lastSavedGpsAtRef.current = nowSave;
          saveLastGpsPos(resolvedLat, resolvedLon);
        }
      }

      // Auto-detecção exclusiva pela Largada (raio 35m) + Auto-armar (WAITING FOR START)
      let detectedTrackOverride: VelocityTrack | null = null;
      if (
        velPrefsRef.current.autoDetectTrack &&
        !userPickedTrackManually &&
        stageStateRef.current !== 'running' &&
        tracksRef.current.length > 0
      ) {
        const hitTrack = autoDetectNearestTrack(
          resolvedLat,
          resolvedLon,
          tracksRef.current,
          velPrefsRef.current.autoDetectRadiusM
        );
        if (hitTrack) {
          const preparedTrack = ensureAutoTrapsFromBaseTrace(hitTrack.track);
          if (preparedTrack !== hitTrack.track) {
            setTracks((list) =>
              list.map((t) => (t.id === preparedTrack.id ? preparedTrack : t))
            );
          }
          detectedTrackOverride = preparedTrack;
          if (preparedTrack.id !== activeTrack?.id) {
            setActiveTrackId(preparedTrack.id);
          }
          setAutoDetectedNotice(`Largada ${hitTrack.distanceM}m`);
          if (stageStateRef.current === 'idle') {
            finishGateArmedRef.current = false;
            stageStateRef.current = 'armed';
            setStageState('armed');
            setIsRecording(false);
          }
        }
      }

      const trackForCrossing = detectedTrackOverride ?? activeTrack;

      const kinG = computeSampleGForces(prev, {
        speedKmh: resolvedSpeedKmh,
        headingDeg: resolvedHeading,
        timestampMs: fix.timestampMs,
      });
      const imu = imuAccelRef.current;
      const accelLongG =
        velPrefsRef.current.useDeviceImu && imu && Math.abs(imu.longG) > 0.05
          ? imu.longG
          : kinG.accelLongG;
      const accelLatG =
        velPrefsRef.current.useDeviceImu && imu && Math.abs(imu.latG) > 0.05
          ? imu.latG
          : kinG.accelLatG;
      setLiveLongG(accelLongG);

      let nextTotalDist = totalDistRef.current + (isZeroLocked ? 0 : deltaDistKm);
      if (stageStateRef.current === 'running') {
        if (!isZeroLocked && deltaDistKm > 0) {
          totalDistRef.current = nextTotalDist;
          setTotalDistKm(nextTotalDist);
          setTripDistKm((t) => t + deltaDistKm);
        }
      } else if (stageStateRef.current === 'armed') {
        // Zero-Speed Anti-Drift Lock: nunca soma metros fantasmas no Trip parado aguardando Largada
        if (!isZeroLocked && resolvedSpeedKmh >= 2.0 && deltaDistKm > 0) {
          setTripDistKm((t) => t + deltaDistKm);
        }
      }

      if (resolvedSpeedKmh > maxSpeedRef.current && stageStateRef.current === 'running') {
        maxSpeedRef.current = Math.round(resolvedSpeedKmh);
        setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
      }

      let activeStartMs = stageStartMsRef.current;
      let nextStageState = stageStateRef.current;
      const updatedSplits = { ...currentSplitTimesRef.current };
      let seededStartSample: VelocitySample | null = null;
      let finishedThisFix = false;

      if (
        trackForCrossing &&
        prev &&
        (nextStageState === 'armed' || nextStageState === 'running')
      ) {
        const rawSegDistM = haversineMetersVel(prev.lat, prev.lon, resolvedLat, resolvedLon);
        const segDtSec = (fix.timestampMs - prev.timestampMs) / 1000;
        const isValidPhysicalSegment = !(rawSegDistM > 350 && segDtSec <= 10);

        if (isValidPhysicalSegment) {
          const ordered = getOrderedTrackTraps(trackForCrossing);
          let startedThisFix = false;

          // FASE 1: Especial ARMADA — avalia EXCLUSIVAMENTE a linha de Largada (L / Larg-Cheg).
          // Chegada (C) e Parciais (P1..Pn) permanecem DESARMADAS até que L seja cruzada,
          // evitando disparo falso durante o deslocamento de casa até a largada.
          if (nextStageState === 'armed') {
            const startGates = ordered.filter(
              (t) => t.kind === 'start' || t.kind === 'start_finish'
            );
            for (const trap of startGates) {
              const hit = detectTrapCrossing(
                { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
                { lat: resolvedLat, lon: resolvedLon, timestampMs: fix.timestampMs },
                trap,
                {
                  hdopAccuracyM: fix.accuracyM,
                  autoSnap: velPrefsRef.current.autoSnapHdop,
                  vehicleHeadingDeg: resolvedHeading,
                }
              );
              if (!hit) continue;

              startedThisFix = true;
              activeStartMs = hit.crossTimestampMs;
              nextStageState = 'running';
              stageStartMsRef.current = hit.crossTimestampMs;
              stageStateRef.current = 'running';
              finishGateArmedRef.current = true;
              const postCrossDistKm =
                (haversineMetersVel(hit.crossLat, hit.crossLon, resolvedLat, resolvedLon) / 1000) *
                calFactorRef.current;
              nextTotalDist = postCrossDistKm;
              totalDistRef.current = postCrossDistKm;
              maxSpeedRef.current = Math.round(resolvedSpeedKmh);
              currentSplitTimesRef.current = {};
              liveSamplesRef.current = [];

              const startSpeedKmh = prev.speedKmh + hit.t * (resolvedSpeedKmh - prev.speedKmh);
              const startAltM =
                prev.altitudeM !== null && fix.altitudeM !== null
                  ? prev.altitudeM + hit.t * (fix.altitudeM - prev.altitudeM)
                  : fix.altitudeM;

              seededStartSample = {
                lat: hit.crossLat,
                lon: hit.crossLon,
                speedKmh: startSpeedKmh,
                accuracyM: fix.accuracyM,
                headingDeg: resolvedHeading,
                altitudeM: startAltM,
                timestampMs: hit.crossTimestampMs,
                distKm: 0,
                stageElapsedMs: 0,
                accelLongG,
                accelLatG,
              };

              setStageStartMs(hit.crossTimestampMs);
              setStageState('running');
              setPreStartModalOpen(false);
              setIsRecording(true);
              setTotalDistKm(postCrossDistKm);
              setTripDistKm(postCrossDistKm);
              setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
              setCurrentSplitTimesMs({});
              setLiveSamples([seededStartSample]);
              void addGoProHiLightTag();
              window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
              showToast(`Largada automática (${trap.name})`);
              break;
            }
          }

          // FASE 2: Especial EM PROVA — Parciais (P1..Pn) e Chegada (C) só operam APÓS
          // L ter sido cruzada (finishGateArmedRef.current === true) e nunca no mesmo tick da largada.
          if (
            !startedThisFix &&
            nextStageState === 'running' &&
            finishGateArmedRef.current &&
            activeStartMs !== null
          ) {
            for (const trap of ordered) {
              if (trap.kind === 'start') continue;

              const hit = detectTrapCrossing(
                { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
                { lat: resolvedLat, lon: resolvedLon, timestampMs: fix.timestampMs },
                trap,
                {
                  hdopAccuracyM: fix.accuracyM,
                  autoSnap: velPrefsRef.current.autoSnapHdop,
                  vehicleHeadingDeg: resolvedHeading,
                }
              );
              if (!hit) continue;

              if (trap.kind === 'split' && updatedSplits[trap.id] === undefined) {
                if (hit.crossTimestampMs >= activeStartMs) {
                  const splitMs = Math.max(0, hit.crossTimestampMs - activeStartMs);
                  updatedSplits[trap.id] = splitMs;
                  currentSplitTimesRef.current = { ...updatedSplits };
                  setCurrentSplitTimesMs({ ...updatedSplits });

                  const prevLast =
                    liveSamplesRef.current[liveSamplesRef.current.length - 1] ?? prev;
                  const segToSplitKm =
                    (haversineMetersVel(prevLast.lat, prevLast.lon, hit.crossLat, hit.crossLon) /
                      1000) *
                    calFactorRef.current;
                  const splitBoundarySample: VelocitySample = {
                    lat: hit.crossLat,
                    lon: hit.crossLon,
                    speedKmh: prev.speedKmh + hit.t * (resolvedSpeedKmh - prev.speedKmh),
                    accuracyM: fix.accuracyM,
                    headingDeg: resolvedHeading,
                    altitudeM:
                      prev.altitudeM !== null && fix.altitudeM !== null
                        ? prev.altitudeM + hit.t * (fix.altitudeM - prev.altitudeM)
                        : fix.altitudeM,
                    timestampMs: hit.crossTimestampMs,
                    distKm: Math.max(prevLast.distKm, prevLast.distKm + segToSplitKm),
                    stageElapsedMs: splitMs,
                    accelLongG,
                    accelLatG,
                  };
                  const withSplit = [...liveSamplesRef.current, splitBoundarySample];
                  liveSamplesRef.current = withSplit;
                  setLiveSamples(withSplit);
                }
              } else if (
                trap.kind === 'start_finish' &&
                hit.crossTimestampMs - activeStartMs >= 6000
              ) {
                const lapMs = hit.crossTimestampMs - activeStartMs;
                updatedSplits[trap.id] = lapMs;
                currentSplitTimesRef.current = { ...updatedSplits };
                setCurrentSplitTimesMs({ ...updatedSplits });

                const prevLast =
                  liveSamplesRef.current[liveSamplesRef.current.length - 1] ?? prev;
                const segToCrossKm =
                  (haversineMetersVel(prevLast.lat, prevLast.lon, hit.crossLat, hit.crossLon) /
                    1000) *
                  calFactorRef.current;
                const finishDistKm = Math.max(prevLast.distKm, prevLast.distKm + segToCrossKm);
                const crossSpeedKmh =
                  prev.speedKmh + hit.t * (resolvedSpeedKmh - prev.speedKmh);
                const crossAltM =
                  prev.altitudeM !== null && fix.altitudeM !== null
                    ? prev.altitudeM + hit.t * (fix.altitudeM - prev.altitudeM)
                    : fix.altitudeM;
                const finishBoundarySample: VelocitySample = {
                  lat: hit.crossLat,
                  lon: hit.crossLon,
                  speedKmh: crossSpeedKmh,
                  accuracyM: fix.accuracyM,
                  headingDeg: resolvedHeading,
                  altitudeM: crossAltM,
                  timestampMs: hit.crossTimestampMs,
                  distKm: finishDistKm,
                  stageElapsedMs: lapMs,
                  accelLongG:
                    typeof prev.accelLongG === 'number'
                      ? Number((prev.accelLongG + hit.t * (accelLongG - prev.accelLongG)).toFixed(2))
                      : accelLongG,
                  accelLatG:
                    typeof prev.accelLatG === 'number'
                      ? Number((prev.accelLatG + hit.t * (accelLatG - prev.accelLatG)).toFixed(2))
                      : accelLatG,
                };
                const lapSamples = [...liveSamplesRef.current, finishBoundarySample];

                finalizeRun(
                  hit.crossTimestampMs,
                  updatedSplits,
                  true,
                  false,
                  lapSamples,
                  finishDistKm,
                  true
                );

                // Inicia próxima volta a partir do ponto exato do cruzamento da linha
                const nextLapPostDistKm =
                  (haversineMetersVel(hit.crossLat, hit.crossLon, resolvedLat, resolvedLon) / 1000) *
                  calFactorRef.current;
                activeStartMs = hit.crossTimestampMs;
                nextTotalDist = nextLapPostDistKm;
                totalDistRef.current = nextLapPostDistKm;
                seededStartSample = { ...finishBoundarySample, distKm: 0, stageElapsedMs: 0 };
                setTotalDistKm(nextLapPostDistKm);
                setLiveSamples([seededStartSample]);
                break;
              } else if (
                trap.kind === 'finish' &&
                hit.crossTimestampMs - activeStartMs >= 500
              ) {
                const finMs = hit.crossTimestampMs - activeStartMs;
                updatedSplits[trap.id] = finMs;
                currentSplitTimesRef.current = { ...updatedSplits };
                setCurrentSplitTimesMs({ ...updatedSplits });

                const prevLast =
                  liveSamplesRef.current[liveSamplesRef.current.length - 1] ?? prev;
                const segToCrossKm =
                  (haversineMetersVel(prevLast.lat, prevLast.lon, hit.crossLat, hit.crossLon) /
                    1000) *
                  calFactorRef.current;
                const finishDistKm = Math.max(prevLast.distKm, prevLast.distKm + segToCrossKm);
                const crossSpeedKmh =
                  prev.speedKmh + hit.t * (resolvedSpeedKmh - prev.speedKmh);
                const crossAltM =
                  prev.altitudeM !== null && fix.altitudeM !== null
                    ? prev.altitudeM + hit.t * (fix.altitudeM - prev.altitudeM)
                    : fix.altitudeM;
                const finishBoundarySample: VelocitySample = {
                  lat: hit.crossLat,
                  lon: hit.crossLon,
                  speedKmh: crossSpeedKmh,
                  accuracyM: fix.accuracyM,
                  headingDeg: resolvedHeading,
                  altitudeM: crossAltM,
                  timestampMs: hit.crossTimestampMs,
                  distKm: finishDistKm,
                  stageElapsedMs: finMs,
                  accelLongG:
                    typeof prev.accelLongG === 'number'
                      ? Number((prev.accelLongG + hit.t * (accelLongG - prev.accelLongG)).toFixed(2))
                      : accelLongG,
                  accelLatG:
                    typeof prev.accelLatG === 'number'
                      ? Number((prev.accelLatG + hit.t * (accelLatG - prev.accelLatG)).toFixed(2))
                      : accelLatG,
                };
                const finSamples = [...liveSamplesRef.current, finishBoundarySample];

                finishGateArmedRef.current = false;
                finishedThisFix = true;
                finalizeRun(
                  hit.crossTimestampMs,
                  updatedSplits,
                  false,
                  true,
                  finSamples,
                  finishDistKm,
                  true
                );
                nextStageState = 'armed';
                activeStartMs = null;
                break;
              }
            }
          }
        }
      }

      const elapsedMs =
        activeStartMs !== null && nextStageState === 'running'
          ? Math.max(0, fix.timestampMs - activeStartMs)
          : 0;

      const sample: VelocitySample = {
        lat: resolvedLat,
        lon: resolvedLon,
        speedKmh: resolvedSpeedKmh,
        accuracyM: fix.accuracyM,
        headingDeg: resolvedHeading,
        altitudeM: fix.altitudeM,
        timestampMs: fix.timestampMs,
        distKm: nextStageState === 'running' ? nextTotalDist : 0,
        stageElapsedMs: elapsedMs,
        accelLongG,
        accelLatG,
      };

      prevSampleRef.current = sample;
      if (nextStageState === 'running' && !finishedThisFix) {
        if (seededStartSample) {
          const nextArr = [seededStartSample, sample];
          liveSamplesRef.current = nextArr;
          setLiveSamples(nextArr);
        } else {
          setLiveSamples((arr) => {
            const nextArr = [...arr, sample];
            liveSamplesRef.current = nextArr;
            return nextArr;
          });
        }
      }

      if (gpsMappingOpenRef.current && gpsMappingPhaseRef.current === 'recording') {
        const currMapTrace = gpsMappingTraceRef.current;
        const lastMapPt = currMapTrace[currMapTrace.length - 1];
        const stepM = lastMapPt
          ? haversineMetersVel(lastMapPt.lat, lastMapPt.lon, resolvedLat, resolvedLon)
          : 0;
        if (!lastMapPt || (stepM >= 2 && stepM < 500)) {
          const nextMapDistKm = lastMapPt ? lastMapPt.distKm + stepM / 1000 : 0;
          const mapElapsedMs = lastMapPt
            ? Math.max(0, fix.timestampMs - currMapTrace[0].timestampMs)
            : 0;
          const ptHeading =
            resolvedHeading !== null
              ? resolvedHeading
              : lastMapPt && stepM >= 2
                ? Math.round(bearingBetweenDeg(lastMapPt.lat, lastMapPt.lon, resolvedLat, resolvedLon))
                : null;
          const mapSample: VelocitySample = {
            lat: resolvedLat,
            lon: resolvedLon,
            speedKmh: resolvedSpeedKmh,
            accuracyM: fix.accuracyM,
            headingDeg: ptHeading,
            altitudeM: fix.altitudeM,
            timestampMs: fix.timestampMs,
            distKm: nextMapDistKm,
            stageElapsedMs: mapElapsedMs,
            accelLongG,
            accelLatG,
          };
          const updatedTrace = [...currMapTrace, mapSample];
          gpsMappingTraceRef.current = updatedTrace;
          setGpsMappingTrace(updatedTrace);

          if (
            gpsMappingStartNeedsBearingRef.current &&
            nextMapDistKm >= 0.012 &&
            updatedTrace.length >= 2 &&
            gpsMappingTrackIdRef.current
          ) {
            gpsMappingStartNeedsBearingRef.current = false;
            const autoBearing = Math.round(
              bearingBetweenDeg(
                updatedTrace[0].lat,
                updatedTrace[0].lon,
                resolvedLat,
                resolvedLon
              )
            );
            const targetId = gpsMappingTrackIdRef.current;
            setTracks((prev) =>
              prev.map((t) =>
                t.id === targetId
                  ? {
                      ...t,
                      traps: t.traps.map((tr) =>
                        tr.kind === 'start'
                          ? { ...tr, bearingDeg: autoBearing, unidirectional: true }
                          : tr
                      ),
                    }
                  : t
              )
            );
          }
        }
      }
    },
    [activeTrack, source, userPickedTrackManually, finalizeRun, showToast]
  );

  const processIncomingFixRef = useRef(processIncomingFix);
  processIncomingFixRef.current = processIncomingFix;

  // Continuous Real GPS listener (never restarts when switching sub-screens)
  useEffect(() => {
    if (!isActive || source !== 'gps') return;
    let cancelled = false;
    kalmanRef.current.reset();

    const cleanup = () => {
      if (webWatchRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(webWatchRef.current);
        webWatchRef.current = null;
      }
      if (capWatchRef.current !== null) {
        Geolocation.clearWatch({ id: capWatchRef.current }).catch(() => {});
        capWatchRef.current = null;
      }
    };

    const startGps = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const perm = await Geolocation.requestPermissions();
          if (cancelled) return;
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            setGpsError('Permissão de GPS negada no dispositivo.');
            return;
          }
          const wid = await Geolocation.watchPosition(
            getCapacitorGpsWatchOptions(),
            (pos, err) => {
              if (cancelled || err || !pos) return;
              if (screenRef.current === 'survey') return;
              const rawDopplerSpeedMs =
                pos.coords.speed !== null && Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0
                  ? pos.coords.speed
                  : null;
              processIncomingFixRef.current({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                speedKmh: rawDopplerSpeedMs !== null ? rawDopplerSpeedMs * 3.6 : 0,
                rawDopplerSpeedMs,
                accuracyM:
                  pos.coords.accuracy !== null && Number.isFinite(pos.coords.accuracy)
                    ? Math.round(pos.coords.accuracy)
                    : null,
                headingDeg:
                  pos.coords.heading !== null && Number.isFinite(pos.coords.heading)
                    ? Math.round(pos.coords.heading)
                    : null,
                altitudeM:
                  pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
                    ? Math.round(pos.coords.altitude)
                    : null,
                timestampMs: pos.timestamp || Date.now(),
              });
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id: wid }).catch(() => {});
            return;
          }
          capWatchRef.current = wid;
        } catch {
          if (!cancelled) setGpsError('Erro ao iniciar receptor GPS.');
        }
        return;
      }

      if (!('geolocation' in navigator)) {
        setGpsError('GPS indisponível. Ative o Simulador nas configurações (⚙️).');
        return;
      }

      webWatchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          if (screenRef.current === 'survey') return;
          const rawDopplerSpeedMs =
            pos.coords.speed !== null && Number.isFinite(pos.coords.speed) && pos.coords.speed >= 0
              ? pos.coords.speed
              : null;
          processIncomingFixRef.current({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speedKmh: rawDopplerSpeedMs !== null ? rawDopplerSpeedMs * 3.6 : 0,
            rawDopplerSpeedMs,
            accuracyM:
              pos.coords.accuracy !== null && Number.isFinite(pos.coords.accuracy)
                ? Math.round(pos.coords.accuracy)
                : null,
            headingDeg:
              pos.coords.heading !== null && Number.isFinite(pos.coords.heading)
                ? Math.round(pos.coords.heading)
                : null,
            altitudeM:
              pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)
                ? Math.round(pos.coords.altitude)
                : null,
            timestampMs: pos.timestamp || Date.now(),
          });
        },
        (err) => {
          if (cancelled) return;
          setGpsActive(false);
          setGpsError(
            err.code === 1
              ? 'Localização bloqueada no navegador. Libere o GPS ou use o Simulador.'
              : 'Aguardando sinal GPS em área aberta (ou ative Simulador em ⚙️).'
          );
        },
        WEB_GPS_WATCH_OPTIONS
      );
    };

    startGps();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [isActive, source]);

  // Continuous External BLE GPS listener (RaceBox Mini/S 25Hz & NMEA-0183 10Hz)
  useEffect(() => {
    if (!isActive || source !== 'ble_gps') return;
    kalmanRef.current.reset();
    fixTimestampsRef.current = [];
    setMeasuredGpsHz(0);
    setZeroSpeedLocked(false);

    if (!extGps.connected && !extGps.connecting && extGps.savedDevice) {
      void reconnectSavedExternalGps();
    }

    const unsubscribe = subscribeExternalGpsFixes((fix) => {
      if (screenRef.current === 'survey') return;
      if (fix.imuAccel) {
        imuAccelRef.current = fix.imuAccel;
      }
      processIncomingFixRef.current({
        lat: fix.lat,
        lon: fix.lon,
        speedKmh: fix.speedKmh,
        rawDopplerSpeedMs: fix.rawDopplerSpeedMs,
        accuracyM: fix.accuracyM,
        headingDeg: fix.headingDeg,
        altitudeM: fix.altitudeM,
        timestampMs: fix.timestampMs,
        satellites: fix.satellites,
        imuAccel: fix.imuAccel,
      });
    });

    return () => {
      unsubscribe();
    };
  }, [isActive, source]);

  // 10 Hz Kalman + IMU Visual Speedometer & Trace Propagation (between 1 Hz fixes)
  useEffect(() => {
    if (!isActive || (source !== 'gps' && source !== 'ble_gps') || !gpsActive || screen !== 'live') {
      return;
    }
    const id = window.setInterval(() => {
      const pred = kalmanRef.current.predictAt10Hz(
        Date.now(),
        velPrefsRef.current.useDeviceImu ? imuAccelRef.current : null
      );
      if (!pred) return;
      setZeroSpeedLocked(pred.zeroSpeedLocked);
      setSpeedKmh(pred.speedKmh);
      setCurrentPos({ lat: pred.lat, lon: pred.lon });
    }, 100);
    return () => window.clearInterval(id);
  }, [isActive, source, gpsActive, screen]);

  // Simulator GPS engine
  const demoStage = useMemo(() => createDemoSpecialStage(), []);
  useEffect(() => {
    if (!isActive || source !== 'simulator' || !simPlaying || screen === 'survey') return;
    const path = demoStage.simWaypoints;
    const id = window.setInterval(() => {
      const idxFloat = simProgressRef.current;
      const idx0 = Math.floor(idxFloat);
      if (idx0 >= path.length - 1) {
        setSimPlaying(false);
        return;
      }
      const idx1 = idx0 + 1;
      const frac = idxFloat - idx0;
      const p0 = path[idx0];
      const p1 = path[idx1];
      const lat = p0.lat + (p1.lat - p0.lat) * frac;
      const lon = p0.lon + (p1.lon - p0.lon) * frac;
      const runVariance = trackRuns.length % 2 === 1 ? 1.07 : 0.96;
      const spd = Math.round((p0.speedKmh + (p1.speedKmh - p0.speedKmh) * frac) * runVariance);
      const alt = Math.round(p0.altM + (p1.altM - p0.altM) * frac);
      const hdg = bearingBetweenDeg(p0.lat, p0.lon, p1.lat, p1.lon);

      processIncomingFixRef.current({
        lat,
        lon,
        speedKmh: spd,
        accuracyM: 3,
        headingDeg: hdg,
        altitudeM: alt,
        timestampMs: Date.now(),
      });

      const segM = Math.max(10, haversineMetersVel(p0.lat, p0.lon, p1.lat, p1.lon));
      const mPerTick = (spd / 3.6) * 0.2 * simMultiplier;
      simProgressRef.current += mPerTick / segM;
    }, 200);

    return () => window.clearInterval(id);
  }, [isActive, source, simPlaying, simMultiplier, demoStage, trackRuns.length, screen]);

  const handleLoadDemoStage = () => {
    const existing = tracks.find((t) => t.id === demoStage.track.id);
    if (!existing) {
      setTracks((prev) => [demoStage.track, ...prev]);
    }
    setActiveTrackId(demoStage.track.id);
    setUserPickedTrackManually(true);
    setSource('simulator');
    setLiveMode('timer');
    setScreen('live');
    simProgressRef.current = 0;
    prevSampleRef.current = null;
    liveSamplesRef.current = [];
    stageStartMsRef.current = null;
    stageStateRef.current = 'armed';
    finishGateArmedRef.current = false;
    totalDistRef.current = 0;
    currentSplitTimesRef.current = {};
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setCurrentSplitTimesMs({});
    setStageStartMs(null);
    setLastFinishedMs(null);
    setStageState('armed');
    setIsRecording(false);
    setSimPlaying(true);
    showToast('Especial SS-01 armada no Simulador!');
  };

  const handleForceManualStart = () => {
    const now = Date.now();
    prevSampleRef.current = null;
    liveSamplesRef.current = [];
    stageStartMsRef.current = now;
    stageStateRef.current = 'running';
    finishGateArmedRef.current = true;
    totalDistRef.current = 0;
    maxSpeedRef.current = 0;
    currentSplitTimesRef.current = {};
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setMaxSpeedKmh(0);
    setCurrentSplitTimesMs({});
    setLastFinishedMs(null);
    setStageStartMs(now);
    setStageState('running');
    setPreStartModalOpen(false);
    setIsRecording(true);
    setScreen('live');
    if (source === 'simulator' && !simPlaying) {
      simProgressRef.current = 0;
      setSimPlaying(true);
    }
    void addGoProHiLightTag();
    window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
    showToast('Largada manual acionada! Cronômetro rodando.');
  };

  const handleStartOrArmStage = () => {
    if (!isPro) {
      openProUpgradeModal(
        'Especial / Circuito com Parciais e Delta Time',
        'A cronometragem de especiais com traps GPS, parciais e Delta Time em tempo real faz parte do Plano PRO. No Plano FREE use o Velocímetro / Hodômetro Básico e Levantamento.'
      );
      return;
    }
    if (stageState === 'running') {
      finishGateArmedRef.current = false;
      finalizeRun(Date.now(), undefined, false, false);
      return;
    }

    prevSampleRef.current = null;
    liveSamplesRef.current = [];
    totalDistRef.current = 0;
    maxSpeedRef.current = 0;
    currentSplitTimesRef.current = {};
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setMaxSpeedKmh(0);
    setCurrentSplitTimesMs({});
    setLastFinishedMs(null);
    setScreen('live');

    const hasStartTrap = activeTrack?.traps.some(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    if (hasStartTrap) {
      stageStartMsRef.current = null;
      stageStateRef.current = 'armed';
      finishGateArmedRef.current = false;
      setStageStartMs(null);
      setStageState('armed');
      setPreStartModalOpen(true);
      setIsRecording(false);
      if (source === 'simulator') {
        simProgressRef.current = 0;
        setSimPlaying(true);
      }
      showToast('Armado: aguardando cruzar linha de Largada');
    } else {
      const now = Date.now();
      stageStartMsRef.current = now;
      stageStateRef.current = 'running';
      finishGateArmedRef.current = true;
      setStageStartMs(now);
      setStageState('running');
      setPreStartModalOpen(false);
      setIsRecording(true);
      void addGoProHiLightTag();
      window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
      showToast('Cronômetro iniciado!');
    }
  };

  const applyTrackUpdateAndRecalc = useCallback(
    (trackId: string, updater: (t: VelocityTrack) => VelocityTrack) => {
      const target = tracksRef.current.find((t) => t.id === trackId);
      if (!target) return;
      const updatedTrack = updater(target);
      tracksRef.current = tracksRef.current.map((t) =>
        t.id === trackId ? updatedTrack : t
      );
      setTracks((prev) => prev.map((t) => (t.id === trackId ? updatedTrack : t)));
      setRuns((prevRuns) => recalculateRunsForTrack(updatedTrack, prevRuns));
    },
    []
  );

  const requestImmediateGpsPosition = useCallback(async (): Promise<{
    lat: number;
    lon: number;
  } | null> => {
    if (source === 'simulator' || source === 'ble_gps') {
      return currentPosRef.current;
    }
    try {
      if (Capacitor.isNativePlatform()) {
        const perm = await Geolocation.requestPermissions().catch(() => null);
        if (perm && perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          return currentPosRef.current;
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 6000,
          maximumAge: 3000,
        });
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setCurrentPos(coords);
        setGpsActive(true);
        setGpsError(null);
        if (pos.coords.accuracy !== null && Number.isFinite(pos.coords.accuracy)) {
          setGpsAccuracyM(Math.round(pos.coords.accuracy));
        }
        if (pos.coords.heading !== null && Number.isFinite(pos.coords.heading)) {
          const h = Math.round(pos.coords.heading);
          setHeadingDeg(h);
          lastValidHeadingRef.current = h;
        }
        if (pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)) {
          setAltitudeM(Math.round(pos.coords.altitude));
        }
        saveLastGpsPos(coords.lat, coords.lon);
        return coords;
      }

      if ('geolocation' in navigator) {
        return await new Promise<{ lat: number; lon: number } | null>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
              setCurrentPos(coords);
              setGpsActive(true);
              setGpsError(null);
              if (pos.coords.accuracy !== null && Number.isFinite(pos.coords.accuracy)) {
                setGpsAccuracyM(Math.round(pos.coords.accuracy));
              }
              if (pos.coords.heading !== null && Number.isFinite(pos.coords.heading)) {
                const h = Math.round(pos.coords.heading);
                setHeadingDeg(h);
                lastValidHeadingRef.current = h;
              }
              if (pos.coords.altitude !== null && Number.isFinite(pos.coords.altitude)) {
                setAltitudeM(Math.round(pos.coords.altitude));
              }
              saveLastGpsPos(coords.lat, coords.lon);
              resolve(coords);
            },
            () => resolve(currentPosRef.current),
            { enableHighAccuracy: true, timeout: 6000, maximumAge: 3000 }
          );
        });
      }
    } catch {
      // Ignore geolocation lookup failure
    }
    return currentPosRef.current;
  }, [source]);

  useEffect(() => {
    if (!isActive) return;
    if ((screen === 'track-editor' || gpsMappingOpen) && source === 'gps') {
      void requestImmediateGpsPosition();
    }
  }, [isActive, screen, gpsMappingOpen, source, requestImmediateGpsPosition]);

  const handleCreateNewTrack = () => {
    const name = newTrackName.trim() || `Pista ${tracks.length + 1}`;
    const newTrack: VelocityTrack = {
      id: `trk_${Date.now()}`,
      name,
      mode: newTrackMode,
      traps: [],
      createdAtMs: Date.now(),
      referenceDistanceKm: 0,
    };
    setTracks((prev) => [newTrack, ...prev]);
    setActiveTrackId(newTrack.id);
    setUserPickedTrackManually(true);
    setNewTrackName('');
    setShowNewTrackModal(false);
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    finishGateArmedRef.current = false;
    stageStartMsRef.current = null;
    stageStateRef.current = 'idle';
    setStageState('idle');
    setIsRecording(false);
    setPlacementKind(newTrackMode === 'circuit' ? 'start_finish' : 'start');
    setSelectedTrapId(null);
    setScreen('track-editor');
    void requestImmediateGpsPosition();
    showToast(`Pista "${name}" aberta no mapa.`);
  };

  const buildTrapName = (track: VelocityTrack, kind: TrapKind) => {
    const splitCount = track.traps.filter((t) => t.kind === 'split').length;
    if (kind === 'start') return 'Largada (Start)';
    if (kind === 'start_finish') return 'Largada / Chegada';
    if (kind === 'finish') return 'Chegada (Finish)';
    return `Parcial ${splitCount + 1}`;
  };

  const handlePlaceTrapFromMap = useCallback(
    (lat: number, lon: number, kindOverride?: TrapKind) => {
      const targetKind = kindOverride ?? placementKind;
      if (!targetKind) return;

      let targetTrack = activeTrack;
      if (!targetTrack) {
        const created: VelocityTrack = {
          id: `trk_${Date.now()}`,
          name: mapTrackNameDraft.trim() || `Pista ${tracks.length + 1}`,
          mode: targetKind === 'start_finish' ? 'circuit' : 'point-to-point',
          traps: [],
          createdAtMs: Date.now(),
          referenceDistanceKm: 0,
        };
        tracksRef.current = [created, ...tracksRef.current];
        setTracks(tracksRef.current);
        setActiveTrackId(created.id);
        targetTrack = created;
      }

      const lastExisting = targetTrack.traps[targetTrack.traps.length - 1];
      const traceBearing = inferNearestBaseTraceBearing(lat, lon, targetTrack.baseTrace);
      const hasValidHeading = headingDeg !== null && speedKmh >= 3;
      const inferredBearing =
        draftBearingDeg > 0
          ? draftBearingDeg
          : traceBearing !== null
            ? traceBearing
            : lastExisting
              ? bearingBetweenDeg(lastExisting.lat, lastExisting.lon, lat, lon)
              : hasValidHeading
                ? headingDeg!
                : 0;
      const effectiveUnidirectional =
        inferredBearing === 0 && !hasValidHeading && traceBearing === null && !lastExisting
          ? false
          : newTrapUnidirectional;

      const trapLabel = buildTrapName(targetTrack, targetKind);
      const newTrap: VelocityTrap = {
        id: `trap_${targetKind}_${Date.now()}`,
        name: trapLabel,
        kind: targetKind,
        lat,
        lon,
        bearingDeg: inferredBearing,
        widthM: newTrapWidthM,
        unidirectional: effectiveUnidirectional,
      };

      const isSingleGate =
        targetKind === 'start' || targetKind === 'finish' || targetKind === 'start_finish';

      applyTrackUpdateAndRecalc(targetTrack.id, (t) => {
        const filtered = isSingleGate
          ? t.traps.filter((existing) => existing.kind !== targetKind)
          : t.traps;
        return {
          ...t,
          mode: targetKind === 'start_finish' ? 'circuit' : t.mode,
          traps: [...filtered, newTrap],
        };
      });
      setSelectedTrapId(newTrap.id);
      setPlacementKind(null);
      showToast(
        `${trapLabel} posicionado (${inferredBearing.toFixed(1)}° · ${newTrapWidthM}m · ${effectiveUnidirectional ? 'Unidir.' : 'Bidir.'}).`
      );
    },
    [
      activeTrack,
      tracks.length,
      mapTrackNameDraft,
      placementKind,
      draftBearingDeg,
      headingDeg,
      speedKmh,
      newTrapWidthM,
      newTrapUnidirectional,
      applyTrackUpdateAndRecalc,
      showToast,
    ]
  );

  const handleDropTrapAtPosition = (kind: TrapKind, sampleOverride?: VelocitySample) => {
    let targetTrack = activeTrack;
    if (!targetTrack) {
      const created: VelocityTrack = {
        id: `trk_${Date.now()}`,
        name: mapTrackNameDraft.trim() || `Pista ${tracks.length + 1}`,
        mode: kind === 'start_finish' ? 'circuit' : 'point-to-point',
        traps: [],
        createdAtMs: Date.now(),
        referenceDistanceKm: 0,
      };
      tracksRef.current = [created, ...tracksRef.current];
      setTracks(tracksRef.current);
      setActiveTrackId(created.id);
      targetTrack = created;
    }

    const pos =
      sampleOverride ??
      (currentPos
        ? {
            lat: currentPos.lat,
            lon: currentPos.lon,
            headingDeg: headingDeg !== null && speedKmh >= 3 ? headingDeg : null,
          }
        : null);

    if (!pos) {
      setPlacementKind(kind);
      setScreen('track-editor');
      showToast('Sem GPS: segure 0,4s no mapa satélite para posicionar o Marco.');
      return;
    }

    const traceBearing = inferNearestBaseTraceBearing(
      pos.lat,
      pos.lon,
      targetTrack.baseTrace
    );
    const resolvedBearing =
      pos.headingDeg !== null && pos.headingDeg !== undefined
        ? pos.headingDeg
        : draftBearingDeg > 0
          ? draftBearingDeg
          : traceBearing !== null
            ? traceBearing
            : 0;
    const effectiveUnidirectional =
      resolvedBearing === 0 && (pos.headingDeg === null || pos.headingDeg === undefined) && traceBearing === null
        ? false
        : newTrapUnidirectional;

    const trapLabel = buildTrapName(targetTrack, kind);
    const newTrap: VelocityTrap = {
      id: `trap_${kind}_${Date.now()}`,
      name: trapLabel,
      kind,
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: resolvedBearing,
      widthM: newTrapWidthM,
      unidirectional: effectiveUnidirectional,
    };

    const isSingleGate =
      kind === 'start' || kind === 'finish' || kind === 'start_finish';

    applyTrackUpdateAndRecalc(targetTrack.id, (t) => {
      const filtered = isSingleGate
        ? t.traps.filter((existing) => existing.kind !== kind)
        : t.traps;
      return {
        ...t,
        mode: kind === 'start_finish' ? 'circuit' : t.mode,
        traps: [...filtered, newTrap],
      };
    });
    setSelectedTrapId(newTrap.id);
    setPlacementKind(null);
    showToast(
      `${trapLabel} marcado (${resolvedBearing.toFixed(1)}° · ${newTrapWidthM}m · ${effectiveUnidirectional ? 'Unidir.' : 'Bidir.'})!`
    );
  };

  const handleDragTrapEnd = useCallback(
    (trapId: string, lat: number, lon: number) => {
      if (!activeTrack) return;
      applyTrackUpdateAndRecalc(activeTrack.id, (t) => ({
        ...t,
        traps: t.traps.map((tr) => (tr.id === trapId ? { ...tr, lat, lon } : tr)),
      }));
      showToast('Posição do Marco ajustada.');
    },
    [activeTrack, applyTrackUpdateAndRecalc, showToast]
  );

  const handleUpdateTrapProps = useCallback(
    (trapId: string, patch: Partial<VelocityTrap>) => {
      if (!activeTrack) return;
      applyTrackUpdateAndRecalc(activeTrack.id, (t) => ({
        ...t,
        traps: t.traps.map((tr) => (tr.id === trapId ? { ...tr, ...patch } : tr)),
      }));
    },
    [activeTrack, applyTrackUpdateAndRecalc]
  );

  const handleChangeTrapKind = useCallback(
    (trapId: string, nextKind: TrapKind) => {
      if (!activeTrack) return;
      const splitCount = activeTrack.traps.filter(
        (t) => t.kind === 'split' && t.id !== trapId
      ).length;
      const nextName =
        nextKind === 'start'
          ? 'Largada (Start)'
          : nextKind === 'finish'
            ? 'Chegada (Finish)'
            : nextKind === 'start_finish'
              ? 'Largada / Chegada'
              : `Parcial ${splitCount + 1}`;
      const isSingleGate =
        nextKind === 'start' || nextKind === 'finish' || nextKind === 'start_finish';

      applyTrackUpdateAndRecalc(activeTrack.id, (t) => ({
        ...t,
        mode: nextKind === 'start_finish' ? 'circuit' : t.mode,
        traps: t.traps
          .filter((tr) => tr.id === trapId || !isSingleGate || tr.kind !== nextKind)
          .map((tr) =>
            tr.id === trapId ? { ...tr, kind: nextKind, name: nextName } : tr
          ),
      }));
    },
    [activeTrack, applyTrackUpdateAndRecalc]
  );

  const handleRemoveTrap = (trapId: string) => {
    if (!activeTrack) return;
    applyTrackUpdateAndRecalc(activeTrack.id, (t) => ({
      ...t,
      traps: t.traps.filter((tr) => tr.id !== trapId),
    }));
    if (selectedTrapId === trapId) setSelectedTrapId(null);
  };

  const handleRotateTrap = (trapId: string, deltaDeg: number) => {
    if (!activeTrack) return;
    applyTrackUpdateAndRecalc(activeTrack.id, (t) => ({
      ...t,
      traps: t.traps.map((tr) =>
        tr.id === trapId
          ? {
              ...tr,
              bearingDeg: Number((((tr.bearingDeg + deltaDeg) % 360) + 360) % 360),
            }
          : tr
      ),
    }));
  };

  const handleSaveCurrentTrackToLibrary = async () => {
    const cleanName = mapTrackNameDraft.trim() || activeTrack?.name || `Pista ${tracks.length + 1}`;
    let savedTrack: VelocityTrack;

    if (!activeTrack) {
      savedTrack = {
        id: `trk_${Date.now()}`,
        name: cleanName,
        mode: newTrackMode,
        traps: [],
        createdAtMs: Date.now(),
        referenceDistanceKm: 0,
      };
      const nextTracks = [savedTrack, ...tracksRef.current];
      tracksRef.current = nextTracks;
      setTracks(nextTracks);
      setActiveTrackId(savedTrack.id);
      await persistVelocityTracks(nextTracks);
      saveActiveVelocityTrackId(savedTrack.id);
    } else {
      const ordered = getOrderedTrackTraps(activeTrack);
      let computedDistKm = activeTrack.referenceDistanceKm;
      if (
        (!activeTrack.baseTrace || activeTrack.baseTrace.length < 2) &&
        ordered.length >= 2
      ) {
        let sumM = 0;
        for (let i = 1; i < ordered.length; i += 1) {
          sumM += haversineMetersVel(
            ordered[i - 1].lat,
            ordered[i - 1].lon,
            ordered[i].lat,
            ordered[i].lon
          );
        }
        computedDistKm = Number((sumM / 1000).toFixed(3));
      } else if (liveSamples.length > 1) {
        computedDistKm = Number(
          liveSamples[liveSamples.length - 1].distKm.toFixed(3)
        );
      }

      savedTrack = {
        ...activeTrack,
        name: cleanName,
        referenceDistanceKm: computedDistKm,
        baseTrace:
          activeTrack.baseTrace && activeTrack.baseTrace.length > 1
            ? activeTrack.baseTrace
            : liveSamples.length > 1
              ? liveSamples
              : activeTrack.baseTrace,
      };
      const nextTracks = tracksRef.current.map((t) =>
        t.id === savedTrack.id ? savedTrack : t
      );
      tracksRef.current = nextTracks;
      setTracks(nextTracks);
      await persistVelocityTracks(nextTracks);
      saveActiveVelocityTrackId(savedTrack.id);
    }

    setPlacementKind(null);
    setJustSavedTrack(true);
    window.setTimeout(() => setJustSavedTrack(false), 2200);
    showToast(`Pista "${savedTrack.name}" salva (${savedTrack.traps.length} marcos)!`);
    void uploadVelocityTrackToCloud(savedTrack);
  };

  const triggerMappingFeedback = useCallback((msg: string) => {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([45, 25, 45]);
      }
    } catch {
      // Ignore vibration errors
    }
    setGpsMappingPulse(msg);
    window.setTimeout(() => {
      setGpsMappingPulse((curr) => (curr === msg ? null : curr));
    }, 2600);
  }, []);

  const ensureMappingTrack = useCallback((): VelocityTrack => {
    const existing =
      tracksRef.current.find((t) => t.id === gpsMappingTrackIdRef.current) ?? activeTrack;
    if (existing) {
      gpsMappingTrackIdRef.current = existing.id;
      return existing;
    }
    const cleanName = mapTrackNameDraft.trim() || `Especial ${tracksRef.current.length + 1}`;
    const created: VelocityTrack = {
      id: `trk_${Date.now()}`,
      name: cleanName,
      mode: 'point-to-point',
      traps: [],
      createdAtMs: Date.now(),
      referenceDistanceKm: 0,
    };
    const nextTracks = [created, ...tracksRef.current];
    tracksRef.current = nextTracks;
    setTracks(nextTracks);
    setActiveTrackId(created.id);
    setUserPickedTrackManually(true);
    gpsMappingTrackIdRef.current = created.id;
    return created;
  }, [activeTrack, mapTrackNameDraft]);

  const resolveMappingBearing = useCallback(
    (lat: number, lon: number): { bearing: number; stationaryFallback: boolean } => {
      if (headingDeg !== null && speedKmh >= 2) {
        return { bearing: headingDeg, stationaryFallback: false };
      }
      const trace = gpsMappingTraceRef.current;
      for (let i = trace.length - 1; i >= 0; i -= 1) {
        const pt = trace[i];
        const d = haversineMetersVel(pt.lat, pt.lon, lat, lon);
        if (d >= 5) {
          return {
            bearing: Math.round(bearingBetweenDeg(pt.lat, pt.lon, lat, lon)),
            stationaryFallback: false,
          };
        }
      }
      if (lastValidHeadingRef.current !== null) {
        return { bearing: lastValidHeadingRef.current, stationaryFallback: false };
      }
      return { bearing: 0, stationaryFallback: true };
    },
    [headingDeg, speedKmh]
  );

  const handleOpenGpsMapping = () => {
    const track = ensureMappingTrack();
    gpsMappingTrackIdRef.current = track.id;
    gpsMappingStartNeedsBearingRef.current = false;
    gpsMappingTraceRef.current = [];
    setGpsMappingTrace([]);
    setGpsMappingPhase('ready');
    setGpsMappingPulse(null);
    setPlacementKind(null);
    setGpsMappingOpen(true);
    void requestImmediateGpsPosition();
  };

  const handleMappingMarkStart = async () => {
    const pos = currentPosRef.current ?? (await requestImmediateGpsPosition());
    if (!pos) {
      triggerMappingFeedback('Aguardando sinal GPS...');
      showToast('Aguardando sinal GPS para marcar a Largada.');
      return;
    }
    const track = ensureMappingTrack();
    const { bearing, stationaryFallback } = resolveMappingBearing(pos.lat, pos.lon);
    gpsMappingStartNeedsBearingRef.current = stationaryFallback;

    const nowMs = Date.now();
    const startSample: VelocitySample = {
      lat: pos.lat,
      lon: pos.lon,
      speedKmh,
      accuracyM: gpsAccuracyM,
      headingDeg: stationaryFallback ? null : bearing,
      altitudeM,
      timestampMs: nowMs,
      distKm: 0,
      stageElapsedMs: 0,
    };

    const startTrap: VelocityTrap = {
      id: `trap_start_${nowMs}`,
      name: 'Largada (Start)',
      kind: 'start',
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: bearing,
      widthM: newTrapWidthM,
      unidirectional: true,
    };

    applyTrackUpdateAndRecalc(track.id, (t) => ({
      ...t,
      mode: 'point-to-point',
      traps: [startTrap],
      baseTrace: undefined,
      referenceDistanceKm: 0,
    }));
    setSelectedTrapId(startTrap.id);
    gpsMappingTraceRef.current = [startSample];
    setGpsMappingTrace([startSample]);
    setGpsMappingPhase('recording');
    triggerMappingFeedback(`Largada (L) marcada · ${bearing.toFixed(0)}°`);
  };

  const handleMappingMarkSplit = async () => {
    const pos = currentPosRef.current ?? (await requestImmediateGpsPosition());
    if (!pos) {
      triggerMappingFeedback('Aguardando sinal GPS...');
      return;
    }
    const track = ensureMappingTrack();
    const { bearing } = resolveMappingBearing(pos.lat, pos.lon);
    const nowMs = Date.now();

    const currTrace = gpsMappingTraceRef.current;
    const lastPt = currTrace[currTrace.length - 1];
    const stepM = lastPt ? haversineMetersVel(lastPt.lat, lastPt.lon, pos.lat, pos.lon) : 0;
    if (!lastPt || stepM >= 1) {
      const nextDist = lastPt ? lastPt.distKm + stepM / 1000 : 0;
      const elapsed = lastPt ? Math.max(0, nowMs - currTrace[0].timestampMs) : 0;
      const splitSample: VelocitySample = {
        lat: pos.lat,
        lon: pos.lon,
        speedKmh,
        accuracyM: gpsAccuracyM,
        headingDeg: bearing,
        altitudeM,
        timestampMs: nowMs,
        distKm: nextDist,
        stageElapsedMs: elapsed,
      };
      const updated = [...currTrace, splitSample];
      gpsMappingTraceRef.current = updated;
      setGpsMappingTrace(updated);
    }

    const splitCount = track.traps.filter((t) => t.kind === 'split').length;
    const nextNum = splitCount + 1;
    const splitTrap: VelocityTrap = {
      id: `trap_split_${nowMs}_${nextNum}`,
      name: `Parcial ${nextNum}`,
      kind: 'split',
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: bearing,
      widthM: newTrapWidthM,
      unidirectional: true,
    };

    applyTrackUpdateAndRecalc(track.id, (t) => ({
      ...t,
      traps: [...t.traps, splitTrap],
    }));
    setSelectedTrapId(splitTrap.id);
    triggerMappingFeedback(`Parcial P${nextNum} marcada!`);
  };

  const handleMappingMarkFinish = async () => {
    const pos = currentPosRef.current ?? (await requestImmediateGpsPosition());
    if (!pos) {
      triggerMappingFeedback('Aguardando sinal GPS...');
      return;
    }
    const track = ensureMappingTrack();
    const { bearing } = resolveMappingBearing(pos.lat, pos.lon);
    const nowMs = Date.now();

    const currTrace = gpsMappingTraceRef.current;
    const lastPt = currTrace[currTrace.length - 1];
    const stepM = lastPt ? haversineMetersVel(lastPt.lat, lastPt.lon, pos.lat, pos.lon) : 0;
    let finalTrace = currTrace;
    if (!lastPt || stepM >= 0.5) {
      const nextDist = lastPt ? lastPt.distKm + stepM / 1000 : 0;
      const elapsed = lastPt ? Math.max(0, nowMs - currTrace[0].timestampMs) : 0;
      const finishSample: VelocitySample = {
        lat: pos.lat,
        lon: pos.lon,
        speedKmh,
        accuracyM: gpsAccuracyM,
        headingDeg: bearing,
        altitudeM,
        timestampMs: nowMs,
        distKm: nextDist,
        stageElapsedMs: elapsed,
      };
      finalTrace = [...currTrace, finishSample];
      gpsMappingTraceRef.current = finalTrace;
      setGpsMappingTrace(finalTrace);
    }

    const traceDistKm =
      finalTrace.length > 1
        ? Number(finalTrace[finalTrace.length - 1].distKm.toFixed(3))
        : 0;

    const finishTrap: VelocityTrap = {
      id: `trap_finish_${nowMs}`,
      name: 'Chegada (Finish)',
      kind: 'finish',
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: bearing,
      widthM: newTrapWidthM,
      unidirectional: true,
    };

    applyTrackUpdateAndRecalc(track.id, (t) => ({
      ...t,
      mode: 'point-to-point',
      traps: [...t.traps.filter((tr) => tr.kind !== 'finish'), finishTrap],
      baseTrace: finalTrace.length > 1 ? finalTrace : t.baseTrace,
      referenceDistanceKm: traceDistKm > 0 ? traceDistKm : t.referenceDistanceKm,
    }));
    setSelectedTrapId(finishTrap.id);
    setGpsMappingPhase('finished');
    triggerMappingFeedback(
      `Chegada (C) marcada! ${traceDistKm > 0 ? `${traceDistKm.toFixed(2)} km` : ''}`
    );
  };

  const handleMappingSaveTrack = async (closeAfterSave = false) => {
    const track = ensureMappingTrack();
    const cleanName = mapTrackNameDraft.trim() || track.name || `Especial ${tracks.length}`;
    const mappedTrace = gpsMappingTraceRef.current;
    let computedDistKm = track.referenceDistanceKm;
    if (mappedTrace.length > 1) {
      computedDistKm = Number(mappedTrace[mappedTrace.length - 1].distKm.toFixed(3));
    } else if (track.traps.length >= 2) {
      const ordered = getOrderedTrackTraps(track);
      let sumM = 0;
      for (let i = 1; i < ordered.length; i += 1) {
        sumM += haversineMetersVel(
          ordered[i - 1].lat,
          ordered[i - 1].lon,
          ordered[i].lat,
          ordered[i].lon
        );
      }
      computedDistKm = Number((sumM / 1000).toFixed(3));
    }

    const savedTrack: VelocityTrack = {
      ...track,
      name: cleanName,
      referenceDistanceKm: computedDistKm,
      baseTrace: mappedTrace.length > 1 ? mappedTrace : track.baseTrace,
    };

    const nextTracks = tracksRef.current.map((t) =>
      t.id === savedTrack.id ? savedTrack : t
    );
    tracksRef.current = nextTracks;
    setTracks(nextTracks);
    await persistVelocityTracks(nextTracks);
    saveActiveVelocityTrackId(savedTrack.id);

    setJustSavedTrack(true);
    window.setTimeout(() => setJustSavedTrack(false), 2200);
    triggerMappingFeedback(`Pista "${cleanName}" salva!`);
    showToast(`Pista "${cleanName}" salva (${savedTrack.traps.length} marcos)!`);
    void uploadVelocityTrackToCloud(savedTrack);
    if (closeAfterSave) {
      setGpsMappingOpen(false);
    }
  };

  const handleDuplicateTrack = (track: VelocityTrack) => {
    const copyId = `trk_${Date.now()}`;
    const copyName = `${track.name} (Cópia)`;
    const cloned: VelocityTrack = {
      ...track,
      id: copyId,
      name: copyName,
      createdAtMs: Date.now(),
      traps: track.traps.map((tr) => ({ ...tr, id: `${tr.id}_c_${Date.now()}` })),
      baseTrace: track.baseTrace ? [...track.baseTrace] : undefined,
    };
    setTracks((prev) => [cloned, ...prev]);
    setActiveTrackId(copyId);
    showToast(`Cópia salva: "${copyName}"`);
  };

  const handleDeleteTrack = (trackId: string) => {
    const remaining = tracks.filter((t) => t.id !== trackId);
    setTracks(remaining);
    setRuns((prev) => prev.filter((r) => r.trackId !== trackId));
    if (activeTrackId === trackId) {
      setActiveTrackId(remaining[0]?.id ?? '');
      finishGateArmedRef.current = false;
      stageStateRef.current = 'idle';
      stageStartMsRef.current = null;
      setStageState('idle');
      setStageStartMs(null);
      setLastFinishedMs(null);
      setCurrentSplitTimesMs({});
    }
    showToast('Pista excluída.');
  };

  const handleCommitRenameTrack = (trackId: string) => {
    const clean = editingTrackName.trim();
    if (!clean) {
      setEditingTrackId(null);
      return;
    }
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, name: clean } : t)));
    setEditingTrackId(null);
    showToast(`Nome atualizado para "${clean}"`);
  };

  const mergeRallyWaypoints = useCallback((incoming: GeoWaypoint[]) => {
    if (!incoming || incoming.length === 0) return;
    setRallyWaypoints((prev) => {
      const byName = new Map<string, GeoWaypoint>();
      for (const wp of prev) byName.set(wp.name.trim().toLowerCase(), wp);
      for (const wp of incoming) byName.set(wp.name.trim().toLowerCase(), wp);
      return Array.from(byName.values());
    });
  }, []);

  const finalizeImportedTracks = (
    finalTracks: VelocityTrack[],
    waypoints: GeoWaypoint[]
  ) => {
    if (waypoints.length > 0) {
      mergeRallyWaypoints(waypoints);
    }
    if (finalTracks.length === 0) return;
    const cleanedTracks: VelocityTrack[] = finalTracks.map((trk) => {
      const { detectedSplitPoints: _unused, ...rest } = trk;
      return rest;
    });

    setTracks((prev) => [...cleanedTracks, ...prev]);
    setActiveTrackId(cleanedTracks[0].id);
    setUserPickedTrackManually(true);
    finishGateArmedRef.current = false;
    stageStateRef.current = 'idle';
    stageStartMsRef.current = null;
    setStageState('idle');
    setStageStartMs(null);
    setLastFinishedMs(null);
    setCurrentSplitTimesMs({});
    void uploadAllTracksToCloud(cleanedTracks);

    if (cleanedTracks.length >= 2) {
      const namesList = formatImportedTrackNamesList(
        cleanedTracks.map((t) => formatCleanTrackName(t.name))
      );
      const wpSuffix =
        waypoints.length > 0
          ? ` · ${waypoints.length} ponto${waypoints.length > 1 ? 's' : ''} no mapa`
          : '';
      setScreen('tracks');
      showToast(`${cleanedTracks.length} especiais importadas: ${namesList}${wpSuffix}`);
    } else {
      const single = cleanedTracks[0];
      setScreen('track-editor');
      showToast(
        `Especial "${formatCleanTrackName(single.name)}" importada (${single.referenceDistanceKm.toFixed(2)} km · ${single.traps.length} marcos)!`
      );
    }
  };

  const resolvePendingImportDecision = (mode: 'use-kml' | 'create-auto' | 'keep-lc') => {
    if (!pendingImportDecision || pendingImportDecision.decisionQueue.length === 0) return;
    const [current, ...remainingQueue] = pendingImportDecision.decisionQueue;

    const starts = current.traps.filter(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    const finishes = current.traps.filter((t) => t.kind === 'finish');

    let chosenSplits: VelocityTrap[] = [];
    if (mode === 'use-kml') {
      chosenSplits = convertDetectedPointsToSplitTraps(
        current,
        current.detectedSplitPoints ?? []
      );
    } else if (mode === 'create-auto') {
      chosenSplits = generateEqualSplitTraps(current, [0.2, 0.4, 0.6, 0.8]);
    }

    const resolvedTrack: VelocityTrack = ensureAutoTrapsFromBaseTrace({
      ...current,
      traps: [...starts, ...chosenSplits, ...finishes],
      detectedSplitPoints: undefined,
    });

    const nextReady = [...pendingImportDecision.readyTracks, resolvedTrack];
    if (remainingQueue.length > 0) {
      setPendingImportDecision({
        readyTracks: nextReady,
        decisionQueue: remainingQueue,
        waypoints: pendingImportDecision.waypoints,
        totalCount: pendingImportDecision.totalCount,
      });
    } else {
      const wps = pendingImportDecision.waypoints;
      setPendingImportDecision(null);
      finalizeImportedTracks(nextReady, wps);
    }
  };

  const handleImportGeoFile = async (file: File) => {
    try {
      const geoResult = await parseTrackFileToGeoResult(file);
      if (geoResult.waypoints.length > 0) {
        mergeRallyWaypoints(geoResult.waypoints);
      }
      if (geoResult.tracks.length === 0) {
        if (geoResult.waypoints.length > 0) {
          const wpNames = formatImportedTrackNamesList(
            geoResult.waypoints.map((w) => w.name)
          );
          showToast(
            `${geoResult.waypoints.length} ponto(s) de apoio salvos para navegação (${wpNames}).`
          );
          return;
        }
        throw new Error('Nenhuma especial válida encontrada no arquivo.');
      }

      const importedTracks: VelocityTrack[] = geoResult.tracks.map((trk) => {
        const withTraps = ensureAutoTrapsFromBaseTrace(trk);
        return geoResult.waypoints.length > 0 && !withTraps.waypoints
          ? { ...withTraps, waypoints: geoResult.waypoints }
          : withTraps;
      });

      const readyTracks: VelocityTrack[] = [];
      const decisionQueue: VelocityTrack[] = [];

      for (const trk of importedTracks) {
        const hasExplicitSplits = trk.traps.some((t) => t.kind === 'split');
        const hasDetectedCandidates = (trk.detectedSplitPoints?.length ?? 0) > 0;
        const isLongEnough = trk.referenceDistanceKm > 0.5;
        if (!hasExplicitSplits && (hasDetectedCandidates || isLongEnough)) {
          decisionQueue.push(trk);
        } else {
          readyTracks.push(trk);
        }
      }

      if (decisionQueue.length > 0) {
        setPendingImportDecision({
          readyTracks,
          decisionQueue,
          waypoints: geoResult.waypoints,
          totalCount: importedTracks.length,
        });
        return;
      }

      finalizeImportedTracks(readyTracks, geoResult.waypoints);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '';
      showToast(
        detail || 'Não foi possível ler o arquivo .KML, .KMZ, .GPX ou .GeoJSON.'
      );
    }
  };

  const handleExportTrack = (fmt: 'geojson' | 'gpx') => {
    if (!activeTrack) return;
    const trace =
      liveSamples.length > 1
        ? liveSamples
        : lastRun?.samples && lastRun.samples.length > 1
          ? lastRun.samples
          : activeTrack.baseTrace ?? [];
    const content =
      fmt === 'geojson'
        ? exportTrackGeoJson(activeTrack, trace)
        : exportTrackGpx(activeTrack, trace);
    const slug = activeTrack.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const blob = new Blob([content], {
      type: fmt === 'geojson' ? 'application/geo+json' : 'application/gpx+xml',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const orderedTraps = useMemo(
    () => (activeTrack ? getOrderedTrackTraps(activeTrack) : []),
    [activeTrack]
  );

  const trackTrapSummary = useMemo(() => {
    const hasStart = orderedTraps.some(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    const hasFinish = orderedTraps.some(
      (t) => t.kind === 'finish' || t.kind === 'start_finish'
    );
    const splitsCount = orderedTraps.filter((t) => t.kind === 'split').length;
    return { hasStart, hasFinish, splitsCount };
  }, [orderedTraps]);

  const editableTrace = useMemo(() => {
    if (liveSamples.length > 1) return liveSamples;
    if (lastRun && lastRun.samples.length > 1) return lastRun.samples;
    if (activeTrack?.baseTrace && activeTrack.baseTrace.length > 1) {
      return activeTrack.baseTrace;
    }
    return [];
  }, [liveSamples, lastRun, activeTrack]);

  useEffect(() => {
    if (postEditIdx >= editableTrace.length) {
      setPostEditIdx(Math.max(0, editableTrace.length - 1));
    }
  }, [editableTrace.length, postEditIdx]);

  const displayedTripKm =
    tripRegressive && tripTargetKm !== null
      ? Math.max(0, tripTargetKm - tripDistKm)
      : tripDistKm;

  const satCount =
    source === 'ble_gps' && extGps.satellites !== null
      ? extGps.satellites
      : estimateSatellites(gpsAccuracyM, gpsActive);
  const effectiveGpsHz = source === 'ble_gps' ? extGps.measuredHz || measuredGpsHz : measuredGpsHz;
  const gpsSourceShort =
    source === 'ble_gps'
      ? extGps.protocol === 'RaceBox 25Hz'
        ? 'RaceBox'
        : extGps.protocol || 'BLE'
      : 'Interno';
  const gpsStatusLabel =
    source === 'simulator'
      ? `${effectiveGpsHz || 5} Hz SIM ${simMultiplier}x`
      : gpsActive
        ? `${effectiveGpsHz || 1} Hz ${gpsSourceShort} · ${satCount} SAT${gpsAccuracyM !== null ? ` ±${gpsAccuracyM}m` : ''}`
        : source === 'ble_gps'
          ? extGps.connecting
            ? 'BLE Conectando...'
            : 'BLE GPS'
          : 'GPS';
  const liveCompactGpsLabel =
    source === 'simulator'
      ? `${effectiveGpsHz || 5}Hz SIM`
      : gpsActive
        ? `${effectiveGpsHz || 1}Hz ${gpsSourceShort} · ${satCount}SAT${gpsAccuracyM !== null ? ` ±${gpsAccuracyM}m` : ''}`
        : source === 'ble_gps'
          ? 'BLE GPS'
          : 'GPS';

  // Open Post-Session Analysis Detail (100% Pure Offline Telemetry)
  const openSessionDetail = (trackId: string, initialTab: 'analysis' | 'video' = 'analysis') => {
    const sRuns = runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    setSelectedSessionTrackId(trackId);
    const best = [...sRuns].sort((a, b) => a.totalMs - b.totalMs)[0];
    const last = sRuns[sRuns.length - 1];
    const lap1Choice = best || last;
    const lap2Choice = sRuns.find((r) => r.id !== lap1Choice?.id) ?? null;
    const lap3Choice =
      sRuns.find((r) => r.id !== lap1Choice?.id && r.id !== lap2Choice?.id) ?? null;
    setLap1Id(lap1Choice?.id || '');
    setLap2Id(lap2Choice?.id || '');
    setLap3Id(lap3Choice?.id || '');
    setDetailTab(initialTab);
    setScreen('session-detail');
  };

  const handleOpenQuickAnalysis = () => {
    if (!isPro) {
      openProUpgradeModal(
        'Datalogger & Telemetria de 3 Voltas',
        'Comparativo de 3 voltas, forças G, mapa de calor e Vídeo Overlay HUD estão disponíveis no Plano PRO.'
      );
      return;
    }
    if (groupedSessions.length > 0) {
      const targetId =
        activeTrack && groupedSessions.some((g) => g.trackId === activeTrack.id)
          ? activeTrack.id
          : groupedSessions[0].trackId;
      openSessionDetail(targetId, 'analysis');
    } else {
      setScreen('sessions');
      showToast('Grave uma sessão ou rode a Demo SS-01 para abrir a Análise.');
    }
  };

  const sessionTrack = useMemo(
    () => tracks.find((t) => t.id === selectedSessionTrackId) ?? null,
    [tracks, selectedSessionTrackId]
  );

  const sessionRuns = useMemo(() => {
    if (!selectedSessionTrackId) return [];
    return runs
      .filter((r) => r.trackId === selectedSessionTrackId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }, [runs, selectedSessionTrackId]);

  const sessionOptimal = useMemo(() => {
    if (!sessionTrack) {
      return {
        optimalTotalMs: null,
        bestRunTotalMs: null,
        bestRunId: null,
        lastRunTotalMs: null,
        sectors: [],
      };
    }
    return computeOptimalStage(sessionTrack, sessionRuns);
  }, [sessionTrack, sessionRuns]);

  const lap1 = useMemo(
    () => sessionRuns.find((r) => r.id === lap1Id) ?? sessionRuns[0] ?? null,
    [sessionRuns, lap1Id]
  );

  const lap2 = useMemo(
    () => (lap2Id ? sessionRuns.find((r) => r.id === lap2Id) ?? null : null),
    [sessionRuns, lap2Id]
  );

  const lap3 = useMemo(
    () => (lap3Id ? sessionRuns.find((r) => r.id === lap3Id) ?? null : null),
    [sessionRuns, lap3Id]
  );

  const lap1Samples = useMemo(
    () => (lap1 ? ensureTraceGForces(lap1.samples) : []),
    [lap1]
  );

  const lap2Samples = useMemo(
    () => (lap2 ? ensureTraceGForces(lap2.samples) : []),
    [lap2]
  );

  const lap3Samples = useMemo(
    () => (lap3 ? ensureTraceGForces(lap3.samples) : []),
    [lap3]
  );


  const handleBackAction = () => {
    if (screen === 'track-editor') setScreen('tracks');
    else if (screen === 'session-detail') setScreen('sessions');
    else setScreen('home');
  };

  const screenTitleMap: Record<VelocityScreen, string> = {
    home: 'Velocidade',
    live: liveMode === 'timer' ? 'Cronômetro SS' : 'Mostradores',
    sessions: 'Sessões',
    'session-detail': sessionTrack ? formatCleanTrackName(sessionTrack.name) : 'Telemetria',
    tracks: 'Pistas',
    'track-editor': 'Editor de Pista',
    settings: 'Configurações GPS',
    odometer: 'Hodômetro',
    survey: 'Levantamento',
    satcron: 'Satcron Ao Vivo',
  };

  const hasAnyGoPro =
    goproFleet.cameras.length > 0 || goproFleet.savedDevices.length > 0;
  const activeGoProsReady = goproFleet.cameras.filter(
    (c) => c.connected && !c.sleeping
  );
  const recordingGoPros = goproFleet.cameras.filter(
    (c) => c.connected && !c.sleeping && c.recording
  );
  const recordingGoProCount = recordingGoPros.length;
  const savedMissingGoPros = goproFleet.savedDevices.filter(
    (sd) => !goproFleet.cameras.some((c) => c.id === sd.deviceId)
  );

  const renderLiveGoProCompactButton = () => {
    const isConnectedReady = activeGoProsReady.length > 0;
    const isRec = recordingGoProCount > 0;

    const handleOpenGoProModal = () => {
      if (!isPro) {
        openProUpgradeModal(
          'Automação de Câmeras GoPro BLE',
          'O controle e pareamento de câmeras GoPro via Bluetooth fazem parte do Plano PRO.'
        );
        return;
      }
      setShowGoProControlModal(true);
    };

    if (isRec) {
      return (
        <button
          type="button"
          onClick={handleOpenGoProModal}
          className="flex min-h-[48px] min-w-0 items-center justify-center gap-1.5 rounded-xl border-2 border-[#EF233C] bg-red-950/90 px-2.5 text-xs font-extrabold text-white uppercase shadow-[0_0_18px_rgba(239,35,60,0.45)] transition-all hover:brightness-110 active:scale-[0.98]"
          title="Abrir controles GoPro BLE"
        >
          <Camera className="h-3.5 w-3.5 shrink-0 text-[#EF233C]" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#FF2A2A] animate-pulse" />
          <span className="truncate font-mono tabular-nums">
            GOPRO ·{' '}
            {recordingGoPros.length === 1
              ? `1 REC ${formatGoProRecTimer(recordingGoPros[0].encodingDurationSec)}`
              : `${recordingGoProCount} REC`}
          </span>
        </button>
      );
    }

    if (isConnectedReady) {
      return (
        <button
          type="button"
          onClick={handleOpenGoProModal}
          className="flex min-h-[48px] min-w-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/60 bg-emerald-500/15 px-2.5 text-xs font-extrabold text-[var(--ps-text)] uppercase transition-all hover:border-emerald-400 active:scale-[0.98]"
          title="Abrir controles GoPro BLE"
        >
          <Camera className="h-3.5 w-3.5 shrink-0 text-[var(--ps-emerald)]" />
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ps-emerald)]" />
          <span className="truncate font-mono tabular-nums">
            GOPRO · {activeGoProsReady.length} OK
          </span>
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={handleOpenGoProModal}
        className="pitstop-btn-metal flex min-h-[48px] min-w-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-extrabold uppercase transition-all hover:border-[var(--ps-accent)] active:scale-[0.98]"
        title="Parear ou conectar GoPro via Bluetooth"
      >
        <Camera className="h-4 w-4 shrink-0 text-[var(--ps-danger)]" />
        <span className="truncate">
          GOPRO{!isPro ? ' (PRO)' : hasAnyGoPro ? ' · OFF' : ' · OFF'}
        </span>
      </button>
    );
  };

  const renderGoProBar = (forceShowInLive: boolean) => {
    if (!hasAnyGoPro && !forceShowInLive) return null;

    if (forceShowInLive) {
      const liveCamCount = goproFleet.cameras.length + savedMissingGoPros.length;
      const gridColsClass = liveCamCount >= 3 ? 'grid-cols-3' : 'grid-cols-2';

      return (
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-1.5 text-[var(--ps-text)] space-y-1 shrink-0 overflow-hidden">
          {goproFleet.errorMsg && (
            <div className="flex items-center justify-between gap-2 rounded border border-red-500/50 bg-red-500/15 px-2 py-1 text-[10px] font-semibold text-[var(--ps-danger)]">
              <span className="truncate">{goproFleet.errorMsg}</span>
              <button
                type="button"
                onClick={clearGoProFleetError}
                className="shrink-0 hover:opacity-75"
                aria-label="Fechar erro GoPro"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Linha 1: Comando Mestre Manual */}
          <div className="flex items-center gap-1.5">
            {hasAnyGoPro ? (
              <button
                type="button"
                onClick={() => {
                  if (!isPro) {
                    openProUpgradeModal(
                      'Automação de Câmeras GoPro BLE',
                      'O disparo multi-câmera via Bluetooth é um recurso exclusivo do Plano PRO.'
                    );
                    return;
                  }
                  void shutterAllGoPro(recordingGoProCount === 0);
                }}
                className={`inline-flex h-[36px] flex-1 items-center justify-center gap-2 rounded-lg px-3 font-mono text-xs font-black uppercase tracking-wide whitespace-nowrap transition-colors ${
                  recordingGoProCount > 0
                    ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)]'
                    : 'bg-[#E10600] text-white shadow-sm hover:brightness-110'
                }`}
              >
                {recordingGoProCount > 0 ? (
                  <>
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-[#FF2A2A] animate-pulse" />
                    <span>PARAR TODAS</span>
                  </>
                ) : (
                  <>
                    <span className="h-2.5 w-2.5 rounded-full bg-white" />
                    <span>GRAVAR TODAS {!isPro ? '(PRO)' : ''}</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!isPro) {
                    openProUpgradeModal(
                      'Automação de Câmeras GoPro BLE',
                      'O controle e pareamento de múltiplas câmeras GoPro via Bluetooth faz parte do Plano PRO.'
                    );
                    return;
                  }
                  setShowGoProControlModal(true);
                }}
                className="inline-flex h-[36px] flex-1 items-center justify-center gap-2 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-[11px] font-bold text-[var(--ps-muted)] uppercase hover:text-[var(--ps-text)]"
              >
                <Camera className="h-3.5 w-3.5 text-[#E10600]" />
                <span>Parear GoPro {!isPro ? '(PRO)' : ''}</span>
              </button>
            )}
          </div>

          {/* Linha 2: Câmeras Conectadas Lado a Lado em Grid Fixo (sem scroll horizontal) */}
          {hasAnyGoPro && (
            <div className={`grid ${gridColsClass} gap-1.5`}>
              {goproFleet.cameras.slice(0, 6).map((cam, idx) => {
                const fullLabel = getGoProDisplayName(cam) || `Cam ${idx + 1}`;
                const shortName = `Cam ${idx + 1}`;
                const asleep = cam.sleeping || !cam.connected;

                return (
                  <div
                    key={cam.id}
                    title={fullLabel}
                    className={`flex h-[34px] min-w-0 items-center justify-between gap-1 rounded-lg border px-2 ${
                      cam.recording
                        ? 'border-[#E10600]/80 bg-red-500/10'
                        : asleep
                          ? 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] opacity-80'
                          : 'border-[var(--ps-border)] bg-[var(--ps-card)]'
                    }`}
                  >
                    <div className="min-w-0 leading-tight font-mono">
                      <p className="truncate text-[10px] font-extrabold text-[var(--ps-text)]">
                        {shortName}
                      </p>
                      <p
                        className={`text-[9px] font-bold tabular-nums ${
                          cam.recording
                            ? 'text-[var(--ps-danger)] animate-pulse'
                            : asleep
                              ? 'text-[var(--ps-muted)]'
                              : 'text-[var(--ps-emerald)]'
                        }`}
                      >
                        {cam.recording
                          ? formatGoProRecTimer(cam.encodingDurationSec)
                          : asleep
                            ? 'OFF'
                            : 'PRONTO'}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={asleep}
                        onClick={() => {
                          void shutterSingleGoPro(cam, !cam.recording);
                        }}
                        title={cam.recording ? `Parar ${fullLabel}` : `Gravar ${fullLabel}`}
                        aria-label={cam.recording ? `Parar ${fullLabel}` : `Gravar ${fullLabel}`}
                        className={`inline-flex h-[28px] w-[28px] items-center justify-center rounded-md border disabled:opacity-30 ${
                          cam.recording
                            ? 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]'
                            : 'border-[#E10600]/80 bg-[#E10600]/15'
                        }`}
                      >
                        {cam.recording ? (
                          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--ps-text)]" />
                        ) : (
                          <span className="h-2.5 w-2.5 rounded-full bg-[#FF2A2A]" />
                        )}
                      </button>

                      <button
                        type="button"
                        disabled={cam.reconnecting}
                        onClick={() => {
                          if (asleep) void wakeSingleGoPro(cam);
                          else void sleepSingleGoPro(cam);
                        }}
                        title={asleep ? `Ligar ${fullLabel}` : `Desligar ${fullLabel}`}
                        aria-label={asleep ? `Ligar ${fullLabel}` : `Desligar ${fullLabel}`}
                        className={`inline-flex h-[28px] w-[28px] items-center justify-center rounded-md border ${
                          asleep
                            ? 'border-[var(--ps-emerald)] bg-emerald-500/15 text-[var(--ps-emerald)]'
                            : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                        }`}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}

              {goproFleet.cameras.length === 0 &&
                savedMissingGoPros.slice(0, 6).map((sd, idx) => {
                  const fullLabel = getGoProDisplayName(sd) || `Cam ${idx + 1}`;
                  return (
                    <div
                      key={sd.deviceId}
                      title={fullLabel}
                      className="flex h-[34px] min-w-0 items-center justify-between gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2"
                    >
                      <div className="min-w-0 leading-tight font-mono">
                        <p className="truncate text-[10px] font-extrabold text-[var(--ps-text)]">
                          Cam {idx + 1}
                        </p>
                        <p className="text-[9px] font-bold text-[var(--ps-muted)]">OFF</p>
                      </div>
                      <button
                        type="button"
                        disabled={goproFleet.wakingId === sd.deviceId}
                        onClick={() => {
                          void wakeSavedGoProInFleet(sd);
                        }}
                        title={`Ligar ${fullLabel}`}
                        aria-label={`Ligar ${fullLabel}`}
                        className="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-md border border-[var(--ps-emerald)] bg-emerald-500/15 text-[var(--ps-emerald)]"
                      >
                        <Power className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-[var(--ps-text)] space-y-1.5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <button
            type="button"
            onClick={() => hasAnyGoPro && setGoproDrawerOpen((v) => !v)}
            className="flex min-w-0 items-center gap-1.5 text-left"
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                recordingGoProCount > 0
                  ? 'bg-[#E10600] animate-pulse'
                  : activeGoProsReady.length > 0
                    ? 'bg-[var(--ps-emerald)]'
                    : 'bg-[var(--ps-muted)]'
              }`}
            />
            <Camera className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
            <p className="text-[11px] font-extrabold uppercase tracking-wide truncate">
              GoPro ({activeGoProsReady.length}/{goproFleet.cameras.length || goproFleet.savedDevices.length})
              {recordingGoProCount > 0 ? ` · ${recordingGoProCount} REC` : ''}
            </p>
            {hasAnyGoPro &&
              (goproDrawerOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-[var(--ps-muted)] shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-[var(--ps-muted)] shrink-0" />
              ))}
          </button>

          <div className="flex flex-wrap items-center gap-1 shrink-0">
            {hasAnyGoPro &&
              (activeGoProsReady.length > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isPro) {
                        openProUpgradeModal(
                          'Automação de Câmeras GoPro BLE',
                          'Controle remoto de gravação GoPro via Bluetooth faz parte do Plano PRO.'
                        );
                        return;
                      }
                      void shutterAllGoPro(recordingGoProCount === 0);
                    }}
                    className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-extrabold uppercase ${
                      recordingGoProCount > 0
                        ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)]'
                        : 'pitstop-btn-red'
                    }`}
                  >
                    {recordingGoProCount > 0 ? (
                      <>
                        <Square className="h-2.5 w-2.5 fill-current" />
                        <span>Parar</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-2.5 w-2.5 fill-current" />
                        <span>REC</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void sleepAllGoPro();
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-1.5 text-[10px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                    title="Desligar / Hibernar todas as GoPro"
                  >
                    <Power className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void wakeAllGoPro();
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--ps-emerald)]/60 bg-emerald-500/15 px-2 text-[10px] font-extrabold text-[var(--ps-emerald)] uppercase hover:bg-emerald-500/25"
                >
                  <Power className="h-3 w-3" />
                  <span>Ligar</span>
                </button>
              ))}
          </div>
        </div>

      {goproFleet.errorMsg && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/50 bg-red-500/15 px-2.5 py-1.5 text-[11px] text-red-500">
          <span className="truncate">{goproFleet.errorMsg}</span>
          <button
            type="button"
            onClick={clearGoProFleetError}
            className="shrink-0 opacity-80 hover:opacity-100"
            aria-label="Fechar erro GoPro"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {goproDrawerOpen && (
        <div className="space-y-1.5 border-t border-[var(--ps-border)] pt-2">
          {goproFleet.cameras.map((cam) => {
            const label = getGoProDisplayName(cam);
            const asleep = cam.sleeping || !cam.connected;
            const isEditing = editingGoProId === cam.id;
            return (
              <div
                key={cam.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      asleep
                        ? 'bg-[var(--ps-muted)]'
                        : cam.recording
                          ? 'bg-[#E10600] animate-pulse'
                          : 'bg-[var(--ps-emerald)]'
                    }`}
                  />
                  {isEditing ? (
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        type="text"
                        value={editingGoProName}
                        onChange={(e) => setEditingGoProName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameGoProInFleet(cam.id, editingGoProName);
                            setEditingGoProId(null);
                          }
                          if (e.key === 'Escape') setEditingGoProId(null);
                        }}
                        placeholder="Ex: Capô"
                        autoFocus
                        className="h-7 min-w-0 flex-1 rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          renameGoProInFleet(cam.id, editingGoProName);
                          setEditingGoProId(null);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded bg-emerald-600 text-white"
                        aria-label="Salvar nome"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="truncate text-xs font-bold text-[var(--ps-text)]">{label}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingGoProId(cam.id);
                          setEditingGoProName(cam.alias || cam.name);
                        }}
                        className="p-0.5 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                        aria-label={`Renomear ${label}`}
                        title="Nomear câmera"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <span className="font-mono text-[10px] text-[var(--ps-muted)] tabular-nums shrink-0">
                        {cam.recording
                          ? `● ${formatGoProRecTimer(cam.encodingDurationSec)}`
                          : `${cam.batteryPct}%`}
                      </span>
                    </>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={asleep}
                    onClick={() => {
                      void shutterSingleGoPro(cam, !cam.recording);
                    }}
                    className={`inline-flex h-7 items-center gap-1 rounded px-2 text-[10px] font-extrabold uppercase disabled:opacity-35 ${
                      cam.recording
                        ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)]'
                        : 'bg-[#E10600] text-white'
                    }`}
                  >
                    {cam.recording ? 'Parar' : 'REC'}
                  </button>
                  <button
                    type="button"
                    disabled={cam.reconnecting}
                    onClick={() => {
                      void toggleSingleGoProPower(cam);
                    }}
                    className={`inline-flex h-7 items-center gap-1 rounded border px-2 text-[10px] font-bold ${
                      asleep
                        ? 'border-[var(--ps-emerald)]/60 bg-emerald-500/15 text-[var(--ps-emerald)]'
                        : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    <Power className="h-3 w-3" />
                    <span>{asleep ? 'Ligar' : 'Desligar'}</span>
                  </button>
                </div>
              </div>
            );
          })}

          {savedMissingGoPros.map((sd) => {
            const label = getGoProDisplayName(sd);
            const isEditing = editingGoProId === sd.deviceId;
            return (
              <div
                key={sd.deviceId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ps-muted)]" />
                  {isEditing ? (
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        type="text"
                        value={editingGoProName}
                        onChange={(e) => setEditingGoProName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameGoProInFleet(sd.deviceId, editingGoProName);
                            setEditingGoProId(null);
                          }
                          if (e.key === 'Escape') setEditingGoProId(null);
                        }}
                        placeholder="Ex: Capô"
                        autoFocus
                        className="h-7 min-w-0 flex-1 rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          renameGoProInFleet(sd.deviceId, editingGoProName);
                          setEditingGoProId(null);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded bg-emerald-600 text-white"
                        aria-label="Salvar nome"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="truncate text-xs font-bold text-[var(--ps-text)]">{label}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingGoProId(sd.deviceId);
                          setEditingGoProName(sd.alias || sd.name);
                        }}
                        className="p-0.5 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                        aria-label={`Renomear ${label}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  disabled={goproFleet.wakingId === sd.deviceId}
                  onClick={() => {
                    void wakeSavedGoProInFleet(sd);
                  }}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[var(--ps-emerald)]/60 bg-emerald-500/15 px-2.5 text-[10px] font-extrabold text-[var(--ps-emerald)] uppercase"
                >
                  <Power className="h-3 w-3" />
                  <span>{goproFleet.wakingId === sd.deviceId ? 'Ligando...' : 'Ligar'}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
    );
  };
  const goproQuickBar = renderGoProBar(false);

  const gpsEngineSettingsBlock = (
    <div className="space-y-3">
      <div className="space-y-2.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3">
        <div>
          <p className="text-xs font-bold text-[var(--ps-text)]">Fonte de Telemetria</p>
          <p className="text-[11px] text-[var(--ps-muted)]">
            GPS Interno, Receptor Externo 10Hz/25Hz (BLE) ou Simulador SS-01
          </p>
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => {
              fixTimestampsRef.current = [];
              setMeasuredGpsHz(0);
              setSource('gps');
              setSimPlaying(false);
            }}
            className={`min-h-[38px] rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
              source === 'gps'
                ? 'pitstop-btn-red border-transparent'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
            }`}
          >
            GPS Interno
          </button>
          <button
            type="button"
            onClick={() => {
              fixTimestampsRef.current = [];
              setMeasuredGpsHz(0);
              setGpsActive(false);
              setSource('ble_gps');
              setSimPlaying(false);
            }}
            className={`min-h-[38px] rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
              source === 'ble_gps'
                ? 'pitstop-btn-red border-transparent'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
            }`}
          >
            GPS Externo BLE (10/25Hz)
          </button>
          <button
            type="button"
            onClick={() => {
              fixTimestampsRef.current = [];
              setMeasuredGpsHz(0);
              setSource('simulator');
            }}
            className={`min-h-[38px] rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
              source === 'simulator'
                ? 'pitstop-btn-red border-transparent'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
            }`}
          >
            Simulador
          </button>
        </div>

        {source === 'ble_gps' && (
          <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Bluetooth
                  className={`h-4 w-4 shrink-0 ${
                    extGps.connected ? 'text-[var(--ps-emerald)]' : 'text-[var(--ps-accent)]'
                  }`}
                />
                <div className="min-w-0">
                  <p className="truncate text-xs font-extrabold text-[var(--ps-text)]">
                    {extGps.connected
                      ? extGps.deviceName || 'GPS BLE Conectado'
                      : extGps.savedDevice
                        ? `Salvo: ${extGps.savedDevice.name}`
                        : 'Nenhum GPS Bluetooth pareado'}
                  </p>
                  <p className="font-mono text-[10px] text-[var(--ps-muted)] tabular-nums">
                    {extGps.connected
                      ? `${extGps.measuredHz} Hz ${extGps.protocol || 'BLE'} · ${extGps.satellites ?? '--'} SAT · ${extGps.accuracyM !== null ? `±${extGps.accuracyM}m` : '--'}`
                      : 'RaceBox Mini / Mini S (25Hz) · Garmin / Qstarz / XGPS (NMEA 10Hz)'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {!extGps.connected ? (
                  <>
                    {extGps.savedDevice && (
                      <button
                        type="button"
                        disabled={extGps.connecting}
                        onClick={() => void reconnectSavedExternalGps()}
                        className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-[var(--ps-emerald)] disabled:opacity-50"
                      >
                        {extGps.connecting ? 'Conectando...' : 'Reconectar'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={extGps.connecting}
                      onClick={() => void scanAndConnectExternalGps()}
                      className="pitstop-btn-red rounded-lg px-2.5 py-1.5 text-[11px] font-extrabold disabled:opacity-50"
                    >
                      {extGps.connecting ? 'Buscando...' : 'Parear GPS BLE'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void disconnectExternalGps()}
                    className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--ps-text)] hover:border-[var(--ps-danger)]"
                  >
                    Desconectar
                  </button>
                )}
                {extGps.savedDevice && !extGps.connected && (
                  <button
                    type="button"
                    onClick={() => forgetSavedExternalGps()}
                    className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 py-1.5 text-[11px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                  >
                    Esquecer
                  </button>
                )}
              </div>
            </div>

            {extGps.errorMsg && (
              <p className="text-[11px] font-semibold text-[var(--ps-amber)]">{extGps.errorMsg}</p>
            )}
          </div>
        )}

        {source === 'simulator' && (
          <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-0.5">
            {([1, 2, 4] as const).map((x) => (
              <button
                key={x}
                type="button"
                onClick={() => setSimMultiplier(x)}
                className={`rounded px-2 py-1 font-mono text-[10px] font-bold ${
                  simMultiplier === x ? 'pitstop-btn-red' : 'text-[var(--ps-muted)]'
                }`}
              >
                {x}x
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 transition-colors hover:border-[var(--ps-border-strong)]">
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--ps-text)]">Detecção Automática de Pista (GPS)</p>
          <p className="text-[11px] text-[var(--ps-muted)]">
            Reconhece pistas salvas num raio de{' '}
            {velPrefs.autoDetectRadiusM >= 1000
              ? `${(velPrefs.autoDetectRadiusM / 1000).toFixed(1)} km`
              : `${velPrefs.autoDetectRadiusM} metros`}{' '}
            da Largada.
          </p>
        </div>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            role="switch"
            aria-checked={velPrefs.autoDetectTrack}
            checked={velPrefs.autoDetectTrack}
            onChange={(e) => updateVelEngine({ autoDetectTrack: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full border p-[2px] transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ps-accent)] ${
              velPrefs.autoDetectTrack
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent)]'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]'
            }`}
          >
            <span
              className={`h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                velPrefs.autoDetectTrack ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 transition-colors hover:border-[var(--ps-border-strong)]">
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--ps-text)]">Auto-Snap Dinâmico (HDOP)</p>
          <p className="text-[11px] text-[var(--ps-muted)]">
            Expande o portal proporcionalmente à precisão horizontal do GPS.
          </p>
        </div>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            role="switch"
            aria-checked={velPrefs.autoSnapHdop}
            checked={velPrefs.autoSnapHdop}
            onChange={(e) => updateVelEngine({ autoSnapHdop: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full border p-[2px] transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ps-accent)] ${
              velPrefs.autoSnapHdop
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent)]'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]'
            }`}
          >
            <span
              className={`h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                velPrefs.autoSnapHdop ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 transition-colors hover:border-[var(--ps-border-strong)]">
        <div className="min-w-0">
          <p className="text-xs font-bold text-[var(--ps-text)]">Acelerômetro &amp; Força G (IMU)</p>
          <p className="text-[11px] text-[var(--ps-muted)]">
            Combina sensores internos com variação cinemática de velocidade.
          </p>
        </div>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            role="switch"
            aria-checked={velPrefs.useDeviceImu}
            checked={velPrefs.useDeviceImu}
            onChange={(e) => updateVelEngine({ useDeviceImu: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full border p-[2px] transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--ps-accent)] ${
              velPrefs.useDeviceImu
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent)]'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]'
            }`}
          >
            <span
              className={`h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                velPrefs.useDeviceImu ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </span>
        </span>
      </label>
    </div>
  );

  const readyLayoutPickerBlock = (
    <div className="grid grid-cols-2 gap-2.5">
      {VELOCITY_COCKPIT_READY_PRESETS.map((item) => {
        const selected = activeReadyLayoutId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              cockpitLayout.setLayoutId(item.id);
              setShowLayoutSelectorModal(false);
            }}
            aria-pressed={selected}
            className={`group flex flex-col justify-between gap-2 rounded-xl border p-2.5 text-left transition-all ${
              selected
                ? 'border-[var(--ps-accent)] bg-[var(--ps-card)] ring-1 ring-[var(--ps-accent)]/50 shadow-md'
                : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-[var(--ps-border-strong)]'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <LayoutMiniSchematic id={item.id} accent={item.accentColor} />
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  selected
                    ? 'border-[var(--ps-accent)] bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-transparent'
                }`}
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1 font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                <span className={selected ? 'text-[var(--ps-accent)]' : ''}>{item.code}</span>
                <span>·</span>
                <span className="truncate">{item.tag}</span>
              </div>
              <p className="mt-0.5 truncate font-['Barlow_Condensed'] text-sm font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                {item.shortName}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );

  const compactLayoutSelectorCard = (
    <button
      type="button"
      onClick={() => setShowLayoutSelectorModal(true)}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-3 text-left transition-colors hover:border-[var(--ps-accent)] active:scale-[0.99]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="shrink-0">
          <LayoutMiniSchematic
            id={activeReadyPreset.id}
            accent={activeReadyPreset.accentColor}
          />
        </div>
        <div className="min-w-0">
          <p className="font-['Barlow_Condensed'] text-base font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
            Layout do Cockpit Ao Vivo
          </p>
          <p className="truncate font-mono text-[11px] font-bold text-[var(--ps-muted)]">
            {activeReadyPreset.code} · {activeReadyPreset.shortName.toUpperCase()}
          </p>
        </div>
      </div>

      <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ps-accent)]/40 bg-[var(--ps-accent)]/15 px-2.5 py-1.5 font-mono text-[11px] font-extrabold text-[var(--ps-accent)] uppercase">
        <span>Alterar</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Compact Top Bar inside Velocidade (hidden in home & full-viewport fixed Live Cockpit) */}
      {screen !== 'live' && screen !== 'home' && (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 text-[var(--ps-text)] shadow-lg">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={handleBackAction}
                  aria-label="Voltar"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                >
                  <ArrowLeft className="h-4 w-4 text-[var(--ps-accent)]" />
                </button>
                <div className="min-w-0">
                  <h2 className="font-['Barlow_Condensed'] text-lg font-extrabold leading-tight tracking-wide uppercase sm:text-xl">
                    {screenTitleMap[screen]}
                  </h2>
                </div>
              </div>

              <div className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 font-mono text-[11px] font-bold text-[var(--ps-muted)] tabular-nums">
                {source === 'ble_gps' ? (
                  <Bluetooth
                    className={`h-3.5 w-3.5 ${
                      gpsActive || extGps.connected
                        ? 'text-[var(--ps-emerald)]'
                        : 'text-[var(--ps-muted)]'
                    }`}
                  />
                ) : (
                  <Satellite
                    className={`h-3.5 w-3.5 ${
                      source === 'simulator'
                        ? 'text-[var(--ps-amber)]'
                        : gpsActive
                          ? 'text-[var(--ps-emerald)]'
                          : 'text-[var(--ps-muted)]'
                    }`}
                  />
                )}
                <span>{gpsStatusLabel}</span>
              </div>
            </div>

            {(statusFeedback || (gpsError && screen !== 'track-editor')) && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-1.5 text-xs">
                <span
                  className={
                    gpsError && !statusFeedback
                      ? 'text-[var(--ps-amber)]'
                      : 'text-[var(--ps-emerald)] font-semibold'
                  }
                >
                  {statusFeedback || gpsError}
                </span>
                {wakeLockActive && (
                  <span className="font-mono text-[10px] text-[var(--ps-muted)] whitespace-nowrap">
                    Tela Ativa
                  </span>
                )}
              </div>
            )}
          </section>
      )}

      {/* SCREEN: HOME (Clean RaceChrono + Rally Hub — 100dvh Zero-Overflow Ergonomics) */}
      {screen === 'home' && (
        <section className="flex h-[calc(100dvh-108px-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] min-h-[430px] max-h-full flex-col justify-between gap-[clamp(4px,1dvh,12px)] overflow-hidden">
          {/* Top: Unified Clean Active Track Bar */}
          <div className="relative shrink-0 text-[var(--ps-text)]">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={showTrackPickerDropdown}
                aria-label="Selecionar pista para cronometragem"
                onClick={() => setShowTrackPickerDropdown((v) => !v)}
                className={`flex h-[clamp(44px,6.2dvh,56px)] min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border bg-[var(--ps-surface)] px-3.5 text-left transition-colors ${
                  showTrackPickerDropdown
                    ? 'border-[var(--ps-accent)]'
                    : 'border-[var(--ps-border)] hover:border-[var(--ps-accent)]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                      Pista Ativa
                    </span>
                    {autoDetectedNotice && (
                      <span className="truncate font-mono text-[10px] font-bold text-[var(--ps-emerald)]">
                        {autoDetectedNotice}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm font-extrabold leading-tight text-[var(--ps-text)]">
                    {activeTrack
                      ? `${formatCleanTrackName(activeTrack.name)}${
                          activeTrack.referenceDistanceKm > 0
                            ? ` • ${activeTrack.referenceDistanceKm.toFixed(1)} km`
                            : ''
                        }`
                      : 'Especial Livre'}
                  </p>
                </div>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-[var(--ps-muted)] transition-transform ${
                    showTrackPickerDropdown ? 'rotate-180 text-[var(--ps-accent)]' : ''
                  }`}
                />
              </button>

              {activeTrack ? (
                <button
                  type="button"
                  onClick={() => setScreen('track-editor')}
                  className="inline-flex h-[clamp(44px,6.2dvh,56px)] shrink-0 items-center gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)] transition-colors"
                  title="Editar Marcos no Mapa"
                >
                  <MapIcon className="h-4 w-4 text-[var(--ps-accent)]" />
                  <span>Mapa</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewTrackModal(true)}
                  className="inline-flex h-[clamp(44px,6.2dvh,56px)] shrink-0 items-center gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)] transition-colors"
                  title="Criar Nova Pista"
                >
                  <Plus className="h-4 w-4 text-[var(--ps-accent)]" />
                  <span>Nova</span>
                </button>
              )}
            </div>

            {showTrackPickerDropdown && (
              <div className="mt-2 max-h-60 space-y-1 overflow-y-auto rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-1.5 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    setUserPickedTrackManually(true);
                    setAutoDetectedNotice(null);
                    setActiveTrackId('');
                    finishGateArmedRef.current = false;
                    stageStateRef.current = 'idle';
                    stageStartMsRef.current = null;
                    setStageState('idle');
                    setStageStartMs(null);
                    setLastFinishedMs(null);
                    setCurrentSplitTimesMs({});
                    setShowTrackPickerDropdown(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                    !activeTrackId
                      ? 'border border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                      : 'border border-transparent hover:bg-[var(--ps-card-deep)]'
                  }`}
                >
                  <p className="truncate text-xs font-extrabold text-[var(--ps-text)]">
                    Especial Livre
                  </p>
                  {!activeTrackId && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />}
                </button>

                {tracks.map((t) => {
                  const isSelected = t.id === activeTrackId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setUserPickedTrackManually(true);
                        setAutoDetectedNotice(null);
                        setTracks((prev) =>
                          prev.map((tr) =>
                            tr.id === t.id ? ensureAutoTrapsFromBaseTrace(tr) : tr
                          )
                        );
                        setActiveTrackId(t.id);
                        finishGateArmedRef.current = false;
                        stageStateRef.current = 'idle';
                        stageStartMsRef.current = null;
                        setStageState('idle');
                        setStageStartMs(null);
                        setLastFinishedMs(null);
                        setCurrentSplitTimesMs({});
                        setShowTrackPickerDropdown(false);
                        setStartTimeCalcContext('track-picker');
                        setStartTimeCalcTrackId(t.id);
                        setStartTimeCalcModalOpen(true);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'border border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                          : 'border border-transparent hover:bg-[var(--ps-card-deep)]'
                      }`}
                    >
                      <p className="min-w-0 flex-1 truncate text-xs font-extrabold leading-tight text-[var(--ps-text)]">
                        {formatCleanTrackName(t.name)}
                        {t.referenceDistanceKm > 0 && (
                          <span className="ml-1.5 font-mono text-[11px] font-bold text-[var(--ps-muted)]">
                            • {t.referenceDistanceKm.toFixed(1)} km
                          </span>
                        )}
                      </p>
                      {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Centerpiece Circular Tachometer Launch Button + Official GPS Clock */}
          <div className="my-auto flex min-h-0 flex-col items-center justify-center gap-[clamp(4px,1.2dvh,12px)] py-0.5">
            <VelocityStartTachButton
              onConfirm={handleStartOrArmStage}
              sweepTrigger={tachSweepTrigger}
              isPro={isPro}
              subtitle={activeTrack ? 'ARMAR ESPECIAL' : 'ESPECIAL LIVRE'}
              gpsSignalOk={
                source === 'simulator' ||
                (gpsActive && (gpsAccuracyM === null || gpsAccuracyM <= 25))
              }
            />

            <OfficialGpsClockPill clockOffsetMs={navSettings.clockOffsetMs} />
          </div>

          {/* Bottom Thumb Zone: 5 Primary Actions + GoPro Quick Bar */}
          <div className="shrink-0 space-y-1.5 sm:space-y-2">
            {/* Primary 2 Buttons matching RaceChrono: Sessões & Pistas */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => {
                if (!isPro) {
                  openProUpgradeModal(
                    'Sessões & Datalogger de 3 Voltas',
                    'O histórico completo de voltas, setores e comparação de telemetria requer Plano PRO.'
                  );
                  return;
                }
                setScreen('sessions');
              }}
              className="relative flex min-h-[clamp(44px,6.4dvh,58px)] items-center justify-center gap-2 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold text-[var(--ps-text)] shadow-md transition-all hover:border-[var(--ps-accent)] active:scale-[0.98] sm:text-sm"
            >
              <History className="h-4 w-4 shrink-0 text-[var(--ps-accent)] sm:h-5 sm:w-5" />
              <span className="truncate">Sessões ({groupedSessions.length})</span>
              {!isPro && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                if (!isPro) {
                  openProUpgradeModal(
                    'Gestor de Pistas & Parciais',
                    'A criação e edição de pistas com traps de largada, parciais e chegada faz parte do Plano PRO.'
                  );
                  return;
                }
                setScreen('tracks');
              }}
              className="relative flex min-h-[clamp(44px,6.4dvh,58px)] items-center justify-center gap-2 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold text-[var(--ps-text)] shadow-md transition-all hover:border-[var(--ps-accent)] active:scale-[0.98] sm:text-sm"
            >
              <Flag className="h-4 w-4 shrink-0 text-[var(--ps-accent)] sm:h-5 sm:w-5" />
              <span className="truncate">Pistas ({tracks.length})</span>
              {!isPro && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
            </button>
          </div>

          {/* Unified Rally Tools Strip (Telemetria, Levantamento & 3D, Satcron) */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={handleOpenQuickAnalysis}
              className="relative flex min-h-[clamp(42px,6.2dvh,56px)] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-1.5 text-[11px] font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              {!isPro && (
                <span className="absolute top-1 right-1 rounded bg-amber-500/20 px-1 py-0.2 font-mono text-[8px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
              <TrendingUp className="h-4 w-4 text-[var(--ps-accent)]" />
              <span className="truncate max-w-full">Telemetria</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('survey')}
              className="flex min-h-[clamp(42px,6.2dvh,56px)] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-1.5 text-[11px] font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              <Compass className="h-4 w-4 text-[var(--ps-accent)]" />
              <span className="truncate max-w-full">Levantam.</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (!isPro) {
                  openProUpgradeModal(
                    'Satcron Ao Vivo',
                    'O acompanhamento oficial de especiais do Satcron em tempo real dentro do cockpit requer Plano PRO.'
                  );
                  return;
                }
                setScreen('satcron');
              }}
              className="relative flex min-h-[clamp(42px,6.2dvh,56px)] flex-col items-center justify-center gap-0.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-1.5 text-[11px] font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              {!isPro && (
                <span className="absolute top-1 right-1 rounded bg-amber-500/20 px-1 py-0.2 font-mono text-[8px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
              <Trophy className="h-4 w-4 text-[var(--ps-accent)]" />
              <span className="truncate max-w-full">Satcron</span>
            </button>
          </div>

            {goproQuickBar}
          </div>
        </section>
      )}

      {/* SCREEN: LIVE COCKPIT (Fixed Non-Scrolling 100dvh + Prominent Active Stage Banner) */}
      {screen === 'live' && (() => {
        const liveMapTrace =
          liveSamples.length > 0 ? liveSamples : activeTrack?.baseTrace ?? [];
        const activeStageBannerName = activeTrack ? formatCleanTrackName(activeTrack.name) : 'Especial Livre';
        const liveReferenceDistanceKm = (() => {
          if (activeTrack?.referenceDistanceKm && activeTrack.referenceDistanceKm > 0.05) {
            return activeTrack.referenceDistanceKm;
          }
          if (bestRun?.distanceKm && bestRun.distanceKm > 0.05) {
            return bestRun.distanceKm;
          }
          if (orderedTraps.length >= 2) {
            let sumM = 0;
            for (let i = 1; i < orderedTraps.length; i += 1) {
              sumM += haversineMetersVel(
                orderedTraps[i - 1].lat,
                orderedTraps[i - 1].lon,
                orderedTraps[i].lat,
                orderedTraps[i].lon
              );
            }
            if (sumM > 50) return sumM / 1000;
          }
          return 0;
        })();

        const liveHasRefDist = liveReferenceDistanceKm > 0.05;
        const liveProgressRatio =
          liveHasRefDist && (stageState === 'running' || stageState === 'finished')
            ? Math.min(1, Math.max(0, totalDistKm / liveReferenceDistanceKm))
            : stageState === 'running'
              ? Math.min(
                  1,
                  Math.max(0, (speedKmh / 140) * 0.72 + Math.max(0, liveLongG) * 0.28)
                )
              : 0;
        const liveProgressPct = Math.round(liveProgressRatio * 100);
        const liveRemainingDistM = liveHasRefDist
          ? Math.max(0, (liveReferenceDistanceKm - totalDistKm) * 1000)
          : null;
        const liveIsFinishFlash =
          stageState === 'running' &&
          liveHasRefDist &&
          (liveProgressRatio >= 0.95 ||
            (liveRemainingDistM !== null && liveRemainingDistM <= 100));

        const handleEditTripFromLive = (nextDisplayedKm: number) => {
          if (tripRegressive && tripTargetKm !== null) {
            setTripDistKm(Math.max(0, tripTargetKm - nextDisplayedKm));
          } else {
            setTripDistKm(Math.max(0, nextDisplayedKm));
          }
          showToast(`Trip ajustado: ${Math.round(nextDisplayedKm * 1000)}m (${nextDisplayedKm.toFixed(2)} km)`);
        };

        const handleOpenLiveAnalysis = () => {
          if (!isPro) {
            openProUpgradeModal(
              'Datalogger & Telemetria de 3 Voltas',
              'Comparativo de 3 voltas, forças G, mapa de calor e Vídeo Overlay HUD estão disponíveis no Plano PRO.'
            );
            return;
          }
          if (trackRuns.length > 0) {
            openSessionDetail(activeTrack?.id || trackRuns[0].trackId, 'analysis');
            return;
          }
          if (groupedSessions.length > 0) {
            openSessionDetail(groupedSessions[0].trackId, 'analysis');
            return;
          }
          setLiveNotice('Nenhuma volta concluída ainda para análise.');
          window.setTimeout(() => setLiveNotice(null), 3200);
        };

        const handleOpenLiveSatcron = () => {
          if (!isPro) {
            openProUpgradeModal(
              'Satcron Ao Vivo',
              'O acompanhamento oficial de especiais do Satcron requer Plano PRO.'
            );
            return;
          }
          setScreen('satcron');
        };

        const handleOpenLiveMapTab = () => {
          if (!isPro) {
            openProUpgradeModal(
              'Mapa Ao Vivo com Calor G/Velocidade',
              'O mapa ao vivo de telemetria requer Plano PRO.'
            );
            return;
          }
          setShowLiveMap(true);
        };

        const gaugesCenterNode = (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-1.5 text-[var(--ps-text)]">
              <button
                type="button"
                onClick={() => {
                  if (!tripRegressive) {
                    const input = tripTargetKm ?? (activeTrack?.referenceDistanceKm || 2.0);
                    setTripTargetKm(input);
                    setTripRegressive(true);
                  } else {
                    setTripRegressive(false);
                  }
                }}
                className={`min-h-[32px] rounded-lg border px-2.5 text-xs font-bold whitespace-nowrap ${
                  tripRegressive
                    ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                    : 'border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)]'
                }`}
              >
                Trip: {tripRegressive ? 'Regressivo' : 'Progressivo'}
              </button>

              <button
                type="button"
                onClick={() => setShowGaugeConfig((v) => !v)}
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                <Settings2 className="h-3.5 w-3.5" />
                <span>Campos</span>
              </button>
            </div>

            {showGaugeConfig && (
              <div className="grid shrink-0 grid-cols-2 gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-[11px] sm:grid-cols-4">
                {(
                  [
                    ['speed', 'Velocidade'],
                    ['trip', 'Hodômetro Trip'],
                    ['officialClock', 'Horário CH (GPS)'],
                    ['stageTime', 'Cronômetro SS'],
                    ['maxSpeed', 'Vel. Máxima'],
                    ['altitude', 'Altitude'],
                    ['gpsAccuracy', 'Sinal GPS'],
                    ['heading', 'Rumo (CAP)'],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center justify-between gap-1.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1 text-[var(--ps-text)]"
                  >
                    <span className="truncate">{label}</span>
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
              </div>
            )}

            <div className="grid flex-1 min-h-0 grid-cols-2 gap-2 sm:grid-cols-4">
              {gaugeVisibility.speed && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2 text-center">
                  <p className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    Velocidade
                  </p>
                  <p className="mt-0.5 font-mono text-[clamp(1.65rem,4.5dvh,3rem)] font-extrabold text-[var(--ps-text)] tabular-nums leading-none">
                    {Math.round(speedKmh)}
                  </p>
                  <p className="font-mono text-[10px] font-bold text-[var(--ps-accent)]">KM/H</p>
                </div>
              )}

              {gaugeVisibility.trip && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2 text-center">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase truncate">
                      {tripRegressive ? 'Trip Regressivo' : 'Trip Parcial'}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setTripDistKm(0);
                        showToast('Hodômetro parcial (Trip) zerado.');
                      }}
                      title="Zerar Trip Parcial"
                      aria-label="Zerar Trip Parcial"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  </div>
                  {editingGaugeTrip ? (
                    <div className="mt-1 space-y-1">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          autoFocus
                          value={gaugeTripInput}
                          onChange={(e) => setGaugeTripInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const n = Number(gaugeTripInput.replace(',', '.'));
                              if (Number.isFinite(n) && n >= 0) {
                                handleEditTripFromLive(gaugeTripUnit === 'm' ? n / 1000 : n);
                              }
                              setEditingGaugeTrip(false);
                            }
                            if (e.key === 'Escape') setEditingGaugeTrip(false);
                          }}
                          className="min-w-0 flex-1 rounded border border-[var(--ps-accent)] bg-[var(--ps-card)] px-1.5 py-1 text-center font-mono text-sm font-black text-[var(--ps-amber)] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setGaugeTripUnit((u) => (u === 'm' ? 'km' : 'm'))}
                          className="rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-1 font-mono text-[10px] font-bold text-[var(--ps-text)] uppercase"
                        >
                          {gaugeTripUnit}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const n = Number(gaugeTripInput.replace(',', '.'));
                          if (Number.isFinite(n) && n >= 0) {
                            handleEditTripFromLive(gaugeTripUnit === 'm' ? n / 1000 : n);
                          }
                          setEditingGaugeTrip(false);
                        }}
                        className="pitstop-btn-red w-full rounded py-0.5 text-[10px] font-extrabold"
                      >
                        OK
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setGaugeTripInput(
                          gaugeTripUnit === 'm'
                            ? String(Math.round(displayedTripKm * 1000))
                            : displayedTripKm.toFixed(2)
                        );
                        setEditingGaugeTrip(true);
                      }}
                      title="Toque para digitar metragem do Trip"
                      className="group flex flex-col items-center justify-center rounded-lg py-0.5 hover:bg-[var(--ps-card)]"
                    >
                      <p className="font-mono text-[clamp(1.35rem,3.6dvh,2.25rem)] font-extrabold text-[var(--ps-amber)] tabular-nums leading-none">
                        {Math.round(displayedTripKm * 1000)}m
                      </p>
                      <p className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--ps-muted)]">
                        <span>{displayedTripKm.toFixed(2)} km</span>
                        <Pencil className="h-2.5 w-2.5 text-[var(--ps-muted)] group-hover:text-[var(--ps-accent)]" />
                      </p>
                    </button>
                  )}
                </div>
              )}

              <VelocityGaugeClockCards
                showOfficialClock={gaugeVisibility.officialClock}
                showStageTime={gaugeVisibility.stageTime}
                stageState={stageState}
                stageStartMs={stageStartMs}
                lastFinishedMs={lastFinishedMs}
                clockOffsetMs={navSettings.clockOffsetMs}
                totalDistKm={totalDistKm}
                bestRun={bestRun}
              />

              {gaugeVisibility.maxSpeed && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                  <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Vel. Máxima</p>
                  <p className="mt-0.5 font-mono text-xl font-bold text-[var(--ps-text)] tabular-nums sm:text-2xl">
                    {maxSpeedKmh}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ps-muted)]">km/h</p>
                </div>
              )}

              {gaugeVisibility.altitude && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                  <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Altitude</p>
                  <p className="mt-0.5 font-mono text-xl font-bold text-[var(--ps-text)] tabular-nums sm:text-2xl">
                    {altitudeM !== null ? `${altitudeM}m` : '--'}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ps-muted)]">Elevação</p>
                </div>
              )}

              {gaugeVisibility.gpsAccuracy && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                  <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Sinal GPS</p>
                  <p className="mt-0.5 font-mono text-xl font-bold text-[var(--ps-emerald)] tabular-nums sm:text-2xl">
                    {gpsAccuracyM !== null ? `±${gpsAccuracyM}m` : '--'}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ps-muted)] tabular-nums">
                    {source === 'simulator'
                      ? `${effectiveGpsHz || 5} Hz SIM`
                      : `${effectiveGpsHz || 1} Hz ${gpsSourceShort} · ${satCount} SAT`}
                  </p>
                </div>
              )}

              {gaugeVisibility.heading && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                  <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Rumo (CAP)</p>
                  <p className="mt-0.5 font-mono text-xl font-bold text-[var(--ps-text)] tabular-nums sm:text-2xl">
                    {headingDeg !== null ? `${headingDeg}°` : '--'}
                  </p>
                  <p className="font-mono text-[9px] text-[var(--ps-muted)]">Direção</p>
                </div>
              )}
            </div>
          </div>
        );

        const cartelaTrackKey = activeTrack?.id || 'live_free';
        const activeCartelaRaw = cartelaTimesByTrack[cartelaTrackKey] ?? '';
        const parsedActiveCartela = parseStartTimeClock(activeCartelaRaw);
        let cartelaCountdownBanner: string | null = null;
        if (stageState === 'armed' && parsedActiveCartela) {
          const adjustedNowMs = preStartNowMs + navSettings.clockOffsetMs;
          const targetDate = new Date(adjustedNowMs);
          targetDate.setHours(
            parsedActiveCartela.hh,
            parsedActiveCartela.mm,
            parsedActiveCartela.ss,
            0
          );
          let targetMs = targetDate.getTime();
          if (targetMs - adjustedNowMs < -300_000) {
            targetMs += 86_400_000;
          }
          const diffSec = Math.ceil((targetMs - adjustedNowMs) / 1000);
          const formattedHhMmSs = `${String(parsedActiveCartela.hh).padStart(2, '0')}:${String(
            parsedActiveCartela.mm
          ).padStart(2, '0')}:${String(parsedActiveCartela.ss).padStart(2, '0')}`;
          cartelaCountdownBanner =
            diffSec <= 0
              ? `Largada ${formattedHhMmSs} · LARGADA! +${formatCountdownMinSec(diffSec)}`
              : `Largada ${formattedHhMmSs} · Regressivo ${formatCountdownMinSec(diffSec)}`;
        }

        return (
          <VelocityLivePresetScreen
            layoutId={activeReadyLayoutId}
            menuPosition="bottom"
            customWidgets={[]}
            activeTrackId={cartelaTrackKey}
            activeTrackName={activeStageBannerName}
            hasTraps={Boolean(activeTrack && activeTrack.traps.length > 0)}
            orderedTraps={orderedTraps}
            currentSplitTimesMs={currentSplitTimesMs}
            stageState={stageState}
            stageStartMs={stageStartMs}
            lastFinishedMs={lastFinishedMs}
            clockOffsetMs={navSettings.clockOffsetMs}
            speedKmh={speedKmh}
            displayedTripKm={displayedTripKm}
            totalDistKm={totalDistKm}
            liveRemainingDistM={liveRemainingDistM}
            liveHasRefDist={liveHasRefDist}
            liveProgressPct={liveProgressPct}
            liveIsFinishFlash={liveIsFinishFlash}
            bestRun={bestRun}
            fallbackRuns={trackRuns}
            optimalSummary={optimalSummary}
            lapNumber={trackRuns.length + 1}
            liveSamples={liveSamples}
            liveMapTrace={liveMapTrace}
            guideTrace={activeTrack?.baseTrace}
            currentPos={currentPos}
            headingDeg={headingDeg}
            liveHeadingUp={liveHeadingUp}
            onToggleHeadingUp={() => setLiveHeadingUp((v) => !v)}
            liveHeatmapMode={liveHeatmapMode}
            onToggleHeatmapMode={() =>
              setLiveHeatmapMode((m) => (m === 'accel' ? 'speed' : 'accel'))
            }
            isPro={isPro}
            showLiveMap={showLiveMap}
            liveMode={liveMode}
            gaugesNode={gaugesCenterNode}
            liveNotice={liveNotice}
            gpsError={gpsError}
            gpsStatusLabel={liveCompactGpsLabel}
            zeroSpeedLocked={zeroSpeedLocked && gpsActive}
            wakeLockActive={wakeLockActive}
            goproCompactButtonNode={renderLiveGoProCompactButton()}
            onBack={handleBackAction}
            onOpenConfigModal={() => setShowGpsSettingsModal(true)}
            onOpenSatcron={handleOpenLiveSatcron}
            onOpenAnalysis={handleOpenLiveAnalysis}
            onSelectTimerTab={() => {
              setShowLiveMap(false);
              setLiveMode('timer');
            }}
            onSelectMapTab={handleOpenLiveMapTab}
            onZeroTrip={() => {
              setTripDistKm(0);
              showToast('Hodômetro parcial (Trip) zerado.');
            }}
            onStartOrArmStage={handleStartOrArmStage}
            onForceManualStart={handleForceManualStart}
            onEditTripDistanceKm={handleEditTripFromLive}
            cartelaCountdownBanner={cartelaCountdownBanner}
          />
        );
      })()}

      {/* SCREEN: SESSIONS LIST (Clean RaceChrono Sessions List) */}
      {screen === 'sessions' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)]">
            <span className="text-xs text-[var(--ps-muted)]">
              Selecione uma sessão para Análise, Gráfico Sobreposto e Telemetria.
            </span>
            <button
              type="button"
              onClick={handleLoadDemoStage}
              className="inline-flex min-h-[38px] shrink-0 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-emerald)] hover:border-[var(--ps-emerald)]"
            >
              <Play className="h-3 w-3" />
              <span>Demo SS-01</span>
            </button>
          </div>

          {groupedSessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-6 text-center text-[var(--ps-text)] space-y-3">
              <History className="mx-auto h-9 w-9 text-[var(--ps-accent)] opacity-85" />
              <div className="space-y-1">
                <p className="text-sm font-extrabold text-[var(--ps-text)]">Nenhuma sessão gravada</p>
                <p className="mx-auto max-w-sm text-xs text-[var(--ps-muted)]">
                  Toque em <strong>START</strong> na tela inicial para cronometrar na pista ou carregue a sessão demonstrativa para explorar os gráficos.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setScreen('home')}
                  className="pitstop-btn-red inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold uppercase"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  <span>Ir para START</span>
                </button>
                <button
                  type="button"
                  onClick={handleLoadDemoStage}
                  className="pitstop-btn-metal inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold uppercase"
                >
                  <Play className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                  <span>Testar Demo SS-01</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--ps-border)] overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-text)]">
              {groupedSessions.map((sess) => (
                <button
                  key={sess.trackId}
                  type="button"
                  onClick={() => openSessionDetail(sess.trackId, 'analysis')}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[var(--ps-card)]"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-extrabold leading-tight text-[var(--ps-text)] sm:text-base">
                        {formatCleanTrackName(sess.trackName)}
                      </span>
                      <span className="shrink-0 font-mono text-xs font-bold text-[var(--ps-muted)] tabular-nums">
                        {sess.approxSizeKb} kB
                      </span>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 font-mono text-xs text-[var(--ps-muted)] tabular-nums">
                      <span>{formatShortDateTime(sess.latestAtMs)}</span>
                      <span>
                        {formatSessionDurationCompact(sess.totalDurationMs)} (
                        {sess.totalDistanceKm.toFixed(1)} km)
                      </span>
                    </div>

                    <p className="truncate text-xs font-semibold text-[var(--ps-muted)] tabular-nums">
                      {sess.runs.length} {sess.runs.length === 1 ? 'volta' : 'voltas'}, melhor:{' '}
                      <span className="font-mono text-[var(--ps-emerald)]">
                        {formatStageDuration(sess.bestTotalMs)}
                      </span>
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ps-muted)]" />
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* SCREEN: SESSION DETAIL — PURE 3-LAP TELEMETRY + HEATMAP + VIDEO HUD */}
      {screen === 'session-detail' && (() => {
        const lapSelectOptions = sessionRuns.map((r) => ({
          value: r.id,
          label: `#${r.runNumber} · ${formatStageDuration(r.totalMs)}`,
          badge: `${r.distanceKm.toFixed(2)} km`,
        }));
        const optionalLapOptions = [
          { value: '', label: 'Nenhuma' },
          ...lapSelectOptions,
        ];

        const lapSelectorElement = (
          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)]">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1 text-[11px] text-[var(--ps-muted)]">
                <span className="block font-bold text-[var(--ps-emerald)] uppercase">
                  Volta 1 (Ref · Verde)
                </span>
                <CockpitSelect
                  compact
                  value={lap1?.id || ''}
                  options={lapSelectOptions}
                  onChange={(val) => {
                    setLap1Id(val);
                  }}
                  placeholder="Selecionar volta"
                  triggerClassName="border-emerald-600/50 font-mono tabular-nums"
                  valueClassName="text-[var(--ps-emerald)]"
                />
              </div>

              <div className="space-y-1 text-[11px] text-[var(--ps-muted)]">
                <span className="block font-bold text-[var(--ps-danger)] uppercase">
                  Volta 2 (Comp. A · Vermelho)
                </span>
                <CockpitSelect
                  compact
                  value={lap2?.id || ''}
                  options={optionalLapOptions}
                  onChange={(val) => {
                    setLap2Id(val);
                  }}
                  placeholder="Nenhuma"
                  triggerClassName="border-red-600/50 font-mono tabular-nums"
                  valueClassName="text-[var(--ps-danger)]"
                />
              </div>

              <div className="space-y-1 text-[11px] text-[var(--ps-muted)]">
                <span className="block font-bold text-sky-500 uppercase">
                  Volta 3 (Comp. B · Ciano)
                </span>
                <CockpitSelect
                  compact
                  value={lap3?.id || ''}
                  options={optionalLapOptions}
                  onChange={(val) => {
                    setLap3Id(val);
                  }}
                  placeholder="Nenhuma"
                  triggerClassName="border-sky-600/50 font-mono tabular-nums"
                  valueClassName="text-sky-500"
                />
              </div>
            </div>
          </div>
        );

        return (
        <section className="space-y-3">
          {/* 2-Tab Bar (Análise | Vídeo HUD) */}
          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-[var(--ps-text)]">
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1">
              {(
                [
                  ['analysis', 'Análise', TrendingUp],
                  ['video', 'Vídeo HUD', Film],
                ] as const
              ).map(([tabId, label, Icon]) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => {
                    if (!isPro) {
                      openProUpgradeModal(
                        label === 'Vídeo HUD' ? 'Vídeo & Overlay HUD' : 'Datalogger & Telemetria de 3 Voltas',
                        'A análise detalhada e o Vídeo & Overlay HUD fazem parte do Plano PRO.'
                      );
                      return;
                    }
                    setDetailTab(tabId);
                  }}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-md px-2 text-xs font-bold ${
                    detailTab === tabId
                      ? 'pitstop-btn-red'
                      : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {detailTab !== 'analysis' && lapSelectorElement}

          {/* 5A. ANÁLISE PURA OFFLINE (Resumo + Matriz no Topo, Seletores e Mapa + Datalogger) */}
          {detailTab === 'analysis' && (
            <FuelTechAnalysisPanel
              sessionTrack={sessionTrack}
              sessionRuns={sessionRuns}
              sessionOptimal={sessionOptimal}
              lap1={lap1}
              lap2={lap2}
              lap3={lap3}
              lap1Samples={lap1Samples}
              lap2Samples={lap2Samples}
              lap3Samples={lap3Samples}
              lapSelectorSlot={lapSelectorElement}
              onSelectRefRun={(runId) => {
                setLap1Id(runId);
                if (lap2Id === runId) setLap2Id('');
                if (lap3Id === runId) setLap3Id('');
              }}
              onDeleteSession={() => {
                setRuns((prev) =>
                  prev.filter((r) => r.trackId !== selectedSessionTrackId)
                );
                setScreen('sessions');
              }}
              onDeleteRun={(runId) => {
                const remainingForTrack = runs
                  .filter((r) => r.trackId === selectedSessionTrackId && r.id !== runId)
                  .sort((a, b) => a.startedAtMs - b.startedAtMs);
                setRuns((prev) => prev.filter((r) => r.id !== runId));
                if (remainingForTrack.length === 0) {
                  setLap1Id('');
                  setLap2Id('');
                  setLap3Id('');
                  setScreen('sessions');
                  return;
                }
                const nextBest =
                  [...remainingForTrack].sort((a, b) => a.totalMs - b.totalMs)[0] ??
                  remainingForTrack[0];
                if (lap1Id === runId) {
                  setLap1Id(nextBest?.id || '');
                }
                if (lap2Id === runId || (lap1Id === runId && lap2Id === nextBest?.id)) {
                  setLap2Id('');
                }
                if (lap3Id === runId || (lap1Id === runId && lap3Id === nextBest?.id)) {
                  setLap3Id('');
                }
              }}
            />
          )}

          {/* 5B. SINCRONIZAÇÃO DE VÍDEO + OVERLAY TELEMETRIA (RACECHRONO PRO HUD + GOPRO WI-FI + AUTO-SYNC) */}
          {detailTab === 'video' && (
            <VideoHudOverlayPanel
              lap1={lap1}
              lap2={lap2}
              lap3={lap3}
              lap1Samples={lap1Samples}
              lap2Samples={lap2Samples}
              lap3Samples={lap3Samples}
              sessionRuns={sessionRuns}
              sessionOptimal={sessionOptimal}
            />
          )}
        </section>
        );
      })()}

      {/* SCREEN: TRACKS LIST (Clean Tracks Library — Map opens only when creating/editing) */}
      {screen === 'tracks' && (
        <section className="space-y-3">
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-[var(--ps-text)]">
            <button
              type="button"
              onClick={() => setShowNewTrackModal(true)}
              className="pitstop-btn-red inline-flex min-h-[42px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-extrabold"
            >
              <Plus className="h-4 w-4" />
              <span>Nova Pista</span>
            </button>

            <label className="inline-flex min-h-[42px] cursor-pointer items-center justify-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]">
              <Upload className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>KML/GPX</span>
              <input
                type="file"
                accept=".kml,.kmz,.gpx,.geojson,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImportGeoFile(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>

            <button
              type="button"
              onClick={handleLoadDemoStage}
              className="inline-flex min-h-[42px] items-center justify-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 text-xs font-bold text-[var(--ps-emerald)] hover:border-[var(--ps-emerald)]"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Demo SS-01</span>
            </button>
          </div>

          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-[var(--ps-accent)]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                  Pistas Salvas ({tracks.length})
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {(tracks.length > 0 || rallyWaypoints.length > 0) && (
                  <button
                    type="button"
                    onClick={() => {
                      const targetKey = activeTrack
                        ? `ss:${activeTrack.id}`
                        : tracks[0]
                          ? `ss:${tracks[0].id}`
                          : rallyWaypoints[0]
                            ? `wp:${rallyWaypoints[0].id}`
                            : '';
                      if (targetKey) {
                        setSurveyNavTrigger({ targetKey, token: Date.now() });
                      }
                      setScreen('survey');
                    }}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-sky-400/40 bg-sky-500/15 px-2.5 text-xs font-extrabold text-sky-300 hover:bg-sky-500/25"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <span>Deslocamento GPS</span>
                  </button>
                )}
                {activeTrack && (
                  <button
                    type="button"
                    onClick={() => setScreen('track-editor')}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                  >
                    <MapIcon className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                    <span>Abrir Mapa Atual</span>
                  </button>
                )}
              </div>
            </div>

            {tracks.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] p-6 text-center space-y-3">
                <Flag className="mx-auto h-8 w-8 text-[var(--ps-accent)] opacity-85" />
                <div className="space-y-1">
                  <p className="text-sm font-extrabold text-[var(--ps-text)]">
                    Nenhuma pista cadastrada
                  </p>
                  <p className="mx-auto max-w-sm text-xs text-[var(--ps-muted)]">
                    Crie sua especial no mapa satélite com traps de largada, parciais e chegada, ou carregue o exemplo SS-01.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowNewTrackModal(true)}
                    className="pitstop-btn-red inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold uppercase"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>+ Nova Pista</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleLoadDemoStage}
                    className="pitstop-btn-metal inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold uppercase"
                  >
                    <Play className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                    <span>Carregar Demo SS-01</span>
                  </button>
                </div>
              </div>
            ) : (
              (() => {
                const groupsMap = new Map<
                  string,
                  { key: string; name: string; isFolder: boolean; tracks: VelocityTrack[]; poiCount: number }
                >();
                for (const tr of tracks) {
                  const key = tr.folderId || (tr.folderName ? `fn:${tr.folderName}` : '__standalone__');
                  const name = tr.folderName || 'Especiais Avulsas';
                  const existing = groupsMap.get(key);
                  if (existing) {
                    existing.tracks.push(tr);
                  } else {
                    groupsMap.set(key, {
                      key,
                      name,
                      isFolder: Boolean(tr.folderName || tr.folderId),
                      tracks: [tr],
                      poiCount: 0,
                    });
                  }
                }
                for (const grp of groupsMap.values()) {
                  const uniqueWps = new Set<string>();
                  for (const tr of grp.tracks) {
                    for (const wp of tr.waypoints ?? []) {
                      uniqueWps.add(wp.id || wp.name);
                    }
                  }
                  if (grp.isFolder) {
                    for (const wp of rallyWaypoints) {
                      if (
                        (wp.folderId && grp.tracks.some((t) => t.folderId === wp.folderId)) ||
                        (wp.folderName && wp.folderName === grp.name)
                      ) {
                        uniqueWps.add(wp.id || wp.name);
                      }
                    }
                  }
                  grp.poiCount = uniqueWps.size;
                }
                const folderGroups = Array.from(groupsMap.values());

                return (
                  <div className="mt-3 space-y-2.5">
                    {folderGroups.map((group) => {
                      const isExpanded = expandedFolders[group.key] !== false;
                      const offlineMeta = offlinePacks.find((p) => p.folderKey === group.key) ?? null;
                      const isDownloadingThis = offlineDownloadingKey === group.key;
                      const groupWaypoints = rallyWaypoints.filter(
                        (wp) =>
                          (wp.folderId && group.tracks.some((t) => t.folderId === wp.folderId)) ||
                          (wp.folderName && wp.folderName === group.name)
                      );
                      return (
                        <div
                          key={group.key}
                          className="overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]"
                        >
                          <div className="flex flex-col gap-2 border-b border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedFolders((prev) => ({
                                  ...prev,
                                  [group.key]: !isExpanded,
                                }))
                              }
                              className="flex min-w-0 flex-1 items-start gap-2 text-left sm:items-center"
                            >
                              {isExpanded ? (
                                <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ps-muted)] sm:mt-0" />
                              ) : (
                                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ps-muted)] sm:mt-0" />
                              )}
                              <Folder className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ps-amber)] sm:mt-0" />
                              <div className="min-w-0 flex-1">
                                <p className="break-words text-xs font-black uppercase tracking-wide text-[var(--ps-text)] sm:text-sm">
                                  {group.name}
                                  <span className="ml-1.5 font-mono text-[10px] font-bold text-[var(--ps-muted)]">
                                    • {group.tracks.length}{' '}
                                    {group.tracks.length === 1 ? 'Especial' : 'Especiais'}
                                    {group.poiCount > 0 ? ` • ${group.poiCount} ${group.poiCount === 1 ? 'Ponto' : 'Pontos'}` : ''}
                                  </span>
                                </p>
                              </div>
                            </button>

                            <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-6 sm:pl-0">
                              <span
                                className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2 font-mono text-[10px] font-extrabold ${
                                  offlineMeta
                                    ? 'border-emerald-500/45 bg-emerald-500/15 text-[var(--ps-emerald)]'
                                    : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)]'
                                }`}
                              >
                                {offlineMeta
                                  ? `✅ Offline Pronto (${formatBytesCompact(offlineMeta.estimatedBytes)})`
                                  : 'Online'}
                              </span>

                              <button
                                type="button"
                                disabled={Boolean(offlineDownloadingKey)}
                                onClick={() =>
                                  void handleStartFolderOfflineDownload(
                                    group.key,
                                    group.name,
                                    group.tracks,
                                    groupWaypoints
                                  )
                                }
                                className="inline-flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 text-[10px] font-extrabold text-emerald-300 uppercase hover:bg-emerald-500/25 disabled:opacity-50"
                                title="Baixar quadrantes de satélite/ruas, elevação e rotas para uso 100% offline"
                              >
                                <Download className="h-3 w-3" />
                                <span>{offlineMeta ? 'Atualizar Offline' : 'Baixar Mapa Offline'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setOverviewFolderKey(group.key)}
                                className="inline-flex h-7 items-center gap-1 rounded-lg border border-sky-400/40 bg-sky-500/15 px-2.5 text-[10px] font-extrabold text-sky-300 uppercase hover:bg-sky-500/25"
                                title={`Abrir mapa completo de ${group.name}`}
                              >
                                <MapIcon className="h-3 w-3" />
                                <span>Ver Mapa da Prova</span>
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  setPendingDeleteFolder({
                                    key: group.key,
                                    name: group.name,
                                    trackIds: group.tracks.map((t) => t.id),
                                  })
                                }
                                className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2 text-[10px] font-bold text-red-400 hover:bg-red-500/20"
                                title={`Excluir pasta ${group.name}`}
                              >
                                <Trash2 className="h-3 w-3" />
                                <span>Excluir Pasta</span>
                              </button>
                            </div>
                          </div>

                          {isDownloadingThis && offlineDownloadProg && (
                            <div className="border-b border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 space-y-1.5">
                              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                                <span className="truncate font-bold text-emerald-300">
                                  {offlineDownloadProg.label} ({formatBytesCompact(offlineDownloadProg.bytesDownloaded)})
                                </span>
                                <button
                                  type="button"
                                  onClick={handleCancelFolderOfflineDownload}
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
                                      Math.round(
                                        (offlineDownloadProg.completed /
                                          Math.max(1, offlineDownloadProg.total)) *
                                          100
                                      )
                                    )}%`,
                                  }}
                                />
                              </div>
                            </div>
                          )}

                          {isExpanded && (
                            <div className="grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-2 lg:grid-cols-3">
                              {group.tracks.map((tr) => {
                                const isAct = tr.id === activeTrackId;
                                const passCount = runs.filter((r) => r.trackId === tr.id).length;
                                return (
                                  <div
                                    key={tr.id}
                                    className={`flex flex-col justify-between gap-2 rounded-xl border p-3 ${
                                      isAct
                                        ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                                        : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
                                    }`}
                                  >
                                    {editingTrackId === tr.id ? (
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="text"
                                          value={editingTrackName}
                                          onChange={(e) => setEditingTrackName(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleCommitRenameTrack(tr.id);
                                            if (e.key === 'Escape') setEditingTrackId(null);
                                          }}
                                          autoFocus
                                          className="w-full min-h-[34px] rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 text-xs text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => handleCommitRenameTrack(tr.id)}
                                          className="min-h-[34px] rounded bg-emerald-600 px-2.5 text-xs font-bold text-white"
                                        >
                                          OK
                                        </button>
                                      </div>
                                    ) : (
                                      <div>
                                        <div className="flex items-start justify-between gap-2">
                                          <p className="flex items-center gap-1.5 font-bold text-sm text-[var(--ps-text)] leading-tight">
                                            {tr.color && (
                                              <span
                                                aria-hidden="true"
                                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-white/40"
                                                style={{ backgroundColor: tr.color }}
                                              />
                                            )}
                                            <span>{formatCleanTrackName(tr.name)}</span>
                                          </p>
                                          {isAct && (
                                            <span className="font-mono text-[10px] font-extrabold text-[var(--ps-accent)] uppercase shrink-0">
                                              Ativa
                                            </span>
                                          )}
                                        </div>
                                        {(() => {
                                          const cleanKmDesc = extractTrackKmOnlyDescription(tr.description);
                                          return cleanKmDesc ? (
                                            <p className="mt-0.5 text-[11px] font-medium text-[var(--ps-amber)] leading-snug">
                                              {cleanKmDesc}
                                            </p>
                                          ) : null;
                                        })()}
                                        <p className="mt-1 font-mono text-[11px] text-[var(--ps-muted)]">
                                          {tr.mode === 'circuit' ? 'Circuito' : 'Especial'} ·{' '}
                                          {tr.traps.length} marcos · {tr.referenceDistanceKm.toFixed(2)} km ·{' '}
                                          {passCount} voltas
                                        </p>
                                      </div>
                                    )}

                                    <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-[var(--ps-border)]">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setActiveTrackId(tr.id);
                                          setUserPickedTrackManually(true);
                                          setScreen('track-editor');
                                        }}
                                        className="pitstop-btn-red inline-flex min-h-[34px] flex-1 items-center justify-center gap-1 rounded-lg px-2.5 text-xs font-bold"
                                      >
                                        <MapIcon className="h-3.5 w-3.5" />
                                        <span>Editar Mapa</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setActiveTrackId(tr.id);
                                          setUserPickedTrackManually(true);
                                          setScreen('home');
                                          showToast(`Pista "${formatCleanTrackName(tr.name)}" selecionada!`);
                                        }}
                                        className="min-h-[34px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-emerald)]"
                                      >
                                        Usar
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setActiveTrackId(tr.id);
                                          setUserPickedTrackManually(true);
                                          setSurveyNavTrigger({
                                            targetKey: `ss:${tr.id}`,
                                            token: Date.now(),
                                          });
                                          setScreen('survey');
                                        }}
                                        className="inline-flex h-[34px] items-center gap-1 rounded-lg border border-sky-400/40 bg-sky-500/15 px-2 text-xs font-bold text-sky-300 hover:bg-sky-500/25"
                                        title="Navegar até a Largada no Levantamento"
                                      >
                                        <Navigation className="h-3.5 w-3.5" />
                                        <span>Ir</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingTrackId(tr.id);
                                          setEditingTrackName(tr.name);
                                        }}
                                        className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                                        aria-label={`Renomear ${tr.name}`}
                                        title="Renomear"
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDuplicateTrack(tr)}
                                        className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                                        aria-label={`Duplicar ${tr.name}`}
                                        title="Duplicar"
                                      >
                                        <Copy className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setPendingDeleteTrack(tr)}
                                        className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:bg-red-500/15 hover:text-red-500"
                                        aria-label={`Excluir ${tr.name}`}
                                        title="Excluir"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()
            )}
          </div>
        </section>
      )}

      {/* SCREEN: TRACK MAP EDITOR (Opened ONLY when creating or editing a Track) */}
      {screen === 'track-editor' && (() => {
        const selectedTrap =
          orderedTraps.find((t) => t.id === selectedTrapId) ?? orderedTraps[0] ?? null;
        const activeBearing = selectedTrap ? selectedTrap.bearingDeg : draftBearingDeg;
        const activeWidthM = selectedTrap ? selectedTrap.widthM : newTrapWidthM;
        const activeUnidirectional = selectedTrap
          ? selectedTrap.unidirectional !== false
          : newTrapUnidirectional;
        const activeKind: TrapKind = placementKind ?? selectedTrap?.kind ?? 'split';

        const kindLabelMap: Record<TrapKind, string> = {
          start: 'Largada',
          finish: 'Chegada',
          start_finish: 'Largada / Chegada',
          split: 'Linha parcial',
        };

        return (
          <section className="space-y-2">
            <div className="overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] shadow-xl">
              {/* Controles Compactos em 3 Linhas Finas Acima do Mapa */}
              <div className="border-b border-[var(--ps-border)] bg-[var(--ps-card)] px-2.5 py-2 space-y-1.5">
                {/* Linha 1: Input compacto + Via GPS + Salvar na mesma linha */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={mapTrackNameDraft}
                    onChange={(e) => setMapTrackNameDraft(e.target.value)}
                    placeholder="Nome da pista (ex: SS-01 Serra Velha)"
                    aria-label="Nome da pista"
                    className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleOpenGpsMapping}
                    className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-xs font-extrabold text-white transition hover:bg-emerald-500 active:scale-[0.98]"
                    title="Mapear pista dirigindo via GPS em tela cheia"
                  >
                    <Navigation className="h-3.5 w-3.5 shrink-0" />
                    <span>Via GPS</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveCurrentTrackToLibrary}
                    className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-extrabold uppercase transition-colors ${
                      justSavedTrack
                        ? 'bg-emerald-600 text-white'
                        : 'pitstop-btn-red'
                    }`}
                  >
                    {justSavedTrack ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        <span>Salva</span>
                      </>
                    ) : (
                      <>
                        <Save className="h-3.5 w-3.5" />
                        <span>Salvar</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Linha 2: Barra segmentada fina de tipo de marco (h-8) */}
                <div className="grid grid-cols-4 gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
                  {(
                    [
                      ['start', 'Largada', 'text-[var(--ps-emerald)]'],
                      ['finish', 'Chegada', 'text-red-500'],
                      ['start_finish', 'Larg/Cheg', 'text-sky-500'],
                      ['split', 'Parcial', 'text-[var(--ps-amber)]'],
                    ] as const
                  ).map(([kindVal, label, tone]) => {
                    const isAct = activeKind === kindVal;
                    return (
                      <button
                        key={kindVal}
                        type="button"
                        onClick={() => {
                          if (placementKind !== null || !selectedTrap) {
                            setPlacementKind(kindVal);
                          } else {
                            handleChangeTrapKind(selectedTrap.id, kindVal);
                          }
                        }}
                        className={`h-8 rounded-md px-1 text-xs font-bold transition-colors ${
                          isAct
                            ? 'pitstop-btn-red'
                            : `${tone} hover:bg-[var(--ps-card)]`
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {/* Linha 3: Ângulo (slider fino) + Largura (m) + Unidirecional + Novo Marco na mesma linha */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <div className="flex min-w-[140px] flex-1 items-center gap-1.5">
                    <span className="shrink-0 font-mono text-[11px] font-bold text-[var(--ps-muted)]">
                      Âng.
                    </span>
                    <span className="w-11 shrink-0 font-mono text-[11px] font-black text-[var(--ps-amber)] tabular-nums">
                      {activeBearing.toFixed(1)}°
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={360}
                      step={0.5}
                      value={activeBearing}
                      aria-label="Ângulo do Marco"
                      onChange={(e) => {
                        const val = Number(e.target.value) % 360;
                        setDraftBearingDeg(val);
                        if (selectedTrap) {
                          handleUpdateTrapProps(selectedTrap.id, { bearingDeg: val });
                        }
                      }}
                      className="h-4 min-w-[60px] flex-1 cursor-pointer accent-lime-500"
                    />
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <label className="inline-flex items-center gap-1 text-[11px] text-[var(--ps-muted)]">
                      <span className="font-bold">Larg.</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={40}
                        max={150}
                        step={1}
                        value={Math.max(40, activeWidthM)}
                        onChange={(e) => {
                          const raw = Number(e.target.value);
                          if (!Number.isFinite(raw)) return;
                          const clamped = Math.min(150, Math.max(40, raw));
                          setNewTrapWidthM(clamped);
                          if (selectedTrap) {
                            handleUpdateTrapProps(selectedTrap.id, { widthM: clamped });
                          }
                        }}
                        aria-label="Largura do Marco em metros"
                        className="h-7 w-12 rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-center font-mono text-[11px] font-extrabold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none tabular-nums"
                      />
                      <span className="font-mono text-[10px]">m</span>
                    </label>

                    <label className="inline-flex cursor-pointer items-center gap-1 select-none">
                      <input
                        type="checkbox"
                        checked={activeUnidirectional}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setNewTrapUnidirectional(checked);
                          if (selectedTrap) {
                            handleUpdateTrapProps(selectedTrap.id, { unidirectional: checked });
                          }
                        }}
                        className="h-4 w-4 rounded border-[var(--ps-border-strong)] accent-lime-500 cursor-pointer"
                      />
                      <span className="text-[11px] font-bold text-[var(--ps-text)]">
                        Unidirecional
                      </span>
                    </label>

                    <button
                      type="button"
                      onClick={() =>
                        setPlacementKind((prev) => (prev ? null : activeKind))
                      }
                      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-extrabold transition-colors ${
                        placementKind
                          ? 'bg-amber-400 text-zinc-950'
                          : 'border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]'
                      }`}
                    >
                      <Plus className="h-3 w-3" />
                      <span>{placementKind ? 'No Mapa' : 'Marco'}</span>
                    </button>
                  </div>
                </div>
              </div>

              <VelocityMapboxView
                trackId={activeTrackId}
                editableTrace={editableTrace}
                traceColor={activeTrack?.color}
                waypoints={activeTrack?.waypoints}
                orderedTraps={orderedTraps}
                postEditIdx={postEditIdx}
                currentPos={currentPos}
                placementKind={placementKind}
                selectedTrapId={selectedTrap?.id ?? null}
                onMapClickPlaceTrap={(lat, lon) => handlePlaceTrapFromMap(lat, lon)}
                onSelectTrap={(id) => {
                  setSelectedTrapId(id);
                  setPlacementKind(null);
                }}
                onDragTrapEnd={handleDragTrapEnd}
                onRequestCenterPos={requestImmediateGpsPosition}
                requireLongPressForTraps
                containerClassName="relative h-[64vh] min-h-[64vh] w-full overflow-hidden bg-[#000000] sm:h-[68vh]"
                fullscreenOverlay={
                  <div className="rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 p-2 text-[var(--ps-text)] shadow-2xl backdrop-blur-md space-y-2">
                    {/* Colocar Marcos direto em Tela Cheia */}
                    <div className="grid grid-cols-4 gap-1">
                      {(
                        [
                          ['start', 'Largada', 'text-[var(--ps-emerald)] border-emerald-500/40'],
                          ['finish', 'Chegada', 'text-red-500 border-red-500/40'],
                          ['start_finish', 'Larg/Cheg', 'text-sky-500 border-sky-500/40'],
                          ['split', 'Parcial', 'text-[var(--ps-amber)] border-amber-500/40'],
                        ] as const
                      ).map(([kindVal, label, tone]) => {
                        const isPlacingThis = placementKind === kindVal;
                        return (
                          <button
                            key={kindVal}
                            type="button"
                            onClick={() =>
                              setPlacementKind((prev) =>
                                prev === kindVal ? null : kindVal
                              )
                            }
                            className={`inline-flex min-h-[36px] items-center justify-center gap-1 rounded-lg border px-1 text-[10px] font-extrabold uppercase transition-colors sm:text-xs ${
                              isPlacingThis
                                ? 'border-amber-300 bg-amber-400 text-zinc-950'
                                : `${tone} bg-[var(--ps-card-deep)] hover:bg-[var(--ps-card)]`
                            }`}
                          >
                            <Plus className="h-3 w-3 shrink-0" />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Rotação rápida, Largura, +GPS e Salvar Pista dentro da Tela Cheia */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex min-w-[140px] flex-1 items-center gap-2">
                        <span className="font-mono text-[10px] font-bold text-[var(--ps-amber)] tabular-nums shrink-0">
                          {activeBearing.toFixed(0)}°
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={360}
                          step={1}
                          value={activeBearing}
                          aria-label="Girar Marco em tela cheia"
                          onChange={(e) => {
                            const val = Number(e.target.value) % 360;
                            setDraftBearingDeg(val);
                            if (selectedTrap) {
                              handleUpdateTrapProps(selectedTrap.id, { bearingDeg: val });
                            }
                          }}
                          className="h-5 w-full cursor-pointer accent-lime-500"
                        />
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={40}
                          max={150}
                          value={Math.max(40, activeWidthM)}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            if (!Number.isFinite(raw)) return;
                            const clamped = Math.min(150, Math.max(40, raw));
                            setNewTrapWidthM(clamped);
                            if (selectedTrap) {
                              handleUpdateTrapProps(selectedTrap.id, { widthM: clamped });
                            }
                          }}
                          aria-label="Largura (m)"
                          className="h-8 w-12 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-center font-mono text-[11px] font-bold text-[var(--ps-text)]"
                        />

                        <button
                          type="button"
                          onClick={() => handleDropTrapAtPosition(activeKind)}
                          className="inline-flex h-8 items-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2 text-[10px] font-bold text-[var(--ps-emerald)]"
                          title="Capturar Marco na posição GPS atual"
                        >
                          +GPS
                        </button>

                        {selectedTrap && (
                          <button
                            type="button"
                            onClick={() => handleRemoveTrap(selectedTrap.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-red-500"
                            aria-label={`Remover ${selectedTrap.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={handleSaveCurrentTrackToLibrary}
                          className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[10px] font-extrabold uppercase ${
                            justSavedTrack
                              ? 'bg-emerald-600 text-white'
                              : 'pitstop-btn-red'
                          }`}
                        >
                          {justSavedTrack ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Save className="h-3.5 w-3.5" />
                          )}
                          <span>{justSavedTrack ? 'Salva' : 'Salvar'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                }
              />

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`h-3.5 w-3.5 shrink-0 rounded-full border border-white/70 ${
                      activeKind === 'start'
                        ? 'bg-emerald-500'
                        : activeKind === 'finish'
                          ? 'bg-[#E10600]'
                          : activeKind === 'start_finish'
                            ? 'bg-sky-400'
                            : 'bg-blue-600'
                    }`}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-extrabold text-[var(--ps-text)] sm:text-sm">
                      {selectedTrap ? selectedTrap.name : 'Novo marco (toque em Novo Marco)'}
                    </p>
                    <p className="font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                      {kindLabelMap[activeKind]}, {activeBearing.toFixed(1).replace('.', ',')} °,{' '}
                      {activeWidthM.toFixed(2).replace('.', ',')} m
                      {activeUnidirectional ? ' · Unidirecional' : ' · Bidirecional'} · Segure 0,4s no mapa p/ mover
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleDropTrapAtPosition(activeKind)}
                    className="min-h-[36px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-[11px] font-bold text-[var(--ps-emerald)] hover:border-[var(--ps-emerald)]"
                    title="Capturar Marco na posição GPS atual"
                  >
                    + GPS Atual
                  </button>
                  {selectedTrap && (
                    <button
                      type="button"
                      onClick={() => handleRemoveTrap(selectedTrap.id)}
                      className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:border-red-500 hover:text-red-500"
                      aria-label={`Remover ${selectedTrap.name}`}
                      title="Excluir Marco selecionado"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2.5">
              {editableTrace.length > 1 && (
                <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px] text-[var(--ps-muted)]">
                    <span>
                      Traçado #{postEditIdx + 1}/{editableTrace.length}
                    </span>
                    <span>{editableTrace[postEditIdx]?.distKm.toFixed(2)} km</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, editableTrace.length - 1)}
                    value={postEditIdx}
                    onChange={(e) => setPostEditIdx(Number(e.target.value))}
                    className="w-full accent-sky-500"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('start', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-emerald-500/40 bg-emerald-500/10 text-[11px] font-bold text-[var(--ps-emerald)]"
                    >
                      + Largada
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('split', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-amber-500/40 bg-amber-500/10 text-[11px] font-bold text-[var(--ps-amber)]"
                    >
                      + Parcial
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('finish', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-red-500/40 bg-red-500/10 text-[11px] font-bold text-red-500"
                    >
                      + Chegada
                    </button>
                  </div>
                </div>
              )}

              {orderedTraps.length > 0 && (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {orderedTraps.map((tr) => {
                    const isSel = tr.id === selectedTrap?.id;
                    return (
                      <div
                        key={tr.id}
                        onClick={() => {
                          setSelectedTrapId(tr.id);
                          setPlacementKind(null);
                        }}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                          isSel
                            ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                            : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-[var(--ps-text)] truncate">{tr.name}</p>
                          <p className="font-mono text-[10px] text-[var(--ps-muted)] tabular-nums">
                            {tr.bearingDeg.toFixed(1)}° · {tr.widthM}m ·{' '}
                            {tr.unidirectional !== false ? 'Unidir.' : 'Bidir.'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveTrap(tr.id);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded text-[var(--ps-muted)] hover:bg-red-500/15 hover:text-red-500"
                          aria-label={`Remover ${tr.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 border-t border-[var(--ps-border)] pt-2">
                {activeTrack && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('gpx')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-semibold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GPX</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('geojson')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-semibold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GeoJSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleStartOrArmStage}
                      className="pitstop-btn-red ml-auto inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      <span>Ir para Cronômetro</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        );
      })()}

      {/* SCREEN: GEAR SETTINGS & SENSORS (Top-right Gear Icon) */}
      {screen === 'settings' && (
        <section className="space-y-3">
          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 text-[var(--ps-text)] space-y-3">
            <div>
              <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                Receptor GPS &amp; Motor de Cronometragem
              </h3>
              <p className="text-xs text-[var(--ps-muted)]">
                Configure fonte GPS, detecção automática, tolerância HDOP e acelerômetro IMU.
              </p>
            </div>
            {gpsEngineSettingsBlock}
          </div>

          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 text-[var(--ps-text)]">
            {compactLayoutSelectorCard}
          </div>
        </section>
      )}

      {/* SCREEN: SURVEY / ODOMETER UNIFIED (Levantamento + Deslocamento + 3D) */}
      {(screen === 'survey' || screen === 'odometer') && (
        <SurveyCockpit
          isActive={isActive && (screen === 'survey' || screen === 'odometer')}
          externalTracks={tracks}
          externalWaypoints={rallyWaypoints}
          initialSelectedTrackId={activeTrackId}
          initialTransitTargetKey={surveyNavTrigger?.targetKey}
          forceOpenNavToken={surveyNavTrigger?.token}
        />
      )}

      {/* SCREEN: SATCRON LIVE RALLY RESULTS */}
      {screen === 'satcron' && <SatcronLivePanel />}

      {/* Modal: Create New Special Stage or Circuit Track */}
      {showNewTrackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 sm:p-5 text-[var(--ps-text)] shadow-2xl space-y-3">
            <h3 className="font-['Barlow_Condensed'] text-xl font-bold italic uppercase">
              Nova Pista / Especial
            </h3>
            <input
              type="text"
              value={newTrackName}
              onChange={(e) => setNewTrackName(e.target.value)}
              placeholder="Ex: SS-02 Erechim ou Kartódromo"
              className="w-full min-h-[42px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-sm text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
            />
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1">
              <button
                type="button"
                onClick={() => setNewTrackMode('circuit')}
                className={`min-h-[36px] rounded-md text-xs font-bold ${
                  newTrackMode === 'circuit'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)]'
                }`}
              >
                Circuito (Voltas)
              </button>
              <button
                type="button"
                onClick={() => setNewTrackMode('point-to-point')}
                className={`min-h-[36px] rounded-md text-xs font-bold ${
                  newTrackMode === 'point-to-point'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)]'
                }`}
              >
                Especial (SS)
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowNewTrackModal(false)}
                className="min-h-[40px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-4 text-xs font-semibold text-[var(--ps-muted)]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleCreateNewTrack}
                className="pitstop-btn-red min-h-[40px] rounded-lg px-4 text-xs font-extrabold"
              >
                Abrir no Mapa
              </button>
            </div>
          </div>
        </div>
      )}
      {showGpsSettingsModal && (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/80 p-2 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Configurações GPS"
        >
          <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ps-border)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Settings className="h-5 w-5 shrink-0 text-[var(--ps-accent)]" />
                <div className="min-w-0">
                  <h3 className="font-['Barlow_Condensed'] text-lg font-black tracking-wide uppercase sm:text-xl">
                    Receptor GPS &amp; Motor de Cronometragem
                  </h3>
                  <p className="truncate text-[11px] text-[var(--ps-muted)]">
                    Fonte de telemetria, detecção automática, HDOP e acelerômetro IMU
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGpsSettingsModal(false)}
                aria-label="Fechar configurações GPS"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
              {gpsEngineSettingsBlock}
              <div className="border-t border-[var(--ps-border)] pt-3">
                {compactLayoutSelectorCard}
              </div>
            </div>
          </div>
        </div>
      )}

      {showLayoutSelectorModal && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/80 p-2 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Selecionar Layout do Cockpit Ao Vivo"
        >
          <div className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ps-border)] px-4 py-3">
              <div className="min-w-0">
                <h3 className="font-['Barlow_Condensed'] text-lg font-black tracking-wide uppercase sm:text-xl">
                  Layout do Cockpit Ao Vivo
                </h3>
                <p className="truncate text-[11px] text-[var(--ps-muted)]">
                  Toque em qualquer modelo para aplicar imediatamente ({VELOCITY_COCKPIT_READY_PRESETS.length} layouts)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowLayoutSelectorModal(false)}
                aria-label="Fechar seletor de layouts"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 sm:p-4">
              {readyLayoutPickerBlock}
            </div>
          </div>
        </div>
      )}

      {showGoProControlModal && (
        <div
          className="fixed inset-0 z-[85] flex items-end justify-center bg-black/80 p-2 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Controle GoPro BLE"
        >
          <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--ps-border)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Camera className="h-5 w-5 shrink-0 text-[#E10600]" />
                <div className="min-w-0">
                  <h3 className="font-['Barlow_Condensed'] text-lg font-black tracking-wide uppercase sm:text-xl">
                    Controle GoPro BLE
                  </h3>
                  <p className="truncate text-[11px] text-[var(--ps-muted)]">
                    Controle manual de gravação, bateria e conexão BLE
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGoProControlModal(false)}
                aria-label="Fechar controle GoPro"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 sm:p-4">
              <GoProBlePanel />
            </div>
          </div>
        </div>
      )}
      {gpsMappingOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-black text-white"
            role="dialog"
            aria-modal="true"
            aria-label="Mapear Pista via GPS ao vivo"
          >
            {/* Mapa Satélite 100% Tela Cheia */}
            <div className="relative h-full w-full flex-1 overflow-hidden">
              <VelocityMapboxView
                trackId={`${activeTrack?.id || 'gps_map'}_live`}
                editableTrace={gpsMappingTrace}
                orderedTraps={orderedTraps}
                postEditIdx={Math.max(0, gpsMappingTrace.length - 1)}
                currentPos={currentPos}
                navigationMode={true}
                headingUp={gpsMappingHeadingUp}
                onToggleHeadingUp={() => setGpsMappingHeadingUp((v) => !v)}
                navHeadingDeg={headingDeg}
                isExternalFullscreen={true}
                hideBuiltInTopControls={true}
                zoomControlsBottomClass="bottom-16 sm:bottom-20"
                mapStyleIndex={gpsMappingStyleIdx}
                onCycleMapStyle={() => setGpsMappingStyleIdx((v) => (v + 1) % 3)}
                onRequestCenterPos={requestImmediateGpsPosition}
                containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
              />

              {/* Barra Superior Única (1 Linha Só) + Pílulas Discretas no Canto */}
              <div className="pointer-events-none absolute top-0 inset-x-0 z-[450] space-y-1.5 px-2.5 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-white/15 bg-black/40 px-2 py-1 shadow-lg backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => setGpsMappingOpen(false)}
                    aria-label="Voltar"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white hover:bg-white/20"
                  >
                    <ArrowLeft className="h-4 w-4 text-[#FF2A2A]" />
                  </button>

                  <input
                    type="text"
                    value={mapTrackNameDraft}
                    onChange={(e) => setMapTrackNameDraft(e.target.value)}
                    placeholder="Nome da especial..."
                    aria-label="Nome da pista"
                    className="h-8 min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-2.5 text-xs font-bold text-white placeholder:text-white/50 focus:border-emerald-400 focus:outline-none"
                  />

                  <span className="inline-flex h-8 shrink-0 items-center gap-1 px-1.5 font-mono text-[11px] font-bold tabular-nums">
                    <Satellite
                      className={`h-3.5 w-3.5 ${
                        gpsActive ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    />
                    <span className={gpsActive ? 'text-emerald-300' : 'text-amber-300'}>
                      {gpsActive ? `${satCount} SAT` : 'GPS'}
                    </span>
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      void handleMappingSaveTrack(gpsMappingPhase === 'finished');
                    }}
                    className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-3 text-xs font-extrabold uppercase transition ${
                      justSavedTrack || gpsMappingPhase === 'finished'
                        ? 'bg-emerald-600/90 text-white hover:bg-emerald-500'
                        : 'bg-[#E10600]/90 text-white hover:bg-red-600'
                    }`}
                  >
                    {justSavedTrack ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        <span>Salva</span>
                      </>
                    ) : (
                      <>
                        <Save className="h-3.5 w-3.5" />
                        <span>Salvar</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Linha de pílulas minúsculas: controles únicos do mapa à esquerda + micro-pílula de telemetria à direita */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="pointer-events-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        void requestImmediateGpsPosition();
                      }}
                      className="inline-flex h-6 items-center gap-1 rounded-full border border-white/20 bg-black/35 px-2 text-[10px] font-bold text-white/95 backdrop-blur-[2px] hover:bg-black/50"
                      title="Centralizar na minha posição GPS"
                    >
                      <Navigation className="h-2.5 w-2.5 text-emerald-400" />
                      <span>Minha Posição</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setGpsMappingStyleIdx((v) => (v + 1) % 3)}
                      className="inline-flex h-6 items-center gap-1 rounded-full border border-white/20 bg-black/35 px-2 text-[10px] font-bold text-white/95 backdrop-blur-[2px] hover:bg-black/50"
                      title="Alternar camada do mapa"
                    >
                      <Layers className="h-2.5 w-2.5 text-amber-400" />
                      <span>
                        {gpsMappingStyleIdx === 0
                          ? 'Satélite'
                          : gpsMappingStyleIdx === 1
                            ? 'Híbrido'
                            : 'Ruas'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setGpsMappingHeadingUp((v) => !v)}
                      className="inline-flex h-6 items-center gap-1 rounded-full border border-white/20 bg-black/35 px-2 text-[10px] font-bold text-white/95 backdrop-blur-[2px] hover:bg-black/50"
                      title="Alternar orientação do mapa"
                    >
                      <Compass
                        className={`h-2.5 w-2.5 ${
                          gpsMappingHeadingUp ? 'text-emerald-400' : 'text-sky-400'
                        }`}
                      />
                      <span>{gpsMappingHeadingUp ? 'Heading-Up' : 'Norte'}</span>
                    </button>
                  </div>

                  <div className="inline-flex h-6 items-center gap-1.5 rounded-full border border-white/20 bg-black/35 px-2.5 font-mono text-[10px] font-bold text-white backdrop-blur-[2px] tabular-nums">
                    <span>
                      {(gpsMappingTrace[gpsMappingTrace.length - 1]?.distKm ?? 0).toFixed(2)} km
                    </span>
                    <span className="text-white/45">·</span>
                    <span>{Math.round(speedKmh)} km/h</span>
                    <span className="text-white/45">·</span>
                    <span>{trackTrapSummary.splitsCount} parc.</span>
                  </div>
                </div>

                {gpsMappingPulse && (
                  <div className="flex justify-center">
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/50 bg-black/60 px-3 py-1 text-[11px] font-extrabold text-emerald-300 backdrop-blur-sm">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      <span>{gpsMappingPulse}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Botões Inferiores Finos e Ultratransparentes Rente à Borda Inferior */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[450] px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                <div className="pointer-events-auto mx-auto max-w-xl">
                  {gpsMappingPhase === 'ready' && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleMappingMarkStart();
                      }}
                      className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/30 bg-black/25 px-4 text-xs font-bold tracking-wide text-white uppercase backdrop-blur-[2px] transition hover:bg-black/40 active:scale-[0.98]"
                    >
                      <Flag className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      <span>Marcar Largada (GPS)</span>
                    </button>
                  )}

                  {gpsMappingPhase === 'recording' && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void handleMappingMarkSplit();
                        }}
                        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/30 bg-black/25 px-4 text-xs font-bold tracking-wide text-white uppercase backdrop-blur-[2px] transition hover:bg-black/40 active:scale-[0.98]"
                      >
                        <Plus className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span>Parcial (P{trackTrapSummary.splitsCount + 1})</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          void handleMappingMarkFinish();
                        }}
                        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/30 bg-black/25 px-4 text-xs font-bold tracking-wide text-white uppercase backdrop-blur-[2px] transition hover:bg-black/40 active:scale-[0.98]"
                      >
                        <Flag className="h-3.5 w-3.5 shrink-0 text-[#FF2A2A]" />
                        <span>Chegada (C)</span>
                      </button>
                    </div>
                  )}

                  {gpsMappingPhase === 'finished' && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          gpsMappingTraceRef.current = [];
                          setGpsMappingTrace([]);
                          setGpsMappingPhase('ready');
                          setGpsMappingPulse(null);
                        }}
                        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/30 bg-black/25 px-4 text-xs font-bold text-white uppercase backdrop-blur-[2px] transition hover:bg-black/40 active:scale-[0.98]"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Refazer</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleMappingSaveTrack(true);
                        }}
                        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-emerald-400/50 bg-black/25 px-4 text-xs font-bold text-emerald-300 uppercase backdrop-blur-[2px] transition hover:bg-black/40 active:scale-[0.98]"
                      >
                        <Save className="h-3.5 w-3.5" />
                        <span>Salvar Pista</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

      {pendingDeleteTrack &&
        createPortal(
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
            onClick={() => setPendingDeleteTrack(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-track-modal-title"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-5 text-[var(--ps-text)] shadow-2xl space-y-4"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/40 bg-red-500/15 text-red-500">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <h2
                    id="delete-track-modal-title"
                    className="text-sm font-extrabold text-[var(--ps-text)] leading-snug"
                  >
                    Excluir Pista
                  </h2>
                  <p className="text-xs text-[var(--ps-muted)] leading-relaxed">
                    Tem certeza que deseja excluir a pista &apos;
                    <span className="font-bold text-[var(--ps-text)]">
                      {formatCleanTrackName(pendingDeleteTrack.name)}
                    </span>
                    &apos;?
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingDeleteTrack(null)}
                  className="min-h-[44px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold uppercase tracking-wide text-[var(--ps-text)] hover:bg-[var(--ps-card-deep)] active:scale-[0.98]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const targetId = pendingDeleteTrack.id;
                    setPendingDeleteTrack(null);
                    handleDeleteTrack(targetId);
                  }}
                  className="min-h-[44px] rounded-xl bg-[#E10600] px-3 text-xs font-extrabold uppercase tracking-wide text-white shadow-lg hover:bg-red-700 active:scale-[0.98]"
                >
                  Sim, Excluir
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {pendingDeleteFolder &&
        createPortal(
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
            onClick={() => setPendingDeleteFolder(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-folder-modal-title"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-5 text-[var(--ps-text)] shadow-2xl space-y-4"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/40 bg-red-500/15 text-red-500">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <h2
                    id="delete-folder-modal-title"
                    className="text-sm font-extrabold text-[var(--ps-text)] leading-snug"
                  >
                    Excluir Pasta de Rally
                  </h2>
                  <p className="text-xs text-[var(--ps-muted)] leading-relaxed">
                    Excluir a pasta &apos;
                    <span className="font-bold text-[var(--ps-text)]">
                      {pendingDeleteFolder.name}
                    </span>
                    &apos; e todas as{' '}
                    <span className="font-bold text-[var(--ps-text)]">
                      {pendingDeleteFolder.trackIds.length}
                    </span>{' '}
                    especiais dentro dela?
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingDeleteFolder(null)}
                  className="min-h-[44px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold uppercase tracking-wide text-[var(--ps-text)] hover:bg-[var(--ps-card-deep)] active:scale-[0.98]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const idSet = new Set(pendingDeleteFolder.trackIds);
                    const remaining = tracks.filter((t) => !idSet.has(t.id));
                    setTracks(remaining);
                    setRuns((prev) => prev.filter((r) => !idSet.has(r.trackId)));
                    if (idSet.has(activeTrackId)) {
                      setActiveTrackId(remaining[0]?.id ?? '');
                      finishGateArmedRef.current = false;
                      stageStateRef.current = 'idle';
                      stageStartMsRef.current = null;
                      setStageState('idle');
                      setStageStartMs(null);
                      setLastFinishedMs(null);
                      setCurrentSplitTimesMs({});
                    }
                    setPendingDeleteFolder(null);
                    showToast(`Pasta "${pendingDeleteFolder.name}" excluída.`);
                  }}
                  className="min-h-[44px] rounded-xl bg-[#E10600] px-3 text-xs font-extrabold uppercase tracking-wide text-white shadow-lg hover:bg-red-700 active:scale-[0.98]"
                >
                  Sim, Excluir
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {pendingImportDecision &&
        pendingImportDecision.decisionQueue.length > 0 &&
        (() => {
          const currentTrk = pendingImportDecision.decisionQueue[0];
          const detectedPts = currentTrk.detectedSplitPoints ?? [];
          const hasDetected = detectedPts.length > 0;
          const totalInModal =
            pendingImportDecision.readyTracks.length +
            pendingImportDecision.decisionQueue.length;
          const currentStepNum = pendingImportDecision.readyTracks.length + 1;
          const previewNames = detectedPts
            .slice(0, 3)
            .map((p) => p.originalName)
            .join(', ');
          const extraCount = detectedPts.length - 3;

          return createPortal(
            <div className="fixed inset-0 z-[1010] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-splits-modal-title"
                className="w-full max-w-sm rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-5 text-[var(--ps-text)] shadow-2xl space-y-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--ps-accent)]/40 bg-[var(--ps-accent-soft)] text-[var(--ps-accent)]">
                    <Flag className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h2
                        id="import-splits-modal-title"
                        className="text-sm font-extrabold text-[var(--ps-text)] leading-snug"
                      >
                        {hasDetected
                          ? 'Pontos Detectados na Pista'
                          : 'Nenhuma Parcial Encontrada'}
                      </h2>
                      {pendingImportDecision.decisionQueue.length > 1 && (
                        <span className="shrink-0 rounded-md border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-muted)]">
                          {currentStepNum}/{totalInModal}
                        </span>
                      )}
                    </div>

                    <p className="truncate font-mono text-[11px] font-bold text-[var(--ps-amber)]">
                      {formatCleanTrackName(currentTrk.name)} •{' '}
                      {currentTrk.referenceDistanceKm.toFixed(2)} km
                    </p>

                    <p className="pt-0.5 text-xs text-[var(--ps-muted)] leading-relaxed">
                      {hasDetected ? (
                        <>
                          Encontramos{' '}
                          <span className="font-bold text-[var(--ps-text)]">
                            {detectedPts.length} ponto{detectedPts.length > 1 ? 's' : ''}
                          </span>{' '}
                          no arquivo ({previewNames}
                          {extraCount > 0 ? ` +${extraCount}` : ''}). Como deseja configurar as
                          parciais?
                        </>
                      ) : (
                        <>
                          Nenhuma parcial ou ponto encontrado nesta pista. Deseja gerar 4
                          parciais automaticamente?
                        </>
                      )}
                    </p>
                  </div>
                </div>

                {hasDetected ? (
                  <div className="space-y-2 pt-1">
                    <button
                      type="button"
                      onClick={() => resolvePendingImportDecision('use-kml')}
                      className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-[var(--ps-accent)] px-3 text-xs font-extrabold uppercase tracking-wide text-[var(--ps-accent-text)] shadow-lg transition hover:opacity-95 active:scale-[0.98]"
                    >
                      Usar Pontos do KML ({detectedPts.length})
                    </button>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => resolvePendingImportDecision('create-auto')}
                        className="min-h-[42px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-extrabold uppercase tracking-wide text-[var(--ps-text)] hover:border-[var(--ps-accent)] active:scale-[0.98]"
                      >
                        Criar Parciais
                      </button>
                      <button
                        type="button"
                        onClick={() => resolvePendingImportDecision('keep-lc')}
                        className="min-h-[42px] rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold uppercase tracking-wide text-[var(--ps-muted)] hover:text-[var(--ps-text)] active:scale-[0.98]"
                      >
                        Sem Parciais
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2.5 pt-1">
                    <button
                      type="button"
                      onClick={() => resolvePendingImportDecision('keep-lc')}
                      className="min-h-[44px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-bold uppercase tracking-wide text-[var(--ps-muted)] hover:text-[var(--ps-text)] active:scale-[0.98]"
                    >
                      Manter Só L e C
                    </button>
                    <button
                      type="button"
                      onClick={() => resolvePendingImportDecision('create-auto')}
                      className="min-h-[44px] rounded-xl bg-[var(--ps-accent)] px-3 text-xs font-extrabold uppercase tracking-wide text-[var(--ps-accent-text)] shadow-lg transition hover:opacity-95 active:scale-[0.98]"
                    >
                      Criar Parciais
                    </button>
                  </div>
                )}
              </div>
            </div>,
            document.body
          );
        })()}

      {/* Tela de Digitação da Hora de Largada Estilo Calculadora + Nome da SS */}
      {(() => {
        const calcTrack =
          (startTimeCalcTrackId ? tracks.find((tr) => tr.id === startTimeCalcTrackId) : null) ??
          activeTrack;
        const calcTrackKey = calcTrack?.id || 'live_free';
        const calcStageName = calcTrack ? formatCleanTrackName(calcTrack.name) : 'Especial Livre';
        return (
          <StartTimeCalculatorModal
            open={startTimeCalcModalOpen}
            stageName={calcStageName}
            initialTimeStr={cartelaTimesByTrack[calcTrackKey] ?? ''}
            clockOffsetMs={navSettings.clockOffsetMs}
            onCancel={() => {
              setStartTimeCalcModalOpen(false);
              if (startTimeCalcContext === 'prestart' && stageState === 'armed') {
                setPreStartModalOpen(true);
              }
            }}
            onSkip={() => {
              setCartelaTimesByTrack((prev) => {
                if (!(calcTrackKey in prev)) return prev;
                const next = { ...prev };
                delete next[calcTrackKey];
                return next;
              });
              setStartTimeCalcModalOpen(false);
              if (startTimeCalcContext === 'prestart' && stageState === 'armed') {
                setPreStartModalOpen(true);
              }
              showToast(`${calcStageName}: seguindo sem horário de largada.`);
            }}
            onConfirm={(hhMmSs) => {
              setCartelaTimesByTrack((prev) => ({
                ...prev,
                [calcTrackKey]: hhMmSs,
              }));
              setStartTimeCalcModalOpen(false);
              if (startTimeCalcContext === 'prestart' && stageState === 'armed') {
                setPreStartModalOpen(true);
                showToast(`Hora de largada salva (${hhMmSs}) · Contagem regressiva ativa!`);
              } else {
                showToast(`Hora de largada de ${calcStageName} salva: ${hhMmSs}`);
              }
            }}
          />
        );
      })()}

      {/* Card Flutuante de PRÉ-LARGADA (100% responsivo sem rolagem nem corte no topo) */}
      {preStartModalOpen &&
        stageState === 'armed' &&
        activeTrack &&
        (() => {
          const trackKey = activeTrack.id;
          const cartelaClockStr = cartelaTimesByTrack[trackKey] ?? '';
          const parsedCartela = parseStartTimeClock(cartelaClockStr);
          const adjustedNowMs = preStartNowMs + navSettings.clockOffsetMs;
          const startGate =
            activeTrack.traps.find((t) => t.kind === 'start' || t.kind === 'start_finish') ??
            activeTrack.traps[0];
          const distToStartM =
            currentPos && startGate
              ? Math.round(
                  haversineMetersVel(
                    currentPos.lat,
                    currentPos.lon,
                    startGate.lat,
                    startGate.lon
                  )
                )
              : null;

          const miniSvg = buildMiniTraceSvg(
            activeTrack.baseTrace && activeTrack.baseTrace.length >= 2
              ? activeTrack.baseTrace
              : activeTrack.traps,
            92,
            46,
            6
          );
          const stageDistKm =
            activeTrack.referenceDistanceKm > 0.05
              ? activeTrack.referenceDistanceKm
              : 0;

          let countdownDiffSec: number | null = null;
          if (parsedCartela) {
            const targetDate = new Date(adjustedNowMs);
            targetDate.setHours(parsedCartela.hh, parsedCartela.mm, parsedCartela.ss, 0);
            let targetMs = targetDate.getTime();
            if (targetMs - adjustedNowMs < -300_000) {
              targetMs += 86_400_000;
            }
            countdownDiffSec = Math.ceil((targetMs - adjustedNowMs) / 1000);
          }

          const isCountdownUrgent =
            countdownDiffSec !== null && countdownDiffSec > 0 && countdownDiffSec <= 10;
          const isCountdownHighlight =
            countdownDiffSec !== null && countdownDiffSec > 0 && countdownDiffSec <= 30;
          const isCountdownReady = countdownDiffSec !== null && countdownDiffSec <= 0;

          return createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Pré-Largada da Especial"
              className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md sm:p-5"
            >
              <div className="relative flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-24px)] w-full max-w-2xl flex-col justify-between gap-[clamp(6px,1.1dvh,12px)] overflow-hidden rounded-2xl border-2 border-[var(--ps-accent)] bg-[var(--ps-surface)] p-[clamp(10px,1.6dvh,20px)] text-[var(--ps-text)] shadow-[0_0_36px_rgba(0,0,0,0.65)] sm:rounded-3xl">
                {/* 1. Topo: Nome da Pista + Botão FECHAR */}
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-1.5">
                    <p className="font-mono text-[9px] font-extrabold tracking-widest text-[var(--ps-accent)] uppercase">
                      Pré-Largada Armada
                    </p>
                    <p className="truncate font-['Barlow_Condensed'] text-[clamp(1rem,2.5dvh,1.25rem)] font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                      {formatCleanTrackName(activeTrack.name)}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setPreStartModalOpen(false)}
                    className="inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold tracking-wider text-[var(--ps-text)] uppercase shadow active:scale-95"
                  >
                    <X className="h-4 w-4" />
                    <span>Fechar</span>
                  </button>
                </div>

                {/* 2. Bloco Central Principal: Relógio Oficial GPS + Mini-Traçado + Distância */}
                <div className="grid shrink-0 grid-cols-1 gap-[clamp(6px,1dvh,10px)] sm:grid-cols-[1fr_auto]">
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-[clamp(8px,1.4dvh,14px)] text-center shadow-inner">
                    <p className="font-mono text-[10px] font-extrabold tracking-[0.2em] text-[var(--ps-muted)] uppercase">
                      Relógio Oficial GPS
                    </p>
                    <p className="mt-0.5 font-mono text-[clamp(1.9rem,5.2dvh,3.4rem)] font-black leading-none tracking-tight text-[var(--ps-text)] tabular-nums">
                      {formatClockTime(adjustedNowMs)}
                    </p>
                    <p className="mt-1 font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                      Aguardando cruzar pórtico de largada
                    </p>
                  </div>

                  <div className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-2 sm:min-w-[160px] sm:flex-col sm:justify-center">
                    {miniSvg ? (
                      <svg
                        viewBox="0 0 92 46"
                        className="h-9 w-20 shrink-0 overflow-visible sm:h-11 sm:w-24"
                        aria-hidden="true"
                      >
                        <path
                          d={miniSvg.pathD}
                          fill="none"
                          stroke="var(--ps-accent)"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <circle cx={miniSvg.startPt.x} cy={miniSvg.startPt.y} r="3" fill="#10B981" />
                        <circle cx={miniSvg.endPt.x} cy={miniSvg.endPt.y} r="3" fill="var(--ps-text)" />
                      </svg>
                    ) : (
                      <Flag className="h-6 w-6 text-[var(--ps-accent)]" />
                    )}
                    <div className="text-right sm:text-center">
                      <p className="font-mono text-[9px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                        Extensão Total
                      </p>
                      <p className="font-mono text-[clamp(0.95rem,2.4dvh,1.25rem)] font-black text-[var(--ps-text)] tabular-nums">
                        {stageDistKm > 0 ? `${stageDistKm.toFixed(2).replace('.', ',')} km` : '--'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 3. Horário de Largada (Cartela) — Botão principal destacado alinhado com -1m e +1m */}
                <div className="shrink-0 space-y-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-2.5">
                  <p className="font-mono text-[10px] font-extrabold tracking-wider text-[var(--ps-muted)] uppercase">
                    Hora de Largada (Cartela)
                  </p>
                  <div className="flex items-stretch gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setCartelaTimesByTrack((prev) => ({
                          ...prev,
                          [trackKey]: shiftClockHhMm(prev[trackKey] || '', -1),
                        }))
                      }
                      className="inline-flex min-h-[44px] min-w-[48px] shrink-0 items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 font-mono text-xs font-extrabold text-[var(--ps-text)] shadow-sm transition-colors hover:border-[var(--ps-accent)] active:scale-95"
                    >
                      -1m
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setStartTimeCalcContext('prestart');
                        setStartTimeCalcTrackId(activeTrack.id);
                        setPreStartModalOpen(false);
                        setStartTimeCalcModalOpen(true);
                      }}
                      className={`flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border px-3 shadow-md transition-all active:scale-[0.98] ${
                        parsedCartela
                          ? 'border-[var(--ps-accent)]/60 bg-[var(--ps-card-deep)] hover:border-[var(--ps-accent)]'
                          : 'border-[var(--ps-accent)] bg-[var(--ps-card-deep)] hover:bg-[var(--ps-accent-soft)]'
                      }`}
                    >
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Clock className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
                        <span className="truncate font-mono text-[clamp(0.95rem,2.4dvh,1.2rem)] font-black tracking-tight text-[var(--ps-text)] tabular-nums">
                          {parsedCartela
                            ? `${String(parsedCartela.hh).padStart(2, '0')}:${String(
                                parsedCartela.mm
                              ).padStart(2, '0')}:${String(parsedCartela.ss).padStart(2, '0')}`
                            : 'DEFINIR HORÁRIO'}
                        </span>
                      </span>
                      {parsedCartela ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--ps-accent)]/50 bg-[var(--ps-accent-soft)] px-2 py-0.5 font-mono text-[10px] font-black tracking-wider text-[var(--ps-accent)] uppercase">
                          <Pencil className="h-2.5 w-2.5" />
                          <span>Editar</span>
                        </span>
                      ) : (
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setCartelaTimesByTrack((prev) => ({
                          ...prev,
                          [trackKey]: shiftClockHhMm(prev[trackKey] || '', 1),
                        }))
                      }
                      className="inline-flex min-h-[44px] min-w-[48px] shrink-0 items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 font-mono text-xs font-extrabold text-[var(--ps-text)] shadow-sm transition-colors hover:border-[var(--ps-accent)] active:scale-95"
                    >
                      +1m
                    </button>
                  </div>
                </div>

                {/* 4. Contagem Regressiva + Distância até Largada (lado a lado mesmo no mobile) */}
                <div className="grid shrink-0 grid-cols-2 gap-2">
                  <div
                    className={`flex flex-col items-center justify-center rounded-2xl border-2 px-2.5 py-[clamp(6px,1.2dvh,12px)] text-center transition-colors ${
                      isCountdownUrgent
                        ? 'animate-pulse border-red-500 bg-red-950/80 text-red-100'
                        : isCountdownHighlight
                          ? 'border-amber-400 bg-amber-500/15 text-[var(--ps-text)]'
                          : isCountdownReady
                            ? 'border-emerald-500 bg-emerald-500/15 text-[var(--ps-text)]'
                            : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                    }`}
                  >
                    <p className="font-mono text-[9px] font-extrabold tracking-wider uppercase opacity-80">
                      Regressivo Largada
                    </p>
                    <p className="mt-0.5 font-mono text-[clamp(1.15rem,3dvh,1.75rem)] font-black leading-tight tabular-nums">
                      {countdownDiffSec === null
                        ? 'Sem Horário'
                        : isCountdownReady
                          ? `GO! +${formatCountdownMinSec(countdownDiffSec)}`
                          : formatCountdownMinSec(countdownDiffSec)}
                    </p>
                  </div>

                  <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-[clamp(6px,1.2dvh,12px)] text-center">
                    <p className="font-mono text-[9px] font-extrabold tracking-wider text-[var(--ps-muted)] uppercase">
                      Até a Largada
                    </p>
                    <p className="mt-0.5 font-mono text-[clamp(1.15rem,3dvh,1.75rem)] font-black leading-tight text-[var(--ps-text)] tabular-nums">
                      {distToStartM === null
                        ? '--'
                        : distToStartM >= 1000
                          ? `${(distToStartM / 1000).toFixed(2).replace('.', ',')} km`
                          : `${distToStartM} m`}
                    </p>
                  </div>
                </div>

                {/* 5. Controle Rápido CÂMERAS GOPRO BLE */}
                <div className="flex shrink-0 items-center justify-between gap-2 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${
                        recordingGoProCount > 0
                          ? 'border-[#EF233C] bg-red-950/70'
                          : activeGoProsReady.length > 0
                            ? 'border-emerald-500/50 bg-emerald-500/15'
                            : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)]'
                      }`}
                    >
                      <Camera
                        className={`h-4 w-4 ${
                          recordingGoProCount > 0
                            ? 'text-[#EF233C]'
                            : activeGoProsReady.length > 0
                              ? 'text-emerald-400'
                              : 'text-[var(--ps-muted)]'
                        }`}
                      />
                    </span>
                    <div className="min-w-0 leading-tight">
                      <p className="font-mono text-[9px] font-extrabold tracking-wider text-[var(--ps-muted)] uppercase">
                        GoPro BLE
                      </p>
                      <p className="truncate text-[11px] font-extrabold text-[var(--ps-text)]">
                        {recordingGoProCount > 0
                          ? `● REC (${recordingGoProCount})${
                              recordingGoPros[0]
                                ? ` · ${formatGoProRecTimer(recordingGoPros[0].encodingDurationSec)}`
                                : ''
                            }`
                          : activeGoProsReady.length > 0
                            ? `${activeGoProsReady.length} Conectada(s)`
                            : savedMissingGoPros.length > 0
                              ? `${savedMissingGoPros.length} Salva(s) • Em espera`
                              : 'Nenhuma câmera'}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {activeGoProsReady.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!isPro) {
                            openProUpgradeModal(
                              'Automação de Câmeras GoPro BLE',
                              'O disparo multi-câmera via Bluetooth é um recurso exclusivo do Plano PRO.'
                            );
                            return;
                          }
                          void shutterAllGoPro(recordingGoProCount === 0);
                        }}
                        className={`inline-flex min-h-[34px] items-center gap-1 rounded-xl px-2.5 font-mono text-[10px] font-black uppercase ${
                          recordingGoProCount > 0
                            ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                            : 'bg-[#E10600] text-white shadow'
                        }`}
                      >
                        {recordingGoProCount > 0 ? (
                          <>
                            <span className="h-2 w-2 rounded-[2px] bg-[#FF2A2A] animate-pulse" />
                            <span>PARAR</span>
                          </>
                        ) : (
                          <>
                            <span className="h-2 w-2 rounded-full bg-white" />
                            <span>GRAVAR</span>
                          </>
                        )}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => {
                        if (!isPro) {
                          openProUpgradeModal(
                            'Automação de Câmeras GoPro BLE',
                            'O controle e pareamento de câmeras GoPro via Bluetooth fazem parte do Plano PRO.'
                          );
                          return;
                        }
                        setShowGoProControlModal(true);
                      }}
                      className="inline-flex min-h-[34px] items-center gap-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-[11px] font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                    >
                      <Settings2 className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
                      <span>{activeGoProsReady.length > 0 ? 'Painel' : 'Conectar'}</span>
                    </button>
                  </div>
                </div>

                {/* Ações Inferiores */}
                <div className="grid shrink-0 grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleForceManualStart}
                    className="flex min-h-[clamp(42px,5.6dvh,48px)] items-center justify-center gap-2 rounded-xl bg-[var(--ps-accent)] px-3 text-xs font-black tracking-wider text-[var(--ps-accent-text)] uppercase shadow-lg active:scale-[0.98] sm:text-sm"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    <span>Largada Manual</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreStartModalOpen(false)}
                    className="flex min-h-[clamp(42px,5.6dvh,48px)] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold tracking-wider text-[var(--ps-text)] uppercase active:scale-[0.98] sm:text-sm"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </div>,
            document.body
          );
        })()}

      {/* Card Flutuante de CHEGADA (100% responsivo sem rolagem nem corte no topo) */}
      {finishSummaryModal &&
        (() => {
          const finishMiniSvg = buildMiniTraceSvg(finishSummaryModal.tracePoints, 92, 44, 5);
          return createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Resumo da Chegada"
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md sm:p-5"
            >
              <div
                className={`relative flex max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-24px)] w-full max-w-2xl flex-col justify-between gap-[clamp(6px,1.1dvh,12px)] overflow-hidden rounded-2xl border-2 p-[clamp(10px,1.6dvh,20px)] text-white backdrop-blur-md sm:rounded-3xl ${
                  finishSummaryModal.isFaster
                    ? 'border-emerald-200/80 finish-modal-pulse-green'
                    : 'border-red-200/80 finish-modal-pulse-red'
                }`}
                style={{
                  backgroundColor: finishSummaryModal.isFaster
                    ? 'rgba(0, 230, 118, 0.90)'
                    : 'rgba(225, 6, 0, 0.90)',
                }}
              >
                {/* Header */}
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 rounded-xl bg-black/75 px-3 py-1.5 backdrop-blur-sm">
                    <p className="truncate font-['Barlow_Condensed'] text-[clamp(0.95rem,2.4dvh,1.15rem)] font-extrabold tracking-wide uppercase">
                      {finishSummaryModal.trackName} · Volta #{finishSummaryModal.runNumber}
                    </p>
                    <p className="truncate font-mono text-[10px] font-bold text-white/80 tabular-nums sm:text-[11px]">
                      Especial concluída · Distância {finishSummaryModal.distanceKm.toFixed(2).replace('.', ',')} km
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFinishSummaryModal(null)}
                    className="inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-xl bg-black/80 px-3 text-xs font-extrabold tracking-wider text-white uppercase shadow-lg active:scale-95"
                  >
                    <X className="h-4 w-4" />
                    <span>Fechar</span>
                  </button>
                </div>

                {/* Bloco Principal + Mini-Traçado Monocromático */}
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[clamp(6px,1dvh,10px)]">
                  <div className="relative w-full shrink-0 rounded-2xl border border-white/25 bg-black/80 px-3 py-[clamp(8px,1.5dvh,14px)] text-center shadow-2xl backdrop-blur-sm">
                    {finishMiniSvg && (
                      <div className="pointer-events-none absolute top-2.5 right-3 flex items-center justify-center opacity-85">
                        <svg
                          viewBox="0 0 92 44"
                          className="h-7 w-14 overflow-visible sm:h-10 sm:w-22"
                          aria-hidden="true"
                        >
                          <path
                            d={finishMiniSvg.pathD}
                            fill="none"
                            stroke="#E2E8F0"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <circle cx={finishMiniSvg.startPt.x} cy={finishMiniSvg.startPt.y} r="2.6" fill="#E2E8F0" />
                          <circle cx={finishMiniSvg.endPt.x} cy={finishMiniSvg.endPt.y} r="2.6" fill="#FFFFFF" />
                        </svg>
                      </div>
                    )}
                    <p className="font-mono text-[10px] font-extrabold tracking-widest text-white/75 uppercase">
                      Tempo Total da Prova
                    </p>
                    <p className="mt-0.5 font-mono text-[clamp(1.9rem,5.4dvh,3.4rem)] font-black leading-none tracking-tight text-white tabular-nums">
                      {formatStageDuration(finishSummaryModal.totalMs)}
                    </p>
                    <div className="mt-1.5 flex items-center justify-center">
                      <span
                        className={`inline-flex items-center rounded-xl px-3 py-1 font-mono text-[clamp(0.9rem,2.4dvh,1.35rem)] font-black tabular-nums ${
                          finishSummaryModal.isFaster
                            ? 'bg-[#00E676]/20 text-[#00E676]'
                            : 'bg-[#E10600]/25 text-[#FF5252]'
                        }`}
                      >
                        {finishSummaryModal.deltaVsBestMs === null
                          ? 'VOLTA DE REFERÊNCIA'
                          : `${formatFinishDeltaMs(finishSummaryModal.deltaVsBestMs)} ${
                              finishSummaryModal.isFaster ? 'MAIS RÁPIDO' : 'MAIS LENTO'
                            }`}
                      </span>
                    </div>
                  </div>

                  {/* Split Cards */}
                  {finishSummaryModal.splits.length > 0 && (
                    <div className="grid w-full shrink-0 grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {finishSummaryModal.splits.slice(0, 4).map((sp) => {
                        const splitFaster = sp.deltaMs === null ? true : sp.deltaMs <= 0;
                        return (
                          <div
                            key={sp.id}
                            className={`rounded-xl border-2 bg-black/80 px-2 py-1.5 text-center shadow ${
                              sp.deltaMs === null
                                ? 'border-white/30'
                                : splitFaster
                                  ? 'border-[#00E676]'
                                  : 'border-[#E10600]'
                            }`}
                          >
                            <p className="truncate font-mono text-[10px] font-extrabold text-white/75 uppercase">
                              {sp.label}
                            </p>
                            <p className="font-mono text-sm font-black text-white tabular-nums">
                              {sp.timeMs !== null ? formatStageDuration(sp.timeMs) : '--:--.--'}
                            </p>
                            <p
                              className={`font-mono text-[10px] font-black tabular-nums ${
                                sp.deltaMs === null
                                  ? 'text-white/60'
                                  : splitFaster
                                    ? 'text-[#00E676]'
                                    : 'text-[#FF5252]'
                              }`}
                            >
                              {sp.deltaMs !== null ? formatFinishDeltaMs(sp.deltaMs) : 'REF'}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Vel Máxima, Vel Média, Melhor Setor & Distância Total */}
                  <div className="grid w-full shrink-0 grid-cols-2 gap-1.5 sm:grid-cols-4">
                    <div className="rounded-xl border border-white/20 bg-black/80 px-2.5 py-1.5 text-center shadow">
                      <p className="font-mono text-[9px] font-bold tracking-wider text-white/75 uppercase">
                        Vel. Máxima
                      </p>
                      <p className="mt-0.5 font-mono text-[clamp(1rem,2.5dvh,1.35rem)] font-black text-white tabular-nums">
                        {finishSummaryModal.maxSpeedKmh}{' '}
                        <span className="text-[10px] font-bold text-white/70">km/h</span>
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/20 bg-black/80 px-2.5 py-1.5 text-center shadow">
                      <p className="font-mono text-[9px] font-bold tracking-wider text-white/75 uppercase">
                        Vel. Média
                      </p>
                      <p className="mt-0.5 font-mono text-[clamp(1rem,2.5dvh,1.35rem)] font-black text-white tabular-nums">
                        {finishSummaryModal.avgSpeedKmh}{' '}
                        <span className="text-[10px] font-bold text-white/70">km/h</span>
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/20 bg-black/80 px-2.5 py-1.5 text-center shadow">
                      <p className="font-mono text-[9px] font-bold tracking-wider text-white/75 uppercase">
                        Distância Total
                      </p>
                      <p className="mt-0.5 font-mono text-[clamp(1rem,2.5dvh,1.35rem)] font-black text-white tabular-nums">
                        {finishSummaryModal.distanceKm.toFixed(2).replace('.', ',')}{' '}
                        <span className="text-[10px] font-bold text-white/70">km</span>
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/20 bg-black/80 px-2.5 py-1.5 text-center shadow">
                      <p className="font-mono text-[9px] font-bold tracking-wider text-white/75 uppercase">
                        Melhor Setor
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[clamp(0.85rem,2.2dvh,1.1rem)] font-black text-[#00E676] tabular-nums">
                        {finishSummaryModal.bestSectorLabel && finishSummaryModal.bestSectorMs !== null
                          ? `${finishSummaryModal.bestSectorLabel} · ${formatStageDuration(
                              finishSummaryModal.bestSectorMs
                            )}`
                          : 'Único'}
                      </p>
                      {finishSummaryModal.bestSectorDeltaMs !== null && (
                        <p className="font-mono text-[9px] font-extrabold text-white/80 tabular-nums">
                          {formatFinishDeltaMs(finishSummaryModal.bestSectorDeltaMs)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bottom Actions */}
                <div className="w-full shrink-0 space-y-1.5">
                  {goproFleet.cameras.some((c) => c.connected || c.recording) && (
                    <button
                      type="button"
                      onClick={() => {
                        void shutterAllGoPro(false);
                        setFinishGoProStopped(true);
                      }}
                      className="flex min-h-[clamp(40px,5.5dvh,48px)] w-full items-center justify-center gap-2 rounded-xl border-2 border-white bg-black/85 px-4 text-xs font-black tracking-wider text-white uppercase shadow-xl active:scale-[0.98] sm:text-sm"
                    >
                      <Square className="h-3.5 w-3.5 fill-current text-[#E10600]" />
                      <span>
                        {finishGoProStopped
                          ? 'Gravação GoPro Interrompida'
                          : 'Parar Gravação GoPro'}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setFinishSummaryModal(null)}
                    className="flex min-h-[clamp(40px,5.5dvh,48px)] w-full items-center justify-center rounded-xl bg-black/85 px-4 text-xs font-extrabold tracking-wider text-white uppercase shadow-xl active:scale-[0.98] sm:text-sm"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            </div>,
            document.body
          );
        })()}

      {overviewFolderKey &&
        (() => {
          const matchingTracks = tracks.filter((tr) => {
            const key = tr.folderId || (tr.folderName ? `fn:${tr.folderName}` : '__standalone__');
            return key === overviewFolderKey;
          });
          if (matchingTracks.length === 0) return null;
          const folderName = matchingTracks[0]?.folderName || 'Especiais Avulsas';
          const folderWpsMap = new Map<string, GeoWaypoint>();
          for (const tr of matchingTracks) {
            for (const wp of tr.waypoints ?? []) {
              folderWpsMap.set(wp.id || wp.name, wp);
            }
          }
          for (const wp of rallyWaypoints) {
            if (
              (wp.folderId && matchingTracks.some((t) => t.folderId === wp.folderId)) ||
              (wp.folderName && wp.folderName === folderName)
            ) {
              folderWpsMap.set(wp.id || wp.name, wp);
            }
          }
          return (
            <RallyOverviewMapModal
              isOpen={true}
              rallyName={folderName}
              tracks={matchingTracks}
              waypoints={Array.from(folderWpsMap.values())}
              activeTrackId={activeTrackId}
              currentPos={currentPos}
              onClose={() => setOverviewFolderKey(null)}
              onSelectStage={(tr) => {
                setActiveTrackId(tr.id);
                setUserPickedTrackManually(true);
                setOverviewFolderKey(null);
                setScreen('home');
                showToast(`Especial "${formatCleanTrackName(tr.name)}" selecionada!`);
              }}
              onNavigateToStage={(tr) => {
                setActiveTrackId(tr.id);
                setUserPickedTrackManually(true);
                setOverviewFolderKey(null);
                setSurveyNavTrigger({
                  targetKey: `ss:${tr.id}`,
                  token: Date.now(),
                });
                setScreen('survey');
              }}
              onNavigateToWaypoint={(wp) => {
                setOverviewFolderKey(null);
                setSurveyNavTrigger({
                  targetKey: `wp:${wp.id}`,
                  token: Date.now(),
                });
                setScreen('survey');
              }}
            />
          );
        })()}
    </div>
  );
};
