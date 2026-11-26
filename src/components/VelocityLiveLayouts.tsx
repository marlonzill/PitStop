import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Flag,
  Map as MapIcon,
  Pencil,
  Play,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  TrendingUp,
  Trophy,
} from 'lucide-react';
import { VelocityMapboxView } from './VelocityMapboxView';
import {
  computePredictiveDeltaSec,
  detectTrapCrossing,
  formatDeltaSeconds,
  formatStageDuration,
  haversineMetersVel,
  interpolateSampleAtDist,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrap,
} from '../utils/velocityEngine';
import type {
  CustomWidgetConfig,
  CustomWidgetSize,
  VelocityCockpitLayoutId,
  VelocityMenuPosition,
} from '../utils/velocityCockpitLayout';

export interface SplitTrapDisplayItem {
  id: string;
  code: string;
  name: string;
  crossed: boolean;
  isActive: boolean;
  sectorMs: number | null;
  diffSec: number | null;
}

export interface VelocityLiveLayoutViewProps {
  layoutId: VelocityCockpitLayoutId;
  menuPosition: VelocityMenuPosition;
  customWidgets: CustomWidgetConfig[];
  activeTrackId: string;
  activeTrackName: string;
  hasTraps: boolean;
  orderedTraps: VelocityTrap[];
  currentSplitTimesMs: Record<string, number>;
  stageState: 'idle' | 'armed' | 'running' | 'finished';
  stageStartMs: number | null;
  lastFinishedMs: number | null;
  clockOffsetMs: number;
  speedKmh: number;
  displayedTripKm: number;
  totalDistKm: number;
  liveRemainingDistM: number | null;
  liveHasRefDist: boolean;
  liveProgressPct: number;
  liveIsFinishFlash: boolean;
  bestRun: VelocityRun | null;
  fallbackRuns: VelocityRun[];
  optimalSummary: OptimalStageSummary;
  lapNumber: number;
  liveSamples: VelocitySample[];
  liveMapTrace: VelocitySample[];
  guideTrace?: VelocitySample[];
  currentPos: { lat: number; lon: number } | null;
  headingDeg: number | null;
  liveHeadingUp: boolean;
  onToggleHeadingUp: () => void;
  liveHeatmapMode: 'speed' | 'accel';
  onToggleHeatmapMode: () => void;
  isPro: boolean;
  showLiveMap: boolean;
  liveMode: 'timer' | 'gauges';
  gaugesNode?: React.ReactNode;
  liveNotice: string | null;
  gpsError: string | null;
  gpsStatusLabel?: string;
  zeroSpeedLocked?: boolean;
  wakeLockActive: boolean;
  goproCompactButtonNode: React.ReactNode;
  onBack: () => void;
  onOpenConfigModal: () => void;
  onOpenSatcron: () => void;
  onOpenAnalysis: () => void;
  onSelectTimerTab: () => void;
  onSelectMapTab: () => void;
  onZeroTrip: () => void;
  onStartOrArmStage: () => void;
  onForceManualStart: () => void;
  onEditTripDistanceKm: (nextDisplayedKm: number) => void;
}

function formatClockTime(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function formatSplitCompactTime(ms: number): string {
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec - mins * 60;
  return `${mins}:${remSec < 10 ? '0' : ''}${remSec.toFixed(1)}`;
}

function resolveTrapElapsedMsInRun(run: VelocityRun, trap: VelocityTrap): number | null {
  const recorded = run.splitTimesMs?.[trap.id];
  if (typeof recorded === 'number' && Number.isFinite(recorded) && recorded >= 0) {
    return recorded;
  }
  if (
    (trap.kind === 'finish' || trap.kind === 'start_finish') &&
    Number.isFinite(run.totalMs) &&
    run.totalMs > 0
  ) {
    return run.totalMs;
  }
  const samples = run.samples;
  if (!samples || samples.length < 2) return null;

  const baseStartMs = run.startedAtMs || samples[0].timestampMs;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const hit = detectTrapCrossing(
      { lat: prev.lat, lon: prev.lon, timestampMs: prev.timestampMs },
      { lat: curr.lat, lon: curr.lon, timestampMs: curr.timestampMs },
      trap,
      { hdopAccuracyM: 45, autoSnap: true }
    );
    if (hit && hit.crossTimestampMs >= baseStartMs) {
      if (
        Number.isFinite(prev.stageElapsedMs) &&
        Number.isFinite(curr.stageElapsedMs) &&
        curr.stageElapsedMs >= prev.stageElapsedMs &&
        curr.stageElapsedMs > 0
      ) {
        return Math.round(
          prev.stageElapsedMs + hit.t * (curr.stageElapsedMs - prev.stageElapsedMs)
        );
      }
      return Math.max(0, hit.crossTimestampMs - baseStartMs);
    }
  }

  let bestDistM = Infinity;
  let bestElapsedMs: number | null = null;
  const startIndex = trap.kind === 'start' ? 0 : Math.min(1, samples.length - 1);
  for (let i = startIndex; i < samples.length; i += 1) {
    const s = samples[i];
    const dM = haversineMetersVel(s.lat, s.lon, trap.lat, trap.lon);
    if (dM < bestDistM) {
      bestDistM = dM;
      bestElapsedMs =
        Number.isFinite(s.stageElapsedMs) && s.stageElapsedMs > 0
          ? s.stageElapsedMs
          : Math.max(0, s.timestampMs - baseStartMs);
    }
  }
  return bestDistM <= 250 && bestElapsedMs !== null ? bestElapsedMs : null;
}

export const VelocityLivePresetScreen: React.FC<VelocityLiveLayoutViewProps> = ({
  layoutId,
  menuPosition,
  customWidgets,
  activeTrackId,
  activeTrackName,
  hasTraps,
  orderedTraps,
  currentSplitTimesMs,
  stageState,
  stageStartMs,
  lastFinishedMs,
  clockOffsetMs,
  speedKmh,
  displayedTripKm,
  totalDistKm,
  liveRemainingDistM,
  liveHasRefDist,
  liveProgressPct,
  liveIsFinishFlash,
  bestRun,
  fallbackRuns,
  optimalSummary,
  lapNumber,
  liveSamples,
  liveMapTrace,
  guideTrace,
  currentPos,
  headingDeg,
  liveHeadingUp,
  onToggleHeadingUp,
  liveHeatmapMode,
  onToggleHeatmapMode,
  showLiveMap,
  liveMode,
  gaugesNode,
  liveNotice,
  gpsError,
  gpsStatusLabel,
  zeroSpeedLocked,
  wakeLockActive,
  goproCompactButtonNode,
  onBack,
  onOpenConfigModal,
  onOpenSatcron,
  onOpenAnalysis,
  onSelectTimerTab,
  onSelectMapTab,
  onZeroTrip,
  onStartOrArmStage,
  onForceManualStart,
  onEditTripDistanceKm,
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editingTrip, setEditingTrip] = useState(false);
  const [tripInput, setTripInput] = useState('');
  const [tripUnit, setTripUnit] = useState<'m' | 'km'>('m');

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

  const latestSample = liveSamples.length > 0 ? liveSamples[liveSamples.length - 1] : null;
  const liveLongG = latestSample?.accelLongG ?? 0;
  const liveLatG = latestSample?.accelLatG ?? 0;

  const deltaTrend = useMemo<'improving' | 'worsening' | null>(() => {
    if (stageState !== 'running' || !bestRun || predictiveDeltaSec === null) return null;
    if (liveSamples.length >= 2 && totalDistKm > 0.03) {
      const lookbackDistKm = Math.max(0, totalDistKm - 0.08);
      const earlierSample = interpolateSampleAtDist(liveSamples, lookbackDistKm);
      if (earlierSample) {
        const earlierDelta = computePredictiveDeltaSec(
          earlierSample.distKm,
          earlierSample.stageElapsedMs,
          bestRun
        );
        if (earlierDelta !== null) {
          const shift = predictiveDeltaSec - earlierDelta;
          if (shift <= -0.04) return 'improving';
          if (shift >= 0.04) return 'worsening';
        }
      }
    }
    const refSample = interpolateSampleAtDist(bestRun.samples, totalDistKm);
    if (refSample) {
      const speedDiff = speedKmh - refSample.speedKmh;
      if (speedDiff >= 2) return 'improving';
      if (speedDiff <= -2) return 'worsening';
    }
    return null;
  }, [stageState, bestRun, predictiveDeltaSec, liveSamples, totalDistKm, speedKmh]);

  const splitTrapItems = useMemo<SplitTrapDisplayItem[]>(() => {
    const checkpoints = orderedTraps.filter((t) => t.kind !== 'start');
    if (checkpoints.length === 0) return [];

    const candidateRuns: VelocityRun[] = [];
    if (bestRun && bestRun.totalMs > 0) candidateRuns.push(bestRun);
    for (let i = fallbackRuns.length - 1; i >= 0; i -= 1) {
      const r = fallbackRuns[i];
      if (r.totalMs > 0 && r.id !== bestRun?.id) {
        candidateRuns.push(r);
      }
    }

    let foundActive = false;
    return checkpoints.map((trap, idx) => {
      const currMs = currentSplitTimesMs[trap.id] ?? null;
      const prevCurrMs =
        idx === 0 ? 0 : currentSplitTimesMs[checkpoints[idx - 1].id] ?? null;
      const hasSectorCurr = currMs !== null && prevCurrMs !== null && currMs >= prevCurrMs;
      const displayMs = hasSectorCurr ? currMs - prevCurrMs : currMs;

      let refSectorMs: number | null = null;
      let refCumulMs: number | null = null;
      for (const refRun of candidateRuns) {
        const cMs = resolveTrapElapsedMsInRun(refRun, trap);
        const pMs = idx === 0 ? 0 : resolveTrapElapsedMsInRun(refRun, checkpoints[idx - 1]);
        if (cMs !== null && refCumulMs === null) {
          refCumulMs = cMs;
        }
        if (cMs !== null && pMs !== null && cMs >= pMs) {
          refSectorMs = cMs - pMs;
          refCumulMs = cMs;
          break;
        }
      }

      let diffSec: number | null = null;
      if (currMs !== null) {
        if (hasSectorCurr && refSectorMs !== null) {
          diffSec = (currMs - prevCurrMs - refSectorMs) / 1000;
        } else if (refCumulMs !== null) {
          diffSec = (currMs - refCumulMs) / 1000;
        }
      }

      const crossed = currMs !== null;
      let isActive = false;
      if (!crossed && !foundActive && stageState === 'running') {
        isActive = true;
        foundActive = true;
      }
      return {
        id: trap.id,
        code: `P${idx + 1}`,
        name: trap.name,
        crossed,
        isActive,
        sectorMs: displayMs,
        diffSec,
      };
    });
  }, [orderedTraps, currentSplitTimesMs, bestRun, fallbackRuns, stageState]);

  const visibleSplitItems = useMemo(() => {
    const total = splitTrapItems.length;
    if (total <= 4) return splitTrapItems;
    const activeIdx = splitTrapItems.findIndex((s) => s.isActive);
    let startIdx = 0;
    if (activeIdx >= 0) {
      startIdx = Math.max(0, Math.min(total - 4, activeIdx - 2));
    } else {
      let lastCrossedIdx = -1;
      for (let i = total - 1; i >= 0; i -= 1) {
        if (splitTrapItems[i].crossed) {
          lastCrossedIdx = i;
          break;
        }
      }
      if (lastCrossedIdx >= 0) {
        startIdx = Math.max(0, Math.min(total - 4, lastCrossedIdx - 1));
      }
    }
    return splitTrapItems.slice(startIdx, startIdx + 4);
  }, [splitTrapItems]);

  const progressSplitMarkers = useMemo(() => {
    const splitTraps = orderedTraps.filter((t) => t.kind === 'split');
    if (splitTraps.length === 0) return [];

    const refTrace =
      guideTrace && guideTrace.length >= 2
        ? guideTrace
        : bestRun && bestRun.samples.length >= 2
          ? bestRun.samples
          : fallbackRuns.find((r) => r.samples.length >= 2)?.samples ?? null;

    if (refTrace && refTrace.length >= 2) {
      const lastDistKm = refTrace[refTrace.length - 1].distKm;
      const cumMeters: number[] = [0];
      const useStoredDist = Number.isFinite(lastDistKm) && lastDistKm > 0.05;
      if (useStoredDist) {
        for (let i = 1; i < refTrace.length; i += 1) {
          cumMeters.push(Math.max(cumMeters[i - 1], refTrace[i].distKm * 1000));
        }
      } else {
        for (let i = 1; i < refTrace.length; i += 1) {
          const stepM = haversineMetersVel(
            refTrace[i - 1].lat,
            refTrace[i - 1].lon,
            refTrace[i].lat,
            refTrace[i].lon
          );
          cumMeters.push(cumMeters[i - 1] + stepM);
        }
      }
      const totalM = cumMeters[cumMeters.length - 1];
      if (totalM > 50) {
        return splitTraps.map((trap, idx) => {
          let bestIdx = 0;
          let bestD = Infinity;
          for (let i = 0; i < refTrace.length; i += 1) {
            const d = haversineMetersVel(refTrace[i].lat, refTrace[i].lon, trap.lat, trap.lon);
            if (d < bestD) {
              bestD = d;
              bestIdx = i;
            }
          }
          const rawPct = (cumMeters[bestIdx] / totalM) * 100;
          return {
            id: trap.id,
            code: `P${idx + 1}`,
            pct: Math.max(4, Math.min(96, rawPct)),
            crossed: currentSplitTimesMs[trap.id] !== undefined,
          };
        });
      }
    }

    if (orderedTraps.length >= 3) {
      const trapCumM: number[] = [0];
      for (let i = 1; i < orderedTraps.length; i += 1) {
        const d = haversineMetersVel(
          orderedTraps[i - 1].lat,
          orderedTraps[i - 1].lon,
          orderedTraps[i].lat,
          orderedTraps[i].lon
        );
        trapCumM.push(trapCumM[i - 1] + d);
      }
      const totalM = trapCumM[trapCumM.length - 1];
      if (totalM > 50) {
        let splitCounter = 0;
        return orderedTraps
          .map((trap, i) => ({ trap, distM: trapCumM[i] }))
          .filter((entry) => entry.trap.kind === 'split')
          .map((entry) => {
            splitCounter += 1;
            return {
              id: entry.trap.id,
              code: `P${splitCounter}`,
              pct: Math.max(4, Math.min(96, (entry.distM / totalM) * 100)),
              crossed: currentSplitTimesMs[entry.trap.id] !== undefined,
            };
          });
      }
    }

    return splitTraps.map((trap, idx) => ({
      id: trap.id,
      code: `P${idx + 1}`,
      pct: Math.round(((idx + 1) / (splitTraps.length + 1)) * 100),
      crossed: currentSplitTimesMs[trap.id] !== undefined,
    }));
  }, [orderedTraps, guideTrace, bestRun, fallbackRuns, currentSplitTimesMs]);

  const isFaster = predictiveDeltaSec !== null && predictiveDeltaSec < -0.05;
  const isSlower = predictiveDeltaSec !== null && predictiveDeltaSec > 0.05;
  const deltaClampedPct =
    predictiveDeltaSec === null
      ? 0
      : Math.min(50, Math.max(6, (Math.abs(predictiveDeltaSec) / 5) * 50));
  const formattedCompactDelta =
    predictiveDeltaSec === null
      ? '--.--s'
      : `${predictiveDeltaSec > 0 ? '+' : ''}${predictiveDeltaSec.toFixed(2)}s`;
  const clockAdjustedNow = nowMs + clockOffsetMs;
  const isNightMode = layoutId === 'night_stage';

  const commitTripEdit = () => {
    const parsed = Number(tripInput.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      onEditTripDistanceKm(tripUnit === 'm' ? parsed / 1000 : parsed);
    }
    setEditingTrip(false);
  };

  const openTripEditor = () => {
    setTripInput(
      tripUnit === 'm'
        ? String(Math.round(displayedTripKm * 1000))
        : displayedTripKm.toFixed(2)
    );
    setEditingTrip(true);
  };

  const handleUnifiedStageAction = () => {
    if (stageState === 'armed') {
      onForceManualStart();
      return;
    }
    onStartOrArmStage();
  };

  const unifiedButtonMeta = (() => {
    if (stageState === 'running') {
      return {
        label: 'Encerrar',
        cls: 'pitstop-btn-red',
        icon: <Flag className="h-4 w-4 shrink-0" />,
      };
    }
    if (stageState === 'armed') {
      return {
        label: 'Largar Agora',
        cls: 'bg-emerald-600 text-white hover:bg-emerald-500 border border-emerald-400/60 shadow-lg',
        icon: <Play className="h-4 w-4 shrink-0 fill-current" />,
      };
    }
    if (stageState === 'finished') {
      return {
        label: 'Armar Nova',
        cls: 'pitstop-btn-red',
        icon: <RotateCcw className="h-4 w-4 shrink-0" />,
      };
    }
    return {
      label: hasTraps ? 'Armar' : 'Iniciar',
      cls: 'pitstop-btn-red text-white',
      icon: <Play className="h-4 w-4 shrink-0 fill-current" />,
    };
  })();

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

  const renderLiveMapOverlay = () => (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)]">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--ps-border)] px-2.5 py-1.5 font-mono text-xs tabular-nums">
        <span className="font-bold text-[var(--ps-text)]">
          {Math.round(speedKmh)} km/h ·{' '}
          <span className="text-[var(--ps-amber)]">{Math.round(displayedTripKm * 1000)}m</span>
        </span>
        <button
          type="button"
          onClick={onToggleHeatmapMode}
          className="rounded-md border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 py-0.5 text-[10px] font-bold text-[var(--ps-text)]"
        >
          Cor: {liveHeatmapMode === 'accel' ? 'Força G' : 'Veloc.'}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <VelocityMapboxView
          trackId={activeTrackId || 'live_free'}
          editableTrace={liveMapTrace}
          guideTrace={guideTrace}
          orderedTraps={orderedTraps}
          postEditIdx={Math.max(0, liveMapTrace.length - 1)}
          currentPos={currentPos}
          navigationMode={true}
          headingUp={liveHeadingUp}
          onToggleHeadingUp={onToggleHeadingUp}
          navHeadingDeg={headingDeg}
          heatmapMode={liveHeatmapMode}
          containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
        />
      </div>
    </div>
  );

  const renderTripEditorOrValue = (
    valueClass: string,
    unitClass: string,
    subClass: string
  ) =>
    editingTrip ? (
      <div className="mx-auto w-full max-w-[165px] space-y-1">
        <div className="flex items-center gap-1 rounded-lg border border-[var(--ps-accent)] bg-[var(--ps-card)] px-1.5 py-1">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            autoFocus
            value={tripInput}
            onChange={(e) => setTripInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTripEdit();
              if (e.key === 'Escape') setEditingTrip(false);
            }}
            aria-label="Editar odômetro Trip"
            className="min-w-0 flex-1 bg-transparent text-center font-mono text-sm font-black text-[var(--ps-amber)] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              const nextUnit = tripUnit === 'm' ? 'km' : 'm';
              setTripUnit(nextUnit);
              setTripInput(
                nextUnit === 'm'
                  ? String(Math.round(displayedTripKm * 1000))
                  : displayedTripKm.toFixed(2)
              );
            }}
            className="rounded bg-[var(--ps-surface)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-text)] uppercase"
          >
            {tripUnit}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => {
              onZeroTrip();
              setEditingTrip(false);
            }}
            className="rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] py-1 text-[10px] font-bold text-[var(--ps-muted)] uppercase hover:text-[var(--ps-text)]"
          >
            Zerar
          </button>
          <button
            type="button"
            onClick={commitTripEdit}
            className="pitstop-btn-red rounded py-1 text-[10px] font-extrabold uppercase"
          >
            OK
          </button>
        </div>
      </div>
    ) : (
      <div className="inline-flex max-w-full items-center justify-center gap-1.5">
        <button
          type="button"
          onClick={openTripEditor}
          title="Toque para digitar metragem do odômetro"
          className="group flex min-w-0 flex-col items-center justify-center rounded-lg px-1.5 py-0.5 hover:bg-white/5"
        >
          <span className={`font-mono font-black leading-none tracking-tight tabular-nums ${valueClass}`}>
            {Math.round(displayedTripKm * 1000)}
            <span className={`ml-0.5 font-extrabold ${unitClass}`}>m</span>
          </span>
          <span className={`mt-1 inline-flex items-center gap-1 font-mono tabular-nums ${subClass}`}>
            <span>{displayedTripKm.toFixed(2)} km</span>
            <Pencil className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onZeroTrip();
          }}
          title="Zerar Trip Parcial"
          aria-label="Zerar Trip Parcial"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)]/80 text-[var(--ps-muted)] transition-colors hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-95"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    );

  const renderProgressBar = () => {
    const clampedPct = Math.max(0, Math.min(100, liveProgressPct));
    const remainingLabel =
      liveHasRefDist && liveRemainingDistM !== null
        ? liveRemainingDistM < 1000
          ? `${clampedPct}% · ${Math.round(liveRemainingDistM) <= 0 ? '0 m' : `-${Math.round(liveRemainingDistM)} m`}`
          : `${clampedPct}% · -${(liveRemainingDistM / 1000).toFixed(1)} km`
        : `${Math.round(speedKmh)} km/h`;

    return (
      <div className="px-0.5 pt-0.5">
        <div className="flex items-center gap-2.5">
          <div className="relative flex-1">
            <div className="relative h-[7px] w-full overflow-hidden rounded-full border border-white/15 bg-[#1A1D21]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#94A3B8] to-[#E2E8F0] transition-all duration-200"
                style={{ width: `${clampedPct}%` }}
              />

              {progressSplitMarkers.map((marker) => (
                <span
                  key={marker.id}
                  aria-hidden="true"
                  title={marker.code}
                  style={{ left: `${marker.pct}%` }}
                  className={`pointer-events-none absolute inset-y-0 z-10 w-[2px] -translate-x-1/2 ${
                    marker.crossed || clampedPct >= marker.pct
                      ? 'bg-[#1A1D21]/85'
                      : 'bg-white/60'
                  }`}
                />
              ))}
            </div>
          </div>

          <span
            className={`shrink-0 font-mono text-[11px] font-extrabold leading-none tabular-nums sm:text-xs ${
              isNightMode ? 'text-slate-100' : 'text-[var(--ps-text)]'
            }`}
          >
            {remainingLabel}
          </span>
        </div>

        {progressSplitMarkers.length > 0 && (
          <div className="mt-0.5 flex items-center gap-2.5">
            <div className="relative h-2.5 flex-1">
              {progressSplitMarkers.map((marker) => (
                <span
                  key={`${marker.id}-lbl`}
                  style={{ left: `${marker.pct}%` }}
                  className={`absolute top-0 -translate-x-1/2 font-mono text-[8px] font-extrabold leading-none tabular-nums ${
                    marker.crossed || clampedPct >= marker.pct
                      ? 'text-[#00E676]'
                      : isNightMode
                        ? 'text-slate-400'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  {marker.code}
                </span>
              ))}
            </div>
            <span
              aria-hidden="true"
              className="invisible shrink-0 font-mono text-[11px] font-extrabold leading-none tabular-nums sm:text-xs"
            >
              {remainingLabel}
            </span>
          </div>
        )}
      </div>
    );
  };

  const renderSplitsGrid = (compact = false) => {
    if (visibleSplitItems.length === 0) return null;
    return (
      <div className="grid shrink-0 grid-cols-4 gap-1.5">
        {visibleSplitItems.map((sp) => {
          const isBetter = sp.diffSec !== null && sp.diffSec <= 0;
          const isWorse = sp.diffSec !== null && sp.diffSec > 0;
          return (
            <div
              key={sp.id}
              title={sp.name}
              className={`flex ${compact ? 'min-h-[52px] py-1' : 'min-h-[60px] py-1.5'} min-w-0 flex-col items-center justify-center rounded-xl border px-1 text-center font-mono tabular-nums transition-colors ${
                sp.isActive
                  ? 'animate-pulse border-amber-400 bg-amber-500/15 text-[var(--ps-amber)]'
                  : sp.crossed
                    ? isBetter
                      ? 'border-emerald-400/75 bg-emerald-600/20 text-[var(--ps-text)]'
                      : isWorse
                        ? 'border-red-500/75 bg-red-600/20 text-[var(--ps-text)]'
                        : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                    : isNightMode
                      ? 'border-white/10 bg-[#050609] text-slate-500'
                      : 'border-[var(--ps-border)]/70 bg-[var(--ps-card-deep)]/65 text-[var(--ps-muted)]'
              }`}
            >
              <span
                className={`text-xs font-black leading-none uppercase ${
                  sp.isActive ? 'text-[var(--ps-amber)]' : 'text-[var(--ps-muted)]'
                }`}
              >
                {sp.code}
              </span>
              {sp.crossed ? (
                sp.diffSec !== null ? (
                  <>
                    <span
                      className={`mt-1 text-sm font-black leading-none tracking-tight sm:text-base ${
                        isBetter ? 'text-[var(--ps-emerald)]' : 'text-[var(--ps-danger)]'
                      }`}
                    >
                      {sp.diffSec > 0 ? '+' : ''}
                      {sp.diffSec.toFixed(1)}s
                    </span>
                    <span className="mt-0.5 text-[11px] font-bold leading-none text-[var(--ps-muted)]">
                      {sp.sectorMs !== null ? formatSplitCompactTime(sp.sectorMs) : '--'}
                    </span>
                  </>
                ) : (
                  <span className="mt-1 text-sm font-black leading-none text-[var(--ps-text)] sm:text-base">
                    {sp.sectorMs !== null ? formatSplitCompactTime(sp.sectorMs) : '--'}
                  </span>
                )
              ) : sp.isActive ? (
                <span className="mt-1 text-xs font-black leading-none text-[var(--ps-amber)] uppercase">
                  ATUAL
                </span>
              ) : (
                <span className="mt-1 text-sm font-bold leading-none opacity-60">--</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ============================================================================
  // SHARED 5-TAB NAVIGATION BAR (CRONÔM. | ANÁLISE | MAPA | SATCRON | CONFIG.)
  // Position configurable via Settings: Rodapé (Polegar) or Topo
  // ============================================================================
  const renderFiveTabBar = () => (
    <div
      className={`grid shrink-0 grid-cols-5 gap-1 rounded-xl border p-1 ${
        isNightMode
          ? 'border-white/10 bg-[#050609]'
          : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
      }`}
    >
      <button
        type="button"
        onClick={onSelectTimerTab}
        className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg px-0.5 text-[10px] font-extrabold uppercase transition-all active:scale-[0.98] ${
          !showLiveMap && liveMode === 'timer'
            ? 'pitstop-btn-red'
            : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
        }`}
      >
        <Flag className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Cronôm.</span>
      </button>

      <button
        type="button"
        onClick={onOpenAnalysis}
        className="flex min-h-[44px] flex-col items-center justify-center rounded-lg px-0.5 text-[10px] font-extrabold text-[var(--ps-emerald)] uppercase transition-all hover:bg-emerald-500/15 active:scale-[0.98]"
      >
        <TrendingUp className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Análise</span>
      </button>

      <button
        type="button"
        onClick={onSelectMapTab}
        className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg px-0.5 text-[10px] font-extrabold uppercase transition-all active:scale-[0.98] ${
          showLiveMap
            ? 'bg-sky-600 text-white'
            : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
        }`}
      >
        <MapIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">Mapa</span>
      </button>

      <button
        type="button"
        onClick={onOpenSatcron}
        className="flex min-h-[44px] flex-col items-center justify-center rounded-lg px-0.5 text-[10px] font-extrabold text-[var(--ps-muted)] uppercase transition-all hover:text-[var(--ps-text)] active:scale-[0.98]"
      >
        <Trophy className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
        <span className="truncate">Satcron</span>
      </button>

      <button
        type="button"
        onClick={onOpenConfigModal}
        className="flex min-h-[44px] flex-col items-center justify-center rounded-lg px-0.5 text-[10px] font-extrabold text-[var(--ps-muted)] uppercase transition-all hover:text-[var(--ps-text)] active:scale-[0.98]"
      >
        <Settings className="h-3.5 w-3.5 shrink-0 text-[var(--ps-text)]" />
        <span className="truncate">Config.</span>
      </button>
    </div>
  );

  // ============================================================================
  // CENTER DATA PANE (EXCLUSIVELY TELEMETRY CARDS FOR SELECTED LAYOUT 01..11)
  // ============================================================================
  const renderCenterDataCards = () => {
    switch (layoutId) {
      // 01 · PITSTOP CLÁSSICO
      case 'classic':
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-[var(--ps-text)] shadow-xl sm:p-3">
            {/* Barra superior de Delta em tempo real */}
            <div className="shrink-0">
              <div className="flex items-center justify-between font-mono text-[10px] sm:text-xs tabular-nums">
                <span className="font-bold text-[var(--ps-danger)]">LENTO (+s)</span>
                <span
                  className={`inline-flex items-center gap-1 text-xs font-black sm:text-sm ${
                    isFaster
                      ? 'text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'text-[var(--ps-danger)]'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  <span>DELTA {formatDeltaSeconds(predictiveDeltaSec)}</span>
                  {deltaTrend === 'improving' && (
                    <span className="text-[var(--ps-emerald)]" aria-label="Ritmo melhorando">
                      ▲
                    </span>
                  )}
                  {deltaTrend === 'worsening' && (
                    <span className="text-[var(--ps-danger)]" aria-label="Ritmo piorando">
                      ▼
                    </span>
                  )}
                </span>
                <span className="font-bold text-[var(--ps-emerald)]">RÁPIDO (-s)</span>
              </div>

              <div className="relative mt-1 h-2 w-full overflow-hidden rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)]">
                <div className="absolute inset-y-0 left-1/2 z-10 w-[2px] -translate-x-1/2 bg-[var(--ps-muted)]/70" />
                {isSlower && (
                  <div
                    className="absolute inset-y-0 right-1/2 bg-[#E10600] transition-all duration-150"
                    style={{ width: `${deltaClampedPct}%` }}
                  />
                )}
                {isFaster && (
                  <div
                    className="absolute inset-y-0 left-1/2 bg-[#10B981] transition-all duration-150"
                    style={{ width: `${deltaClampedPct}%` }}
                  />
                )}
              </div>
            </div>

            {/* Bloco Delta Time */}
            <div
              className={`flex shrink-0 flex-col items-center justify-center rounded-xl border-2 px-3 py-1.5 text-center transition-colors ${
                isFaster
                  ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                  : isSlower
                    ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                    : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5 font-mono text-[11px] font-black leading-tight tracking-wider uppercase sm:text-xs">
                <span>{isFaster ? '▲' : isSlower ? '▼' : '●'}</span>
                <span>{isFaster ? 'MAIS RÁPIDO' : isSlower ? 'MAIS LENTO' : 'DELTA TIME'}</span>
              </div>
              <div className="my-0.5 font-mono text-6xl font-black leading-none tracking-tighter tabular-nums">
                {formattedCompactDelta}
              </div>
              <p className="max-w-full truncate font-mono text-[10px] font-bold leading-tight opacity-85 uppercase">
                {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
              </p>
            </div>

            {renderSplitsGrid(false)}

            {/* Velocidade + Metros */}
            <div className="grid flex-1 min-h-0 grid-cols-2 gap-1.5">
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center">
                <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <div className="mt-0.5 flex items-baseline justify-center gap-1 font-mono tabular-nums">
                  <span className="text-5xl font-black leading-none tracking-tight text-[var(--ps-text)] sm:text-6xl">
                    {Math.round(speedKmh)}
                  </span>
                  <span className="text-xs font-extrabold text-[var(--ps-accent)] sm:text-sm">
                    km/h
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center">
                <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Metros (Odômetro)
                </span>
                {renderTripEditorOrValue(
                  'text-4xl sm:text-5xl text-[var(--ps-amber)]',
                  'text-sm text-[var(--ps-amber)]',
                  'text-[11px] text-[var(--ps-muted)]'
                )}
              </div>
            </div>

            {/* Cronômetro Principal + CH / MELHOR / ÚLTIMA */}
            <div className="flex flex-1 min-h-0 flex-col justify-center space-y-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-2 sm:px-3">
              <div className="flex flex-col items-center text-center">
                <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] font-bold uppercase text-[var(--ps-muted)]">
                  <span className="text-[var(--ps-text)]">
                    {activeTrackName}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={
                      stageState === 'running'
                        ? 'text-[var(--ps-emerald)]'
                        : stageState === 'armed'
                          ? 'text-[var(--ps-amber)]'
                          : 'text-[var(--ps-muted)]'
                    }
                  >
                    {statusHeadline}
                  </span>
                </div>
                <div
                  className={`mt-0.5 font-mono text-6xl font-black leading-none tracking-tighter tabular-nums ${
                    stageState === 'running'
                      ? 'text-[var(--ps-text)]'
                      : stageState === 'finished'
                        ? 'text-[var(--ps-emerald)]'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  {formatStageDuration(currentStageElapsedMs)}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1 py-1 text-center">
                  <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    CH
                  </p>
                  <p className="font-mono text-lg font-extrabold leading-tight tracking-tighter text-[var(--ps-text)] tabular-nums sm:text-xl">
                    {formatClockTime(clockAdjustedNow)}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1 py-1 text-center">
                  <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-emerald)] uppercase">
                    MELHOR
                  </p>
                  <p className="font-mono text-lg font-extrabold leading-tight tracking-tighter text-[var(--ps-emerald)] tabular-nums sm:text-xl">
                    {formatStageDuration(optimalSummary.bestRunTotalMs)}
                  </p>
                </div>
                <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1 py-1 text-center">
                  <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    ÚLTIMA
                  </p>
                  <p className="font-mono text-lg font-extrabold leading-tight tracking-tighter text-[var(--ps-text)] tabular-nums sm:text-xl">
                    {formatStageDuration(optimalSummary.lastRunTotalMs)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );

      // 02 · ERGONOMIA THUMB-ZONE
      case 'thumb_zone':
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 sm:p-3">
            <div
              className={`flex shrink-0 flex-col items-center justify-center rounded-xl border-2 px-3 py-1.5 text-center transition-colors ${
                isFaster
                  ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                  : isSlower
                    ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                    : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
              }`}
            >
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-black tracking-wider uppercase sm:text-xs">
                <span>{isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : '● DELTA TIME'}</span>
              </div>
              <div className="my-0.5 font-mono text-6xl font-black leading-none tracking-tighter tabular-nums">
                {formattedCompactDelta}
              </div>
              <p className="font-mono text-[10px] font-bold opacity-80 uppercase">
                {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
              </p>
            </div>

            {renderSplitsGrid(false)}

            <div className="grid flex-1 min-h-0 grid-cols-2 gap-1.5">
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center">
                <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <div className="mt-0.5 flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-5xl font-black leading-none text-[var(--ps-text)] sm:text-6xl">
                    {Math.round(speedKmh)}
                  </span>
                  <span className="text-xs font-extrabold text-[var(--ps-accent)] sm:text-sm">km/h</span>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center">
                <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Metros
                </span>
                {renderTripEditorOrValue(
                  'text-4xl sm:text-5xl text-[var(--ps-amber)]',
                  'text-sm text-[var(--ps-amber)]',
                  'text-[11px] text-[var(--ps-muted)]'
                )}
              </div>
            </div>

            <div className="flex flex-1 min-h-0 flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 text-center">
              <div className="flex items-center justify-between font-mono text-xs font-extrabold tracking-tight text-[var(--ps-muted)] uppercase tabular-nums">
                <span>CH <strong className="text-[var(--ps-text)]">{formatClockTime(clockAdjustedNow)}</strong></span>
                <span className="text-[var(--ps-text)]">{statusHeadline}</span>
                <span className="text-[var(--ps-emerald)]">
                  MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </span>
              </div>
              <div className="mt-1 font-mono text-6xl font-black leading-none tracking-tighter text-[var(--ps-text)] tabular-nums">
                {formatStageDuration(currentStageElapsedMs)}
              </div>
            </div>
          </div>
        );

      // 03 · CORALBA / MONIT RALLY (NAVEGADOR — APENAS CARDS DE DADOS)
      case 'coralba':
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
            {/* Odômetro Parcial (Trip) Gigante em largura total */}
            <div className="flex flex-[1.4] min-h-0 flex-col items-center justify-center rounded-2xl border-2 border-amber-500/60 bg-[#141109] p-3 text-center">
              <span className="font-mono text-xs font-black tracking-widest text-amber-400 uppercase">
                Odômetro Parcial (Trip) · Toque para Editar
              </span>
              <div className="mt-2">
                {renderTripEditorOrValue(
                  'text-6xl sm:text-7xl text-[#FBBF24]',
                  'text-2xl text-[#FBBF24]',
                  'text-xs text-amber-200/80'
                )}
              </div>
            </div>

            {/* Odômetro Total + CH + Velocidade */}
            <div className="grid flex-1 min-h-0 grid-cols-3 gap-2">
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Odo Total
                </span>
                <span className="mt-1 font-mono text-2xl font-black text-[var(--ps-text)] tabular-nums sm:text-3xl">
                  {totalDistKm.toFixed(2)}
                </span>
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)]">km</span>
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Hora Oficial (CH)
                </span>
                <span className="mt-1 font-mono text-xl font-black text-emerald-400 tabular-nums sm:text-2xl">
                  {formatClockTime(clockAdjustedNow)}
                </span>
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)]">GPS Sinc</span>
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <span className="mt-1 font-mono text-3xl font-black text-[var(--ps-text)] tabular-nums sm:text-4xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="font-mono text-[10px] font-bold text-[var(--ps-accent)]">km/h</span>
              </div>
            </div>

            {/* Cronômetro SS + Delta resumido */}
            <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
              <div>
                <p className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Cronômetro SS · {statusHeadline}
                </p>
                <p className="font-mono text-2xl font-black text-[var(--ps-text)] tabular-nums sm:text-3xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </p>
              </div>
              <div className="text-right font-mono tabular-nums">
                <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Delta</p>
                <p
                  className={`text-xl font-black sm:text-2xl ${
                    isFaster
                      ? 'text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'text-[var(--ps-danger)]'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  {formattedCompactDelta}
                </p>
              </div>
            </div>
          </div>
        );

      // 04 · RACECHRONO SPLIT-SCREEN (MAPA + DADOS)
      case 'split_map':
        return (
          <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-hidden">
            <div className="flex flex-[1.2] min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)]">
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--ps-border)] px-2.5 py-1 font-mono text-[10px]">
                <span className="font-bold text-[var(--ps-muted)] uppercase">
                  Mapa ao Vivo · {statusHeadline}
                </span>
                <button
                  type="button"
                  onClick={onToggleHeatmapMode}
                  className="rounded border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 py-0.5 font-bold text-[var(--ps-text)]"
                >
                  {liveHeatmapMode === 'accel' ? 'Calor: Força G' : 'Calor: Veloc.'}
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <VelocityMapboxView
                  trackId={activeTrackId || 'live_free'}
                  editableTrace={liveMapTrace}
                  guideTrace={guideTrace}
                  orderedTraps={orderedTraps}
                  postEditIdx={Math.max(0, liveMapTrace.length - 1)}
                  currentPos={currentPos}
                  navigationMode={true}
                  headingUp={liveHeadingUp}
                  onToggleHeadingUp={onToggleHeadingUp}
                  navHeadingDeg={headingDeg}
                  heatmapMode={liveHeatmapMode}
                  containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
                />
              </div>
            </div>

            <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5">
              <div
                className={`flex flex-1 min-h-[58px] items-center justify-between rounded-xl border-2 px-3 py-1.5 ${
                  isFaster
                    ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                    : isSlower
                      ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                }`}
              >
                <div>
                  <p className="font-mono text-[10px] font-black uppercase">
                    {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : '● DELTA TIME'}
                  </p>
                  <p className="font-mono text-[10px] font-bold opacity-80 uppercase">
                    {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
                  </p>
                </div>
                <div className="font-mono text-3xl font-black leading-none tabular-nums sm:text-4xl">
                  {formattedCompactDelta}
                </div>
              </div>

              <div className="grid shrink-0 grid-cols-3 gap-1.5">
                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-2 text-center">
                  <span className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Veloc.</span>
                  <span className="font-mono text-2xl font-black leading-none text-[var(--ps-text)] tabular-nums sm:text-3xl">
                    {Math.round(speedKmh)}
                  </span>
                  <span className="font-mono text-[9px] font-bold text-[var(--ps-accent)]">km/h</span>
                </div>

                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-2 text-center">
                  <span className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Metros</span>
                  {renderTripEditorOrValue(
                    'text-2xl sm:text-3xl text-[var(--ps-amber)]',
                    'text-xs text-[var(--ps-amber)]',
                    'text-[9px] text-[var(--ps-muted)]'
                  )}
                </div>

                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-2 text-center">
                  <span className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Tempo SS</span>
                  <span className="font-mono text-lg font-black leading-tight text-[var(--ps-text)] tabular-nums sm:text-2xl">
                    {formatStageDuration(currentStageElapsedMs)}
                  </span>
                  <span className="font-mono text-[9px] text-[var(--ps-emerald)]">
                    MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        );

      // 05 · AIM SOLO 2 (MINIMALISTA — 3 BLOCOS GIGANTES)
      case 'aim_minimal':
        return (
          <div className="flex flex-1 min-h-0 flex-col gap-2 overflow-hidden">
            <div
              className={`flex flex-1 min-h-0 flex-col items-center justify-center rounded-2xl border-2 px-4 text-center ${
                isFaster
                  ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                  : isSlower
                    ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                    : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-text)]'
              }`}
            >
              <span className="font-mono text-xs font-black tracking-widest uppercase">
                {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : 'DELTA TIME'}
              </span>
              <span className="mt-1 font-mono text-5xl font-black leading-none tracking-tight tabular-nums sm:text-6xl">
                {formattedCompactDelta}
              </span>
            </div>

            <div className="flex flex-1 min-h-0 flex-col items-center justify-center rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-4 text-center">
              <span className="font-mono text-xs font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                Cronômetro · {statusHeadline}
              </span>
              <span className="mt-1 font-mono text-5xl font-black leading-none tracking-tight text-[var(--ps-text)] tabular-nums sm:text-6xl">
                {formatStageDuration(currentStageElapsedMs)}
              </span>
              <span className="mt-1 font-mono text-xs font-bold text-[var(--ps-emerald)] tabular-nums">
                MELHOR {formatStageDuration(optimalSummary.bestRunTotalMs)}
              </span>
            </div>

            <div className="flex flex-1 min-h-0 flex-col items-center justify-center rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-4 text-center">
              <span className="font-mono text-xs font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                Velocidade
              </span>
              <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-5xl font-black leading-none tracking-tight text-[var(--ps-text)] sm:text-6xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="text-xl font-black text-[var(--ps-accent)] uppercase">km/h</span>
              </div>
            </div>
          </div>
        );

      // 06 · FUELTECH FT700 CLUSTER
      case 'ft700_cluster': {
        const ledCount = 14;
        const activeLeds =
          predictiveDeltaSec !== null
            ? Math.max(
                2,
                Math.min(ledCount, Math.round((Math.abs(predictiveDeltaSec) / 4) * ledCount))
              )
            : Math.max(1, Math.min(ledCount, Math.round((speedKmh / 150) * ledCount)));

        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 rounded-2xl border border-cyan-500/35 bg-gradient-to-b from-[#0E131E] to-[#080B12] p-2.5 shadow-2xl">
            <div className="shrink-0 space-y-1">
              <div className="flex items-center justify-between font-mono text-[10px] font-bold uppercase">
                <span className="text-cyan-400">FT700 CLUSTER</span>
                <span className="text-slate-300">{statusHeadline}</span>
              </div>
              <div className="grid grid-cols-14 gap-1 rounded-lg border border-white/10 bg-black/70 p-1.5">
                {Array.from({ length: ledCount }).map((_, idx) => {
                  const lit = idx < activeLeds;
                  const color = isFaster
                    ? 'bg-[#10B981] shadow-[0_0_8px_#10B981]'
                    : isSlower
                      ? 'bg-[#FF2A2A] shadow-[0_0_8px_#FF2A2A]'
                      : idx >= 10
                        ? 'bg-[#FF2A2A]'
                        : idx >= 6
                          ? 'bg-[#F59E0B]'
                          : 'bg-[#00E5FF]';
                  return (
                    <span
                      key={idx}
                      className={`h-2.5 rounded-xs transition-opacity ${
                        lit ? color : 'bg-white/10 opacity-40'
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            <div className="grid flex-1 min-h-0 grid-cols-2 gap-2">
              <div className="relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-cyan-500/30 bg-[#0B101A] p-2 text-center">
                <span className="font-mono text-[10px] font-black tracking-widest text-cyan-400 uppercase">
                  Velocidade
                </span>
                <span className="mt-1 font-mono text-5xl font-black leading-none text-white tabular-nums sm:text-6xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="mt-1 font-mono text-xs font-extrabold text-cyan-300 uppercase">
                  km/h
                </span>
                <span className="absolute inset-x-0 bottom-0 h-[3px] bg-[#00E5FF]" />
              </div>

              <div
                className={`relative flex flex-col items-center justify-center overflow-hidden rounded-xl border p-2 text-center ${
                  isFaster
                    ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-300'
                    : isSlower
                      ? 'border-red-500/70 bg-red-500/20 text-red-400'
                      : 'border-white/15 bg-[#0B101A] text-white'
                }`}
              >
                <span className="font-mono text-[10px] font-black tracking-widest uppercase">
                  {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : 'DELTA TIME'}
                </span>
                <span className="mt-1 font-mono text-3xl font-black leading-none tabular-nums sm:text-4xl">
                  {formattedCompactDelta}
                </span>
                <span className="mt-1 font-mono text-[10px] font-bold opacity-80 uppercase">
                  {bestRun ? `vs V#${bestRun.runNumber}` : 'Base'}
                </span>
                <span
                  className={`absolute inset-x-0 bottom-0 h-[3px] ${
                    isFaster ? 'bg-[#10B981]' : isSlower ? 'bg-[#FF2A2A]' : 'bg-slate-600'
                  }`}
                />
              </div>
            </div>

            {renderSplitsGrid(true)}

            <div className="grid shrink-0 grid-cols-2 gap-2">
              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#0B101A] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-slate-400 uppercase">
                  Metros (Odômetro)
                </span>
                {renderTripEditorOrValue(
                  'text-2xl sm:text-3xl text-[#FBBF24]',
                  'text-xs text-[#FBBF24]',
                  'text-[10px] text-slate-400'
                )}
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#0B101A] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-slate-400 uppercase">
                  Cronômetro · CH {formatClockTime(clockAdjustedNow)}
                </span>
                <span className="mt-0.5 font-mono text-2xl font-black leading-none text-white tabular-nums sm:text-3xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </span>
                <span className="mt-1 font-mono text-[10px] font-bold text-emerald-400 tabular-nums">
                  MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </span>
              </div>
            </div>
          </div>
        );
      }

      // 07 · HARRY'S LAPTIMER (VISÃO PERIFÉRICA ~45%)
      case 'harrys_delta':
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
            <div
              className={`flex flex-[1.5] min-h-[170px] flex-col items-center justify-center rounded-2xl border-2 px-4 py-3 text-center transition-colors ${
                isFaster
                  ? 'border-emerald-300 bg-[#10B981] text-black shadow-[0_0_30px_rgba(16,185,129,0.45)]'
                  : isSlower
                    ? 'border-red-300 bg-[#E10600] text-white shadow-[0_0_30px_rgba(225,6,0,0.45)]'
                    : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
              }`}
            >
              <span className="font-mono text-sm font-black tracking-widest uppercase sm:text-base">
                {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : '● DELTA TIME'}
              </span>
              <span className="my-1 font-mono text-6xl font-black leading-none tracking-tight tabular-nums sm:text-7xl">
                {formattedCompactDelta}
              </span>
              <span className="font-mono text-xs font-extrabold opacity-90 uppercase">
                {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem volta de referência'}
              </span>
            </div>

            {renderSplitsGrid(true)}

            <div className="grid shrink-0 grid-cols-3 gap-2">
              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <span className="mt-0.5 font-mono text-3xl font-black leading-none text-[var(--ps-text)] tabular-nums">
                  {Math.round(speedKmh)}
                </span>
                <span className="font-mono text-[10px] font-bold text-[var(--ps-accent)]">km/h</span>
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Metros
                </span>
                {renderTripEditorOrValue(
                  'text-2xl sm:text-3xl text-[var(--ps-amber)]',
                  'text-xs text-[var(--ps-amber)]',
                  'text-[10px] text-[var(--ps-muted)]'
                )}
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Cronômetro
                </span>
                <span className="mt-0.5 font-mono text-xl font-black leading-tight text-[var(--ps-text)] tabular-nums sm:text-2xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </span>
                <span className="font-mono text-[10px] font-bold text-[var(--ps-emerald)]">
                  MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </span>
              </div>
            </div>
          </div>
        );

      // 08 · WRC PACE-NOTE (METRAGEM COLOSSAL)
      case 'wrc_pacenote': {
        const remainingText =
          liveHasRefDist && liveRemainingDistM !== null
            ? liveRemainingDistM >= 1000
              ? `${(liveRemainingDistM / 1000).toFixed(2)} km`
              : `${Math.round(liveRemainingDistM)} m`
            : '--';

        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
            <div className="flex flex-[1.5] min-h-0 flex-col items-center justify-center rounded-2xl border-2 border-amber-500/60 bg-[#141007] px-3 py-2 text-center">
              <span className="font-mono text-xs font-black tracking-widest text-amber-400 uppercase">
                Metros Percorridos · Toque para Editar
              </span>
              <div className="mt-2">
                {renderTripEditorOrValue(
                  'text-6xl sm:text-7xl text-[#FBBF24]',
                  'text-2xl text-[#FBBF24]',
                  'text-sm text-amber-200/80'
                )}
              </div>
            </div>

            <div className="grid flex-1 min-h-0 grid-cols-2 gap-2">
              <div
                className={`flex flex-col items-center justify-center rounded-2xl border p-2 text-center ${
                  liveIsFinishFlash
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300'
                    : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-text)]'
                }`}
              >
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Restante p/ Chegada
                </span>
                <span className="mt-1 font-mono text-4xl font-black leading-none tabular-nums sm:text-5xl">
                  {remainingText}
                </span>
                <span className="mt-1 font-mono text-[10px] font-bold text-[var(--ps-muted)]">
                  {liveHasRefDist ? `${liveProgressPct}% concluído` : 'Especial livre'}
                </span>
              </div>

              <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <span className="mt-1 font-mono text-5xl font-black leading-none text-[var(--ps-text)] tabular-nums sm:text-6xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="mt-1 font-mono text-xs font-black text-[var(--ps-accent)] uppercase">
                  km/h
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 font-mono tabular-nums">
              <div>
                <span className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Cronômetro ({statusHeadline})
                </span>
                <p className="text-2xl font-black text-[var(--ps-text)]">
                  {formatStageDuration(currentStageElapsedMs)}
                </p>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Delta</span>
                <p
                  className={`text-2xl font-black ${
                    isFaster
                      ? 'text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'text-[var(--ps-danger)]'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  {formattedCompactDelta}
                </p>
              </div>
            </div>
          </div>
        );
      }

      // 09 · NIGHT STAGE (ENDURANCE NOTURNO)
      case 'night_stage':
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
            <div className="flex shrink-0 flex-col items-center justify-center rounded-2xl border border-white/10 bg-[#050608] px-3 py-2 text-center">
              <span className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
                {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : 'DELTA NOTURNO'}
              </span>
              <span
                className={`my-0.5 font-mono text-6xl font-black leading-none tracking-tighter tabular-nums ${
                  isFaster
                    ? 'text-emerald-400/90'
                    : isSlower
                      ? 'text-red-400/90'
                      : 'text-slate-300'
                }`}
              >
                {formattedCompactDelta}
              </span>
              <span className="font-mono text-[10px] text-slate-500 uppercase">
                {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
              </span>
            </div>

            {renderSplitsGrid(true)}

            <div className="grid flex-1 min-h-0 grid-cols-2 gap-2">
              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#050608] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-slate-500 uppercase">
                  Velocidade
                </span>
                <div className="mt-0.5 flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-5xl font-black leading-none text-slate-100 sm:text-6xl">
                    {Math.round(speedKmh)}
                  </span>
                  <span className="text-xs font-bold text-amber-400/80">km/h</span>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#050608] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-slate-500 uppercase">
                  Metros
                </span>
                {renderTripEditorOrValue(
                  'text-4xl sm:text-5xl text-amber-300/90',
                  'text-sm text-amber-300/90',
                  'text-[10px] text-slate-500'
                )}
              </div>
            </div>

            <div className="flex flex-1 min-h-0 flex-col justify-center rounded-xl border border-white/10 bg-[#050608] px-3 py-2 text-center">
              <div className="flex items-center justify-between font-mono text-xs font-bold text-slate-400 uppercase tabular-nums">
                <span>CH {formatClockTime(clockAdjustedNow)}</span>
                <span>{statusHeadline}</span>
                <span className="text-emerald-400/80">
                  MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </span>
              </div>
              <div className="mt-1 font-mono text-6xl font-black leading-none tracking-tighter text-slate-100 tabular-nums">
                {formatStageDuration(currentStageElapsedMs)}
              </div>
            </div>
          </div>
        );

      // 10 · COCKPIT HORIZONTAL (PAISAGEM / TABLET — 3 COLUNAS)
      case 'landscape_3col':
        return (
          <div className="grid flex-1 min-h-0 grid-cols-3 gap-2 overflow-hidden">
            <div className="flex min-h-0 flex-col justify-between gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
              <div
                className={`flex flex-1 min-h-0 flex-col items-center justify-center rounded-xl border-2 p-2 text-center ${
                  isFaster
                    ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                    : isSlower
                      ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                }`}
              >
                <span className="font-mono text-[10px] font-black uppercase">
                  {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : 'DELTA TIME'}
                </span>
                <span className="mt-1 font-mono text-3xl font-black leading-none tabular-nums sm:text-4xl">
                  {formattedCompactDelta}
                </span>
                <span className="mt-1 font-mono text-[10px] opacity-80 uppercase">
                  {bestRun ? `vs V#${bestRun.runNumber}` : 'Base'}
                </span>
              </div>

              {visibleSplitItems.length > 0 && (
                <div className="grid shrink-0 grid-cols-2 gap-1">
                  {visibleSplitItems.map((sp) => (
                    <div
                      key={sp.id}
                      className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-1.5 py-1 text-center font-mono text-[10px] tabular-nums"
                    >
                      <span className="font-black text-[var(--ps-muted)]">{sp.code} </span>
                      <span
                        className={`font-black ${
                          sp.diffSec !== null
                            ? sp.diffSec <= 0
                              ? 'text-[var(--ps-emerald)]'
                              : 'text-[var(--ps-danger)]'
                            : 'text-[var(--ps-text)]'
                        }`}
                      >
                        {sp.crossed
                          ? sp.diffSec !== null
                            ? `${sp.diffSec > 0 ? '+' : ''}${sp.diffSec.toFixed(1)}s`
                            : sp.sectorMs !== null
                              ? formatSplitCompactTime(sp.sectorMs)
                              : '--'
                          : sp.isActive
                            ? 'ATUAL'
                            : '--'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-col justify-between gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
              <div className="flex flex-1 min-h-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Cronômetro · {statusHeadline}
                </span>
                <span className="mt-1 font-mono text-3xl font-black leading-none text-[var(--ps-text)] tabular-nums sm:text-4xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </span>
                <div className="mt-2 flex w-full justify-around font-mono text-[10px] tabular-nums">
                  <span className="text-[var(--ps-muted)]">
                    CH{' '}
                    <strong className="text-[var(--ps-text)]">
                      {formatClockTime(clockAdjustedNow)}
                    </strong>
                  </span>
                  <span className="text-[var(--ps-emerald)]">
                    MEL <strong>{formatStageDuration(optimalSummary.bestRunTotalMs)}</strong>
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Velocidade
                </span>
                <div className="flex items-baseline gap-1 font-mono tabular-nums">
                  <span className="text-3xl font-black leading-none text-[var(--ps-text)] sm:text-4xl">
                    {Math.round(speedKmh)}
                  </span>
                  <span className="text-xs font-black text-[var(--ps-accent)]">km/h</span>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col justify-between gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
              <div className="flex shrink-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2 text-center">
                <span className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  Metros (Trip)
                </span>
                {renderTripEditorOrValue(
                  'text-2xl sm:text-3xl text-[var(--ps-amber)]',
                  'text-xs text-[var(--ps-amber)]',
                  'text-[10px] text-[var(--ps-muted)]'
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-hidden rounded-xl border border-[var(--ps-border)]">
                <VelocityMapboxView
                  trackId={activeTrackId || 'live_free'}
                  editableTrace={liveMapTrace}
                  guideTrace={guideTrace}
                  orderedTraps={orderedTraps}
                  postEditIdx={Math.max(0, liveMapTrace.length - 1)}
                  currentPos={currentPos}
                  navigationMode={true}
                  headingUp={liveHeadingUp}
                  onToggleHeadingUp={onToggleHeadingUp}
                  navHeadingDeg={headingDeg}
                  heatmapMode={liveHeatmapMode}
                  containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
                />
              </div>
            </div>
          </div>
        );

      // 11 · DIGITAL CLUSTER (VELOCÍMETRO GIGANTE + BARRA LUMINOSA 0–200 + SS)
      case 'digital_cluster': {
        const clampedSpeed = Math.max(0, Math.min(200, speedKmh));
        const activeSegments = Math.round((clampedSpeed / 200) * 20);
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-[var(--ps-text)] shadow-xl sm:p-3">
            {/* Velocímetro Digital Gigante + Barra Luminosa 0–200 km/h */}
            <div className="flex flex-[1.2] min-h-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-2 text-center">
              <div className="flex w-full items-center justify-between font-mono text-[10px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                <span>DIGITAL CLUSTER</span>
                <span className={isFaster ? 'text-[var(--ps-emerald)]' : isSlower ? 'text-[var(--ps-danger)]' : 'text-[var(--ps-accent)]'}>
                  {bestRun ? `DELTA ${formattedCompactDelta}` : 'KM/H'}
                </span>
              </div>

              <div className="my-auto flex items-baseline justify-center gap-1.5 font-['Orbitron'] tabular-nums">
                <span className="text-6xl font-black leading-none tracking-tight text-[var(--ps-text)] sm:text-7xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="text-sm font-black text-[var(--ps-accent)] uppercase sm:text-base">
                  km/h
                </span>
              </div>

              {/* Barra Luminosa Segmentada 0–200 km/h */}
              <div className="w-full space-y-1">
                <div className="grid grid-cols-[repeat(20,minmax(0,1fr))] gap-1">
                  {Array.from({ length: 20 }, (_, i) => {
                    const lit = i < activeSegments;
                    const segClass = !lit
                      ? 'bg-white/10'
                      : i >= 16
                        ? 'bg-[#FF1744] shadow-[0_0_8px_rgba(255,23,68,0.85)]'
                        : i >= 12
                          ? 'bg-[var(--ps-amber)] shadow-[0_0_8px_rgba(251,191,36,0.7)]'
                          : 'bg-[var(--ps-accent)] shadow-[0_0_8px_var(--ps-accent-soft)]';
                    return <span key={i} className={`h-2.5 rounded-[2px] transition-colors ${segClass}`} />;
                  })}
                </div>
                <div className="flex justify-between font-mono text-[9px] font-bold text-[var(--ps-muted)] tabular-nums">
                  <span>0</span>
                  <span>50</span>
                  <span>100</span>
                  <span>150</span>
                  <span>200</span>
                </div>
              </div>
            </div>

            {/* Cronômetro SS em Destaque Logo Abaixo */}
            <div className="flex flex-1 min-h-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 text-center">
              <div className="flex w-full items-center justify-between font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                <span>TEMPO SS · {statusHeadline}</span>
                <span className="text-[var(--ps-emerald)]">
                  MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </span>
              </div>
              <div
                className={`my-auto font-['Orbitron'] text-4xl font-black leading-none tracking-tight tabular-nums sm:text-5xl ${
                  stageState === 'running'
                    ? 'text-[var(--ps-accent)]'
                    : stageState === 'finished'
                      ? 'text-[var(--ps-emerald)]'
                      : 'text-[var(--ps-text)]'
                }`}
              >
                {formatStageDuration(currentStageElapsedMs)}
              </div>
              <div className="flex w-full items-center justify-between font-mono text-[10px] text-[var(--ps-muted)] tabular-nums">
                <span>CH {formatClockTime(clockAdjustedNow)}</span>
                <span className="inline-flex items-center gap-1.5">
                  <span>
                    DIST{' '}
                    <strong className="text-[var(--ps-amber)]">
                      {Math.round(displayedTripKm * 1000)}m
                    </strong>
                  </span>
                  <button
                    type="button"
                    onClick={onZeroTrip}
                    title="Zerar Trip Parcial"
                    aria-label="Zerar Trip Parcial"
                    className="inline-flex h-5 w-5 items-center justify-center rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                  </button>
                </span>
              </div>
            </div>

            {renderSplitsGrid(true)}
          </div>
        );
      }

      // 12 · OLD SCHOOL RALLY (TERRATRIP / HALDA RETRÔ)
      case 'old_school': {
        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 rounded-sm border-2 border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-2 text-[var(--ps-text)]">
            <div className="grid flex-1 min-h-0 grid-cols-2 gap-2">
              <div className="flex flex-col justify-between rounded-sm border-2 border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] overflow-hidden">
                <div className="border-b border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 py-1 font-['Share_Tech_Mono'] text-[10px] font-bold tracking-widest text-[var(--ps-accent)] uppercase">
                  VELOCIDADE
                </div>
                <div className="flex flex-1 items-baseline justify-center gap-1 px-2 py-2 font-['Share_Tech_Mono'] tabular-nums">
                  <span className="text-5xl font-bold leading-none text-[var(--ps-text)] sm:text-6xl">
                    {String(Math.round(speedKmh)).padStart(3, '0')}
                  </span>
                  <span className="text-xs font-bold text-[var(--ps-muted)] uppercase">KM/H</span>
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-sm border-2 border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] overflow-hidden">
                <div className="border-b border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 py-1 font-['Share_Tech_Mono'] text-[10px] font-bold tracking-widest text-[var(--ps-accent)] uppercase">
                  DISTÂNCIA
                </div>
                <div className="flex flex-1 flex-col items-center justify-center px-2 py-1 font-['Share_Tech_Mono'] tabular-nums">
                  {renderTripEditorOrValue(
                    "font-['Share_Tech_Mono'] text-4xl sm:text-5xl text-[var(--ps-amber)]",
                    "font-['Share_Tech_Mono'] text-sm text-[var(--ps-amber)]",
                    "font-['Share_Tech_Mono'] text-[10px] text-[var(--ps-muted)]"
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-1 min-h-0 flex-col justify-between rounded-sm border-2 border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] overflow-hidden">
              <div className="flex items-center justify-between border-b border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1 font-['Share_Tech_Mono'] text-[10px] font-bold tracking-widest uppercase">
                <span className="text-[var(--ps-accent)]">TEMPO SS</span>
                <span className="text-[var(--ps-muted)]">{statusHeadline}</span>
              </div>
              <div
                className={`flex flex-1 items-center justify-center px-2 py-1 text-center font-['Share_Tech_Mono'] text-5xl font-bold leading-none tabular-nums sm:text-6xl ${
                  stageState === 'running'
                    ? 'text-[var(--ps-accent)]'
                    : stageState === 'finished'
                      ? 'text-[var(--ps-emerald)]'
                      : 'text-[var(--ps-text)]'
                }`}
              >
                {formatStageDuration(currentStageElapsedMs)}
              </div>
            </div>

            <div className="grid shrink-0 grid-cols-3 gap-2">
              <div className="rounded-sm border-2 border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center font-['Share_Tech_Mono'] tabular-nums">
                <p className="text-[9px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  DELTA
                </p>
                <p
                  className={`mt-0.5 text-base font-bold leading-none sm:text-lg ${
                    isFaster
                      ? 'text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'text-[var(--ps-danger)]'
                        : 'text-[var(--ps-text)]'
                  }`}
                >
                  {formattedCompactDelta}
                </p>
              </div>
              <div className="rounded-sm border-2 border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center font-['Share_Tech_Mono'] tabular-nums">
                <p className="text-[9px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  HORA CH
                </p>
                <p className="mt-0.5 text-base font-bold leading-none text-[var(--ps-text)] sm:text-lg">
                  {formatClockTime(clockAdjustedNow)}
                </p>
              </div>
              <div className="rounded-sm border-2 border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center font-['Share_Tech_Mono'] tabular-nums">
                <p className="text-[9px] font-bold tracking-widest text-[var(--ps-emerald)] uppercase">
                  MELHOR SS
                </p>
                <p className="mt-0.5 text-base font-bold leading-none text-[var(--ps-emerald)] sm:text-lg">
                  {formatStageDuration(optimalSummary.bestRunTotalMs)}
                </p>
              </div>
            </div>
          </div>
        );
      }

      // 13 · FUTURISTIC HUD (VISOR HEAD-UP DISPLAY DE AVIAÇÃO / F1)
      case 'futuristic_hud': {
        const gLatPct = Math.max(-100, Math.min(100, (liveLatG / 1.5) * 100));
        return (
          <div className="relative flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)]/75 p-3 text-[var(--ps-text)] backdrop-blur-sm">
            {/* Linhas de Mira Geométricas nos 4 Cantos */}
            <span aria-hidden="true" className="pointer-events-none absolute top-2 left-2 h-4 w-4 border-t-2 border-l-2 border-[var(--ps-accent)]" />
            <span aria-hidden="true" className="pointer-events-none absolute top-2 right-2 h-4 w-4 border-t-2 border-r-2 border-[var(--ps-accent)]" />
            <span aria-hidden="true" className="pointer-events-none absolute bottom-2 left-2 h-4 w-4 border-b-2 border-l-2 border-[var(--ps-accent)]" />
            <span aria-hidden="true" className="pointer-events-none absolute bottom-2 right-2 h-4 w-4 border-b-2 border-r-2 border-[var(--ps-accent)]" />

            {/* Barra Superior HUD: Rumo / Inclinação Lateral & Força G */}
            <div className="grid shrink-0 grid-cols-3 items-center gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]/70 px-2.5 py-1.5 font-['Orbitron'] tabular-nums">
              <div className="text-left">
                <p className="text-[8px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  LONG G
                </p>
                <p className="text-xs font-bold text-[var(--ps-accent)] sm:text-sm">
                  {liveLongG >= 0 ? '+' : ''}
                  {liveLongG.toFixed(2)}G
                </p>
              </div>
              <div className="flex flex-col items-center text-center">
                <p className="text-[8px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  HORIZON / CAP {headingDeg !== null ? `${headingDeg}°` : '---'}
                </p>
                <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-[var(--ps-accent)]/70" />
                  <div
                    className="absolute inset-y-0 w-2.5 -translate-x-1/2 rounded-full bg-[var(--ps-accent)]"
                    style={{ left: `${50 + gLatPct * 0.45}%` }}
                  />
                </div>
              </div>
              <div className="text-right">
                <p className="text-[8px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  LAT G
                </p>
                <p className="text-xs font-bold text-[var(--ps-amber)] sm:text-sm">
                  {liveLatG >= 0 ? '+' : ''}
                  {liveLatG.toFixed(2)}G
                </p>
              </div>
            </div>

            {/* Velocímetro Translúcido + Mira Central */}
            <div className="relative flex flex-[1.15] min-h-0 flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]/55 px-3 py-2 text-center">
              <span className="font-mono text-[9px] font-bold tracking-[0.22em] text-[var(--ps-accent)] uppercase">
                HUD VELOCITY · {statusHeadline}
              </span>
              <div className="my-auto flex items-baseline justify-center gap-1.5 font-['Orbitron'] tabular-nums">
                <span className="text-6xl font-black leading-none tracking-tight text-[var(--ps-text)] drop-shadow-[0_0_12px_var(--ps-accent-soft)] sm:text-7xl">
                  {Math.round(speedKmh)}
                </span>
                <span className="text-xs font-bold text-[var(--ps-accent)] uppercase sm:text-sm">
                  KM/H
                </span>
              </div>
              <div className="flex w-full items-center justify-between font-mono text-[10px] tabular-nums">
                <span className="inline-flex items-center gap-1.5 text-[var(--ps-muted)]">
                  <span>
                    DIST <strong className="text-[var(--ps-amber)]">{Math.round(displayedTripKm * 1000)}m</strong>
                  </span>
                  <button
                    type="button"
                    onClick={onZeroTrip}
                    title="Zerar Trip Parcial"
                    aria-label="Zerar Trip Parcial"
                    className="inline-flex h-5 w-5 items-center justify-center rounded border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                  </button>
                </span>
                <span
                  className={`font-bold ${
                    isFaster
                      ? 'text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'text-[var(--ps-danger)]'
                        : 'text-[var(--ps-muted)]'
                  }`}
                >
                  DELTA {formattedCompactDelta}
                </span>
              </div>
            </div>

            {/* Telemetria Inferior HUD: SS + CH/MELHOR */}
            <div className="grid shrink-0 grid-cols-3 gap-2">
              <div className="col-span-2 flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]/65 px-2.5 py-2 text-center">
                <span className="font-mono text-[9px] font-bold tracking-widest text-[var(--ps-muted)] uppercase">
                  CRONÔMETRO SS
                </span>
                <span className="mt-0.5 font-['Orbitron'] text-3xl font-black leading-none text-[var(--ps-text)] tabular-nums sm:text-4xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </span>
              </div>
              <div className="flex flex-col justify-center gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]/65 px-2 py-1.5 text-center font-mono tabular-nums">
                <div>
                  <p className="text-[8px] font-bold text-[var(--ps-muted)] uppercase">CH</p>
                  <p className="text-xs font-bold text-[var(--ps-text)]">
                    {formatClockTime(clockAdjustedNow)}
                  </p>
                </div>
                <div>
                  <p className="text-[8px] font-bold text-[var(--ps-emerald)] uppercase">MELHOR</p>
                  <p className="text-xs font-bold text-[var(--ps-emerald)]">
                    {formatStageDuration(optimalSummary.bestRunTotalMs)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      }

      // 14 · CUSTOMIZADO (MONTE O SEU COCKPIT — APENAS WIDGETS DE DADOS)
      case 'custom': {
        const enabledWidgets = customWidgets.filter((w) => w.enabled);
        const sizeFlexClass = (sz: CustomWidgetSize) =>
          sz === 'G' ? 'flex-[1.8] min-h-0' : sz === 'M' ? 'flex-1 min-h-0' : 'shrink-0';

        if (enabledWidgets.length === 0) {
          return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 text-center">
              <p className="text-sm font-bold text-[var(--ps-muted)]">
                Todos os widgets estão ocultos no modo Customizado.
              </p>
              <button
                type="button"
                onClick={onOpenConfigModal}
                className="pitstop-btn-red inline-flex min-h-[42px] items-center gap-2 rounded-xl px-4 text-xs font-extrabold uppercase"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>Abrir Config. &amp; Widgets</span>
              </button>
            </div>
          );
        }

        return (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 overflow-hidden">
            {enabledWidgets.map((widget) => {
              const flexCls = sizeFlexClass(widget.size);
              switch (widget.id) {
                case 'delta':
                  return (
                    <div
                      key="delta"
                      className={`${flexCls} flex flex-col justify-center rounded-xl border-2 px-3 py-1 ${
                        isFaster
                          ? 'border-[#10B981] bg-emerald-600/20 text-[var(--ps-emerald)]'
                          : isSlower
                            ? 'border-[var(--ps-danger)] bg-red-600/20 text-[var(--ps-danger)]'
                            : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                      }`}
                    >
                      {widget.size !== 'P' && (
                        <div className="relative mb-1 h-1.5 w-full overflow-hidden rounded border border-white/10 bg-black/40">
                          <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-white/40" />
                          {isSlower && (
                            <div
                              className="absolute inset-y-0 right-1/2 bg-[#E10600]"
                              style={{ width: `${deltaClampedPct}%` }}
                            />
                          )}
                          {isFaster && (
                            <div
                              className="absolute inset-y-0 left-1/2 bg-[#10B981]"
                              style={{ width: `${deltaClampedPct}%` }}
                            />
                          )}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-left">
                          <p className="font-mono text-[11px] font-black uppercase">
                            {isFaster
                              ? '▲ MAIS RÁPIDO'
                              : isSlower
                                ? '▼ MAIS LENTO'
                                : '● DELTA TIME'}
                          </p>
                          <p className="font-mono text-[10px] opacity-80 uppercase">
                            {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
                            {deltaTrend === 'improving'
                              ? ' · ▲'
                              : deltaTrend === 'worsening'
                                ? ' · ▼'
                                : ''}
                          </p>
                        </div>
                        <span
                          className={`font-mono font-black leading-none tracking-tighter tabular-nums ${
                            widget.size === 'G'
                              ? 'text-5xl sm:text-6xl'
                              : widget.size === 'M'
                                ? 'text-4xl sm:text-5xl'
                                : 'text-3xl'
                          }`}
                        >
                          {formattedCompactDelta}
                        </span>
                      </div>
                    </div>
                  );

                case 'splits':
                  return (
                    <div key="splits" className="shrink-0">
                      {renderSplitsGrid(widget.size === 'P')}
                    </div>
                  );

                case 'speed':
                  return (
                    <div
                      key="speed"
                      className={`${flexCls} flex items-center justify-between rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-1.5`}
                    >
                      <div>
                        <p className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                          Velocidade
                        </p>
                        <p className="font-mono text-xs font-bold text-[var(--ps-accent)] uppercase">
                          km/h
                        </p>
                      </div>
                      <span
                        className={`font-mono font-black leading-none text-[var(--ps-text)] tabular-nums ${
                          widget.size === 'G'
                            ? 'text-5xl sm:text-6xl'
                            : widget.size === 'M'
                              ? 'text-5xl'
                              : 'text-4xl'
                        }`}
                      >
                        {Math.round(speedKmh)}
                      </span>
                    </div>
                  );

                case 'meters':
                  return (
                    <div
                      key="meters"
                      className={`${flexCls} flex items-center justify-between rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-1.5`}
                    >
                      <div>
                        <p className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                          Metros (Odômetro)
                        </p>
                        <p className="font-mono text-[10px] text-[var(--ps-muted)]">
                          Toque p/ editar
                        </p>
                      </div>
                      <div>
                        {renderTripEditorOrValue(
                          widget.size === 'G'
                            ? 'text-4xl sm:text-5xl text-[var(--ps-amber)]'
                            : widget.size === 'M'
                              ? 'text-4xl text-[var(--ps-amber)]'
                              : 'text-3xl text-[var(--ps-amber)]',
                          'text-xs text-[var(--ps-amber)]',
                          'text-[10px] text-[var(--ps-muted)]'
                        )}
                      </div>
                    </div>
                  );

                case 'chrono':
                  return (
                    <div
                      key="chrono"
                      className={`${flexCls} flex flex-col justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-1.5`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                            Cronômetro · {statusHeadline}
                          </p>
                          <p
                            className={`font-mono font-black leading-none tracking-tighter text-[var(--ps-text)] tabular-nums ${
                              widget.size === 'G'
                                ? 'text-5xl sm:text-6xl'
                                : widget.size === 'M'
                                  ? 'text-4xl sm:text-5xl'
                                  : 'text-3xl'
                            }`}
                          >
                            {formatStageDuration(currentStageElapsedMs)}
                          </p>
                        </div>
                        <div className="text-right font-mono text-xs tabular-nums">
                          <p className="text-[var(--ps-muted)]">
                            CH{' '}
                            <strong className="text-sm font-extrabold text-[var(--ps-text)]">
                              {formatClockTime(clockAdjustedNow)}
                            </strong>
                          </p>
                          <p className="text-[var(--ps-emerald)]">
                            MEL <strong className="text-sm font-extrabold">{formatStageDuration(optimalSummary.bestRunTotalMs)}</strong>
                          </p>
                          {widget.size !== 'P' && (
                            <p className="text-[var(--ps-muted)]">
                              ÚLT <strong className="text-sm font-extrabold">{formatStageDuration(optimalSummary.lastRunTotalMs)}</strong>
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );

                case 'minimap':
                  return (
                    <div
                      key="minimap"
                      className={`${
                        widget.size === 'P' ? 'h-28 shrink-0' : flexCls
                      } overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[#000000]`}
                    >
                      <VelocityMapboxView
                        trackId={activeTrackId || 'live_free'}
                        editableTrace={liveMapTrace}
                        guideTrace={guideTrace}
                        orderedTraps={orderedTraps}
                        postEditIdx={Math.max(0, liveMapTrace.length - 1)}
                        currentPos={currentPos}
                        navigationMode={true}
                        headingUp={liveHeadingUp}
                        onToggleHeadingUp={onToggleHeadingUp}
                        navHeadingDeg={headingDeg}
                        heatmapMode={liveHeatmapMode}
                        containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
                      />
                    </div>
                  );
              }
            })}
          </div>
        );
      }
    }
  };

  // ============================================================================
  // SINGLE FIXED MANDATORY CHASSIS FOR ALL 11 LAYOUTS
  // Topo limpo (← Voltar + Nome da Especial + barra de progresso)
  // Centro (exclusivamente cards de dados do layout ativo / Mapa / Gauges)
  // Rodapé unificado (GoPro + ZERAR TRIP / ARMAR|LARGAR|ENCERRAR + Barra 5 abas)
  // ============================================================================
  return (
    <section
      className={`fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden p-2 sm:p-3 ${
        isNightMode ? '!bg-[#000000] text-slate-200' : 'bg-[var(--ps-bg)] text-[var(--ps-text)]'
      }`}
    >
      {/* 1. TOPO LIMPO ÚNICO */}
      <div className="shrink-0 space-y-1.5">
        <div
          className={`space-y-1 rounded-xl border px-2.5 py-2 ${
            isNightMode
              ? 'border-white/10 bg-[#050609]'
              : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
          }`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              aria-label="Voltar"
              className={`inline-flex min-h-[40px] shrink-0 items-center gap-1 rounded-lg border px-2.5 text-xs font-bold transition-all active:scale-[0.98] ${
                isNightMode
                  ? 'border-white/10 bg-[#0A0C10] text-slate-200'
                  : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]'
              }`}
            >
              <ArrowLeft className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Voltar</span>
            </button>

            <p className="min-w-0 flex-1 text-center font-['Barlow_Condensed'] text-base font-black leading-tight tracking-wide uppercase sm:text-lg">
              {activeTrackName}
            </p>

            {(gpsStatusLabel || zeroSpeedLocked) && (
              <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] font-bold">
                {zeroSpeedLocked && (
                  <span
                    title="Zero-Speed Anti-Drift Lock ativo (< 2,0 km/h)"
                    className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-black text-amber-400 uppercase"
                  >
                    LOCK 0.0
                  </span>
                )}
                {gpsStatusLabel && (
                  <span
                    className={`rounded border px-1.5 py-0.5 tabular-nums ${
                      isNightMode
                        ? 'border-white/10 bg-[#0A0C10] text-emerald-400'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-emerald)]'
                    }`}
                  >
                    {gpsStatusLabel}
                  </span>
                )}
              </div>
            )}
          </div>

          {renderProgressBar()}

          {(liveNotice || gpsError) && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1 text-[11px]">
              <span className="truncate text-[var(--ps-amber)]">{liveNotice || gpsError}</span>
              {wakeLockActive && (
                <span className="shrink-0 font-mono text-[9px] text-[var(--ps-muted)]">
                  Tela Ativa
                </span>
              )}
            </div>
          )}
        </div>

        {/* Caso usuário escolha "Posição do Menu: Topo", move apenas a barra de 5 abas para cá */}
        {menuPosition === 'top' && renderFiveTabBar()}
      </div>

      {/* 2. ÁREA CENTRAL DE DADOS (SEM CABEÇALHO OU BOTÕES PRÓPRIOS) */}
      <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 overflow-hidden">
        {showLiveMap
          ? renderLiveMapOverlay()
          : liveMode === 'gauges' && gaugesNode
            ? gaugesNode
            : renderCenterDataCards()}
      </div>

      {/* 3. RODAPÉ UNIFICADO ÚNICO */}
      <div className="shrink-0 space-y-1.5">
        <div className="grid grid-cols-2 gap-2">
          {goproCompactButtonNode}

          <button
            type="button"
            onClick={handleUnifiedStageAction}
            className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-3 text-xs font-extrabold uppercase transition-all active:scale-[0.98] sm:text-sm ${unifiedButtonMeta.cls}`}
          >
            {unifiedButtonMeta.icon}
            <span>{unifiedButtonMeta.label}</span>
          </button>
        </div>

        {/* Posição padrão: Barra de 5 abas no Rodapé (Polegar) */}
        {menuPosition === 'bottom' && renderFiveTabBar()}
      </div>
    </section>
  );
};
