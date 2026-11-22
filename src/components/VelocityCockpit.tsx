import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  Activity,
  ArrowLeft,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Compass,
  Copy,
  Cpu,
  Download,
  Film,
  Flag,
  Flame,
  FolderOpen,
  Gauge,
  History,
  Map as MapIcon,
  Pause,
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
import { OdometerCockpit } from './OdometerCockpit';
import { SatcronLivePanel } from './SatcronLivePanel';
import { SurveyCockpit } from './SurveyCockpit';
import { VelocityMapboxView } from './VelocityMapboxView';
import { useNavSettings } from '../utils/navSettings';
import {
  clearGoProFleetError,
  getGoProDisplayName,
  renameGoProInFleet,
  shutterAllGoPro,
  shutterSingleGoPro,
  sleepAllGoPro,
  toggleSingleGoProPower,
  useGoProFleet,
  wakeAllGoPro,
  wakeSavedGoProInFleet,
} from '../utils/goproBle';
import {
  autoDetectNearestTrack,
  bearingBetweenDeg,
  computeLapComparisonSummary,
  computeOptimalStage,
  computePredictiveDeltaSec,
  computeSampleGForces,
  createDemoSpecialStage,
  detectTrapCrossing,
  ensureAutoTrapsFromBaseTrace,
  ensureTraceGForces,
  exportTrackGeoJson,
  exportTrackGpx,
  formatDeltaSeconds,
  formatStageDuration,
  getOrderedTrackTraps,
  haversineMetersVel,
  inferNearestBaseTraceBearing,
  parseTrackFileToTrack,
  recalculateRunsForTrack,
  type LapComparisonSummary,
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
type VelDriveSource = 'gps' | 'simulator';

interface VelocityPrefs {
  autoDetectTrack: boolean;
  autoDetectRadiusM: number;
  autoSnapHdop: boolean;
  useDeviceImu: boolean;
}

const VEL_PREFS_KEY = 'pitstop_velocity_prefs_v3';
const GAUGE_PREFS_KEY = 'pitstop_velocity_gauges_v1';

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

const DEFAULT_VEL_PREFS: VelocityPrefs = {
  autoDetectTrack: true,
  autoDetectRadiusM: 35,
  autoSnapHdop: true,
  useDeviceImu: true,
};

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

function loadVelPrefs(): VelocityPrefs {
  try {
    const raw = localStorage.getItem(VEL_PREFS_KEY);
    if (!raw) return DEFAULT_VEL_PREFS;
    return { ...DEFAULT_VEL_PREFS, ...(JSON.parse(raw) as Partial<VelocityPrefs>) };
  } catch {
    return DEFAULT_VEL_PREFS;
  }
}

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

interface VelocityLiveStagePanelProps {
  activeTrackName: string;
  hasTraps: boolean;
  stageState: 'idle' | 'armed' | 'running' | 'finished';
  stageStartMs: number | null;
  lastFinishedMs: number | null;
  clockOffsetMs: number;
  speedKmh: number;
  displayedTripKm: number;
  totalDistKm: number;
  longG: number;
  latG: number;
  bestRun: VelocityRun | null;
  optimalSummary: OptimalStageSummary;
  lapNumber: number;
}

const VelocityLiveStagePanel: React.FC<VelocityLiveStagePanelProps> = ({
  activeTrackName,
  hasTraps,
  stageState,
  stageStartMs,
  lastFinishedMs,
  clockOffsetMs,
  speedKmh,
  displayedTripKm,
  totalDistKm,
  longG,
  latG,
  bestRun,
  optimalSummary,
  lapNumber,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalMs = stageState === 'running' ? 80 : 500;
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [stageState]);

  const currentStageElapsedMs =
    stageState === 'running' && stageStartMs !== null
      ? Math.max(0, nowMs - stageStartMs)
      : stageState === 'finished' && lastFinishedMs !== null
        ? lastFinishedMs
        : 0;

  const predictiveDeltaSec =
    stageState === 'running' && bestRun
      ? computePredictiveDeltaSec(totalDistKm, currentStageElapsedMs, bestRun)
      : null;

  const deltaClampedPct =
    predictiveDeltaSec === null
      ? 0
      : Math.min(50, Math.max(6, (Math.abs(predictiveDeltaSec) / 5) * 50));
  const isFaster = predictiveDeltaSec !== null && predictiveDeltaSec < -0.05;
  const isSlower = predictiveDeltaSec !== null && predictiveDeltaSec > 0.05;
  const clockAdjustedNow = nowMs + clockOffsetMs;

  const statusHeadline =
    stageState === 'armed'
      ? hasTraps
        ? 'WAITING FOR START'
        : 'WAITING FOR TRAP'
      : stageState === 'running'
        ? `VOLTA ${lapNumber}`
        : stageState === 'finished'
          ? 'FINALIZADA'
          : 'PRONTO';

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3 text-white shadow-xl sm:p-4">
      <div className="flex items-center justify-between font-mono text-[11px] sm:text-xs tabular-nums">
        <span className="font-bold text-emerald-400">RÁPIDO (-s)</span>
        <span
          className={`text-sm font-extrabold sm:text-lg ${
            isFaster
              ? 'text-emerald-400'
              : isSlower
                ? 'text-[#FF2A2A]'
                : 'text-[#C0C4C9]'
          }`}
        >
          DELTA {formatDeltaSeconds(predictiveDeltaSec)}
        </span>
        <span className="font-bold text-[#FF2A2A]">LENTO (+s)</span>
      </div>

      <div className="relative mt-1.5 h-4 w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#111214]">
        <div className="absolute inset-y-0 left-1/2 z-10 w-[2px] -translate-x-1/2 bg-zinc-400/80" />
        {isFaster && (
          <div
            className="absolute inset-y-0 right-1/2 bg-emerald-500 transition-all duration-150"
            style={{ width: `${deltaClampedPct}%` }}
          />
        )}
        {isSlower && (
          <div
            className="absolute inset-y-0 left-1/2 bg-[#E10600] transition-all duration-150"
            style={{ width: `${deltaClampedPct}%` }}
          />
        )}
      </div>

      <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-zinc-800/90 bg-[#050608] py-5 px-3 text-center sm:py-6">
        <div className="flex flex-wrap items-center justify-center gap-1.5 font-mono text-[11px] font-bold tracking-wider uppercase text-[#B5B5B5]">
          <span className="truncate max-w-[190px] sm:max-w-xs text-white">
            {activeTrackName}
          </span>
          <span aria-hidden="true">·</span>
          <span
            className={
              stageState === 'running'
                ? 'text-emerald-400'
                : stageState === 'armed'
                  ? 'text-amber-300'
                  : 'text-[#C0C4C9]'
            }
          >
            {statusHeadline}
          </span>
        </div>

        <div
          className={`mt-2 font-mono text-5xl font-extrabold tracking-tight tabular-nums sm:text-7xl ${
            stageState === 'running'
              ? 'text-white'
              : stageState === 'finished'
                ? 'text-emerald-400'
                : 'text-[#C0C4C9]'
          }`}
        >
          {formatStageDuration(currentStageElapsedMs)}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-xs text-[#C0C4C9] tabular-nums sm:text-sm">
          <span>
            Vel <strong className="text-white text-sm sm:text-base">{Math.round(speedKmh)}</strong> km/h
          </span>
          <span>
            Trip <strong className="text-amber-300 text-sm sm:text-base">{displayedTripKm.toFixed(2)}</strong> km
          </span>
          <span>
            G <strong className={longG < -0.1 ? 'text-[#FF4D47]' : 'text-emerald-400'}>
              {longG >= 0 ? `+${longG.toFixed(2)}` : longG.toFixed(2)}
            </strong> / {latG.toFixed(2)}
          </span>
          <span>
            CH <strong className="text-white text-sm sm:text-base">{formatClockTime(clockAdjustedNow)}</strong>
          </span>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono tabular-nums">
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Última</p>
          <p className="mt-0.5 text-sm font-extrabold text-white sm:text-base">
            {formatStageDuration(optimalSummary.lastRunTotalMs)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-emerald-400 uppercase">Melhor</p>
          <p className="mt-0.5 text-sm font-extrabold text-emerald-400 sm:text-base">
            {formatStageDuration(optimalSummary.bestRunTotalMs)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-2 text-center">
          <p className="text-[10px] font-bold text-amber-400 uppercase">Ideal</p>
          <p className="mt-0.5 text-sm font-extrabold text-amber-300 sm:text-base">
            {formatStageDuration(optimalSummary.optimalTotalMs)}
          </p>
        </div>
      </div>
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
        <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3.5 text-center">
          <p className="text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
            Horário Oficial (CH)
          </p>
          <p className="mt-1.5 font-mono text-2xl font-extrabold text-emerald-400 tabular-nums sm:text-4xl">
            {formatClockTime(nowMs + clockOffsetMs)}
          </p>
          <p className="mt-1 font-mono text-[10px] text-zinc-400">GPS SYNC</p>
        </div>
      )}

      {showStageTime && (
        <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3.5 text-center">
          <p className="text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
            Tempo Especial
          </p>
          <p className="mt-1.5 font-mono text-2xl font-extrabold text-white tabular-nums sm:text-4xl">
            {formatStageDuration(elapsed)}
          </p>
          <p className="mt-1 font-mono text-[10px] text-zinc-400">
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
  const [navSettings] = useNavSettings();
  const [screen, setScreen] = useState<VelocityScreen>('home');
  const [liveMode, setLiveMode] = useState<LivePanelMode>('timer');
  const [source, setSource] = useState<VelDriveSource>('gps');
  const [velPrefs, setVelPrefs] = useState<VelocityPrefs>(() => loadVelPrefs());

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
  const [totalDistKm, setTotalDistKm] = useState(0);
  const [tripDistKm, setTripDistKm] = useState(0);
  const [tripTargetKm, setTripTargetKm] = useState<number | null>(null);
  const [tripRegressive, setTripRegressive] = useState(false);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);
  const [liveLongG, setLiveLongG] = useState(0);
  const [liveLatG, setLiveLatG] = useState(0);

  // Simulator & Track Map Editor state
  const [simPlaying, setSimPlaying] = useState(false);
  const [simMultiplier, setSimMultiplier] = useState(1);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackMode, setNewTrackMode] = useState<TrackMode>('circuit');
  const [showNewTrackModal, setShowNewTrackModal] = useState(false);
  const [newTrapWidthM, setNewTrapWidthM] = useState(25);
  const [newTrapUnidirectional, setNewTrapUnidirectional] = useState(true);
  const [draftBearingDeg, setDraftBearingDeg] = useState(0);
  const [placementKind, setPlacementKind] = useState<TrapKind | null>(null);
  const [selectedTrapId, setSelectedTrapId] = useState<string | null>(null);
  const [postEditIdx, setPostEditIdx] = useState(0);
  const [showGaugeConfig, setShowGaugeConfig] = useState(false);
  const [gaugeVisibility, setGaugeVisibility] = useState<GaugeVisibility>(() => loadGaugePrefs());
  const [statusFeedback, setStatusFeedback] = useState<string | null>(null);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [mapTrackNameDraft, setMapTrackNameDraft] = useState('');
  const [justSavedTrack, setJustSavedTrack] = useState(false);

  // Session Analysis Detail (Analysis+AI as primary view, plus Heatmap & Video HUD)
  const [selectedSessionTrackId, setSelectedSessionTrackId] = useState<string>('');
  const [detailTab, setDetailTab] = useState<'analysis' | 'heatmap' | 'video'>('analysis');
  const [heatmapMode, setHeatmapMode] = useState<'speed' | 'accel'>('accel');
  const [lapAId, setLapAId] = useState<string>('');
  const [lapBId, setLapBId] = useState<string>('');
  const [replayIdx, setReplayIdx] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoOffsetMs, setVideoOffsetMs] = useState(0);
  const [videoHudSampleIdx, setVideoHudSampleIdx] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [coachLoading, setCoachLoading] = useState(false);
  const [coachAdvice, setCoachAdvice] = useState<string | null>(null);
  const [coachError, setCoachError] = useState<string | null>(null);

  const goproFleet = useGoProFleet();
  const [goproDrawerOpen, setGoproDrawerOpen] = useState(false);
  const [editingGoProId, setEditingGoProId] = useState<string | null>(null);
  const [editingGoProName, setEditingGoProName] = useState('');
  const [showLiveMap, setShowLiveMap] = useState(true);
  const [liveHeadingUp, setLiveHeadingUp] = useState(true);
  const [liveHeatmapMode, setLiveHeatmapMode] = useState<'accel' | 'speed'>('accel');

  const tracksRef = useRef<VelocityTrack[]>(tracks);
  tracksRef.current = tracks;
  const calFactorRef = useRef(navSettings.calibrationPct / 100);
  calFactorRef.current = navSettings.calibrationPct / 100;
  const velPrefsRef = useRef(velPrefs);
  velPrefsRef.current = velPrefs;

  const prevSampleRef = useRef<VelocitySample | null>(null);
  const imuAccelRef = useRef<{ longG: number; latG: number } | null>(null);
  const stageStateRef = useRef(stageState);
  stageStateRef.current = stageState;
  const stageStartMsRef = useRef(stageStartMs);
  stageStartMsRef.current = stageStartMs;
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

  useEffect(() => {
    try {
      localStorage.setItem(VEL_PREFS_KEY, JSON.stringify(velPrefs));
    } catch {
      // Ignore storage error
    }
  }, [velPrefs]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

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
    if (!isActive || (!isRecording && stageState !== 'running' && stageState !== 'armed')) {
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
  }, [isActive, isRecording, stageState]);

  const activeTrack = useMemo(
    () => tracks.find((t) => t.id === activeTrackId) ?? null,
    [tracks, activeTrackId]
  );

  useEffect(() => {
    setMapTrackNameDraft(activeTrack?.name ?? '');
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
      const trackName = trk?.name || 'Especial Avulsa';
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
      rearmAfterFinish = false
    ) => {
      const startMs = stageStartMsRef.current;
      if (!startMs) return;
      const elapsedTotal = Math.max(100, finishedAtMs - startMs);
      const samples = ensureTraceGForces([...liveSamplesRef.current]);
      const distKm = totalDistRef.current;
      const avgSpeed = elapsedTotal > 0 ? distKm / (elapsedTotal / 3600000) : 0;

      const targetTrackId = activeTrack?.id || 'free_stage';
      const nextNum = runs.filter((r) => r.trackId === targetTrackId).length + 1;

      const newRun: VelocityRun = {
        id: `run_${Date.now()}_${nextNum}`,
        trackId: targetTrackId,
        runNumber: nextNum,
        startedAtMs: startMs,
        finishedAtMs,
        totalMs: elapsedTotal,
        splitTimesMs: splitsOverride ?? currentSplitTimesRef.current,
        maxSpeedKmh: Math.round(maxSpeedRef.current),
        avgSpeedKmh: Math.round(avgSpeed),
        distanceKm: Number(distKm.toFixed(3)),
        samples,
      };
      setRuns((prev) => [newRun, ...prev]);

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

      setLastFinishedMs(elapsedTotal);
      if (continueNextLap) {
        setStageStartMs(finishedAtMs);
        setStageState('running');
        setTotalDistKm(0);
        setTripDistKm(0);
        setMaxSpeedKmh(0);
        setCurrentSplitTimesMs({});
        setLiveSamples([]);
        showToast(`Volta #${nextNum}: ${formatStageDuration(elapsedTotal)}`);
      } else if (rearmAfterFinish) {
        setStageStartMs(null);
        setStageState('armed');
        setTotalDistKm(0);
        setTripDistKm(0);
        setMaxSpeedKmh(0);
        setCurrentSplitTimesMs({});
        setLiveSamples([]);
        setIsRecording(true);
        showToast(
          `Chegada #${nextNum}: ${formatStageDuration(elapsedTotal)} · Armado para próxima!`
        );
      } else {
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
      rawDopplerSpeedKmh?: number | null;
      accuracyM: number | null;
      headingDeg: number | null;
      altitudeM: number | null;
      timestampMs: number;
    }) => {
      // Filtro rigoroso de precisão GPS (descarta pacotes > 20m para evitar saltos fora da estrada)
      setGpsAccuracyM(fix.accuracyM);
      setGpsActive(true);
      if (source === 'gps' && fix.accuracyM !== null && fix.accuracyM > 20) {
        setGpsError(`Sinal GPS fraco (±${fix.accuracyM}m > 20m) — aguardando precisão melhor.`);
        return;
      }

      setCurrentPos({ lat: fix.lat, lon: fix.lon });
      setAltitudeM(fix.altitudeM);
      setGpsError(null);

      const prev = prevSampleRef.current;
      const stepM = prev ? haversineMetersVel(prev.lat, prev.lon, fix.lat, fix.lon) : 0;
      const dtSec = prev ? (fix.timestampMs - prev.timestampMs) / 1000 : 0;
      const geomSpeedKmh =
        prev && dtSec > 0.05 && dtSec < 15 && stepM < 500 ? (stepM / dtSec) * 3.6 : 0;

      let resolvedSpeedKmh = fix.speedKmh;
      if (source === 'gps') {
        const doppler =
          typeof fix.rawDopplerSpeedKmh === 'number' && fix.rawDopplerSpeedKmh > 0
            ? fix.rawDopplerSpeedKmh
            : fix.speedKmh > 0
              ? fix.speedKmh
              : null;
        const blended =
          doppler !== null
            ? geomSpeedKmh > 0
              ? 0.7 * doppler + 0.3 * geomSpeedKmh
              : doppler
            : geomSpeedKmh;

        // Deadzone anti-ruído estacionário
        if (
          (prev && stepM < 1.2) ||
          blended < 2.0 ||
          (blended < 4.0 && (fix.accuracyM ?? 0) > 15)
        ) {
          resolvedSpeedKmh = 0;
        } else {
          resolvedSpeedKmh = blended;
        }
      }
      setSpeedKmh(resolvedSpeedKmh);

      // Auto-detecção exclusiva pela Largada (raio 35m) + Auto-armar (WAITING FOR START)
      let detectedTrackOverride: VelocityTrack | null = null;
      if (
        velPrefsRef.current.autoDetectTrack &&
        !userPickedTrackManually &&
        stageStateRef.current !== 'running' &&
        tracksRef.current.length > 0
      ) {
        const hitTrack = autoDetectNearestTrack(
          fix.lat,
          fix.lon,
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
            setStageState('armed');
          }
        }
      }

      const trackForCrossing = detectedTrackOverride ?? activeTrack;

      let deltaDistKm = 0;
      let resolvedHeading: number | null = prev?.headingDeg ?? null;

      if (fix.headingDeg !== null && resolvedSpeedKmh >= 4) {
        resolvedHeading = fix.headingDeg;
      } else if (prev && stepM >= 1.5 && stepM < 500) {
        resolvedHeading = bearingBetweenDeg(prev.lat, prev.lon, fix.lat, fix.lon);
      }

      if (prev && stepM >= 0.4 && stepM < 500 && resolvedSpeedKmh > 0) {
        deltaDistKm = (stepM / 1000) * calFactorRef.current;
      }
      if (resolvedHeading !== null) {
        setHeadingDeg(Math.round(resolvedHeading));
      }

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
      setLiveLatG(accelLatG);

      const nextTotalDist = totalDistRef.current + deltaDistKm;
      if (isRecording || stageStateRef.current === 'running') {
        setTotalDistKm(nextTotalDist);
        setTripDistKm((t) => t + deltaDistKm);
      } else if (stageStateRef.current === 'armed') {
        setTripDistKm((t) => t + deltaDistKm);
      }

      if (
        resolvedSpeedKmh > maxSpeedRef.current &&
        (isRecording || stageStateRef.current === 'running')
      ) {
        setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
      }

      let activeStartMs = stageStartMsRef.current;
      let nextStageState = stageStateRef.current;
      const updatedSplits = { ...currentSplitTimesRef.current };

      if (
        trackForCrossing &&
        prev &&
        (nextStageState === 'armed' || nextStageState === 'running')
      ) {
        const ordered = getOrderedTrackTraps(trackForCrossing);
        let startedThisFix = false;

        for (const trap of ordered) {
          const hit = detectTrapCrossing(
            { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
            { lat: fix.lat, lon: fix.lon, timestampMs: fix.timestampMs },
            trap,
            {
              hdopAccuracyM: fix.accuracyM,
              autoSnap: velPrefsRef.current.autoSnapHdop,
            }
          );
          if (!hit) continue;

          if (
            (trap.kind === 'start' || trap.kind === 'start_finish') &&
            nextStageState === 'armed'
          ) {
            startedThisFix = true;
            activeStartMs = hit.crossTimestampMs;
            nextStageState = 'running';
            setStageStartMs(hit.crossTimestampMs);
            setStageState('running');
            setIsRecording(true);
            setTotalDistKm(0);
            setTripDistKm(0);
            setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
            setCurrentSplitTimesMs({});
            window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
            showToast(`Largada automática (${trap.name})`);
          } else if (
            trap.kind === 'start_finish' &&
            nextStageState === 'running' &&
            activeStartMs !== null &&
            hit.crossTimestampMs - activeStartMs >= 6000
          ) {
            const lapMs = hit.crossTimestampMs - activeStartMs;
            updatedSplits[trap.id] = lapMs;
            setCurrentSplitTimesMs({ ...updatedSplits });
            finalizeRun(hit.crossTimestampMs, updatedSplits, true, false);
            activeStartMs = hit.crossTimestampMs;
          } else if (
            trap.kind === 'split' &&
            nextStageState === 'running' &&
            activeStartMs !== null &&
            updatedSplits[trap.id] === undefined
          ) {
            const splitMs = Math.max(0, hit.crossTimestampMs - activeStartMs);
            updatedSplits[trap.id] = splitMs;
            setCurrentSplitTimesMs({ ...updatedSplits });
            showToast(`${trap.name}: ${formatStageDuration(splitMs)}`);
          } else if (
            trap.kind === 'finish' &&
            nextStageState === 'running' &&
            activeStartMs !== null
          ) {
            const finMs = Math.max(100, hit.crossTimestampMs - activeStartMs);
            updatedSplits[trap.id] = finMs;
            setCurrentSplitTimesMs({ ...updatedSplits });
            finalizeRun(hit.crossTimestampMs, updatedSplits, false, true);
            nextStageState = 'armed';
            activeStartMs = null;
          }
        }

        // Fallback de segurança por proximidade (< 12m da Largada com velocidade >= 4 km/h)
        if (!startedThisFix && nextStageState === 'armed' && resolvedSpeedKmh >= 4) {
          const startGate = ordered.find(
            (t) => t.kind === 'start' || t.kind === 'start_finish'
          );
          if (
            startGate &&
            haversineMetersVel(fix.lat, fix.lon, startGate.lat, startGate.lon) <= 12
          ) {
            activeStartMs = fix.timestampMs;
            nextStageState = 'running';
            setStageStartMs(fix.timestampMs);
            setStageState('running');
            setIsRecording(true);
            setTotalDistKm(0);
            setTripDistKm(0);
            setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
            setCurrentSplitTimesMs({});
            window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
            showToast(`Largada por proximidade (${startGate.name})`);
          }
        }
      }

      const elapsedMs =
        activeStartMs !== null && nextStageState === 'running'
          ? Math.max(0, fix.timestampMs - activeStartMs)
          : liveSamplesRef.current.length > 0
            ? fix.timestampMs - liveSamplesRef.current[0].timestampMs
            : 0;

      const sample: VelocitySample = {
        lat: fix.lat,
        lon: fix.lon,
        speedKmh: resolvedSpeedKmh,
        accuracyM: fix.accuracyM,
        headingDeg: resolvedHeading,
        altitudeM: fix.altitudeM,
        timestampMs: fix.timestampMs,
        distKm:
          nextStageState === 'running'
            ? nextTotalDist
            : liveSamplesRef.current.length === 0
              ? 0
              : nextTotalDist,
        stageElapsedMs: elapsedMs,
        accelLongG,
        accelLatG,
      };

      prevSampleRef.current = sample;
      if (isRecording || nextStageState === 'running') {
        setLiveSamples((arr) => [...arr, sample]);
      }
    },
    [activeTrack, source, userPickedTrackManually, isRecording, finalizeRun, showToast]
  );

  const processIncomingFixRef = useRef(processIncomingFix);
  processIncomingFixRef.current = processIncomingFix;

  // Real GPS listener
  useEffect(() => {
    if (!isActive || source !== 'gps' || screen === 'survey') return;
    let cancelled = false;

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
            { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 },
            (pos, err) => {
              if (cancelled || err || !pos) return;
              const rawDopplerSpeedKmh =
                pos.coords.speed !== null && Number.isFinite(pos.coords.speed) && pos.coords.speed > 0
                  ? pos.coords.speed * 3.6
                  : null;
              processIncomingFixRef.current({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                speedKmh: rawDopplerSpeedKmh ?? 0,
                rawDopplerSpeedKmh,
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
          const rawDopplerSpeedKmh =
            pos.coords.speed !== null && Number.isFinite(pos.coords.speed) && pos.coords.speed > 0
              ? pos.coords.speed * 3.6
              : null;
          processIncomingFixRef.current({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speedKmh: rawDopplerSpeedKmh ?? 0,
            rawDopplerSpeedKmh,
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
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
      );
    };

    startGps();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [isActive, source, screen]);

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
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setCurrentSplitTimesMs({});
    setStageStartMs(null);
    setLastFinishedMs(null);
    setStageState('armed');
    setIsRecording(true);
    setSimPlaying(true);
    showToast('Especial SS-01 armada no Simulador!');
  };

  const handleForceManualStart = () => {
    const now = Date.now();
    prevSampleRef.current = null;
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setMaxSpeedKmh(0);
    setCurrentSplitTimesMs({});
    setLastFinishedMs(null);
    setStageStartMs(now);
    setStageState('running');
    setIsRecording(true);
    setScreen('live');
    if (source === 'simulator' && !simPlaying) {
      simProgressRef.current = 0;
      setSimPlaying(true);
    }
    window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
    showToast('Largada manual acionada! Cronômetro rodando.');
  };

  const handleStartOrArmStage = () => {
    if (stageState === 'running') {
      finalizeRun(Date.now(), undefined, false, false);
      return;
    }

    prevSampleRef.current = null;
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setMaxSpeedKmh(0);
    setCurrentSplitTimesMs({});
    setLastFinishedMs(null);
    setIsRecording(true);
    setScreen('live');

    const hasStartTrap = activeTrack?.traps.some(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    if (hasStartTrap) {
      setStageStartMs(null);
      setStageState('armed');
      if (source === 'simulator') {
        simProgressRef.current = 0;
        setSimPlaying(true);
      }
      showToast('Armado: aguardando cruzar linha de Largada');
    } else {
      setStageStartMs(Date.now());
      setStageState('running');
      window.dispatchEvent(new CustomEvent('pitstop:stage-started'));
      showToast('Cronômetro iniciado!');
    }
  };

  const applyTrackUpdateAndRecalc = useCallback(
    (trackId: string, updater: (t: VelocityTrack) => VelocityTrack) => {
      const target = tracksRef.current.find((t) => t.id === trackId);
      if (!target) return;
      const updatedTrack = updater(target);
      setTracks((prev) => prev.map((t) => (t.id === trackId ? updatedTrack : t)));
      setRuns((prevRuns) => recalculateRunsForTrack(updatedTrack, prevRuns));
    },
    []
  );

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
    setStageState('idle');
    setIsRecording(false);
    setPlacementKind(newTrackMode === 'circuit' ? 'start_finish' : 'start');
    setSelectedTrapId(null);
    setScreen('track-editor');
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
      showToast('Sem GPS: toque no mapa satélite para posicionar o Marco.');
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

  const handleImportGeoFile = async (file: File) => {
    try {
      const parsedRaw = await parseTrackFileToTrack(file);
      const parsed = ensureAutoTrapsFromBaseTrace(parsedRaw);
      setTracks((prev) => [parsed, ...prev]);
      setActiveTrackId(parsed.id);
      setUserPickedTrackManually(true);
      setStageState('idle');
      setStageStartMs(null);
      setLastFinishedMs(null);
      setCurrentSplitTimesMs({});
      setScreen('track-editor');
      showToast(
        `Pista "${parsed.name}" importada (${parsed.referenceDistanceKm.toFixed(2)} km · ${parsed.traps.length} traps)!`
      );
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

  const satCount = estimateSatellites(gpsAccuracyM, gpsActive);

  // Open Post-Session Analysis Detail (always opens on Análise & Treinador IA)
  const openSessionDetail = (trackId: string, initialTab: 'analysis' | 'heatmap' | 'video' = 'analysis') => {
    const sRuns = runs
      .filter((r) => r.trackId === trackId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    setSelectedSessionTrackId(trackId);
    const best = [...sRuns].sort((a, b) => a.totalMs - b.totalMs)[0];
    const last = sRuns[sRuns.length - 1];
    const secondLast = sRuns.length >= 2 ? sRuns[sRuns.length - 2] : last;
    setLapAId(last?.id || '');
    setLapBId(best && best.id !== last?.id ? best.id : secondLast?.id || '');
    setReplayIdx(0);
    setReplayPlaying(false);
    setCoachAdvice(null);
    setCoachError(null);
    setDetailTab(initialTab);
    setScreen('session-detail');
  };

  const handleOpenQuickAnalysis = () => {
    if (groupedSessions.length > 0) {
      const targetId =
        activeTrack && groupedSessions.some((g) => g.trackId === activeTrack.id)
          ? activeTrack.id
          : groupedSessions[0].trackId;
      openSessionDetail(targetId, 'analysis');
    } else {
      setScreen('sessions');
      showToast('Grave uma sessão ou rode a Demo SS-01 para abrir a Análise & IA.');
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

  const lapA = useMemo(
    () => sessionRuns.find((r) => r.id === lapAId) ?? sessionRuns[sessionRuns.length - 1] ?? null,
    [sessionRuns, lapAId]
  );

  const lapB = useMemo(
    () => sessionRuns.find((r) => r.id === lapBId) ?? sessionRuns[0] ?? null,
    [sessionRuns, lapBId]
  );

  const lapASamples = useMemo(
    () => (lapA ? ensureTraceGForces(lapA.samples) : []),
    [lapA]
  );

  const lapBSamples = useMemo(
    () => (lapB ? ensureTraceGForces(lapB.samples) : []),
    [lapB]
  );

  const comparisonSummary: LapComparisonSummary | null = useMemo(() => {
    if (!lapA || !lapB) return null;
    return computeLapComparisonSummary(lapA, lapB);
  }, [lapA, lapB]);

  useEffect(() => {
    if (screen !== 'session-detail' || !replayPlaying || lapASamples.length < 2) return;
    const id = window.setInterval(() => {
      setReplayIdx((prev) => {
        if (prev >= lapASamples.length - 1) {
          setReplayPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 180);
    return () => window.clearInterval(id);
  }, [screen, replayPlaying, lapASamples.length]);

  const handleRequestAiCoach = async () => {
    if (!lapA || !lapB || !comparisonSummary) return;
    setCoachLoading(true);
    setCoachError(null);
    try {
      const resp = await fetch('/api/velocity/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackName: sessionTrack?.name || 'Especial Livre',
          lapA: {
            runNumber: lapA.runNumber,
            totalMs: lapA.totalMs,
            avgSpeedKmh: lapA.avgSpeedKmh,
            maxSpeedKmh: lapA.maxSpeedKmh,
            distanceKm: lapA.distanceKm,
          },
          lapB: {
            runNumber: lapB.runNumber,
            totalMs: lapB.totalMs,
            avgSpeedKmh: lapB.avgSpeedKmh,
            maxSpeedKmh: lapB.maxSpeedKmh,
            distanceKm: lapB.distanceKm,
          },
          comparison: comparisonSummary,
        }),
      });
      const data = (await resp.json()) as { ok?: boolean; advice?: string; error?: string };
      if (!resp.ok || !data.ok || !data.advice) {
        setCoachError(
          data.error || 'Não foi possível gerar a análise tática do Treinador IA.'
        );
      } else {
        setCoachAdvice(data.advice);
      }
    } catch {
      setCoachError(
        'Sem conexão com o servidor para o Treinador IA. Confira os pontos de frenagem e ápice na tabela acima.'
      );
    } finally {
      setCoachLoading(false);
    }
  };

  const handleBackAction = () => {
    if (screen === 'track-editor') setScreen('tracks');
    else if (screen === 'session-detail') setScreen('sessions');
    else setScreen('home');
  };

  const screenTitleMap: Record<VelocityScreen, string> = {
    home: 'Velocidade',
    live: liveMode === 'timer' ? 'Cronômetro SS' : 'Mostradores',
    sessions: 'Sessões',
    'session-detail': sessionTrack?.name || 'Análise & IA',
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
  const recordingGoProCount = goproFleet.cameras.filter((c) => c.recording).length;
  const savedMissingGoPros = goproFleet.savedDevices.filter(
    (sd) => !goproFleet.cameras.some((c) => c.id === sd.deviceId)
  );

  const goproQuickBar = hasAnyGoPro ? (
    <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 text-white space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setGoproDrawerOpen((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${
              recordingGoProCount > 0
                ? 'bg-[#E10600] animate-pulse'
                : activeGoProsReady.length > 0
                  ? 'bg-emerald-400'
                  : 'bg-zinc-500'
            }`}
          />
          <Camera className="h-4 w-4 shrink-0 text-[#E10600]" />
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-wide truncate">
              GoPro ({activeGoProsReady.length}/{goproFleet.cameras.length || goproFleet.savedDevices.length})
              {recordingGoProCount > 0 ? ` · ${recordingGoProCount} REC` : ''}
            </p>
          </div>
          {goproDrawerOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          )}
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {activeGoProsReady.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => {
                  void shutterAllGoPro(recordingGoProCount === 0);
                }}
                className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-extrabold uppercase ${
                  recordingGoProCount > 0
                    ? 'border border-zinc-600 bg-zinc-800 text-white'
                    : 'pitstop-btn-red text-white'
                }`}
              >
                {recordingGoProCount > 0 ? (
                  <>
                    <Square className="h-3 w-3 fill-current" />
                    <span>Parar</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3 w-3 fill-current" />
                    <span>REC Todas</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  void sleepAllGoPro();
                }}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2 text-[11px] font-bold text-[#C0C4C9] hover:text-white"
                title="Desligar / Hibernar todas as GoPro"
              >
                <Power className="h-3.5 w-3.5 text-zinc-400" />
                <span>Desligar</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                void wakeAllGoPro();
              }}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-emerald-500/50 bg-emerald-950/40 px-2.5 text-[11px] font-extrabold text-emerald-300 uppercase hover:bg-emerald-950/70"
            >
              <Power className="h-3.5 w-3.5" />
              <span>Ligar GoPro</span>
            </button>
          )}
        </div>
      </div>

      {goproFleet.errorMsg && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-700/60 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-200">
          <span className="truncate">{goproFleet.errorMsg}</span>
          <button
            type="button"
            onClick={clearGoProFleetError}
            className="shrink-0 text-red-300 hover:text-white"
            aria-label="Fechar erro GoPro"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {goproDrawerOpen && (
        <div className="space-y-1.5 border-t border-zinc-800 pt-2">
          {goproFleet.cameras.map((cam) => {
            const label = getGoProDisplayName(cam);
            const asleep = cam.sleeping || !cam.connected;
            const isEditing = editingGoProId === cam.id;
            return (
              <div
                key={cam.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-1.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      asleep
                        ? 'bg-zinc-500'
                        : cam.recording
                          ? 'bg-[#E10600] animate-pulse'
                          : 'bg-emerald-400'
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
                        className="h-7 min-w-0 flex-1 rounded border border-zinc-600 bg-[#111214] px-2 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
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
                      <span className="truncate text-xs font-bold text-white">{label}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingGoProId(cam.id);
                          setEditingGoProName(cam.alias || cam.name);
                        }}
                        className="p-0.5 text-zinc-500 hover:text-white"
                        aria-label={`Renomear ${label}`}
                        title="Nomear câmera"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <span className="font-mono text-[10px] text-zinc-400 tabular-nums shrink-0">
                        {cam.batteryPct}%
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
                        ? 'border border-zinc-600 bg-zinc-800 text-white'
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
                        ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300'
                        : 'border-zinc-700 bg-[#111214] text-[#C0C4C9] hover:text-white'
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
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-1.5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-600" />
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
                        className="h-7 min-w-0 flex-1 rounded border border-zinc-600 bg-[#111214] px-2 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
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
                      <span className="truncate text-xs font-bold text-zinc-300">{label}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingGoProId(sd.deviceId);
                          setEditingGoProName(sd.alias || sd.name);
                        }}
                        className="p-0.5 text-zinc-500 hover:text-white"
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
                  className="inline-flex h-7 items-center gap-1 rounded border border-emerald-500/50 bg-emerald-950/40 px-2.5 text-[10px] font-extrabold text-emerald-300 uppercase"
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
  ) : null;

  return (
    <div className="space-y-3">
      {/* Compact Top Bar inside Velocidade (RaceChrono-inspired) */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] px-3 py-2 text-white shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {screen !== 'home' && (
              <button
                type="button"
                onClick={handleBackAction}
                aria-label="Voltar"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-white hover:border-[#E10600]"
              >
                <ArrowLeft className="h-4 w-4 text-[#E10600]" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide uppercase truncate sm:text-xl">
                {screenTitleMap[screen]}
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setScreen('settings')}
              title="Status GPS / Satélites"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 font-mono text-[11px] font-bold text-[#C0C4C9] hover:text-white"
            >
              <Satellite
                className={`h-3.5 w-3.5 ${
                  source === 'simulator'
                    ? 'text-amber-400'
                    : gpsActive
                      ? 'text-emerald-400'
                      : 'text-zinc-500'
                }`}
              />
              <span>
                {source === 'simulator'
                  ? `SIM ${simMultiplier}x`
                  : gpsActive
                    ? `${satCount} SAT${gpsAccuracyM !== null ? ` ±${gpsAccuracyM}m` : ''}`
                    : 'GPS'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setScreen(screen === 'settings' ? 'home' : 'settings')}
              aria-label="Configurações de Velocidade"
              title="Configurações de Velocidade"
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                screen === 'settings'
                  ? 'border-[#E10600] bg-[#E10600] text-white'
                  : 'border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white'
              }`}
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>

        {(statusFeedback || gpsError) && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-1.5 text-xs">
            <span
              className={
                gpsError && !statusFeedback ? 'text-amber-300' : 'text-emerald-400 font-semibold'
              }
            >
              {statusFeedback || gpsError}
            </span>
            {wakeLockActive && (
              <span className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">
                Tela Ativa
              </span>
            )}
          </div>
        )}
      </section>

      {/* SCREEN: HOME (Clean RaceChrono + Rally Hub — No Map clutter) */}
      {screen === 'home' && (
        <section className="space-y-4">
          {/* Active Track / Especial Selector */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                Especial / Pista Ativa
              </span>
              {autoDetectedNotice && (
                <span className="font-mono text-[10px] font-bold text-emerald-400">
                  {autoDetectedNotice}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <select
                aria-label="Selecionar pista para cronometragem"
                value={activeTrackId}
                onChange={(e) => {
                  const chosenId = e.target.value;
                  setUserPickedTrackManually(true);
                  setAutoDetectedNotice(null);
                  if (chosenId) {
                    setTracks((prev) =>
                      prev.map((t) => (t.id === chosenId ? ensureAutoTrapsFromBaseTrace(t) : t))
                    );
                  }
                  setActiveTrackId(chosenId);
                  setStageState('idle');
                  setStageStartMs(null);
                  setLastFinishedMs(null);
                  setCurrentSplitTimesMs({});
                }}
                className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-sm font-bold text-white focus:border-[#E10600] focus:outline-none"
              >
                <option value="">Especial Livre (Sem traps fixos)</option>
                {tracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.traps.length} traps)
                  </option>
                ))}
              </select>
              {activeTrack ? (
                <button
                  type="button"
                  onClick={() => setScreen('track-editor')}
                  className="inline-flex h-[44px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-bold text-[#C0C4C9] hover:text-white shrink-0"
                  title="Editar Marcos no Mapa"
                >
                  <MapIcon className="h-4 w-4 text-[#E10600]" />
                  <span>Mapa</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewTrackModal(true)}
                  className="inline-flex h-[44px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-bold text-white hover:border-[#E10600] shrink-0"
                  title="Criar Nova Pista"
                >
                  <Plus className="h-4 w-4 text-[#E10600]" />
                  <span>Nova</span>
                </button>
              )}
            </div>
          </div>

          {/* Centerpiece Circular RaceChrono START Button */}
          <div className="flex flex-col items-center justify-center py-3 sm:py-5">
            <button
              type="button"
              onClick={handleStartOrArmStage}
              className="group relative flex h-36 w-36 flex-col items-center justify-center rounded-full border-4 border-zinc-600/80 bg-gradient-to-b from-[#FF2A2A] via-[#E10600] to-[#990400] text-white shadow-[0_12px_36px_rgba(225,6,0,0.45)] transition-transform active:scale-95 hover:scale-[1.03] sm:h-40 sm:w-40"
            >
              <span className="font-['Barlow_Condensed'] text-4xl font-black tracking-wider uppercase drop-shadow">
                START
              </span>
              <span className="mt-0.5 font-mono text-[10px] font-bold tracking-widest text-white/85 uppercase">
                {activeTrack ? 'Armar Especial' : 'Especial Livre'}
              </span>
            </button>
          </div>

          {/* Primary 2 Buttons matching RaceChrono: Sessões & Pistas */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setScreen('sessions')}
              className="flex min-h-[60px] items-center justify-center gap-2.5 rounded-xl border border-zinc-700 bg-[#14161A] px-3 text-sm font-extrabold text-white shadow-md transition-colors hover:border-[#E10600] active:scale-[0.98]"
            >
              <History className="h-5 w-5 text-[#E10600]" />
              <span>Sessões ({groupedSessions.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('tracks')}
              className="flex min-h-[60px] items-center justify-center gap-2.5 rounded-xl border border-zinc-700 bg-[#14161A] px-3 text-sm font-extrabold text-white shadow-md transition-colors hover:border-[#E10600] active:scale-[0.98]"
            >
              <Flag className="h-5 w-5 text-[#E10600]" />
              <span>Pistas ({tracks.length})</span>
            </button>
          </div>

          {/* Rally Tools Strip (Uniform Icon Styling + Satcron Live Results) */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              onClick={handleOpenQuickAnalysis}
              className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border border-zinc-800 bg-[#111214] px-2 py-2 text-xs font-bold text-[#C0C4C9] hover:border-zinc-600 hover:text-white"
            >
              <TrendingUp className="h-4 w-4 text-[#E10600]" />
              <span>Análise &amp; IA</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('odometer')}
              className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border border-zinc-800 bg-[#111214] px-2 py-2 text-xs font-bold text-[#C0C4C9] hover:border-zinc-600 hover:text-white"
            >
              <Gauge className="h-4 w-4 text-[#E10600]" />
              <span>Hodômetro</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('survey')}
              className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border border-zinc-800 bg-[#111214] px-2 py-2 text-xs font-bold text-[#C0C4C9] hover:border-zinc-600 hover:text-white"
            >
              <Compass className="h-4 w-4 text-[#E10600]" />
              <span>Levantamento</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('satcron')}
              className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-xl border border-zinc-800 bg-[#111214] px-2 py-2 text-xs font-bold text-[#C0C4C9] hover:border-zinc-600 hover:text-white"
            >
              <Trophy className="h-4 w-4 text-[#E10600]" />
              <span>Satcron Ao Vivo</span>
            </button>
          </div>

          {goproQuickBar}
        </section>
      )}

      {/* SCREEN: LIVE COCKPIT (Unified Cronômetro SS + Mostradores + Live Map) */}
      {screen === 'live' && (() => {
        const startGate = orderedTraps.find(
          (t) => t.kind === 'start' || t.kind === 'start_finish'
        );
        const distToStartM =
          currentPos && startGate
            ? Math.round(haversineMetersVel(currentPos.lat, currentPos.lon, startGate.lat, startGate.lon))
            : null;
        const liveMapTrace =
          liveSamples.length > 0 ? liveSamples : activeTrack?.baseTrace ?? [];

        return (
        <section className="space-y-3">
          {/* Clean 2-way toggle + Satcron quick link inside Live Cockpit */}
          <div className="flex items-center gap-1.5">
            <div className="grid flex-1 grid-cols-2 gap-1 rounded-xl border border-zinc-800 bg-[#111214] p-1">
              <button
                type="button"
                onClick={() => setLiveMode('timer')}
                className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg text-xs font-extrabold uppercase transition-colors ${
                  liveMode === 'timer'
                    ? 'pitstop-btn-red text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                <Flag className="h-3.5 w-3.5" />
                <span>Cronômetro SS</span>
              </button>
              <button
                type="button"
                onClick={() => setLiveMode('gauges')}
                className={`inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg text-xs font-extrabold uppercase transition-colors ${
                  liveMode === 'gauges'
                    ? 'pitstop-btn-red text-white'
                    : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                <span>Mostradores</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setScreen('satcron')}
              className="inline-flex h-[50px] items-center gap-1 rounded-xl border border-zinc-800 bg-[#111214] px-2.5 text-[11px] font-bold text-[#C0C4C9] hover:border-[#E10600] hover:text-white shrink-0"
              title="Abrir Cronometragem Satcron Ao Vivo"
            >
              <Trophy className="h-4 w-4 text-[#E10600]" />
              <span className="hidden sm:inline">Satcron</span>
            </button>
          </div>

          {/* Live GPS Diagnostics Telemetry Bar */}
          <div className="grid grid-cols-4 gap-1.5 rounded-xl border border-zinc-800 bg-[#0C0D10] px-2.5 py-2 font-mono text-[10px] tabular-nums sm:text-[11px]">
            <div className="text-center">
              <p className="text-zinc-500 uppercase">Precisão</p>
              <p
                className={`font-bold ${
                  gpsAccuracyM !== null && gpsAccuracyM <= 10
                    ? 'text-emerald-400'
                    : gpsAccuracyM !== null && gpsAccuracyM <= 20
                      ? 'text-amber-300'
                      : 'text-[#FF2A2A]'
                }`}
              >
                {gpsAccuracyM !== null ? `±${gpsAccuracyM}m` : '--'}
              </p>
            </div>
            <div className="text-center">
              <p className="text-zinc-500 uppercase">Vel GPS</p>
              <p className="font-bold text-white">{Math.round(speedKmh)} km/h</p>
            </div>
            <div className="text-center">
              <p className="text-zinc-500 uppercase">Dist. Start</p>
              <p className="font-bold text-amber-300">
                {distToStartM !== null ? `${distToStartM}m` : '--'}
              </p>
            </div>
            <div className="text-center">
              <p className="text-zinc-500 uppercase">Status</p>
              <p
                className={`font-bold uppercase ${
                  stageState === 'running'
                    ? 'text-emerald-400'
                    : stageState === 'armed'
                      ? 'text-amber-300'
                      : 'text-zinc-300'
                }`}
              >
                {stageState === 'running'
                  ? 'Rodando'
                  : stageState === 'armed'
                    ? 'Armado'
                    : stageState === 'finished'
                      ? 'Salva'
                      : 'Pronto'}
              </p>
            </div>
          </div>

          {/* Manual Play Override whenever Waiting for Start or Idle */}
          {(stageState === 'idle' || stageState === 'armed') && (
            <button
              type="button"
              onClick={handleForceManualStart}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/60 bg-emerald-600/20 px-3 text-xs font-extrabold tracking-wider text-emerald-300 uppercase shadow transition-colors hover:bg-emerald-600/30 active:scale-[0.99] sm:text-sm"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>Largar Agora (Play Manual)</span>
            </button>
          )}

          {liveMode === 'timer' && (
            <>
              <VelocityLiveStagePanel
                activeTrackName={activeTrack ? activeTrack.name : 'Especial Livre'}
                hasTraps={Boolean(activeTrack && activeTrack.traps.length > 0)}
                stageState={stageState}
                stageStartMs={stageStartMs}
                lastFinishedMs={lastFinishedMs}
                clockOffsetMs={navSettings.clockOffsetMs}
                speedKmh={speedKmh}
                displayedTripKm={displayedTripKm}
                totalDistKm={totalDistKm}
                longG={liveLongG}
                latG={liveLatG}
                bestRun={bestRun}
                optimalSummary={optimalSummary}
                lapNumber={trackRuns.length + 1}
              />

              {orderedTraps.filter((t) => t.kind !== 'start').length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
                  <h3 className="text-xs font-bold tracking-wider text-[#B5B5B5] uppercase">
                    Parciais (Splits)
                  </h3>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                      <thead>
                        <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                          <th className="py-2 pr-2">Trap</th>
                          <th className="px-2 py-2 text-right">Atual</th>
                          <th className="px-2 py-2 text-right">Melhor</th>
                          <th className="py-2 pl-2 text-right">Dif.</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70">
                        {orderedTraps
                          .filter((t) => t.kind !== 'start')
                          .map((trap) => {
                            const currMs = currentSplitTimesMs[trap.id] ?? null;
                            const bestMs = bestRun?.splitTimesMs[trap.id] ?? null;
                            const diffSec =
                              currMs !== null && bestMs !== null ? (currMs - bestMs) / 1000 : null;
                            return (
                              <tr key={trap.id}>
                                <td className="py-2 pr-2 font-sans font-semibold text-white">
                                  {trap.name}
                                </td>
                                <td className="px-2 py-2 text-right text-white">
                                  {formatStageDuration(currMs)}
                                </td>
                                <td className="px-2 py-2 text-right text-emerald-400">
                                  {formatStageDuration(bestMs)}
                                </td>
                                <td
                                  className={`py-2 pl-2 text-right font-bold ${
                                    diffSec === null
                                      ? 'text-zinc-500'
                                      : diffSec <= 0
                                        ? 'text-emerald-400'
                                        : 'text-[#FF2A2A]'
                                  }`}
                                >
                                  {formatDeltaSeconds(diffSec)}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setTripDistKm(0);
                    showToast('Hodômetro parcial (Trip) zerado.');
                  }}
                  className="pitstop-btn-metal flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold uppercase sm:text-sm"
                >
                  <RotateCcw className="h-5 w-5 text-[#C0C4C9]" />
                  <span>Zerar Trip</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    handleDropTrapAtPosition(
                      !activeTrack || activeTrack.traps.every((t) => t.kind !== 'start')
                        ? 'start'
                        : 'split'
                    )
                  }
                  className="pitstop-btn-metal flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold uppercase sm:text-sm"
                >
                  <Flag className="h-5 w-5 text-[#E10600]" />
                  <span>+ Trap</span>
                </button>

                <button
                  type="button"
                  onClick={handleStartOrArmStage}
                  className="pitstop-btn-red flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-2 text-xs font-extrabold text-white uppercase sm:text-sm"
                >
                  {stageState === 'running' ? (
                    <>
                      <Flag className="h-5 w-5" />
                      <span>Encerrar</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-5 w-5 fill-current" />
                      <span>Iniciar</span>
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {liveMode === 'gauges' && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3 py-2 text-white">
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
                  className={`min-h-[36px] rounded-lg border px-2.5 text-xs font-bold whitespace-nowrap ${
                    tripRegressive
                      ? 'border-[#E10600] bg-[#E10600]/20 text-white'
                      : 'border-zinc-700 bg-[#080B0D] text-[#C0C4C9]'
                  }`}
                >
                  Trip: {tripRegressive ? 'Regressivo' : 'Progressivo'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowGaugeConfig((v) => !v)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  <span>Campos</span>
                </button>
              </div>

              {showGaugeConfig && (
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-xs sm:grid-cols-4">
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
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-2 text-white"
                    >
                      <span>{label}</span>
                      <input
                        type="checkbox"
                        checked={gaugeVisibility[key]}
                        onChange={(e) =>
                          setGaugeVisibility((prev) => ({
                            ...prev,
                            [key]: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 accent-[#E10600]"
                      />
                    </label>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
                {gaugeVisibility.speed && (
                  <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3.5 text-center">
                    <p className="text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                      Velocidade
                    </p>
                    <p className="mt-1 font-mono text-4xl font-extrabold text-white tabular-nums sm:text-6xl">
                      {Math.round(speedKmh)}
                    </p>
                    <p className="font-mono text-xs text-[#E10600] font-bold">KM/H</p>
                  </div>
                )}

                {gaugeVisibility.trip && (
                  <div className="rounded-xl border border-zinc-800 bg-[#000000] p-3.5 text-center">
                    <p className="text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
                      {tripRegressive ? 'Trip Regressivo' : 'Trip Parcial'}
                    </p>
                    <p className="mt-1 font-mono text-3xl font-extrabold text-amber-300 tabular-nums sm:text-5xl">
                      {displayedTripKm.toFixed(2)}
                    </p>
                    <p className="font-mono text-xs text-zinc-400">
                      Total {totalDistKm.toFixed(2)} km
                    </p>
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
                  <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3 text-center">
                    <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Máxima</p>
                    <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums sm:text-3xl">
                      {maxSpeedKmh}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">km/h</p>
                  </div>
                )}

                {gaugeVisibility.altitude && (
                  <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3 text-center">
                    <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Altitude</p>
                    <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums sm:text-3xl">
                      {altitudeM !== null ? `${altitudeM}m` : '--'}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">Elevação</p>
                  </div>
                )}

                {gaugeVisibility.gpsAccuracy && (
                  <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3 text-center">
                    <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Sinal GPS</p>
                    <p className="mt-1 font-mono text-2xl font-bold text-emerald-400 tabular-nums sm:text-3xl">
                      {gpsAccuracyM !== null ? `±${gpsAccuracyM}m` : '--'}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">
                      {source === 'simulator' ? 'Simulador' : 'Receptor'}
                    </p>
                  </div>
                )}

                {gaugeVisibility.heading && (
                  <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-3 text-center">
                    <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Rumo (CAP)</p>
                    <p className="mt-1 font-mono text-2xl font-bold text-white tabular-nums sm:text-3xl">
                      {headingDeg !== null ? `${headingDeg}°` : '--'}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">Direção</p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setTripDistKm(0);
                    showToast('Trip zerado.');
                  }}
                  className="pitstop-btn-metal min-h-[54px] rounded-xl text-xs font-extrabold uppercase sm:text-sm"
                >
                  Zerar Trip
                </button>
                <button
                  type="button"
                  onClick={handleStartOrArmStage}
                  className="pitstop-btn-red min-h-[54px] rounded-xl text-xs font-extrabold text-white uppercase sm:text-sm"
                >
                  {stageState === 'running' ? 'Encerrar' : 'Iniciar'}
                </button>
              </div>
            </>
          )}

          {(stageState === 'finished' || lastFinishedMs !== null) && (activeTrack || runs.length > 0) && (
            <button
              type="button"
              onClick={() => openSessionDetail(activeTrack?.id || 'free_stage', 'analysis')}
              className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/60 bg-emerald-950/30 text-sm font-bold text-emerald-300 hover:bg-emerald-950/50"
            >
              <TrendingUp className="h-4 w-4" />
              <span>Abrir Análise &amp; Treinador IA</span>
            </button>
          )}

          {/* Collapsible Live Map with Heading-Up vs Fixed North and Heatmap trace */}
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-[#111214]">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => setShowLiveMap((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs font-extrabold text-white uppercase"
              >
                <MapIcon className="h-3.5 w-3.5 text-[#E10600]" />
                <span>Mapa ao Vivo</span>
                {showLiveMap ? (
                  <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                )}
              </button>

              {showLiveMap && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setLiveHeatmapMode((m) => (m === 'accel' ? 'speed' : 'accel'))
                    }
                    className="rounded-md border border-zinc-700 bg-[#080B0D] px-2 py-1 font-mono text-[10px] font-bold text-[#C0C4C9] hover:text-white"
                  >
                    Cor: {liveHeatmapMode === 'accel' ? 'Força G' : 'Veloc.'}
                  </button>
                </div>
              )}
            </div>

            {showLiveMap && (
              <VelocityMapboxView
                trackId={activeTrack?.id || 'live_free'}
                editableTrace={liveMapTrace}
                orderedTraps={orderedTraps}
                postEditIdx={Math.max(0, liveMapTrace.length - 1)}
                currentPos={currentPos}
                navigationMode={true}
                headingUp={liveHeadingUp}
                onToggleHeadingUp={() => setLiveHeadingUp((v) => !v)}
                navHeadingDeg={headingDeg}
                heatmapMode={liveHeatmapMode}
                containerClassName="relative h-60 w-full overflow-hidden border-t border-zinc-800 bg-[#000000] sm:h-72"
              />
            )}
          </div>

          {goproQuickBar}
        </section>
        );
      })()}

      {/* SCREEN: SESSIONS LIST (Clean RaceChrono Sessions List) */}
      {screen === 'sessions' && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white">
            <span className="text-xs text-[#B5B5B5]">
              Selecione uma sessão para Análise, Gráfico Sobreposto e Treinador IA.
            </span>
            <button
              type="button"
              onClick={handleLoadDemoStage}
              className="inline-flex min-h-[38px] shrink-0 items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-emerald-400 hover:border-emerald-500"
            >
              <Play className="h-3 w-3" />
              <span>Demo SS-01</span>
            </button>
          </div>

          {groupedSessions.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-6 text-center text-white space-y-2.5">
              <p className="text-sm font-bold text-[#C0C4C9]">Nenhuma sessão gravada.</p>
              <p className="text-xs text-zinc-500">
                Toque em <strong>START</strong> na tela inicial ou rode a <strong>Demo SS-01</strong>.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-[#111214] text-white">
              {groupedSessions.map((sess) => (
                <button
                  key={sess.trackId}
                  type="button"
                  onClick={() => openSessionDetail(sess.trackId, 'analysis')}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-[#17191D] active:bg-[#1E2026]"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-extrabold text-white sm:text-base">
                        {sess.trackName}
                      </span>
                      <span className="shrink-0 font-mono text-xs font-bold text-[#C0C4C9] tabular-nums">
                        {sess.approxSizeKb} kB
                      </span>
                    </div>

                    <div className="flex items-baseline justify-between gap-2 font-mono text-xs text-zinc-400 tabular-nums">
                      <span>{formatShortDateTime(sess.latestAtMs)}</span>
                      <span>
                        {formatSessionDurationCompact(sess.totalDurationMs)} (
                        {sess.totalDistanceKm.toFixed(1)} km)
                      </span>
                    </div>

                    <p className="truncate text-xs font-semibold text-[#C0C4C9] tabular-nums">
                      {sess.runs.length} {sess.runs.length === 1 ? 'volta' : 'voltas'}, melhor:{' '}
                      <span className="font-mono text-emerald-400">
                        {formatStageDuration(sess.bestTotalMs)}
                      </span>
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* SCREEN: SESSION DETAIL — SECTION 5 ANALYSIS + AI COACH + HEATMAP + VIDEO HUD */}
      {screen === 'session-detail' && (
        <section className="space-y-3">
          {/* Lap A vs Lap B selector + Compact 3-Tab Bar */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[11px] text-[#B5B5B5]">
                <span className="font-bold uppercase">Volta A (Sólida)</span>
                <select
                  value={lapA?.id || ''}
                  onChange={(e) => {
                    setLapAId(e.target.value);
                    setReplayIdx(0);
                    setCoachAdvice(null);
                  }}
                  className="min-h-[40px] w-full rounded-lg border border-zinc-700 bg-[#080B0D] px-2 font-mono text-xs font-bold text-white"
                >
                  {sessionRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      #{r.runNumber} · {formatStageDuration(r.totalMs)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-[11px] text-[#B5B5B5]">
                <span className="font-bold uppercase">Volta B (Tracejada)</span>
                <select
                  value={lapB?.id || ''}
                  onChange={(e) => {
                    setLapBId(e.target.value);
                    setCoachAdvice(null);
                  }}
                  className="min-h-[40px] w-full rounded-lg border border-zinc-700 bg-[#080B0D] px-2 font-mono text-xs font-bold text-emerald-300"
                >
                  {sessionRuns.map((r) => (
                    <option key={r.id} value={r.id}>
                      #{r.runNumber} · {formatStageDuration(r.totalMs)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
              {(
                [
                  ['analysis', 'Análise & IA', TrendingUp],
                  ['heatmap', 'Mapa Calor', Flame],
                  ['video', 'Vídeo HUD', Film],
                ] as const
              ).map(([tabId, label, Icon]) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => setDetailTab(tabId)}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-md px-1 text-[11px] font-bold sm:text-xs ${
                    detailTab === tabId
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 5A. ANÁLISE & TREINADOR IA (Primary View — Exact Section 5 Spec) */}
          {detailTab === 'analysis' && (() => {
            const maxDistA =
              lapASamples.length > 0 ? lapASamples[lapASamples.length - 1].distKm * 1000 : 0;
            const maxDistB =
              lapBSamples.length > 0 ? lapBSamples[lapBSamples.length - 1].distKm * 1000 : 0;
            const maxDistM = Math.max(100, maxDistA, maxDistB);
            const maxSpd = Math.max(
              100,
              ...lapASamples.map((s) => s.speedKmh),
              ...lapBSamples.map((s) => s.speedKmh)
            );
            const yTop = Math.ceil(maxSpd / 20) * 20;

            const padL = 34;
            const padR = 12;
            const padT = 16;
            const padB = 26;
            const chartW = 420;
            const chartH = 190;
            const plotW = chartW - padL - padR;
            const plotH = chartH - padT - padB;

            const xAtM = (distM: number) =>
              padL + Math.max(0, Math.min(1, distM / maxDistM)) * plotW;
            const yAtKmh = (kmh: number) =>
              padT + plotH - Math.max(0, Math.min(1, kmh / yTop)) * plotH;

            const polyA = lapASamples
              .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
              .join(' ');
            const polyB = lapBSamples
              .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
              .join(' ');

            const xTicksM = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxDistM * f));
            const yTicksKmh = [yTop, Math.round(yTop * 0.5), 0];

            return (
              <div className="space-y-3">
                {/* Summary KPI Strip */}
                {comparisonSummary && (
                  <div className="grid grid-cols-3 gap-2 font-mono text-center tabular-nums">
                    <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5">
                      <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Delta A vs B</p>
                      <p
                        className={`mt-0.5 text-sm font-extrabold sm:text-base ${
                          comparisonSummary.totalDeltaSec <= 0
                            ? 'text-emerald-400'
                            : 'text-[#FF4D47]'
                        }`}
                      >
                        {comparisonSummary.totalDeltaSec > 0 ? '+' : ''}
                        {comparisonSummary.totalDeltaSec.toFixed(2)}s
                      </p>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5">
                      <p className="text-[10px] font-bold text-emerald-400 uppercase">Melhor</p>
                      <p className="mt-0.5 text-sm font-extrabold text-emerald-400 sm:text-base">
                        {formatStageDuration(sessionOptimal.bestRunTotalMs)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5">
                      <p className="text-[10px] font-bold text-amber-400 uppercase">Ideal</p>
                      <p className="mt-0.5 text-sm font-extrabold text-amber-300 sm:text-base">
                        {formatStageDuration(sessionOptimal.optimalTotalMs)}
                      </p>
                    </div>
                  </div>
                )}

                {/* 1. GRÁFICO DE VELOCIDADE SOBREPOSTO (Eixo X = Distância em m + Ícones de Frenagem e Ápice) */}
                <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
                      Gráfico de Velocidade Sobreposto
                    </h3>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
                      <span className="inline-flex items-center gap-1 text-[#FF4D47] font-bold">
                        <span className="inline-block h-[2px] w-3.5 bg-[#E10600]" />
                        Volta #{lapA?.runNumber ?? '-'}
                      </span>
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                        <span className="inline-block w-3.5 border-t-2 border-dashed border-emerald-400" />
                        Volta #{lapB?.runNumber ?? '-'}
                      </span>
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        ▼ Frenagem
                      </span>
                      <span className="inline-flex items-center gap-1 text-sky-400">
                        ● Ápice
                      </span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-[#080B0D] p-2">
                    {lapASamples.length > 2 ? (
                      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="h-48 w-full sm:h-56">
                        {/* Speed Y grid */}
                        {yTicksKmh.map((spdVal) => {
                          const y = yAtKmh(spdVal);
                          return (
                            <g key={spdVal}>
                              <line
                                x1={padL}
                                y1={y}
                                x2={chartW - padR}
                                y2={y}
                                stroke="#27272a"
                                strokeDasharray={spdVal === 0 ? undefined : '3 3'}
                              />
                              <text
                                x={padL - 4}
                                y={y + 3}
                                textAnchor="end"
                                fill="#71717a"
                                fontSize="8.5"
                                fontFamily="monospace"
                              >
                                {spdVal}
                              </text>
                            </g>
                          );
                        })}

                        {/* Distance X grid (meters) */}
                        {xTicksM.map((mVal, i) => {
                          const x = xAtM(mVal);
                          return (
                            <g key={`${mVal}_${i}`}>
                              <line
                                x1={x}
                                y1={padT}
                                x2={x}
                                y2={padT + plotH}
                                stroke="#1f2024"
                              />
                              <text
                                x={x}
                                y={chartH - 7}
                                textAnchor={i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'}
                                fill="#a1a1aa"
                                fontSize="8.5"
                                fontFamily="monospace"
                              >
                                {mVal}m
                              </text>
                            </g>
                          );
                        })}

                        {/* Volta B (Dashed Line) */}
                        {lapBSamples.length > 1 && (
                          <polyline
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="2"
                            strokeDasharray="6 4"
                            strokeOpacity="0.88"
                            points={polyB}
                          />
                        )}

                        {/* Volta A (Solid Line) */}
                        <polyline
                          fill="none"
                          stroke="#E10600"
                          strokeWidth="2.4"
                          points={polyA}
                        />

                        {/* Corner Brake & Apex Markers */}
                        {comparisonSummary?.corners.map((c) => {
                          const bx = xAtM(c.lapABrakeStartM);
                          const by = yAtKmh(c.lapABrakeStartKmh);
                          const ax = xAtM(c.lapAApexDistM);
                          const ay = yAtKmh(c.lapAApexKmh);
                          return (
                            <g key={c.cornerIndex}>
                              {/* Braking icon (inverted triangle + badge) */}
                              <polygon
                                points={`${bx},${by + 4} ${bx - 4.5},${by - 4} ${bx + 4.5},${by - 4}`}
                                fill="#f59e0b"
                                stroke="#000000"
                                strokeWidth="1"
                              />
                              <text
                                x={bx}
                                y={Math.max(10, by - 7)}
                                textAnchor="middle"
                                fill="#fcd34d"
                                fontSize="8"
                                fontWeight="bold"
                                fontFamily="monospace"
                              >
                                F{c.cornerIndex}
                              </text>

                              {/* Apex icon (circle + badge) */}
                              <circle
                                cx={ax}
                                cy={ay}
                                r="3.8"
                                fill="#38bdf8"
                                stroke="#000000"
                                strokeWidth="1"
                              />
                              <text
                                x={ax}
                                y={Math.min(padT + plotH - 3, ay + 12)}
                                textAnchor="middle"
                                fill="#7dd3fc"
                                fontSize="8"
                                fontWeight="bold"
                                fontFamily="monospace"
                              >
                                A{c.cornerIndex}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                    ) : (
                      <p className="py-10 text-center text-xs text-zinc-500">
                        Dados insuficientes para plotar a curva de velocidade.
                      </p>
                    )}
                  </div>
                </div>

                {/* 2. TABELA CURVA A CURVA (Frenagem m, Ápice km/h, Saída km/h com setas verdes/vermelhas) */}
                <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
                      Tabela Curva a Curva (#{lapA?.runNumber ?? '-'} vs #{lapB?.runNumber ?? '-'})
                    </h3>
                    <span className="font-mono text-[10px] text-[#B5B5B5]">
                      Volta A / Volta B
                    </span>
                  </div>

                  {comparisonSummary && comparisonSummary.corners.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums sm:text-xs">
                        <thead>
                          <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                            <th className="py-2 pr-1.5">Curva</th>
                            <th className="px-1.5 py-2 text-right">Frenagem (m)</th>
                            <th className="px-1.5 py-2 text-right">Ápice (km/h)</th>
                            <th className="px-1.5 py-2 text-right">Saída (km/h)</th>
                            <th className="py-2 pl-1.5 text-right">Delta</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/70">
                          {comparisonSummary.corners.map((c) => {
                            const brakeDiffM = c.lapABrakeDistM - c.lapBBrakeDistM;
                            const brakeGood = brakeDiffM <= 0;
                            const apexDiff = c.lapAApexKmh - c.lapBApexKmh;
                            const apexGood = apexDiff >= 0;
                            const exitDiff = c.lapAExitKmh - c.lapBExitKmh;
                            const exitGood = exitDiff >= 0;
                            const timeGood = c.timeDeltaSec <= 0;

                            return (
                              <tr key={c.cornerIndex}>
                                <td className="py-2 pr-1.5 font-sans font-bold text-white whitespace-nowrap">
                                  C{c.cornerIndex}{' '}
                                  <span className="font-mono text-[10px] font-normal text-zinc-500">
                                    {Math.round(c.distKm * 1000)}m
                                  </span>
                                </td>

                                <td className="px-1.5 py-2 text-right whitespace-nowrap">
                                  <span className="text-white font-bold">{c.lapABrakeDistM}</span>
                                  <span className="text-zinc-500"> / {c.lapBBrakeDistM}</span>{' '}
                                  <span className={brakeGood ? 'text-emerald-400' : 'text-[#FF4D47]'}>
                                    {brakeGood ? '▲' : '▼'}
                                  </span>
                                </td>

                                <td className="px-1.5 py-2 text-right whitespace-nowrap">
                                  <span className="text-white font-bold">{c.lapAApexKmh}</span>
                                  <span className="text-zinc-500"> / {c.lapBApexKmh}</span>{' '}
                                  <span className={apexGood ? 'text-emerald-400' : 'text-[#FF4D47]'}>
                                    {apexGood ? '▲' : '▼'}
                                  </span>
                                </td>

                                <td className="px-1.5 py-2 text-right whitespace-nowrap">
                                  <span className="text-white font-bold">{c.lapAExitKmh}</span>
                                  <span className="text-zinc-500"> / {c.lapBExitKmh}</span>{' '}
                                  <span className={exitGood ? 'text-emerald-400' : 'text-[#FF4D47]'}>
                                    {exitGood ? '▲' : '▼'}
                                  </span>
                                </td>

                                <td
                                  className={`py-2 pl-1.5 text-right font-extrabold whitespace-nowrap ${
                                    timeGood ? 'text-emerald-400' : 'text-[#FF4D47]'
                                  }`}
                                >
                                  {timeGood ? '▲ ' : '▼ '}
                                  {c.timeDeltaSec > 0 ? '+' : ''}
                                  {c.timeDeltaSec.toFixed(2)}s
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="py-3 text-xs text-zinc-500">
                      Selecione duas voltas gravadas com trechos de frenagem e retomada para exibir o comparativo curva a curva.
                    </p>
                  )}
                </div>

                {/* 3. CARD DO TREINADOR IA (Logo abaixo da tabela) */}
                <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3.5 text-white space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                        Treinador IA
                      </h3>
                      <p className="text-xs text-[#B5B5B5]">
                        Feedback tático direto comparando Volta #{lapA?.runNumber ?? '-'} com Volta #{lapB?.runNumber ?? '-'}.
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={coachLoading || !comparisonSummary}
                      onClick={handleRequestAiCoach}
                      className="pitstop-btn-red inline-flex min-h-[42px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold text-white disabled:opacity-50"
                    >
                      <Cpu className="h-4 w-4" />
                      <span>
                        {coachLoading ? 'Gerando Análise...' : 'Gerar Análise Tática'}
                      </span>
                    </button>
                  </div>

                  {coachError && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-200">
                      {coachError}
                    </div>
                  )}

                  {coachAdvice && (
                    <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3.5 text-xs leading-relaxed text-emerald-100 whitespace-pre-line">
                      <p className="mb-1.5 font-mono text-[10px] font-bold tracking-wider text-emerald-400 uppercase">
                        Análise Tática do Engenheiro
                      </p>
                      {coachAdvice}
                    </div>
                  )}
                </div>

                {/* Volta Ideal por Setores & Lista de Voltas da Sessão */}
                {sessionOptimal.sectors.length > 0 && (
                  <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3.5 text-white">
                    <h3 className="text-xs font-bold tracking-wider text-amber-400 uppercase">
                      Volta Ideal por Setores
                    </h3>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {sessionOptimal.sectors.map((sec) => (
                        <div
                          key={sec.sectorIndex}
                          className="rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-2 font-mono"
                        >
                          <p className="font-sans text-xs font-bold text-[#C0C4C9]">{sec.label}</p>
                          <p className="mt-0.5 text-lg font-extrabold text-amber-300 tabular-nums">
                            {formatStageDuration(sec.bestMs)}
                          </p>
                          <p className="text-[10px] text-zinc-500">
                            {sec.bestRunNumber ? `Volta #${sec.bestRunNumber}` : 'Sem registro'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3.5 text-white">
                  <div className="flex items-center justify-between">
                    <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
                      Voltas da Sessão ({sessionRuns.length})
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        setRuns((prev) =>
                          prev.filter((r) => r.trackId !== selectedSessionTrackId)
                        );
                        setScreen('sessions');
                      }}
                      className="text-xs font-semibold text-red-400 hover:text-red-300"
                    >
                      Excluir Sessão
                    </button>
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                      <thead>
                        <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                          <th className="py-2 pr-2">Volta</th>
                          <th className="px-2 py-2">Tempo</th>
                          <th className="px-2 py-2 text-right">Dist.</th>
                          <th className="py-2 pl-2 text-right">Máx</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70">
                        {sessionRuns.map((run) => {
                          const isBest = run.id === sessionOptimal.bestRunId;
                          return (
                            <tr key={run.id} className={isBest ? 'bg-emerald-950/25' : ''}>
                              <td className="py-2 pr-2 font-sans font-bold text-white">
                                #{run.runNumber}{' '}
                                {isBest && <span className="text-emerald-400">(Melhor)</span>}
                              </td>
                              <td className="px-2 py-2 font-extrabold text-white">
                                {formatStageDuration(run.totalMs)}
                              </td>
                              <td className="px-2 py-2 text-right text-[#C0C4C9]">
                                {run.distanceKm.toFixed(2)} km
                              </td>
                              <td className="py-2 pl-2 text-right text-amber-300">
                                {run.maxSpeedKmh} km/h
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 5B. MAPA DE CALOR NO TRAÇADO */}
          {detailTab === 'heatmap' && (
            <div className="space-y-2.5 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
                  <button
                    type="button"
                    onClick={() => setHeatmapMode('accel')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-bold ${
                      heatmapMode === 'accel'
                        ? 'bg-[#E10600] text-white'
                        : 'text-[#B5B5B5]'
                    }`}
                  >
                    Aceleração / Freio
                  </button>
                  <button
                    type="button"
                    onClick={() => setHeatmapMode('speed')}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-bold ${
                      heatmapMode === 'speed'
                        ? 'bg-[#E10600] text-white'
                        : 'text-[#B5B5B5]'
                    }`}
                  >
                    Velocidade (km/h)
                  </button>
                </div>

                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="text-emerald-400">
                    ■ {heatmapMode === 'accel' ? 'Acelerando' : 'Alta'}
                  </span>
                  <span className="text-amber-400">■ Médio</span>
                  <span className="text-[#FF2A2A]">
                    ■ {heatmapMode === 'accel' ? 'Freando' : 'Baixa'}
                  </span>
                </div>
              </div>

              <VelocityMapboxView
                trackId={selectedSessionTrackId}
                editableTrace={lapASamples}
                orderedTraps={sessionTrack ? getOrderedTrackTraps(sessionTrack) : []}
                postEditIdx={replayIdx}
                currentPos={
                  lapASamples[replayIdx]
                    ? {
                        lat: lapASamples[replayIdx].lat,
                        lon: lapASamples[replayIdx].lon,
                      }
                    : null
                }
                navHeadingDeg={lapASamples[replayIdx]?.headingDeg ?? null}
                heatmapMode={heatmapMode}
                containerClassName="relative h-[300px] w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#000000] sm:h-[380px]"
              />

              {lapASamples.length > 1 && (
                <div className="space-y-2 rounded-lg border border-zinc-800 bg-[#080B0D] p-2.5">
                  <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
                    <button
                      type="button"
                      onClick={() => setReplayPlaying((v) => !v)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#E10600] px-3 text-xs font-bold text-white"
                    >
                      {replayPlaying ? (
                        <>
                          <Pause className="h-3.5 w-3.5" />
                          <span>Pausar</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5" />
                          <span>Replay</span>
                        </>
                      )}
                    </button>
                    <span className="text-white font-bold">
                      {Math.round(lapASamples[replayIdx]?.speedKmh ?? 0)} km/h
                    </span>
                    <span className="text-amber-300">
                      {formatStageDuration(lapASamples[replayIdx]?.stageElapsedMs ?? 0)}
                    </span>
                    <span className="text-zinc-400">
                      {(lapASamples[replayIdx]?.accelLongG ?? 0).toFixed(2)} G
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, lapASamples.length - 1)}
                    value={replayIdx}
                    onChange={(e) => setReplayIdx(Number(e.target.value))}
                    className="w-full accent-[#E10600]"
                  />
                </div>
              )}
            </div>
          )}

          {/* 5C. SINCRONIZAÇÃO DE VÍDEO + OVERLAY TELEMETRIA */}
          {detailTab === 'video' && (() => {
            const activeHudSample = lapASamples[videoHudSampleIdx] ?? lapASamples[0] ?? null;
            const gX = Math.max(-1, Math.min(1, activeHudSample?.accelLatG ?? 0));
            const gY = Math.max(-1, Math.min(1, activeHudSample?.accelLongG ?? 0));

            return (
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
                      Vídeo &amp; Overlay HUD
                    </h3>
                    <p className="text-[11px] text-[#B5B5B5]">
                      Sincronize seu vídeo com os dados GPS da Volta #{lapA?.runNumber ?? '-'}.
                    </p>
                  </div>

                  <label className="pitstop-btn-red inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold text-white">
                    <Upload className="h-3.5 w-3.5" />
                    <span>{videoUrl ? 'Trocar Vídeo' : 'Abrir Vídeo MP4/MOV'}</span>
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (videoUrl) URL.revokeObjectURL(videoUrl);
                        setVideoUrl(URL.createObjectURL(file));
                      }}
                    />
                  </label>
                </div>

                <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#050608]">
                  {videoUrl ? (
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      controls
                      playsInline
                      onTimeUpdate={() => {
                        const vid = videoRef.current;
                        if (!vid || lapASamples.length === 0) return;
                        const targetMs = Math.max(0, vid.currentTime * 1000 + videoOffsetMs);
                        let closest = 0;
                        let bestDiff = Infinity;
                        for (let i = 0; i < lapASamples.length; i += 1) {
                          const diff = Math.abs(lapASamples[i].stageElapsedMs - targetMs);
                          if (diff < bestDiff) {
                            bestDiff = diff;
                            closest = i;
                          }
                        }
                        setVideoHudSampleIdx(closest);
                      }}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center p-4 text-center">
                      <Film className="h-8 w-8 text-zinc-600" />
                      <p className="mt-2 text-xs text-zinc-400">
                        Abra um vídeo da GoPro ou arraste o controle abaixo para pré-visualizar o Overlay HUD.
                      </p>
                    </div>
                  )}

                  {activeHudSample && (
                    <div className="pointer-events-none absolute top-2.5 left-2.5 right-2.5 flex items-start justify-between gap-2">
                      <div className="rounded-lg border border-white/15 bg-black/70 px-2.5 py-1.5 backdrop-blur-xs font-mono tabular-nums">
                        <p className="text-[10px] font-bold text-[#E10600] uppercase">
                          VOLTA #{lapA?.runNumber ?? '-'}
                        </p>
                        <p className="text-lg font-black text-white leading-tight sm:text-2xl">
                          {Math.round(activeHudSample.speedKmh)}{' '}
                          <span className="text-[10px] font-bold text-zinc-300">KM/H</span>
                        </p>
                        <p className="text-xs font-bold text-emerald-400">
                          {formatStageDuration(activeHudSample.stageElapsedMs)}
                        </p>
                      </div>

                      <div className="flex flex-col items-center rounded-lg border border-white/15 bg-black/70 p-2 backdrop-blur-xs">
                        <div className="relative h-12 w-12 rounded-full border border-zinc-500/80">
                          <div className="absolute inset-x-0 top-1/2 h-px bg-zinc-600/70" />
                          <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600/70" />
                          <div
                            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#E10600] shadow"
                            style={{
                              left: `${50 + gX * 42}%`,
                              top: `${50 - gY * 42}%`,
                            }}
                          />
                        </div>
                        <span className="mt-1 font-mono text-[9px] text-zinc-300 tabular-nums">
                          G {gY.toFixed(1)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-lg border border-zinc-800 bg-[#080B0D] p-2.5 font-mono text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[#C0C4C9]">
                      Sincronia Vídeo vs GPS:{' '}
                      <strong className="text-amber-300">
                        {videoOffsetMs >= 0 ? `+${videoOffsetMs}` : videoOffsetMs} ms
                      </strong>
                    </span>
                    <div className="flex items-center gap-1">
                      {[-2000, -500, 500, 2000].map((step) => (
                        <button
                          key={step}
                          type="button"
                          onClick={() => setVideoOffsetMs((v) => v + step)}
                          className="rounded border border-zinc-700 bg-[#14161A] px-2 py-1 text-[10px] font-bold text-white hover:border-[#E10600]"
                        >
                          {step > 0 ? `+${step / 1000}s` : `${step / 1000}s`}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setVideoOffsetMs(0)}
                        className="rounded border border-zinc-700 bg-[#14161A] px-2 py-1 text-[10px] font-bold text-zinc-400"
                      >
                        0
                      </button>
                    </div>
                  </div>

                  {!videoUrl && lapASamples.length > 1 && (
                    <input
                      type="range"
                      min={0}
                      max={lapASamples.length - 1}
                      value={videoHudSampleIdx}
                      onChange={(e) => setVideoHudSampleIdx(Number(e.target.value))}
                      className="w-full accent-[#E10600]"
                    />
                  )}
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {/* SCREEN: TRACKS LIST (Clean Tracks Library — Map opens only when creating/editing) */}
      {screen === 'tracks' && (
        <section className="space-y-3">
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-zinc-800 bg-[#111214] p-2.5 text-white">
            <button
              type="button"
              onClick={() => setShowNewTrackModal(true)}
              className="pitstop-btn-red inline-flex min-h-[42px] items-center justify-center gap-1 rounded-lg px-2 text-xs font-extrabold text-white"
            >
              <Plus className="h-4 w-4" />
              <span>Nova Pista</span>
            </button>

            <label className="inline-flex min-h-[42px] cursor-pointer items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2 text-xs font-bold text-white hover:border-[#E10600]">
              <Upload className="h-3.5 w-3.5 text-[#E10600]" />
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
              className="inline-flex min-h-[42px] items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2 text-xs font-bold text-emerald-400 hover:border-emerald-500"
            >
              <Play className="h-3.5 w-3.5" />
              <span>Demo SS-01</span>
            </button>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-[#E10600]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                  Pistas Salvas ({tracks.length})
                </h3>
              </div>
              {activeTrack && (
                <button
                  type="button"
                  onClick={() => setScreen('track-editor')}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:border-[#E10600]"
                >
                  <MapIcon className="h-3.5 w-3.5 text-[#E10600]" />
                  <span>Abrir Mapa Atual</span>
                </button>
              )}
            </div>

            {tracks.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                Nenhuma pista cadastrada. Toque em <strong>+ Nova Pista</strong> para abrir o mapa satélite.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tracks.map((tr) => {
                  const isAct = tr.id === activeTrackId;
                  const passCount = runs.filter((r) => r.trackId === tr.id).length;
                  return (
                    <div
                      key={tr.id}
                      className={`flex flex-col justify-between gap-2 rounded-xl border p-3 ${
                        isAct
                          ? 'border-[#E10600]/80 bg-[#1A0D0E]'
                          : 'border-zinc-800 bg-[#080B0D]'
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
                            className="w-full min-h-[34px] rounded border border-zinc-700 bg-[#111214] px-2 text-xs text-white focus:border-[#E10600] focus:outline-none"
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
                            <p className="font-bold text-sm text-white leading-tight truncate">
                              {tr.name}
                            </p>
                            {isAct && (
                              <span className="font-mono text-[10px] font-extrabold text-[#E10600] uppercase shrink-0">
                                Ativa
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-zinc-400">
                            {tr.mode === 'circuit' ? 'Circuito' : 'Ponto-a-Ponto'} ·{' '}
                            {tr.traps.length} traps · {tr.referenceDistanceKm.toFixed(2)} km ·{' '}
                            {passCount} voltas
                          </p>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-zinc-800/80">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTrackId(tr.id);
                            setUserPickedTrackManually(true);
                            setScreen('track-editor');
                          }}
                          className="inline-flex min-h-[34px] flex-1 items-center justify-center gap-1 rounded-lg bg-[#E10600] px-2.5 text-xs font-bold text-white"
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
                            showToast(`Pista "${tr.name}" selecionada!`);
                          }}
                          className="min-h-[34px] rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:border-emerald-400"
                        >
                          Usar
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTrackId(tr.id);
                            setEditingTrackName(tr.name);
                          }}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-400 hover:text-white"
                          aria-label={`Renomear ${tr.name}`}
                          title="Renomear"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDuplicateTrack(tr)}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-400 hover:text-white"
                          aria-label={`Duplicar ${tr.name}`}
                          title="Duplicar"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTrack(tr.id)}
                          className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg border border-zinc-800 bg-[#111214] text-zinc-500 hover:bg-red-950/50 hover:text-red-400"
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
          <section className="space-y-3">
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 sm:p-3 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-1 items-center gap-2 min-w-0">
                  <input
                    type="text"
                    value={mapTrackNameDraft}
                    onChange={(e) => setMapTrackNameDraft(e.target.value)}
                    placeholder="Nome da pista (ex: SS-01 Erechim)"
                    aria-label="Nome da pista"
                    className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleSaveCurrentTrackToLibrary}
                    className={`inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold uppercase transition-colors ${
                      justSavedTrack
                        ? 'bg-emerald-600 text-white'
                        : 'pitstop-btn-red text-white'
                    }`}
                  >
                    {justSavedTrack ? (
                      <>
                        <Check className="h-4 w-4" />
                        <span>Salva</span>
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        <span>Salvar Pista</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#B5B5B5]">
                  <span className={trackTrapSummary.hasStart ? 'text-emerald-400 font-bold' : ''}>
                    {trackTrapSummary.hasStart ? '✓ Largada' : '○ Largada'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={trackTrapSummary.splitsCount > 0 ? 'text-amber-300 font-bold' : ''}>
                    Parciais ({trackTrapSummary.splitsCount})
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={trackTrapSummary.hasFinish ? 'text-[#FF4D47] font-bold' : ''}>
                    {trackTrapSummary.hasFinish ? '✓ Chegada' : '○ Chegada'}
                  </span>
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] shadow-xl">
              <div className="border-b border-zinc-800 bg-[#14161A] px-3 py-2.5 space-y-2.5">
                <div>
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-white">Deslize para girar</span>
                    <div className="flex items-center gap-1.5">
                      {selectedTrap && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleRotateTrap(selectedTrap.id, -5)}
                            className="rounded border border-zinc-700 bg-[#080B0D] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#C0C4C9] hover:text-white"
                            aria-label="Girar -5 graus"
                          >
                            -5°
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRotateTrap(selectedTrap.id, 5)}
                            className="rounded border border-zinc-700 bg-[#080B0D] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#C0C4C9] hover:text-white"
                            aria-label="Girar +5 graus"
                          >
                            +5°
                          </button>
                        </>
                      )}
                      <span className="font-mono text-sm font-black text-amber-300 tabular-nums">
                        {activeBearing.toFixed(1).replace('.', ',')} °
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    step={0.5}
                    value={activeBearing}
                    aria-label="Deslize para girar o Marco"
                    onChange={(e) => {
                      const val = Number(e.target.value) % 360;
                      setDraftBearingDeg(val);
                      if (selectedTrap) {
                        handleUpdateTrapProps(selectedTrap.id, { bearingDeg: val });
                      }
                    }}
                    className="mt-1.5 h-6 w-full cursor-pointer accent-lime-400"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-2 select-none">
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
                      className="h-5 w-5 rounded border-zinc-600 accent-lime-400 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-white sm:text-sm">
                      Unidirecional
                    </span>
                  </label>

                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs text-[#C0C4C9]">
                      <span className="font-bold">Largura (m):</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={150}
                        step={1}
                        value={activeWidthM}
                        onChange={(e) => {
                          const raw = Number(e.target.value);
                          if (!Number.isFinite(raw)) return;
                          const clamped = Math.min(150, Math.max(5, raw));
                          setNewTrapWidthM(clamped);
                          if (selectedTrap) {
                            handleUpdateTrapProps(selectedTrap.id, { widthM: clamped });
                          }
                        }}
                        aria-label="Largura do Marco em metros"
                        className="h-9 w-16 rounded-lg border border-zinc-700 bg-[#080B0D] text-center font-mono text-xs font-extrabold text-white focus:border-[#E10600] focus:outline-none"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() =>
                        setPlacementKind((prev) => (prev ? null : activeKind))
                      }
                      className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 text-xs font-extrabold transition-colors ${
                        placementKind
                          ? 'bg-amber-400 text-zinc-950'
                          : 'border border-zinc-700 bg-[#080B0D] text-white hover:border-[#E10600]'
                      }`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>{placementKind ? 'Toque no Mapa' : 'Novo Marco'}</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
                  {(
                    [
                      ['start', 'Largada', 'text-emerald-300'],
                      ['finish', 'Chegada', 'text-red-300'],
                      ['start_finish', 'Larg/Cheg', 'text-sky-300'],
                      ['split', 'Parcial (Setor)', 'text-amber-300'],
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
                        className={`min-h-[36px] rounded-md px-1 text-[10px] font-bold transition-colors sm:text-xs ${
                          isAct
                            ? 'bg-[#E10600] text-white'
                            : `${tone} hover:bg-zinc-800`
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <VelocityMapboxView
                trackId={activeTrackId}
                editableTrace={editableTrace}
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
                containerClassName="relative h-[340px] w-full overflow-hidden bg-[#000000] sm:h-[440px]"
                fullscreenOverlay={
                  <div className="rounded-xl border border-zinc-700/90 bg-[#080B0D]/92 p-2 text-white shadow-2xl backdrop-blur-md space-y-2">
                    {/* Colocar Marcos direto em Tela Cheia */}
                    <div className="grid grid-cols-4 gap-1">
                      {(
                        [
                          ['start', 'Largada', 'text-emerald-300 border-emerald-600/40'],
                          ['finish', 'Chegada', 'text-red-300 border-red-600/40'],
                          ['start_finish', 'Larg/Cheg', 'text-sky-300 border-sky-600/40'],
                          ['split', 'Parcial', 'text-amber-300 border-amber-600/40'],
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
                                : `${tone} bg-[#111214] hover:bg-zinc-800`
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
                        <span className="font-mono text-[10px] font-bold text-amber-300 tabular-nums shrink-0">
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
                          className="h-5 w-full cursor-pointer accent-lime-400"
                        />
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={5}
                          max={150}
                          value={activeWidthM}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            if (!Number.isFinite(raw)) return;
                            const clamped = Math.min(150, Math.max(5, raw));
                            setNewTrapWidthM(clamped);
                            if (selectedTrap) {
                              handleUpdateTrapProps(selectedTrap.id, { widthM: clamped });
                            }
                          }}
                          aria-label="Largura (m)"
                          className="h-8 w-12 rounded-lg border border-zinc-700 bg-[#111214] text-center font-mono text-[11px] font-bold text-white"
                        />

                        <button
                          type="button"
                          onClick={() => handleDropTrapAtPosition(activeKind)}
                          className="inline-flex h-8 items-center rounded-lg border border-zinc-700 bg-[#111214] px-2 text-[10px] font-bold text-emerald-300"
                          title="Capturar Marco na posição GPS atual"
                        >
                          +GPS
                        </button>

                        {selectedTrap && (
                          <button
                            type="button"
                            onClick={() => handleRemoveTrap(selectedTrap.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#111214] text-zinc-400 hover:text-red-400"
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
                              : 'pitstop-btn-red text-white'
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

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 bg-[#14161A] px-3 py-2.5">
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
                    <p className="truncate text-xs font-extrabold text-white sm:text-sm">
                      {selectedTrap ? selectedTrap.name : 'Novo marco (toque em Novo Marco)'}
                    </p>
                    <p className="font-mono text-[11px] text-[#B5B5B5] tabular-nums">
                      {kindLabelMap[activeKind]}, {activeBearing.toFixed(1).replace('.', ',')} °,{' '}
                      {activeWidthM.toFixed(2).replace('.', ',')} m
                      {activeUnidirectional ? ' · Unidirecional' : ' · Bidirecional'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleDropTrapAtPosition(activeKind)}
                    className="min-h-[36px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-[11px] font-bold text-emerald-300 hover:border-emerald-400"
                    title="Capturar Marco na posição GPS atual"
                  >
                    + GPS Atual
                  </button>
                  {selectedTrap && (
                    <button
                      type="button"
                      onClick={() => handleRemoveTrap(selectedTrap.id)}
                      className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-zinc-400 hover:border-red-500 hover:text-red-400"
                      aria-label={`Remover ${selectedTrap.name}`}
                      title="Excluir Marco selecionado"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white space-y-2.5">
              {editableTrace.length > 1 && (
                <div className="rounded-lg border border-zinc-800 bg-[#080B0D] p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px] text-zinc-400">
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
                    className="w-full accent-sky-400"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('start', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-emerald-600/40 bg-emerald-950/30 text-[11px] font-bold text-emerald-300"
                    >
                      + Largada
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('split', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-amber-600/40 bg-amber-950/30 text-[11px] font-bold text-amber-300"
                    >
                      + Parcial
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDropTrapAtPosition('finish', editableTrace[postEditIdx])}
                      className="min-h-[34px] rounded border border-red-600/40 bg-red-950/30 text-[11px] font-bold text-red-300"
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
                            ? 'border-[#E10600] bg-[#1A0D0E]'
                            : 'border-zinc-800 bg-[#080B0D]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-white truncate">{tr.name}</p>
                          <p className="font-mono text-[10px] text-zinc-400 tabular-nums">
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
                          className="flex h-8 w-8 items-center justify-center rounded text-zinc-500 hover:bg-red-950/50 hover:text-red-400"
                          aria-label={`Remover ${tr.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap gap-1.5 border-t border-zinc-800 pt-2">
                {activeTrack && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('gpx')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GPX</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportTrack('geojson')}
                      className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>.GeoJSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleStartOrArmStage}
                      className="pitstop-btn-red ml-auto inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold text-white"
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
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white space-y-4">
            <div>
              <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                Receptor GPS &amp; Motor de Cronometragem
              </h3>
              <p className="text-xs text-[#B5B5B5]">
                Configure fonte GPS, tolerância automática HDOP e acelerômetro IMU.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] p-3">
              <div>
                <p className="text-xs font-bold text-white">Fonte de Telemetria</p>
                <p className="text-[11px] text-zinc-400">
                  GPS real ou Simulador de bancada (SS-01)
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-zinc-700 bg-[#111214] p-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSource('gps');
                      setSimPlaying(false);
                    }}
                    className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                      source === 'gps' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5]'
                    }`}
                  >
                    GPS
                  </button>
                  <button
                    type="button"
                    onClick={() => setSource('simulator')}
                    className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                      source === 'simulator' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5]'
                    }`}
                  >
                    Simulador
                  </button>
                </div>
                {source === 'simulator' && (
                  <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-[#111214] p-0.5">
                    {[1, 2, 4].map((x) => (
                      <button
                        key={x}
                        type="button"
                        onClick={() => setSimMultiplier(x)}
                        className={`rounded px-2 py-1 font-mono text-[10px] font-bold ${
                          simMultiplier === x ? 'bg-[#E10600] text-white' : 'text-zinc-400'
                        }`}
                      >
                        {x}x
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#080B0D] p-3">
              <div>
                <p className="text-xs font-bold text-white">Detecção Automática de Pista (GPS)</p>
                <p className="text-[11px] text-zinc-400">
                  Reconhece pistas salvas num raio de{' '}
                  {velPrefs.autoDetectRadiusM >= 1000
                    ? `${(velPrefs.autoDetectRadiusM / 1000).toFixed(1)} km`
                    : `${velPrefs.autoDetectRadiusM} metros`}{' '}
                  da Largada.
                </p>
              </div>
              <input
                type="checkbox"
                checked={velPrefs.autoDetectTrack}
                onChange={(e) =>
                  setVelPrefs((p) => ({ ...p, autoDetectTrack: e.target.checked }))
                }
                className="h-5 w-5 accent-[#E10600]"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#080B0D] p-3">
              <div>
                <p className="text-xs font-bold text-white">Auto-Snap Dinâmico (HDOP)</p>
                <p className="text-[11px] text-zinc-400">
                  Expande o portal proporcionalmente à precisão horizontal do GPS.
                </p>
              </div>
              <input
                type="checkbox"
                checked={velPrefs.autoSnapHdop}
                onChange={(e) =>
                  setVelPrefs((p) => ({ ...p, autoSnapHdop: e.target.checked }))
                }
                className="h-5 w-5 accent-[#E10600]"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-[#080B0D] p-3">
              <div>
                <p className="text-xs font-bold text-white">Acelerômetro &amp; Força G (IMU)</p>
                <p className="text-[11px] text-zinc-400">
                  Combina sensores internos com variação cinemática de velocidade.
                </p>
              </div>
              <input
                type="checkbox"
                checked={velPrefs.useDeviceImu}
                onChange={(e) =>
                  setVelPrefs((p) => ({ ...p, useDeviceImu: e.target.checked }))
                }
                className="h-5 w-5 accent-[#E10600]"
              />
            </label>
          </div>
        </section>
      )}

      {/* SCREEN: DIGITAL ODOMETER */}
      {screen === 'odometer' && (
        <OdometerCockpit isActive={isActive && screen === 'odometer'} />
      )}

      {/* SCREEN: SURVEY (Levantamento / Recce) */}
      {screen === 'survey' && (
        <SurveyCockpit isActive={isActive && screen === 'survey'} />
      )}

      {/* SCREEN: SATCRON LIVE RALLY RESULTS */}
      {screen === 'satcron' && <SatcronLivePanel />}

      {/* Modal: Create New Special Stage or Circuit Track */}
      {showNewTrackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-[#111214] p-4 sm:p-5 text-white shadow-2xl space-y-3">
            <h3 className="font-['Barlow_Condensed'] text-xl font-bold italic uppercase">
              Nova Pista / Especial
            </h3>
            <input
              type="text"
              value={newTrackName}
              onChange={(e) => setNewTrackName(e.target.value)}
              placeholder="Ex: SS-02 Erechim ou Kartódromo"
              className="w-full min-h-[42px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-sm text-white focus:border-[#E10600] focus:outline-none"
            />
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
              <button
                type="button"
                onClick={() => setNewTrackMode('circuit')}
                className={`min-h-[36px] rounded-md text-xs font-bold ${
                  newTrackMode === 'circuit'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5]'
                }`}
              >
                Circuito (Voltas)
              </button>
              <button
                type="button"
                onClick={() => setNewTrackMode('point-to-point')}
                className={`min-h-[36px] rounded-md text-xs font-bold ${
                  newTrackMode === 'point-to-point'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5]'
                }`}
              >
                Ponto-a-Ponto (SS)
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowNewTrackModal(false)}
                className="min-h-[40px] rounded-lg border border-zinc-700 bg-[#080B0D] px-4 text-xs font-semibold text-[#C0C4C9]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleCreateNewTrack}
                className="pitstop-btn-red min-h-[40px] rounded-lg px-4 text-xs font-extrabold text-white"
              >
                Abrir no Mapa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
