import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  ArrowLeft,
  Bluetooth,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Compass,
  Copy,
  Download,
  Film,
  Flag,
  FolderOpen,
  History,
  Map as MapIcon,
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
  Zap,
} from 'lucide-react';
import { CockpitSelect } from './CockpitSelect';
import { FuelTechAnalysisPanel } from './FuelTechAnalysisPanel';
import { GoProBlePanel } from './GoProBlePanel';
import { SatcronLivePanel } from './SatcronLivePanel';
import { SurveyCockpit } from './SurveyCockpit';
import { LayoutMiniSchematic } from './VelocityCockpitLayoutEditor';
import { VelocityLivePresetScreen } from './VelocityLiveLayouts';
import { VelocityMapboxView } from './VelocityMapboxView';
import { VideoHudOverlayPanel } from './VideoHudOverlayPanel';
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
  autoStartGoProRecording,
  autoStopGoProRecording,
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
  computeSampleGForces,
  createDemoSpecialStage,
  createGpsKalmanProcessor,
  detectTrapCrossing,
  ensureAutoTrapsFromBaseTrace,
  ensureTraceGForces,
  exportTrackGeoJson,
  exportTrackGpx,
  formatDeltaSeconds,
  formatStageDuration,
  getCapacitorGpsWatchOptions,
  getOrderedTrackTraps,
  haversineMetersVel,
  inferNearestBaseTraceBearing,
  parseTrackFileToTrack,
  recalculateRunsForTrack,
  WEB_GPS_WATCH_OPTIONS,
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
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);
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
  const [mapTrackNameDraft, setMapTrackNameDraft] = useState('');
  const [justSavedTrack, setJustSavedTrack] = useState(false);

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

  const tracksRef = useRef<VelocityTrack[]>(tracks);
  tracksRef.current = tracks;
  const calFactorRef = useRef(navSettings.calibrationPct / 100);
  calFactorRef.current = navSettings.calibrationPct / 100;
  const autoRecGoProRef = useRef(navSettings.goproAutoRecOnStart);
  useEffect(() => {
    autoRecGoProRef.current = navSettings.goproAutoRecOnStart;
  }, [navSettings.goproAutoRecOnStart]);
  autoRecGoProRef.current = navSettings.goproAutoRecOnStart;
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
      rearmAfterFinish = false,
      samplesOverride?: VelocitySample[],
      distKmOverride?: number
    ) => {
      const startMs = stageStartMsRef.current;
      if (!startMs) return;
      const elapsedTotal = Math.max(100, finishedAtMs - startMs);
      const samples = ensureTraceGForces(samplesOverride ?? [...liveSamplesRef.current]);
      const distKm = distKmOverride ?? totalDistRef.current;
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

      void addGoProHiLightTag();
      if (!continueNextLap && autoRecGoProRef.current) {
        void autoStopGoProRecording();
      }

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
        setHeadingDeg(Math.round(resolvedHeading));
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

              seededStartSample = {
                lat: hit.crossLat,
                lon: hit.crossLon,
                speedKmh: resolvedSpeedKmh,
                accuracyM: fix.accuracyM,
                headingDeg: resolvedHeading,
                altitudeM: fix.altitudeM,
                timestampMs: hit.crossTimestampMs,
                distKm: 0,
                stageElapsedMs: 0,
                accelLongG,
                accelLatG,
              };

              setStageStartMs(hit.crossTimestampMs);
              setStageState('running');
              setIsRecording(true);
              setTotalDistKm(postCrossDistKm);
              setTripDistKm(postCrossDistKm);
              setMaxSpeedKmh(Math.round(resolvedSpeedKmh));
              setCurrentSplitTimesMs({});
              setLiveSamples([seededStartSample]);
              void addGoProHiLightTag();
              if (autoRecGoProRef.current) {
                void autoStartGoProRecording();
              }
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
                }
              } else if (
                trap.kind === 'start_finish' &&
                hit.crossTimestampMs - activeStartMs >= 6000
              ) {
                const lapMs = hit.crossTimestampMs - activeStartMs;
                updatedSplits[trap.id] = lapMs;
                currentSplitTimesRef.current = { ...updatedSplits };
                setCurrentSplitTimesMs({ ...updatedSplits });

                const preCrossDistKm =
                  totalDistRef.current -
                  (haversineMetersVel(hit.crossLat, hit.crossLon, resolvedLat, resolvedLon) / 1000) *
                    calFactorRef.current;
                const finishDistKm = Math.max(0, preCrossDistKm);
                const finishBoundarySample: VelocitySample = {
                  lat: hit.crossLat,
                  lon: hit.crossLon,
                  speedKmh: resolvedSpeedKmh,
                  accuracyM: fix.accuracyM,
                  headingDeg: resolvedHeading,
                  altitudeM: fix.altitudeM,
                  timestampMs: hit.crossTimestampMs,
                  distKm: finishDistKm,
                  stageElapsedMs: lapMs,
                  accelLongG,
                  accelLatG,
                };
                const lapSamples = [...liveSamplesRef.current, finishBoundarySample];

                finalizeRun(
                  hit.crossTimestampMs,
                  updatedSplits,
                  true,
                  false,
                  lapSamples,
                  finishDistKm
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

                const preCrossDistKm =
                  totalDistRef.current -
                  (haversineMetersVel(hit.crossLat, hit.crossLon, resolvedLat, resolvedLon) / 1000) *
                    calFactorRef.current;
                const finishDistKm = Math.max(0, preCrossDistKm);
                const finishBoundarySample: VelocitySample = {
                  lat: hit.crossLat,
                  lon: hit.crossLon,
                  speedKmh: resolvedSpeedKmh,
                  accuracyM: fix.accuracyM,
                  headingDeg: resolvedHeading,
                  altitudeM: fix.altitudeM,
                  timestampMs: hit.crossTimestampMs,
                  distKm: finishDistKm,
                  stageElapsedMs: finMs,
                  accelLongG,
                  accelLatG,
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
                  finishDistKm
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
    setIsRecording(true);
    setScreen('live');
    if (source === 'simulator' && !simPlaying) {
      simProgressRef.current = 0;
      setSimPlaying(true);
    }
    void addGoProHiLightTag();
    if (autoRecGoProRef.current) {
      void autoStartGoProRecording();
    }
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
      setIsRecording(true);
      void addGoProHiLightTag();
      if (autoRecGoProRef.current) {
        void autoStartGoProRecording();
      }
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
    finishGateArmedRef.current = false;
    stageStartMsRef.current = null;
    stageStateRef.current = 'idle';
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

  const handleImportGeoFile = async (file: File) => {
    try {
      const parsedRaw = await parseTrackFileToTrack(file);
      const parsed = ensureAutoTrapsFromBaseTrace(parsedRaw);
      setTracks((prev) => [parsed, ...prev]);
      setActiveTrackId(parsed.id);
      setUserPickedTrackManually(true);
      finishGateArmedRef.current = false;
      stageStateRef.current = 'idle';
      stageStartMsRef.current = null;
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
    'session-detail': sessionTrack?.name || 'Telemetria',
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
    const autoActive = navSettings.goproAutoRecOnStart && isPro;

    const handleOpenGoProModal = () => {
      if (!isPro) {
        openProUpgradeModal(
          'Automação de Câmeras GoPro BLE',
          'O controle, pareamento e disparo automático de câmeras GoPro via Bluetooth fazem parte do Plano PRO.'
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
          className="flex min-h-[48px] min-w-0 items-center justify-center gap-1.5 rounded-xl border-2 border-[#E10600] bg-red-950/85 px-2.5 text-xs font-extrabold text-white uppercase shadow-[0_0_16px_rgba(225,6,0,0.35)] transition-all hover:brightness-110 active:scale-[0.98]"
          title="Abrir controles GoPro BLE"
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#FF2A2A] animate-pulse" />
          <span className="truncate font-mono tabular-nums">
            ● REC{' '}
            {recordingGoPros.length === 1
              ? formatGoProRecTimer(recordingGoPros[0].encodingDurationSec)
              : `(${recordingGoProCount})`}
          </span>
          {autoActive && (
            <span className="shrink-0 rounded bg-emerald-500/25 px-1.5 py-0.5 font-mono text-[9px] font-black text-emerald-300">
              AUTO
            </span>
          )}
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
          <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--ps-emerald)]" />
          <span className="truncate">GOPRO PRONTA</span>
          {autoActive && (
            <span className="shrink-0 rounded bg-emerald-500/25 px-1.5 py-0.5 font-mono text-[9px] font-black text-[var(--ps-emerald)]">
              AUTO
            </span>
          )}
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
          GOPRO{!isPro ? ' (PRO)' : hasAnyGoPro ? ' · OFF' : ''}
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

          {/* Linha 1: Comando Mestre (flex-1) + Auto Largada */}
          <div className="flex items-center gap-1.5">
            {hasAnyGoPro ? (
              <button
                type="button"
                onClick={() => {
                  if (!isPro) {
                    openProUpgradeModal(
                      'Automação de Câmeras GoPro BLE',
                      'O disparo multi-câmera e Auto-REC na largada/chegada são recursos exclusivos do Plano PRO.'
                    );
                    return;
                  }
                  if (recordingGoProCount > 0) {
                    void autoStopGoProRecording();
                  } else {
                    void autoStartGoProRecording();
                  }
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

            <button
              type="button"
              onClick={() => {
                if (!isPro) {
                  openProUpgradeModal(
                    'Auto-REC GoPro na Largada',
                    'A gravação automática sincronizada com largada e chegada requer Plano PRO.'
                  );
                  return;
                }
                const next = !navSettings.goproAutoRecOnStart;
                autoRecGoProRef.current = next;
                updateNavSettings({ goproAutoRecOnStart: next });
              }}
              title="Auto-REC na Largada e Stop na Chegada"
              className={`inline-flex h-[36px] shrink-0 items-center gap-1 rounded-lg border px-2 font-mono text-[10px] font-extrabold uppercase whitespace-nowrap transition-colors ${
                navSettings.goproAutoRecOnStart && isPro
                  ? 'border-[var(--ps-emerald)] bg-emerald-500/15 text-[var(--ps-emerald)]'
                  : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Auto</span>
            </button>
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
            <button
              type="button"
              onClick={() => {
                if (!isPro) {
                  openProUpgradeModal(
                    'Automação de Câmeras GoPro BLE',
                    'O disparo automático na largada e chegada requer Plano PRO.'
                  );
                  return;
                }
                updateNavSettings({ goproAutoRecOnStart: !navSettings.goproAutoRecOnStart });
              }}
              title="Grava automaticamente na Largada e para na Chegada"
              className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[10px] font-extrabold uppercase transition-colors ${
                navSettings.goproAutoRecOnStart && isPro
                  ? 'border-[var(--ps-emerald)]/70 bg-emerald-500/15 text-[var(--ps-emerald)]'
                  : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              <span>Auto-REC Largada/Chegada:</span>
              <span>{navSettings.goproAutoRecOnStart && isPro ? 'ON' : 'OFF'}</span>
            </button>

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
      {/* Compact Top Bar inside Velocidade (hidden in full-viewport fixed Live Cockpit) */}
      {screen !== 'live' && (
        screen === 'home' ? (
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 text-[var(--ps-text)] shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold tabular-nums">
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
                <span className="text-[var(--ps-text)]">{gpsStatusLabel}</span>
                {zeroSpeedLocked && gpsActive && (
                  <span
                    title="Zero-Speed Anti-Drift Lock (< 2,0 km/h)"
                    className="rounded border border-amber-500/40 bg-amber-500/15 px-1 py-0.2 text-[9px] font-black text-amber-400 uppercase"
                  >
                    LOCK 0.0
                  </span>
                )}
              </div>

              {(statusFeedback || gpsError || wakeLockActive) && (
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  {(statusFeedback || gpsError) && (
                    <span
                      className={
                        gpsError && !statusFeedback
                          ? 'text-[var(--ps-amber)]'
                          : 'text-[var(--ps-emerald)] font-semibold'
                      }
                    >
                      {statusFeedback || gpsError}
                    </span>
                  )}
                  {wakeLockActive && (
                    <span className="text-[var(--ps-muted)] whitespace-nowrap">
                      Tela Ativa
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>
        ) : (
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
                  <h2 className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide uppercase truncate sm:text-xl">
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

            {(statusFeedback || gpsError) && (
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
        )
      )}

      {/* SCREEN: HOME (Clean RaceChrono + Rally Hub — No Map clutter) */}
      {screen === 'home' && (
        <section className="space-y-4">
          {/* Active Track / Especial Selector */}
          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                Especial / Pista Ativa
              </span>
              {autoDetectedNotice && (
                <span className="font-mono text-[10px] font-bold text-[var(--ps-emerald)]">
                  {autoDetectedNotice}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                aria-expanded={showTrackPickerDropdown}
                aria-label="Selecionar pista para cronometragem"
                onClick={() => setShowTrackPickerDropdown((v) => !v)}
                className={`flex min-h-[48px] min-w-0 flex-1 items-center justify-between gap-2 rounded-xl border bg-[var(--ps-card-deep)] px-3 py-1.5 text-left transition-colors ${
                  showTrackPickerDropdown
                    ? 'border-[var(--ps-accent)]'
                    : 'border-[var(--ps-border-strong)] hover:border-[var(--ps-accent)]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-extrabold leading-tight text-[var(--ps-text)]">
                    {activeTrack ? activeTrack.name : 'Especial Livre'}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                    {activeTrack
                      ? activeTrack.mode === 'circuit'
                        ? 'Circuito'
                        : 'Ponto-a-Ponto'
                      : 'Sem traps fixos'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-md border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-0.5 font-mono text-[10px] font-extrabold text-[var(--ps-accent)] uppercase">
                    {activeTrack ? `${activeTrack.traps.length} traps` : 'Livre'}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-[var(--ps-muted)] transition-transform ${
                      showTrackPickerDropdown ? 'rotate-180 text-[var(--ps-accent)]' : ''
                    }`}
                  />
                </div>
              </button>

              {activeTrack ? (
                <button
                  type="button"
                  onClick={() => setScreen('track-editor')}
                  className="inline-flex h-[48px] items-center gap-1.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)] shrink-0"
                  title="Editar Marcos no Mapa"
                >
                  <MapIcon className="h-4 w-4 text-[var(--ps-accent)]" />
                  <span>Mapa</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewTrackModal(true)}
                  className="inline-flex h-[48px] items-center gap-1.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)] shrink-0"
                  title="Criar Nova Pista"
                >
                  <Plus className="h-4 w-4 text-[var(--ps-accent)]" />
                  <span>Nova</span>
                </button>
              )}
            </div>

            {showTrackPickerDropdown && (
              <div className="mt-2 max-h-60 space-y-1 overflow-y-auto rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] p-1.5 shadow-xl">
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
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    !activeTrackId
                      ? 'border border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                      : 'border border-transparent hover:bg-[var(--ps-surface)]'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-extrabold text-[var(--ps-text)]">
                      Especial Livre
                    </p>
                    <p className="font-mono text-[10px] text-[var(--ps-muted)] uppercase">
                      Sem traps fixos
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-muted)]">
                      Livre
                    </span>
                    {!activeTrackId && <Check className="h-3.5 w-3.5 text-[var(--ps-accent)]" />}
                  </div>
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
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        isSelected
                          ? 'border border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                          : 'border border-transparent hover:bg-[var(--ps-surface)]'
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-extrabold text-[var(--ps-text)]">
                          {t.name}
                        </p>
                        <p className="font-mono text-[10px] text-[var(--ps-muted)] uppercase">
                          {t.mode === 'circuit' ? 'Circuito' : 'Ponto-a-Ponto'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-accent)]">
                          {t.traps.length} traps
                        </span>
                        {isSelected && <Check className="h-3.5 w-3.5 text-[var(--ps-accent)]" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Centerpiece Circular RaceChrono START Button */}
          <div className="flex flex-col items-center justify-center py-3 sm:py-5 gap-3">
            <button
              type="button"
              onClick={handleStartOrArmStage}
              className="pitstop-btn-red group relative flex h-36 w-36 flex-col items-center justify-center rounded-full border-4 border-[var(--ps-border-strong)] shadow-xl transition-transform active:scale-95 hover:scale-[1.03] sm:h-40 sm:w-40"
            >
              {!isPro && (
                <span className="absolute -top-2 rounded-md border border-amber-500/60 bg-[var(--ps-card-deep)] px-2 py-0.5 font-mono text-[10px] font-black text-[var(--ps-amber)] shadow">
                  PRO
                </span>
              )}
              <span className="font-['Barlow_Condensed'] text-4xl font-black tracking-wider uppercase drop-shadow">
                START
              </span>
              <span className="mt-0.5 font-mono text-[10px] font-bold tracking-widest opacity-85 uppercase">
                {activeTrack ? 'Armar Especial' : 'Especial Livre'}
              </span>
            </button>
          </div>

          {/* Primary 2 Buttons matching RaceChrono: Sessões & Pistas */}
          <div className="grid grid-cols-2 gap-3">
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
              className="relative flex min-h-[60px] items-center justify-center gap-2.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-sm font-extrabold text-[var(--ps-text)] shadow-md transition-all hover:border-[var(--ps-accent)] active:scale-[0.98]"
            >
              <History className="h-5 w-5 text-[var(--ps-accent)]" />
              <span>Sessões ({groupedSessions.length})</span>
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
              className="relative flex min-h-[60px] items-center justify-center gap-2.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-sm font-extrabold text-[var(--ps-text)] shadow-md transition-all hover:border-[var(--ps-accent)] active:scale-[0.98]"
            >
              <Flag className="h-5 w-5 text-[var(--ps-accent)]" />
              <span>Pistas ({tracks.length})</span>
              {!isPro && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
            </button>
          </div>

          {/* Unified Rally Tools Strip (Levantamento + Hodômetro unified) */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={handleOpenQuickAnalysis}
              className="relative flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-2 text-xs font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              {!isPro && (
                <span className="absolute top-1 right-1 rounded bg-amber-500/20 px-1 py-0.2 font-mono text-[8px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
              <TrendingUp className="h-4 w-4 text-[var(--ps-accent)]" />
              <span>Telemetria</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('survey')}
              className="flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-2 text-xs font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              <Compass className="h-4 w-4 text-[var(--ps-accent)]" />
              <span>Levantamento</span>
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
              className="relative flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-2 text-xs font-bold text-[var(--ps-muted)] transition-all hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-[0.98]"
            >
              {!isPro && (
                <span className="absolute top-1 right-1 rounded bg-amber-500/20 px-1 py-0.2 font-mono text-[8px] font-black text-[var(--ps-amber)]">
                  PRO
                </span>
              )}
              <Trophy className="h-4 w-4 text-[var(--ps-accent)]" />
              <span>Satcron Ao Vivo</span>
            </button>
          </div>

          {goproQuickBar}
        </section>
      )}

      {/* SCREEN: LIVE COCKPIT (Fixed Non-Scrolling 100dvh + Prominent Active Stage Banner) */}
      {screen === 'live' && (() => {
        const liveMapTrace =
          liveSamples.length > 0 ? liveSamples : activeTrack?.baseTrace ?? [];
        const activeStageBannerName = activeTrack ? activeTrack.name : 'Especial Livre';
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
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 text-center">
                  <p className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    Velocidade
                  </p>
                  <p className="mt-0.5 font-mono text-3xl font-extrabold text-[var(--ps-text)] tabular-nums sm:text-5xl">
                    {Math.round(speedKmh)}
                  </p>
                  <p className="font-mono text-[10px] font-bold text-[var(--ps-accent)]">KM/H</p>
                </div>
              )}

              {gaugeVisibility.trip && (
                <div className="flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 text-center">
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
                      <p className="font-mono text-2xl font-extrabold text-[var(--ps-amber)] tabular-nums sm:text-4xl">
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

        return (
          <VelocityLivePresetScreen
            layoutId={activeReadyLayoutId}
            menuPosition="bottom"
            customWidgets={[]}
            activeTrackId={activeTrack?.id || 'live_free'}
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
                      <span className="truncate text-sm font-extrabold text-[var(--ps-text)] sm:text-base">
                        {sess.trackName}
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
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tracks.map((tr) => {
                  const isAct = tr.id === activeTrackId;
                  const passCount = runs.filter((r) => r.trackId === tr.id).length;
                  return (
                    <div
                      key={tr.id}
                      className={`flex flex-col justify-between gap-2 rounded-xl border p-3 ${
                        isAct
                          ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                          : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)]'
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
                            <p className="font-bold text-sm text-[var(--ps-text)] leading-tight truncate">
                              {tr.name}
                            </p>
                            {isAct && (
                              <span className="font-mono text-[10px] font-extrabold text-[var(--ps-accent)] uppercase shrink-0">
                                Ativa
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-[var(--ps-muted)]">
                            {tr.mode === 'circuit' ? 'Circuito' : 'Ponto-a-Ponto'} ·{' '}
                            {tr.traps.length} traps · {tr.referenceDistanceKm.toFixed(2)} km ·{' '}
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
                            showToast(`Pista "${tr.name}" selecionada!`);
                          }}
                          className="min-h-[34px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-emerald)]"
                        >
                          Usar
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
                          onClick={() => handleDeleteTrack(tr.id)}
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
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-1 items-center gap-2 min-w-0">
                  <input
                    type="text"
                    value={mapTrackNameDraft}
                    onChange={(e) => setMapTrackNameDraft(e.target.value)}
                    placeholder="Nome da pista (ex: SS-01 Erechim)"
                    aria-label="Nome da pista"
                    className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleSaveCurrentTrackToLibrary}
                    className={`inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold uppercase transition-colors ${
                      justSavedTrack
                        ? 'bg-emerald-600 text-white'
                        : 'pitstop-btn-red'
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

                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[var(--ps-muted)]">
                  <span className={trackTrapSummary.hasStart ? 'text-[var(--ps-emerald)] font-bold' : ''}>
                    {trackTrapSummary.hasStart ? '✓ Largada' : '○ Largada'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={trackTrapSummary.splitsCount > 0 ? 'text-[var(--ps-amber)] font-bold' : ''}>
                    Parciais ({trackTrapSummary.splitsCount})
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className={trackTrapSummary.hasFinish ? 'text-[#FF4D47] font-bold' : ''}>
                    {trackTrapSummary.hasFinish ? '✓ Chegada' : '○ Chegada'}
                  </span>
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] shadow-xl">
              <div className="border-b border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-2.5 space-y-2.5">
                <div>
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-[var(--ps-text)]">Deslize para girar</span>
                    <div className="flex items-center gap-1.5">
                      {selectedTrap && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleRotateTrap(selectedTrap.id, -5)}
                            className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                            aria-label="Girar -5 graus"
                          >
                            -5°
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRotateTrap(selectedTrap.id, 5)}
                            className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                            aria-label="Girar +5 graus"
                          >
                            +5°
                          </button>
                        </>
                      )}
                      <span className="font-mono text-sm font-black text-[var(--ps-amber)] tabular-nums">
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
                    className="mt-1.5 h-6 w-full cursor-pointer accent-lime-500"
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
                      className="h-5 w-5 rounded border-[var(--ps-border-strong)] accent-lime-500 cursor-pointer"
                    />
                    <span className="text-xs font-bold text-[var(--ps-text)] sm:text-sm">
                      Unidirecional
                    </span>
                  </label>

                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 text-xs text-[var(--ps-muted)]">
                      <span className="font-bold">Largura (m):</span>
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
                        className="h-9 w-16 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-center font-mono text-xs font-extrabold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                      />
                      <span className="hidden font-mono text-[10px] opacity-80 sm:inline">
                        (±{Math.round(Math.max(40, activeWidthM) / 2)}m/lado)
                      </span>
                    </label>

                    <button
                      type="button"
                      onClick={() =>
                        setPlacementKind((prev) => (prev ? null : activeKind))
                      }
                      className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 text-xs font-extrabold transition-colors ${
                        placementKind
                          ? 'bg-amber-400 text-zinc-950'
                          : 'border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]'
                      }`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>{placementKind ? 'Toque no Mapa' : 'Novo Marco'}</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1">
                  {(
                    [
                      ['start', 'Largada', 'text-[var(--ps-emerald)]'],
                      ['finish', 'Chegada', 'text-red-500'],
                      ['start_finish', 'Larg/Cheg', 'text-sky-500'],
                      ['split', 'Parcial (Setor)', 'text-[var(--ps-amber)]'],
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
                            ? 'pitstop-btn-red'
                            : `${tone} hover:bg-[var(--ps-card)]`
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
                      {activeUnidirectional ? ' · Unidirecional' : ' · Bidirecional'}
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

      {/* SCREEN: SURVEY / ODOMETER UNIFIED (Levantamento + Hodômetro) */}
      {(screen === 'survey' || screen === 'odometer') && (
        <SurveyCockpit isActive={isActive && (screen === 'survey' || screen === 'odometer')} />
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
                Ponto-a-Ponto (SS)
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
                    Pareamento, gravação sincronizada, bateria e Auto-REC na largada
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
    </div>
  );
};
