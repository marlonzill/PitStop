import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Flag,
  LayoutGrid,
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
  layoutId: Exclude<VelocityCockpitLayoutId, 'classic'>;
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
  currentPos: { lat: number; lon: number } | null;
  headingDeg: number | null;
  liveHeadingUp: boolean;
  onToggleHeadingUp: () => void;
  liveHeatmapMode: 'speed' | 'accel';
  onToggleHeatmapMode: () => void;
  isPro: boolean;
  showLiveMap: boolean;
  liveNotice: string | null;
  gpsError: string | null;
  wakeLockActive: boolean;
  goproBarNode: React.ReactNode;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenSatcron: () => void;
  onOpenLayoutModal: () => void;
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
  if ((trap.kind === 'finish' || trap.kind === 'start_finish') && Number.isFinite(run.totalMs) && run.totalMs > 0) {
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
        return Math.round(prev.stageElapsedMs + hit.t * (curr.stageElapsedMs - prev.stageElapsedMs));
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
  currentPos,
  headingDeg,
  liveHeadingUp,
  onToggleHeadingUp,
  liveHeatmapMode,
  onToggleHeatmapMode,
  isPro,
  showLiveMap,
  liveNotice,
  gpsError,
  wakeLockActive,
  goproBarNode,
  onBack,
  onOpenSettings,
  onOpenSatcron,
  onOpenLayoutModal,
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
  const [showCustomGoProDrawer, setShowCustomGoProDrawer] = useState(false);

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
        cls: 'pitstop-btn-red text-white',
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
        cls: 'pitstop-btn-red text-white',
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
        ? 'ARMADA · ESPERANDO LARGADA'
        : 'ARMADA'
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
      <div className="w-full max-w-[165px] space-y-1 mx-auto">
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
        <button
          type="button"
          onClick={commitTripEdit}
          className="pitstop-btn-red w-full rounded py-1 text-[10px] font-extrabold uppercase"
        >
          Confirmar
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={openTripEditor}
        title="Toque para digitar metragem do odômetro"
        className="group flex flex-col items-center justify-center rounded-lg px-1.5 py-0.5 hover:bg-white/5"
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
    );

  const renderProgressBar = (pureBlack = false) => (
    <div className="flex items-center gap-2 px-0.5">
      <div
        className={`relative h-1.5 flex-1 overflow-hidden rounded-full border ${
          pureBlack ? 'border-white/10 bg-[#07080B]' : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)]'
        }`}
      >
        <div
          className={`h-full rounded-full transition-all duration-200 ${
            liveIsFinishFlash
              ? 'animate-pulse bg-[#00E5FF] shadow-[0_0_8px_#00E5FF]'
              : 'bg-gradient-to-r from-[#10B981] via-[#F59E0B] to-[#FF2A2A]'
          }`}
          style={{ width: `${liveProgressPct}%` }}
        />
      </div>
      <span
        className={`shrink-0 font-mono text-[9px] font-extrabold tabular-nums ${
          liveIsFinishFlash
            ? 'text-[#00E5FF]'
            : liveProgressPct >= 85
              ? 'text-[#FF2A2A]'
              : 'text-[var(--ps-muted)]'
        }`}
      >
        {liveHasRefDist
          ? liveRemainingDistM !== null &&
            liveRemainingDistM <= 300 &&
            stageState === 'running'
            ? `-${Math.round(liveRemainingDistM)}m`
            : `${liveProgressPct}%`
          : `${Math.round(speedKmh)} km/h`}
      </span>
    </div>
  );

  const renderStandardHeader = (options?: {
    hideTopTabs?: boolean;
    nightMode?: boolean;
    compact?: boolean;
  }) => {
    const night = Boolean(options?.nightMode);
    const cardCls = night
      ? 'rounded-xl border border-white/10 bg-[#050609] px-2 py-1.5 space-y-1'
      : 'rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2 py-1.5 space-y-1';
    const btnCls = night
      ? 'inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-[#0A0C10] px-2 text-[10px] font-bold text-slate-300 hover:border-white/25'
      : 'inline-flex h-7 items-center gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 text-[10px] font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]';

    return (
      <div className="shrink-0 space-y-1">
        <div className={cardCls}>
          <div className="flex items-center justify-between gap-1.5">
            <button type="button" onClick={onBack} aria-label="Voltar" className={btnCls}>
              <ArrowLeft className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span className="hidden xs:inline">Voltar</span>
            </button>

            <p className="min-w-0 flex-1 truncate text-center font-['Barlow_Condensed'] text-sm font-black tracking-wide text-[var(--ps-text)] uppercase sm:text-base">
              {activeTrackName}
            </p>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={onOpenLayoutModal}
                title="Trocar Layout do Cockpit"
                className={btnCls}
              >
                <LayoutGrid className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                <span className="hidden sm:inline">Layout</span>
              </button>
              <button
                type="button"
                onClick={onOpenSatcron}
                title="Satcron Ao Vivo"
                className={btnCls}
              >
                <Trophy className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              </button>
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label="Configurações"
                className={btnCls}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {renderProgressBar(night)}
        </div>

        {!options?.hideTopTabs && (
          <div
            className={`grid grid-cols-3 gap-1 rounded-xl border p-1 ${
              night
                ? 'border-white/10 bg-[#050609]'
                : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
            }`}
          >
            <button
              type="button"
              onClick={onSelectTimerTab}
              className={`inline-flex min-h-[34px] items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-extrabold uppercase transition-colors sm:text-xs ${
                !showLiveMap ? 'pitstop-btn-red' : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              <Flag className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Cronômetro</span>
            </button>

            <button
              type="button"
              onClick={onOpenAnalysis}
              className="inline-flex min-h-[34px] items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-extrabold text-[var(--ps-emerald)] uppercase transition-colors hover:bg-emerald-500/15 sm:text-xs"
            >
              <TrendingUp className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Análise {!isPro ? '(PRO)' : ''}</span>
            </button>

            <button
              type="button"
              onClick={onSelectMapTab}
              className={`inline-flex min-h-[34px] items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-extrabold uppercase transition-colors sm:text-xs ${
                showLiveMap ? 'bg-sky-600 text-white' : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              <MapIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Mapa {!isPro ? '(PRO)' : ''}</span>
            </button>
          </div>
        )}

        {(liveNotice || gpsError) && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1 text-[11px]">
            <span className="truncate text-[var(--ps-amber)]">{liveNotice || gpsError}</span>
            {wakeLockActive && (
              <span className="shrink-0 font-mono text-[9px] text-[var(--ps-muted)]">Tela Ativa</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderStandardFooter = (options?: { nightMode?: boolean }) => (
    <div className="shrink-0 space-y-1.5">
      {goproBarNode}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onZeroTrip}
          className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-3 text-xs font-extrabold uppercase sm:text-sm ${
            options?.nightMode
              ? 'border border-white/15 bg-[#080A0F] text-slate-200'
              : 'pitstop-btn-metal'
          }`}
        >
          <RotateCcw className="h-4 w-4 opacity-75" />
          <span>Zerar Trip</span>
        </button>

        <button
          type="button"
          onClick={handleUnifiedStageAction}
          className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-3 text-xs font-extrabold uppercase sm:text-sm ${unifiedButtonMeta.cls}`}
        >
          {unifiedButtonMeta.icon}
          <span>{unifiedButtonMeta.label}</span>
        </button>
      </div>
    </div>
  );

  const renderSplitsGrid = (compact = false, nightMode = false) => {
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
              className={`flex ${compact ? 'min-h-[48px] py-1' : 'min-h-[58px] py-1.5'} min-w-0 flex-col items-center justify-center rounded-xl border px-1 text-center font-mono tabular-nums transition-colors ${
                sp.isActive
                  ? 'animate-pulse border-amber-400 bg-amber-500/15 text-[var(--ps-amber)]'
                  : sp.crossed
                    ? isBetter
                      ? 'border-emerald-400/75 bg-emerald-600/20 text-[var(--ps-text)]'
                      : isWorse
                        ? 'border-red-500/75 bg-red-600/20 text-[var(--ps-text)]'
                        : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                    : nightMode
                      ? 'border-white/10 bg-[#050609] text-slate-500'
                      : 'border-[var(--ps-border)]/70 bg-[var(--ps-card-deep)]/65 text-[var(--ps-muted)]'
              }`}
            >
              <span
                className={`text-[10px] font-black leading-none uppercase ${
                  sp.isActive ? 'text-[var(--ps-amber)]' : 'text-[var(--ps-muted)]'
                }`}
              >
                {sp.code}
              </span>
              {sp.crossed ? (
                sp.diffSec !== null ? (
                  <>
                    <span
                      className={`mt-0.5 text-xs font-black leading-none sm:text-sm ${
                        isBetter ? 'text-[var(--ps-emerald)]' : 'text-[#FF453A]'
                      }`}
                    >
                      {sp.diffSec > 0 ? '+' : ''}
                      {sp.diffSec.toFixed(1)}s
                    </span>
                    <span className="mt-0.5 text-[10px] font-bold leading-none text-[var(--ps-muted)]">
                      {sp.sectorMs !== null ? formatSplitCompactTime(sp.sectorMs) : '--'}
                    </span>
                  </>
                ) : (
                  <span className="mt-1 text-xs font-black leading-none text-white sm:text-sm">
                    {sp.sectorMs !== null ? formatSplitCompactTime(sp.sectorMs) : '--'}
                  </span>
                )
              ) : sp.isActive ? (
                <span className="mt-1 text-[11px] font-black leading-none text-[var(--ps-amber)] uppercase">
                  ATUAL
                </span>
              ) : (
                <span className="mt-1 text-xs font-bold leading-none opacity-60">--</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ============================================================================
  // LAYOUT 02: ERGONOMIA THUMB-ZONE
  // Topo 100% limpo só com Voltar (<-), barra fina de progresso e Nome da Especial.
  // Centro dedicado apenas aos dados. Todos os controles na base (Thumb Zone).
  // ============================================================================
  if (layoutId === 'thumb_zone') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {/* Topo 100% limpo */}
        <div className="shrink-0 space-y-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-2.5 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              aria-label="Voltar"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)]"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Voltar</span>
            </button>
            <p className="min-w-0 flex-1 text-center font-['Barlow_Condensed'] text-base font-black tracking-wide text-[var(--ps-text)] uppercase truncate sm:text-lg">
              {activeTrackName}
            </p>
          </div>
          {renderProgressBar(false)}
          {(liveNotice || gpsError) && (
            <p className="truncate text-center font-mono text-[10px] font-bold text-[var(--ps-amber)]">
              {liveNotice || gpsError}
            </p>
          )}
        </div>

        {/* Centro 100% Dados (ou Mapa ao Vivo se selecionado) */}
        <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 sm:p-3">
              {/* Delta Time */}
              <div
                className={`flex flex-1 min-h-[78px] flex-col items-center justify-center rounded-xl border-2 px-3 py-2 text-center transition-colors ${
                  isFaster
                    ? 'border-[#10B981] bg-emerald-600/25 text-[var(--ps-emerald)]'
                    : isSlower
                      ? 'border-[#FF2A2A] bg-red-600/25 text-[#FF2A2A]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-mono text-[10px] font-black tracking-wider uppercase sm:text-xs">
                  <span>{isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : '● DELTA TIME'}</span>
                </div>
                <div className="mt-0.5 font-mono text-3xl font-black leading-none tracking-tight tabular-nums sm:text-5xl">
                  {formattedCompactDelta}
                </div>
                <p className="mt-1 font-mono text-[10px] font-bold opacity-80 uppercase">
                  {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
                </p>
              </div>

              {renderSplitsGrid(false)}

              {/* Velocidade + Metros */}
              <div className="grid shrink-0 grid-cols-2 gap-1.5">
                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-2 text-center">
                  <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    Velocidade
                  </span>
                  <div className="mt-0.5 flex items-baseline gap-1 font-mono tabular-nums">
                    <span className="text-3xl font-black leading-none text-[var(--ps-text)] sm:text-4xl">
                      {Math.round(speedKmh)}
                    </span>
                    <span className="text-xs font-extrabold text-[var(--ps-accent)]">km/h</span>
                  </div>
                </div>
                <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-1.5 text-center">
                  <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                    Metros
                  </span>
                  {renderTripEditorOrValue(
                    'text-3xl sm:text-4xl text-[var(--ps-amber)]',
                    'text-sm text-[var(--ps-amber)]',
                    'text-[10px] text-[var(--ps-muted)]'
                  )}
                </div>
              </div>

              {/* Cronômetro + CH / Melhor */}
              <div className="shrink-0 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 text-center">
                <div className="flex items-center justify-between font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                  <span>CH {formatClockTime(clockAdjustedNow)}</span>
                  <span className="text-[var(--ps-text)]">{statusHeadline}</span>
                  <span className="text-[var(--ps-emerald)]">
                    MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-4xl font-black leading-none tracking-tight text-[var(--ps-text)] tabular-nums sm:text-5xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Base Thumb-Zone: GoPro + Zerar Trip / Botão Unificado + Abas Bottom */}
        <div className="shrink-0 space-y-1.5">
          {goproBarNode}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onZeroTrip}
              className="pitstop-btn-metal flex min-h-[46px] items-center justify-center gap-2 rounded-xl px-3 text-xs font-extrabold uppercase sm:text-sm"
            >
              <RotateCcw className="h-4 w-4 text-[var(--ps-muted)]" />
              <span>Zerar Trip</span>
            </button>
            <button
              type="button"
              onClick={handleUnifiedStageAction}
              className={`flex min-h-[46px] items-center justify-center gap-2 rounded-xl px-3 text-xs font-extrabold uppercase sm:text-sm ${unifiedButtonMeta.cls}`}
            >
              {unifiedButtonMeta.icon}
              <span>{unifiedButtonMeta.label}</span>
            </button>
          </div>

          <div className="grid grid-cols-5 gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-1">
            <button
              type="button"
              onClick={onSelectTimerTab}
              className={`flex min-h-[38px] flex-col items-center justify-center rounded-lg text-[10px] font-extrabold uppercase ${
                !showLiveMap ? 'pitstop-btn-red' : 'text-[var(--ps-muted)]'
              }`}
            >
              <Flag className="h-3.5 w-3.5" />
              <span>Cronôm.</span>
            </button>
            <button
              type="button"
              onClick={onOpenAnalysis}
              className="flex min-h-[38px] flex-col items-center justify-center rounded-lg text-[10px] font-extrabold text-[var(--ps-emerald)] uppercase hover:bg-emerald-500/15"
            >
              <TrendingUp className="h-3.5 w-3.5" />
              <span>Análise</span>
            </button>
            <button
              type="button"
              onClick={onSelectMapTab}
              className={`flex min-h-[38px] flex-col items-center justify-center rounded-lg text-[10px] font-extrabold uppercase ${
                showLiveMap ? 'bg-sky-600 text-white' : 'text-[var(--ps-muted)]'
              }`}
            >
              <MapIcon className="h-3.5 w-3.5" />
              <span>Mapa</span>
            </button>
            <button
              type="button"
              onClick={onOpenSatcron}
              className="flex min-h-[38px] flex-col items-center justify-center rounded-lg text-[10px] font-extrabold text-[var(--ps-muted)] uppercase hover:text-[var(--ps-text)]"
            >
              <Trophy className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Satcron</span>
            </button>
            <button
              type="button"
              onClick={onOpenLayoutModal}
              className="flex min-h-[38px] flex-col items-center justify-center rounded-lg text-[10px] font-extrabold text-[var(--ps-muted)] uppercase hover:text-[var(--ps-text)]"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-sky-400" />
              <span>Layout</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 03: CORALBA / MONIT RALLY (NAVEGADOR)
  // ============================================================================
  if (layoutId === 'coralba') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              {/* Odômetro Parcial (Trip) + Botão Zerar Trip Gigante */}
              <div className="grid flex-[1.35] min-h-0 grid-cols-3 gap-2">
                <div className="col-span-2 flex flex-col items-center justify-center rounded-2xl border-2 border-amber-500/60 bg-[#141109] p-3 text-center">
                  <span className="font-mono text-xs font-black tracking-widest text-amber-400 uppercase">
                    Odômetro Parcial (Trip)
                  </span>
                  <div className="mt-2">
                    {renderTripEditorOrValue(
                      'text-5xl sm:text-6xl text-[#FBBF24]',
                      'text-xl text-[#FBBF24]',
                      'text-xs text-amber-200/80'
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onZeroTrip}
                  className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-[#E10600]/80 bg-[#E10600] p-2 text-white shadow-lg active:scale-95"
                >
                  <RotateCcw className="h-8 w-8" />
                  <span className="font-['Barlow_Condensed'] text-xl font-black leading-none tracking-wide uppercase sm:text-2xl">
                    Zerar Trip
                  </span>
                </button>
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
                          ? 'text-[#FF2A2A]'
                          : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    {formattedCompactDelta}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer com GoPro + Botão Unificado */}
        <div className="shrink-0 space-y-1.5">
          {goproBarNode}
          <button
            type="button"
            onClick={handleUnifiedStageAction}
            className={`flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold uppercase ${unifiedButtonMeta.cls}`}
          >
            {unifiedButtonMeta.icon}
            <span>{unifiedButtonMeta.label}</span>
          </button>
        </div>
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 04: RACECHRONO SPLIT-SCREEN (MAPA + DADOS)
  // ============================================================================
  if (layoutId === 'split_map') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              {/* Metade Superior: Mapa ao Vivo */}
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

              {/* Metade Inferior: Delta + Velocidade / Metros / Cronômetro */}
              <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5">
                <div
                  className={`flex flex-1 min-h-[60px] items-center justify-between rounded-xl border-2 px-3 py-1.5 ${
                    isFaster
                      ? 'border-[#10B981] bg-emerald-600/25 text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'border-[#FF2A2A] bg-red-600/25 text-[#FF2A2A]'
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
            </>
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 05: AIM SOLO 2 (MINIMALISTA — 3 BLOCOS GIGANTES)
  // ============================================================================
  if (layoutId === 'aim_minimal') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              {/* Bloco 1: Delta Time Gigante */}
              <div
                className={`flex flex-1 min-h-0 flex-col items-center justify-center rounded-2xl border-2 px-4 text-center ${
                  isFaster
                    ? 'border-[#10B981] bg-emerald-600/25 text-[var(--ps-emerald)]'
                    : isSlower
                      ? 'border-[#FF2A2A] bg-red-600/25 text-[#FF2A2A]'
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

              {/* Bloco 2: Cronômetro Gigante */}
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

              {/* Bloco 3: Velocidade Gigante */}
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
            </>
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 06: FUELTECH FT700 CLUSTER
  // ============================================================================
  if (layoutId === 'ft700_cluster') {
    const ledCount = 14;
    const activeLeds =
      predictiveDeltaSec !== null
        ? Math.max(2, Math.min(ledCount, Math.round((Math.abs(predictiveDeltaSec) / 4) * ledCount)))
        : Math.max(1, Math.min(ledCount, Math.round((speedKmh / 150) * ledCount)));

    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[#080A0F] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 rounded-2xl border border-cyan-500/35 bg-gradient-to-b from-[#0E131E] to-[#080B12] p-2.5 shadow-2xl">
              {/* Barra de LED FT700 */}
              <div className="shrink-0 space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px] font-bold uppercase">
                  <span className="text-cyan-400">FT700 CLUSTER</span>
                  <span className="text-slate-300">{statusHeadline}</span>
                </div>
                <div className="grid grid-cols-14 gap-1 rounded-lg border border-white/10 bg-black/70 p-1.5">
                  {Array.from({ length: ledCount }).map((_, idx) => {
                    const lit = idx < activeLeds;
                    const color =
                      isFaster
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

              {/* Centro Proeminente: Velocidade + Delta */}
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

              {/* Parciais P1-P4 */}
              {renderSplitsGrid(true)}

              {/* Faixa inferior: Metros + Cronômetro + CH */}
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
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 07: HARRY'S LAPTIMER (VISÃO PERIFÉRICA ~45% ALTURA)
  // ============================================================================
  if (layoutId === 'harrys_delta') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              {/* ~45% da tela em cor sólida verde/vermelha para visão periférica */}
              <div
                className={`flex flex-[1.5] min-h-[180px] flex-col items-center justify-center rounded-2xl border-2 px-4 py-3 text-center transition-colors ${
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
            </>
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 08: WRC PACE-NOTE (METRAGEM COLOSSAL)
  // ============================================================================
  if (layoutId === 'wrc_pacenote') {
    const remainingText =
      liveHasRefDist && liveRemainingDistM !== null
        ? liveRemainingDistM >= 1000
          ? `${(liveRemainingDistM / 1000).toFixed(2)} km`
          : `${Math.round(liveRemainingDistM)} m`
        : '--';

    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
        {renderStandardHeader()}

        <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              {/* Metros Percorridos Colossal */}
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

              {/* Distância Restante + Velocidade */}
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

              {/* Faixa Cronômetro + Delta */}
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
                          ? 'text-[#FF2A2A]'
                          : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    {formattedCompactDelta}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 09: NIGHT STAGE (ENDURANCE NOTURNO — FUNDO PRETO PURO #000000)
  // ============================================================================
  if (layoutId === 'night_stage') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-2 overflow-hidden !bg-[#000000] p-2 text-slate-200 sm:p-3">
        {renderStandardHeader({ nightMode: true })}

        <div className="flex flex-1 min-h-0 flex-col justify-between gap-2 overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <>
              <div className="flex flex-1 min-h-0 flex-col items-center justify-center rounded-2xl border border-white/10 bg-[#050608] p-3 text-center">
                <span className="font-mono text-[10px] font-bold tracking-widest text-slate-500 uppercase">
                  {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : 'DELTA NOTURNO'}
                </span>
                <span
                  className={`mt-1 font-mono text-4xl font-black leading-none tabular-nums sm:text-5xl ${
                    isFaster
                      ? 'text-emerald-400/90'
                      : isSlower
                        ? 'text-red-400/90'
                        : 'text-slate-300'
                  }`}
                >
                  {formattedCompactDelta}
                </span>
                <span className="mt-1.5 font-mono text-[10px] text-slate-500 uppercase">
                  {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
                </span>
              </div>

              {renderSplitsGrid(true, true)}

              <div className="grid shrink-0 grid-cols-2 gap-2">
                <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#050608] p-3 text-center">
                  <span className="font-mono text-[10px] font-bold text-slate-500 uppercase">
                    Velocidade
                  </span>
                  <div className="mt-1 flex items-baseline gap-1 font-mono tabular-nums">
                    <span className="text-4xl font-black leading-none text-slate-100">
                      {Math.round(speedKmh)}
                    </span>
                    <span className="text-xs font-bold text-amber-400/80">km/h</span>
                  </div>
                </div>

                <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#050608] p-3 text-center">
                  <span className="font-mono text-[10px] font-bold text-slate-500 uppercase">
                    Metros
                  </span>
                  {renderTripEditorOrValue(
                    'text-4xl text-amber-300/90',
                    'text-sm text-amber-300/90',
                    'text-[10px] text-slate-500'
                  )}
                </div>
              </div>

              <div className="shrink-0 rounded-xl border border-white/10 bg-[#050608] px-3 py-2.5 text-center">
                <div className="flex items-center justify-between font-mono text-[10px] text-slate-500 uppercase">
                  <span>CH {formatClockTime(clockAdjustedNow)}</span>
                  <span>{statusHeadline}</span>
                  <span className="text-emerald-400/80">
                    MEL {formatStageDuration(optimalSummary.bestRunTotalMs)}
                  </span>
                </div>
                <div className="mt-1 font-mono text-4xl font-black leading-none text-slate-100 tabular-nums sm:text-5xl">
                  {formatStageDuration(currentStageElapsedMs)}
                </div>
              </div>
            </>
          )}
        </div>

        {renderStandardFooter({ nightMode: true })}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 10: COCKPIT HORIZONTAL (PAISAGEM / TABLET — 3 COLUNAS)
  // ============================================================================
  if (layoutId === 'landscape_3col') {
    return (
      <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)]">
        {renderStandardHeader({ compact: true })}

        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          {showLiveMap ? (
            renderLiveMapOverlay()
          ) : (
            <div className="grid flex-1 min-h-0 grid-cols-3 gap-2">
              {/* Coluna 1: Delta + Parciais */}
              <div className="flex min-h-0 flex-col justify-between gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
                <div
                  className={`flex flex-1 min-h-0 flex-col items-center justify-center rounded-xl border-2 p-2 text-center ${
                    isFaster
                      ? 'border-[#10B981] bg-emerald-600/25 text-[var(--ps-emerald)]'
                      : isSlower
                        ? 'border-[#FF2A2A] bg-red-600/25 text-[#FF2A2A]'
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
                                : 'text-[#FF453A]'
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

              {/* Coluna 2: Cronômetro + Velocidade */}
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
                      CH <strong className="text-[var(--ps-text)]">{formatClockTime(clockAdjustedNow)}</strong>
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

              {/* Coluna 3: Metros + Mini-Mapa ao Vivo */}
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
          )}
        </div>

        {renderStandardFooter()}
      </section>
    );
  }

  // ============================================================================
  // LAYOUT 11: CUSTOMIZADO (MONTE O SEU COCKPIT)
  // ============================================================================
  const enabledWidgets = customWidgets.filter((w) => w.enabled);
  const goproWidgetEnabled = enabledWidgets.some((w) => w.id === 'gopro');

  const sizeFlexClass = (sz: CustomWidgetSize) =>
    sz === 'G' ? 'flex-[1.8] min-h-0' : sz === 'M' ? 'flex-1 min-h-0' : 'shrink-0';

  const renderCustomWidget = (widget: CustomWidgetConfig) => {
    const flexCls = sizeFlexClass(widget.size);
    switch (widget.id) {
      case 'delta':
        return (
          <div
            key="delta"
            className={`${flexCls} flex flex-col justify-center rounded-xl border-2 px-3 py-1.5 ${
              isFaster
                ? 'border-[#10B981] bg-emerald-600/25 text-[var(--ps-emerald)]'
                : isSlower
                  ? 'border-[#FF2A2A] bg-red-600/25 text-[#FF2A2A]'
                  : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-text)]'
            }`}
          >
            {widget.size !== 'P' && (
              <div className="relative mb-1 h-1.5 w-full overflow-hidden rounded border border-white/10 bg-black/40">
                <div className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 bg-white/40" />
                {isFaster && (
                  <div
                    className="absolute inset-y-0 right-1/2 bg-[#10B981]"
                    style={{ width: `${deltaClampedPct}%` }}
                  />
                )}
                {isSlower && (
                  <div
                    className="absolute inset-y-0 left-1/2 bg-[#E10600]"
                    style={{ width: `${deltaClampedPct}%` }}
                  />
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="text-left">
                <p className="font-mono text-[10px] font-black uppercase">
                  {isFaster ? '▲ MAIS RÁPIDO' : isSlower ? '▼ MAIS LENTO' : '● DELTA TIME'}
                </p>
                <p className="font-mono text-[10px] opacity-80 uppercase">
                  {bestRun ? `vs Volta #${bestRun.runNumber}` : 'Sem referência'}
                  {deltaTrend === 'improving' ? ' · ▲' : deltaTrend === 'worsening' ? ' · ▼' : ''}
                </p>
              </div>
              <span
                className={`font-mono font-black leading-none tabular-nums ${
                  widget.size === 'G'
                    ? 'text-4xl sm:text-5xl'
                    : widget.size === 'M'
                      ? 'text-3xl sm:text-4xl'
                      : 'text-2xl'
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
              <p className="font-mono text-[10px] font-bold text-[var(--ps-accent)] uppercase">km/h</p>
            </div>
            <span
              className={`font-mono font-black leading-none text-[var(--ps-text)] tabular-nums ${
                widget.size === 'G'
                  ? 'text-5xl sm:text-6xl'
                  : widget.size === 'M'
                    ? 'text-4xl'
                    : 'text-3xl'
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
              <p className="font-mono text-[10px] text-[var(--ps-muted)]">Toque p/ editar</p>
            </div>
            <div>
              {renderTripEditorOrValue(
                widget.size === 'G'
                  ? 'text-4xl sm:text-5xl text-[var(--ps-amber)]'
                  : widget.size === 'M'
                    ? 'text-3xl sm:text-4xl text-[var(--ps-amber)]'
                    : 'text-2xl text-[var(--ps-amber)]',
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
                  className={`font-mono font-black leading-none text-[var(--ps-text)] tabular-nums ${
                    widget.size === 'G'
                      ? 'text-4xl sm:text-5xl'
                      : widget.size === 'M'
                        ? 'text-3xl sm:text-4xl'
                        : 'text-2xl'
                  }`}
                >
                  {formatStageDuration(currentStageElapsedMs)}
                </p>
              </div>
              <div className="text-right font-mono text-[10px] tabular-nums">
                <p className="text-[var(--ps-muted)]">
                  CH <strong className="text-[var(--ps-text)]">{formatClockTime(clockAdjustedNow)}</strong>
                </p>
                <p className="text-[var(--ps-emerald)]">
                  MEL <strong>{formatStageDuration(optimalSummary.bestRunTotalMs)}</strong>
                </p>
                {widget.size !== 'P' && (
                  <p className="text-[var(--ps-muted)]">
                    ÚLT <strong>{formatStageDuration(optimalSummary.lastRunTotalMs)}</strong>
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

      case 'gopro':
        return (
          <div key="gopro" className="shrink-0">
            {goproBarNode}
          </div>
        );
    }
  };

  return (
    <section className="fixed inset-0 z-40 flex h-[100dvh] flex-col justify-between gap-1.5 overflow-hidden bg-[var(--ps-bg)] p-2 text-[var(--ps-text)] sm:p-3">
      {renderStandardHeader()}

      <div className="flex flex-1 min-h-0 flex-col gap-1.5 overflow-hidden">
        {showLiveMap ? (
          renderLiveMapOverlay()
        ) : enabledWidgets.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 text-center">
            <p className="text-sm font-bold text-[var(--ps-muted)]">
              Todos os widgets estão ocultos no modo Customizado.
            </p>
            <button
              type="button"
              onClick={onOpenLayoutModal}
              className="pitstop-btn-red inline-flex min-h-[42px] items-center gap-2 rounded-xl px-4 text-xs font-extrabold uppercase"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span>Editar Widgets do Painel</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col justify-between gap-1.5 overflow-hidden">
            {enabledWidgets.map((w) => renderCustomWidget(w))}
          </div>
        )}
      </div>

      {/* Bottom Dock: keeps Zerar Trip, Unified Start/Finish + fallback GoPro/Edit access */}
      <div className="shrink-0 space-y-1.5">
        {!goproWidgetEnabled && showCustomGoProDrawer && goproBarNode}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onZeroTrip}
            className="pitstop-btn-metal flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-extrabold uppercase"
          >
            <RotateCcw className="h-4 w-4 text-[var(--ps-muted)]" />
            <span>Zerar Trip</span>
          </button>

          <button
            type="button"
            onClick={handleUnifiedStageAction}
            className={`flex min-h-[44px] flex-[1.2] items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-extrabold uppercase ${unifiedButtonMeta.cls}`}
          >
            {unifiedButtonMeta.icon}
            <span>{unifiedButtonMeta.label}</span>
          </button>

          {!goproWidgetEnabled && (
            <button
              type="button"
              onClick={() => setShowCustomGoProDrawer((v) => !v)}
              title="Abrir comando rápido GoPro"
              aria-label="Abrir comando rápido GoPro"
              className={`flex min-h-[44px] items-center justify-center gap-1 rounded-xl border px-2.5 text-[10px] font-extrabold uppercase ${
                showCustomGoProDrawer
                  ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                  : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)]'
              }`}
            >
              <Camera className="h-4 w-4 text-[var(--ps-accent)]" />
            </button>
          )}

          <button
            type="button"
            onClick={onOpenLayoutModal}
            title="Editar Widgets"
            aria-label="Editar Widgets"
            className="flex min-h-[44px] items-center justify-center rounded-xl border border-purple-500/40 bg-purple-600/15 px-2.5 text-purple-300 hover:border-purple-400"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
};
