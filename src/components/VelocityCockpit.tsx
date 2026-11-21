import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  Activity,
  Check,
  CheckCircle2,
  Compass,
  Copy,
  Download,
  Flag,
  FolderOpen,
  Gauge,
  Map as MapIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Timer,
  Trash2,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { OdometerCockpit } from './OdometerCockpit';
import { SurveyCockpit } from './SurveyCockpit';
import { VelocityMapboxView } from './VelocityMapboxView';
import { useNavSettings } from '../utils/navSettings';
import {
  bearingBetweenDeg,
  computeOptimalStage,
  computePredictiveDeltaSec,
  createDemoSpecialStage,
  detectTrapCrossing,
  exportTrackGeoJson,
  exportTrackGpx,
  formatDeltaSeconds,
  formatStageDuration,
  getOrderedTrackTraps,
  haversineMetersVel,
  parseTrackFileToTrack,
  recalculateRunsForTrack,
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

type VelocitySubTab = 'timer' | 'gauges' | 'odometer' | 'map' | 'analysis' | 'survey';
type VelDriveSource = 'gps' | 'simulator';

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

const GAUGE_PREFS_KEY = 'pitstop_velocity_gauges_v1';

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

interface VelocityLiveStagePanelProps {
  activeTrackName: string;
  stageState: 'idle' | 'armed' | 'running' | 'finished';
  stageStartMs: number | null;
  lastFinishedMs: number | null;
  clockOffsetMs: number;
  speedKmh: number;
  displayedTripKm: number;
  totalDistKm: number;
  bestRun: VelocityRun | null;
  optimalSummary: OptimalStageSummary;
}

const VelocityLiveStagePanel: React.FC<VelocityLiveStagePanelProps> = ({
  activeTrackName,
  stageState,
  stageStartMs,
  lastFinishedMs,
  clockOffsetMs,
  speedKmh,
  displayedTripKm,
  totalDistKm,
  bestRun,
  optimalSummary,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalMs = stageState === 'running' ? 100 : 500;
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

      <div className="relative mt-2 h-5 w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#111214]">
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

      <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-zinc-800/90 bg-[#050608] py-4 px-3 text-center sm:py-6">
        <div className="flex flex-wrap items-center justify-center gap-1.5 font-mono text-[11px] font-bold tracking-wider uppercase text-[#B5B5B5]">
          <span className="truncate max-w-[200px] sm:max-w-xs">{activeTrackName}</span>
          <span aria-hidden="true">·</span>
          <span
            className={
              stageState === 'running'
                ? 'text-emerald-400'
                : stageState === 'armed'
                  ? 'text-amber-400'
                  : 'text-[#C0C4C9]'
            }
          >
            {stageState === 'running'
              ? 'CRONOMETRANDO'
              : stageState === 'armed'
                ? 'ARMADO'
                : stageState === 'finished'
                  ? 'FINALIZADA'
                  : 'PRONTO'}
          </span>
        </div>

        <div
          className={`mt-1 font-mono text-4xl font-extrabold tracking-tight tabular-nums sm:text-6xl ${
            stageState === 'running'
              ? 'text-white'
              : stageState === 'finished'
                ? 'text-emerald-400'
                : 'text-[#C0C4C9]'
          }`}
        >
          {formatStageDuration(currentStageElapsedMs)}
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono text-xs text-[#C0C4C9] tabular-nums sm:text-sm">
          <span>
            Vel <strong className="text-white text-sm sm:text-base">{Math.round(speedKmh)}</strong> km/h
          </span>
          <span>
            Trip <strong className="text-amber-300 text-sm sm:text-base">{displayedTripKm.toFixed(2)}</strong> km
          </span>
          <span>
            CH <strong className="text-white text-sm sm:text-base">{formatClockTime(clockAdjustedNow)}</strong>
          </span>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2 font-mono tabular-nums">
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-1.5 text-center">
          <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Última</p>
          <p className="mt-0.5 text-xs font-extrabold text-white sm:text-base">
            {formatStageDuration(optimalSummary.lastRunTotalMs)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-1.5 text-center">
          <p className="text-[10px] font-bold text-emerald-400 uppercase">Melhor</p>
          <p className="mt-0.5 text-xs font-extrabold text-emerald-400 sm:text-base">
            {formatStageDuration(optimalSummary.bestRunTotalMs)}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2 py-1.5 text-center">
          <p className="text-[10px] font-bold text-amber-400 uppercase">Ideal</p>
          <p className="mt-0.5 text-xs font-extrabold text-amber-300 sm:text-base">
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
  const [subTab, setSubTab] = useState<VelocitySubTab>('timer');
  const [source, setSource] = useState<VelDriveSource>('gps');

  const [dbLoaded, setDbLoaded] = useState(false);
  const [tracks, setTracks] = useState<VelocityTrack[]>([]);
  const [runs, setRuns] = useState<VelocityRun[]>([]);
  const [activeTrackId, setActiveTrackId] = useState<string>(() => loadActiveVelocityTrackId() ?? '');

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

  // Simulator & Editor state
  const [simPlaying, setSimPlaying] = useState(false);
  const [simMultiplier, setSimMultiplier] = useState(1);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackMode, setNewTrackMode] = useState<TrackMode>('point-to-point');
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

  const tracksRef = useRef<VelocityTrack[]>(tracks);
  tracksRef.current = tracks;
  const calFactorRef = useRef(navSettings.calibrationPct / 100);
  calFactorRef.current = navSettings.calibrationPct / 100;

  const prevSampleRef = useRef<VelocitySample | null>(null);
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

  // Load IndexedDB velocity tracks & runs on mount and sync when updated from Settings Backup
  useEffect(() => {
    let alive = true;
    const syncDb = () => {
      loadVelocityDatabase().then(({ tracks: loadedTracks, runs: loadedRuns }) => {
        if (!alive) return;
        setTracks(loadedTracks);
        setRuns(loadedRuns);
        setActiveTrackId((prev) => {
          if (prev && loadedTracks.some((t) => t.id === prev)) return prev;
          return loadedTracks[0]?.id ?? '';
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

  // Optional screen wake lock while session or timer is active
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
      continueNextLap = false
    ) => {
      const startMs = stageStartMsRef.current;
      if (!startMs) return;
      const elapsedTotal = Math.max(100, finishedAtMs - startMs);
      const samples = [...liveSamplesRef.current];
      const distKm = totalDistRef.current;
      const avgSpeed = elapsedTotal > 0 ? distKm / (elapsedTotal / 3600000) : 0;

      let nextNum = 1;
      if (activeTrack) {
        nextNum = runs.filter((r) => r.trackId === activeTrack.id).length + 1;
        const newRun: VelocityRun = {
          id: `run_${Date.now()}_${nextNum}`,
          trackId: activeTrack.id,
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

        setTracks((prev) =>
          prev.map((t) =>
            t.id === activeTrack.id && (!t.baseTrace || t.baseTrace.length === 0)
              ? {
                  ...t,
                  referenceDistanceKm: distKm,
                  baseTrace: samples,
                }
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
        setCurrentSplitTimesMs({});
        setLiveSamples([]);
        showToast(`Volta #${nextNum}: ${formatStageDuration(elapsedTotal)}`);
      } else {
        setStageState('finished');
        setIsRecording(false);
        setSimPlaying(false);
        showToast(`Chegada registrada: ${formatStageDuration(elapsedTotal)}`);
      }
    },
    [activeTrack, runs, showToast]
  );

  // Core GPS sample processor with Trap vector intersection + calibration factor
  const processIncomingFix = useCallback(
    (fix: {
      lat: number;
      lon: number;
      speedKmh: number;
      accuracyM: number | null;
      headingDeg: number | null;
      altitudeM: number | null;
      timestampMs: number;
    }) => {
      setCurrentPos({ lat: fix.lat, lon: fix.lon });
      setSpeedKmh(fix.speedKmh);
      setGpsAccuracyM(fix.accuracyM);
      setAltitudeM(fix.altitudeM);
      setGpsActive(true);
      setGpsError(null);

      const prev = prevSampleRef.current;
      let deltaDistKm = 0;
      let resolvedHeading = fix.headingDeg;

      if (prev) {
        const stepM = haversineMetersVel(prev.lat, prev.lon, fix.lat, fix.lon);
        if (stepM >= 0.4 && stepM < 500) {
          deltaDistKm = (stepM / 1000) * calFactorRef.current;
          if (resolvedHeading === null && stepM >= 2) {
            resolvedHeading = bearingBetweenDeg(prev.lat, prev.lon, fix.lat, fix.lon);
          }
        }
      }
      if (resolvedHeading !== null) {
        setHeadingDeg(Math.round(resolvedHeading));
      }

      const nextTotalDist = totalDistRef.current + deltaDistKm;
      if (isRecording || stageStateRef.current === 'running') {
        setTotalDistKm(nextTotalDist);
        setTripDistKm((t) => t + deltaDistKm);
      } else if (stageStateRef.current === 'armed') {
        setTripDistKm((t) => t + deltaDistKm);
      }

      if (
        fix.speedKmh > maxSpeedRef.current &&
        (isRecording || stageStateRef.current === 'running')
      ) {
        setMaxSpeedKmh(Math.round(fix.speedKmh));
      }

      let activeStartMs = stageStartMsRef.current;
      let nextStageState = stageStateRef.current;
      const updatedSplits = { ...currentSplitTimesRef.current };

      if (
        activeTrack &&
        prev &&
        (stageStateRef.current === 'armed' || stageStateRef.current === 'running')
      ) {
        const ordered = getOrderedTrackTraps(activeTrack);
        for (const trap of ordered) {
          const hit = detectTrapCrossing(
            { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
            { lat: fix.lat, lon: fix.lon, timestampMs: fix.timestampMs },
            trap
          );
          if (!hit) continue;

          if (
            (trap.kind === 'start' || trap.kind === 'start_finish') &&
            nextStageState === 'armed'
          ) {
            activeStartMs = hit.crossTimestampMs;
            nextStageState = 'running';
            setStageStartMs(hit.crossTimestampMs);
            setStageState('running');
            setTotalDistKm(0);
            setTripDistKm(0);
            setMaxSpeedKmh(Math.round(fix.speedKmh));
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
            finalizeRun(hit.crossTimestampMs, updatedSplits, true);
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
            finalizeRun(hit.crossTimestampMs, updatedSplits, false);
            nextStageState = 'finished';
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
        speedKmh: fix.speedKmh,
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
      };

      prevSampleRef.current = sample;
      if (isRecording || nextStageState === 'running') {
        // Keep full stage trace without mid-run truncation (stored in IndexedDB)
        setLiveSamples((arr) => [...arr, sample]);
      }
    },
    [activeTrack, isRecording, finalizeRun, showToast]
  );

  const processIncomingFixRef = useRef(processIncomingFix);
  processIncomingFixRef.current = processIncomingFix;

  // Real GPS listener (paused automatically when Levantamento tab is active or Velocidade is backgrounded)
  useEffect(() => {
    if (!isActive || source !== 'gps' || subTab === 'survey') return;
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
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
            (pos, err) => {
              if (cancelled || err || !pos) return;
              processIncomingFixRef.current({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                speedKmh: pos.coords.speed ? Math.max(0, pos.coords.speed * 3.6) : 0,
                accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
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
        setGpsError('GPS indisponível neste navegador. Use o modo Simulador para testar.');
        return;
      }

      webWatchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;
          processIncomingFixRef.current({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speedKmh: pos.coords.speed ? Math.max(0, pos.coords.speed * 3.6) : 0,
            accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
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
              : 'Aguardando sinal GPS em área aberta (ou ative Simulador).'
          );
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    };

    startGps();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [isActive, source, subTab]);

  // Simulator GPS engine for testing Point-to-Point traps indoors
  const demoStage = useMemo(() => createDemoSpecialStage(), []);
  useEffect(() => {
    if (!isActive || source !== 'simulator' || !simPlaying || subTab === 'survey') return;
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
  }, [isActive, source, simPlaying, simMultiplier, demoStage, trackRuns.length, subTab]);

  const handleLoadDemoStage = () => {
    const existing = tracks.find((t) => t.id === demoStage.track.id);
    if (!existing) {
      setTracks((prev) => [demoStage.track, ...prev]);
    }
    setActiveTrackId(demoStage.track.id);
    setSource('simulator');
    if (subTab === 'survey') setSubTab('timer');
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
    showToast('Especial SS-01 armada no Simulador! Cruzando pórtico de largada...');
  };

  const handleStartOrArmStage = () => {
    if (stageState === 'running') {
      finalizeRun(Date.now());
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
    const name = newTrackName.trim() || `Especial ${tracks.length + 1}`;
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
    setNewTrackName('');
    setShowNewTrackModal(false);
    setLiveSamples([]);
    setTotalDistKm(0);
    setTripDistKm(0);
    setStageState('idle');
    setIsRecording(false);
    setPlacementKind(newTrackMode === 'circuit' ? 'start_finish' : 'start');
    setSelectedTrapId(null);
    setSubTab('map');
    showToast(`Pista "${name}" criada. Marque Largada, Parciais e Chegada e toque em Salvar Pista.`);
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
      const inferredBearing =
        draftBearingDeg > 0
          ? draftBearingDeg
          : lastExisting
            ? bearingBetweenDeg(lastExisting.lat, lastExisting.lon, lat, lon)
            : headingDeg ?? 0;

      const trapLabel = buildTrapName(targetTrack, targetKind);
      const newTrap: VelocityTrap = {
        id: `trap_${targetKind}_${Date.now()}`,
        name: trapLabel,
        kind: targetKind,
        lat,
        lon,
        bearingDeg: inferredBearing,
        widthM: newTrapWidthM,
        unidirectional: newTrapUnidirectional,
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
      showToast(`${trapLabel} posicionado (${inferredBearing.toFixed(1)}° · ${newTrapWidthM}m).`);
    },
    [
      activeTrack,
      tracks.length,
      mapTrackNameDraft,
      placementKind,
      draftBearingDeg,
      headingDeg,
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
            headingDeg: headingDeg ?? draftBearingDeg,
          }
        : null);

    if (!pos) {
      setPlacementKind(kind);
      showToast('Sem GPS: toque no mapa satélite para posicionar o Marco.');
      return;
    }

    const trapLabel = buildTrapName(targetTrack, kind);
    const newTrap: VelocityTrap = {
      id: `trap_${kind}_${Date.now()}`,
      name: trapLabel,
      kind,
      lat: pos.lat,
      lon: pos.lon,
      bearingDeg: pos.headingDeg ?? headingDeg ?? draftBearingDeg,
      widthM: newTrapWidthM,
      unidirectional: newTrapUnidirectional,
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
    showToast(`${trapLabel} marcado (${newTrap.bearingDeg}° · ${newTrapWidthM}m)!`);
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
      // Compute approximate track distance between traps when no GPS trace recorded yet
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

    const hasStart = savedTrack.traps.some(
      (t) => t.kind === 'start' || t.kind === 'start_finish'
    );
    const hasFinish = savedTrack.traps.some(
      (t) => t.kind === 'finish' || t.kind === 'start_finish'
    );
    if (!hasStart || !hasFinish) {
      showToast(
        `Pista "${savedTrack.name}" salva (${savedTrack.traps.length} pontos). Lembre-se de marcar Largada e Chegada.`
      );
    } else {
      showToast(
        `Pista "${savedTrack.name}" salva com sucesso (${savedTrack.traps.length} traps)!`
      );
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
      setStageState('idle');
      setStageStartMs(null);
      setLastFinishedMs(null);
      setCurrentSplitTimesMs({});
    }
    showToast('Mapa / Pista excluída.');
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
      const parsed = await parseTrackFileToTrack(file);
      setTracks((prev) => [parsed, ...prev]);
      setActiveTrackId(parsed.id);
      setStageState('idle');
      setStageStartMs(null);
      setLastFinishedMs(null);
      setCurrentSplitTimesMs({});
      setSubTab('map');
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

  // Trace available for Post-Recording Trap Editor & Mapbox
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

  return (
    <div className="space-y-3">
      {/* Ultra-Clean Top Bar (Track Selector + Single-Line Submenus) */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] px-2.5 py-2 text-white shadow-lg sm:px-4 sm:py-2.5">
        <div className="flex items-center gap-2">
          <select
            aria-label="Selecionar especial ou circuito"
            value={activeTrackId}
            onChange={(e) => {
              setActiveTrackId(e.target.value);
              setStageState('idle');
              setStageStartMs(null);
              setLastFinishedMs(null);
              setCurrentSplitTimesMs({});
            }}
            className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none sm:text-sm"
          >
            <option value="">Selecionar Pista / SS...</option>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.traps.length})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setSubTab('map')}
            title="Configurar pista, KML e GPS/Simulador no Mapa"
            className="inline-flex h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 font-mono text-[11px] font-bold text-[#C0C4C9] hover:border-zinc-700 hover:text-white"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                source === 'simulator'
                  ? 'bg-amber-400'
                  : gpsActive
                    ? 'bg-emerald-400'
                    : 'bg-zinc-500'
              }`}
            />
            <span>
              {source === 'simulator'
                ? `SIM ${simMultiplier}x`
                : gpsActive && gpsAccuracyM !== null
                  ? `GPS ±${gpsAccuracyM}m`
                  : 'GPS'}
            </span>
          </button>
        </div>

        {/* 6 Velocity Submenus (1 crisp scrollable/grid line on mobile, Highlighted "Levantamento") */}
        <div
          role="tablist"
          aria-label="Submenus de Velocidade"
          className="mt-2 flex items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 bg-[#080B0D] p-1 sm:grid sm:grid-cols-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {(
            [
              ['timer', 'Cronômetro', Timer, false],
              ['gauges', 'Painel', Activity, false],
              ['odometer', 'Hodômetro', Gauge, false],
              ['map', 'Mapa', MapIcon, false],
              ['analysis', 'Dados', TrendingUp, false],
              ['survey', 'Levantamento', Compass, true],
            ] as const
          ).map(([id, label, Icon, isHighlighted]) => {
            const active = subTab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setSubTab(id)}
                className={`inline-flex min-h-[38px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-2.5 py-1 text-[10px] font-bold whitespace-nowrap transition-all sm:min-w-0 sm:flex-row sm:gap-1.5 sm:px-1.5 sm:text-xs ${
                  active
                    ? isHighlighted
                      ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-zinc-950 font-black shadow-[0_0_12px_rgba(245,158,11,0.45)]'
                      : 'pitstop-btn-red text-white'
                    : isHighlighted
                      ? 'border border-amber-500/60 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20'
                      : 'text-[#B5B5B5] hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="leading-none">{label}</span>
              </button>
            );
          })}
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

      {/* SCREEN 1: CRONÔMETRO DE ESPECIAL */}
      {subTab === 'timer' && (
        <section className="space-y-3">
          <VelocityLiveStagePanel
            activeTrackName={activeTrack ? activeTrack.name : 'Especial Livre'}
            stageState={stageState}
            stageStartMs={stageStartMs}
            lastFinishedMs={lastFinishedMs}
            clockOffsetMs={navSettings.clockOffsetMs}
            speedKmh={speedKmh}
            displayedTripKm={displayedTripKm}
            totalDistKm={totalDistKm}
            bestRun={bestRun}
            optimalSummary={optimalSummary}
          />

          {/* Splits Comparison Table */}
          {orderedTraps.filter((t) => t.kind !== 'start').length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
              <h3 className="text-xs font-bold tracking-wider text-[#B5B5B5] uppercase">
                Parciais da Especial (Splits)
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

          {/* Extra-Large Vibration-Proof Bottom Controls */}
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
              <Flag className="h-5 w-5 text-amber-400" />
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
                  <span>Encerrar SS</span>
                </>
              ) : (
                <>
                  <Play className="h-5 w-5 fill-current" />
                  <span>Iniciar SS</span>
                </>
              )}
            </button>
          </div>
        </section>
      )}

      {/* SCREEN 2: MOSTRADORES (PAINEL) */}
      {subTab === 'gauges' && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3.5 py-2.5 text-white">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-[#E10600]" />
              <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                Painel de Telemetria
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
              {stageState === 'running' ? 'Encerrar SS' : 'Iniciar SS'}
            </button>
          </div>
        </section>
      )}

      {/* SCREEN 2B: HODÔMETRO DIGITAL INTEGRADO */}
      {subTab === 'odometer' && (
        <OdometerCockpit isActive={isActive && subTab === 'odometer'} />
      )}

      {/* SCREEN 3: MAPA & MARCOS (ESTILO RACECHRONO) + NOVA / KML / DEMO / GPS / SIM + SALVAR PISTA */}
      {subTab === 'map' && (() => {
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
            {/* Map Tools Bar: Nova, KML, Demo, GPS / Sim (Moved inside Mapa submenu) */}
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 sm:p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowNewTrackModal(true)}
                    title="Nova Pista / Especial"
                    className="inline-flex h-[36px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:border-[#E10600]"
                  >
                    <Plus className="h-3.5 w-3.5 text-[#E10600]" />
                    <span>Nova</span>
                  </button>

                  <label
                    title="Importar KML / KMZ / GPX"
                    className="inline-flex h-[36px] cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:border-[#E10600]"
                  >
                    <Upload className="h-3.5 w-3.5 text-[#E10600]" />
                    <span>KML</span>
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
                    title="Testar Demo SS-01"
                    className="inline-flex h-[36px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white"
                  >
                    <Play className="h-3 w-3 text-emerald-400" />
                    <span>Demo</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setSource('gps');
                        setSimPlaying(false);
                      }}
                      className={`min-h-[30px] rounded-md px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap ${
                        source === 'gps' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
                      }`}
                    >
                      GPS{gpsActive && gpsAccuracyM !== null ? ` ±${gpsAccuracyM}` : ''}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSource('simulator')}
                      className={`min-h-[30px] rounded-md px-2.5 text-[11px] font-bold transition-colors whitespace-nowrap ${
                        source === 'simulator' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
                      }`}
                    >
                      Sim
                    </button>
                  </div>

                  {source === 'simulator' && (
                    <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] px-1 py-0.5">
                      <button
                        type="button"
                        onClick={() => setSimPlaying((v) => !v)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-white hover:bg-zinc-800"
                        aria-label={simPlaying ? 'Pausar simulador' : 'Rodar simulador'}
                      >
                        {simPlaying ? (
                          <Pause className="h-3.5 w-3.5 text-amber-300" />
                        ) : (
                          <Play className="h-3.5 w-3.5 text-emerald-400" />
                        )}
                      </button>
                      {[1, 2, 4].map((x) => (
                        <button
                          key={x}
                          type="button"
                          onClick={() => setSimMultiplier(x)}
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
                            simMultiplier === x ? 'bg-[#E10600] text-white' : 'text-zinc-400 hover:text-white'
                          }`}
                        >
                          {x}x
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Save Track & Gate Readiness Bar */}
              <div className="flex flex-col gap-2 border-t border-zinc-800/80 pt-2 sm:flex-row sm:items-center sm:justify-between">
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
                        <span>Pista Salva</span>
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

            {/* RaceChrono-Style Integrated Map Editor (Top Controls + Satellite Map + Bottom Marco Info) */}
            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] shadow-xl">
              {/* Top Editor Controls: Slider "Deslize para girar" + Unidirecional + Largura (m) + Tipo */}
              <div className="border-b border-zinc-800 bg-[#14161A] px-3 py-2.5 space-y-2.5">
                {/* 1. Rotation Slider + Real-time Angle */}
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

                {/* 2. Unidirecional Checkbox + Numeric Width Input + Novo Marco Action */}
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

                {/* 3. Tipo Selector: Largada, Chegada, Largada/Chegada ou Linha Parcial (Setor) */}
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

              {/* Satellite Map Viewport with Single-Point Unified Gate + Arrow */}
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
              />

              {/* Bottom RaceChrono Summary Strip + Quick Actions */}
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

            {/* Lista Compacta de Marcos + Scrubber de Traçado + Exportação */}
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
                <button
                  type="button"
                  onClick={handleSaveCurrentTrackToLibrary}
                  className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1 rounded-lg px-3.5 text-xs font-extrabold text-white"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>Salvar Pista</span>
                </button>

                <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-semibold text-white hover:bg-zinc-800">
                  <Upload className="h-3.5 w-3.5 text-[#E10600]" />
                  <span>KML/KMZ</span>
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
                  </>
                )}
              </div>
            </div>

          {/* Saved Maps, Tracks & Trips Library */}
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-white sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-[#E10600]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
                  Pistas, Mapas &amp; Trips Salvos ({tracks.length})
                </h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeTrack && (
                  <button
                    type="button"
                    onClick={() => handleDuplicateTrack(activeTrack)}
                    className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Duplicar</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowNewTrackModal(true)}
                  className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1 rounded-lg px-3 text-xs font-extrabold text-white"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Nova Pista</span>
                </button>
              </div>
            </div>

            {tracks.length === 0 ? (
              <p className="py-5 text-center text-xs text-zinc-500">
                Nenhuma pista salva ainda. Marque os pontos no mapa e toque em{' '}
                <strong>Salvar Pista</strong> ou importe um KML/GPX.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {tracks.map((tr) => {
                  const isActive = tr.id === activeTrackId;
                  const passCount = runs.filter((r) => r.trackId === tr.id).length;
                  return (
                    <div
                      key={tr.id}
                      className={`flex flex-col justify-between gap-2 rounded-xl border p-3 transition-colors ${
                        isActive
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
                            {isActive && (
                              <span className="font-mono text-[10px] font-extrabold text-[#E10600] uppercase shrink-0">
                                Ativa
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-zinc-400">
                            {tr.traps.length} traps · {tr.referenceDistanceKm.toFixed(2)} km ·{' '}
                            {passCount} pass.
                          </p>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-zinc-800/80">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveTrackId(tr.id);
                            setStageState('idle');
                            setStageStartMs(null);
                            setLastFinishedMs(null);
                            setCurrentSplitTimesMs({});
                            showToast(`Pista carregada: ${tr.name}`);
                          }}
                          className={`min-h-[34px] flex-1 rounded-lg px-2.5 text-xs font-bold ${
                            isActive
                              ? 'bg-[#E10600] text-white'
                              : 'border border-zinc-700 bg-[#1E1E22] text-white hover:bg-zinc-800'
                          }`}
                        >
                          {isActive ? 'Selecionada' : 'Carregar'}
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
        );
      })()}

      {/* SCREEN 4: TELEMETRIA & PASSAGENS */}
      {subTab === 'analysis' && (
        <section className="space-y-3">
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide uppercase">
                  Gráfico de Velocidade e Parciais
                </h3>
                <p className="text-xs text-[#B5B5B5]">
                  Comparativo de velocidade (km/h) ao longo da especial.
                </p>
              </div>
              {optimalSummary.optimalTotalMs !== null && (
                <div className="font-mono text-xs text-amber-300 font-bold">
                  Ideal (Optimal): {formatStageDuration(optimalSummary.optimalTotalMs)}
                </div>
              )}
            </div>

            <div className="mt-3 rounded-xl border border-zinc-800 bg-[#080B0D] p-3">
              {editableTrace.length > 2 ? (
                <svg viewBox="0 0 400 130" className="h-40 w-full">
                  <line x1="0" y1="30" x2="400" y2="30" stroke="#27272a" strokeDasharray="3 3" />
                  <line x1="0" y1="70" x2="400" y2="70" stroke="#27272a" strokeDasharray="3 3" />
                  <line x1="0" y1="110" x2="400" y2="110" stroke="#27272a" />
                  {bestRun && bestRun.samples.length > 1 && (
                    <polyline
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="1.75"
                      strokeOpacity="0.65"
                      points={bestRun.samples
                        .map((s, i) => {
                          const x = (i / Math.max(1, bestRun.samples.length - 1)) * 390 + 5;
                          const y = 115 - Math.min(100, (s.speedKmh / 160) * 100);
                          return `${x.toFixed(1)},${y.toFixed(1)}`;
                        })
                        .join(' ')}
                    />
                  )}
                  <polyline
                    fill="none"
                    stroke="#E10600"
                    strokeWidth="2.5"
                    points={editableTrace
                      .map((s, i) => {
                        const x = (i / Math.max(1, editableTrace.length - 1)) * 390 + 5;
                        const y = 115 - Math.min(100, (s.speedKmh / 160) * 100);
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')}
                  />
                  <text x="8" y="25" fill="#71717a" fontSize="9" fontFamily="monospace">
                    140 km/h
                  </text>
                  <text x="8" y="66" fill="#71717a" fontSize="9" fontFamily="monospace">
                    70 km/h
                  </text>
                </svg>
              ) : (
                <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
                  Complete uma passagem ou ative o Simulador para gerar o gráfico.
                </div>
              )}
            </div>
          </div>

          {optimalSummary.sectors.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
              <h3 className="text-xs font-bold tracking-wider text-amber-400 uppercase">
                Tempo Ideal por Setor (Optimal Stage)
              </h3>
              <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {optimalSummary.sectors.map((sec) => (
                  <div
                    key={sec.sectorIndex}
                    className="rounded-lg border border-zinc-800 bg-[#080B0D] px-3 py-2.5 font-mono"
                  >
                    <p className="font-sans text-xs font-bold text-[#C0C4C9]">{sec.label}</p>
                    <p className="mt-1 text-lg font-extrabold text-amber-300 tabular-nums">
                      {formatStageDuration(sec.bestMs)}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      {sec.bestRunNumber ? `Passada #${sec.bestRunNumber}` : 'Sem registro'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-white">
            <div className="flex items-center justify-between">
              <h3 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide uppercase">
                Histórico de Passagens ({trackRuns.length})
              </h3>
              {trackRuns.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (!activeTrack) return;
                    setRuns((prev) => prev.filter((r) => r.trackId !== activeTrack.id));
                  }}
                  className="text-xs font-semibold text-red-400 hover:text-red-300"
                >
                  Limpar Passagens
                </button>
              )}
            </div>

            {trackRuns.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                Nenhuma passagem gravada ainda nesta especial.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-[#B5B5B5]">
                      <th className="py-2 pr-2">Passada</th>
                      <th className="px-2 py-2">Tempo Total</th>
                      <th className="px-2 py-2 text-right">Distância</th>
                      <th className="px-2 py-2 text-right">Vel. Méd</th>
                      <th className="py-2 pl-2 text-right">Vel. Máx</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {trackRuns.map((run) => {
                      const isBest = run.id === optimalSummary.bestRunId;
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
                          <td className="px-2 py-2 text-right text-[#C0C4C9]">
                            {run.avgSpeedKmh} km/h
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
            )}
          </div>
        </section>
      )}

      {/* SCREEN 5: SUBMENU DESTACADO "LEVANTAMENTO" */}
      {subTab === 'survey' && (
        <SurveyCockpit isActive={isActive && subTab === 'survey'} />
      )}

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
                onClick={() => setNewTrackMode('point-to-point')}
                className={`min-h-[36px] rounded-md text-xs font-bold ${
                  newTrackMode === 'point-to-point'
                    ? 'bg-[#E10600] text-white'
                    : 'text-[#B5B5B5]'
                }`}
              >
                Ponto-a-Ponto (SS)
              </button>
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
