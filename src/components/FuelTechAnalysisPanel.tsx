import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Award,
  Crosshair,
  Layers,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Target,
  Trash2,
  TrendingUp,
  ZoomIn,
} from 'lucide-react';
import {
  analyzeTrackCornersAndBraking,
  buildTrackSectors,
  computeMultiLapSectorComparison,
  computeRunSectorMetrics,
  computeSafeAverageSpeedKmh,
  detectTelemetryCriticalPoints,
  ensureTraceGForces,
  formatStageDuration,
  getOrderedTrackTraps,
  interpolateSampleAtDist,
  interpolateSampleAtElapsedMs,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
} from '../utils/velocityEngine';
import { VelocityMapboxView } from './VelocityMapboxView';
export { VideoHudOverlayPanel } from './VideoHudOverlayPanel';

interface FuelTechAnalysisPanelProps {
  sessionTrack: VelocityTrack | null;
  sessionRuns: VelocityRun[];
  sessionOptimal: OptimalStageSummary;
  lap1: VelocityRun | null;
  lap2: VelocityRun | null;
  lap3: VelocityRun | null;
  lap1Samples: VelocitySample[];
  lap2Samples: VelocitySample[];
  lap3Samples: VelocitySample[];
  lapSelectorSlot?: React.ReactNode;
  onSelectRefRun?: (runId: string) => void;
  onDeleteSession: () => void;
  onDeleteRun?: (runId: string) => void;
}

type MapLayerMode = 'laps' | 'speed' | 'accel';

function formatSectorSec(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--.--s';
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatAccumulatedSplit(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--.--s';
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
  return `${min}:${sec}`;
}

function formatIsolatedSplit(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--';
  return `+${(ms / 1000).toFixed(2)}s`;
}

function formatSignedSec(deltaSec: number | null): string {
  if (deltaSec === null || !Number.isFinite(deltaSec)) return '--';
  if (Math.abs(deltaSec) < 0.005) return '0.00s';
  return `${deltaSec > 0 ? '+' : ''}${deltaSec.toFixed(2)}s`;
}

function formatSignedKmh(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '--';
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : ''}${delta}`;
}

/**
 * Gera polígonos bicolores separados acima (positivo = verde) e abaixo (negativo = vermelho)
 * da linha central neutra (midY), interpolando cruzamentos em zero.
 */
function buildBicolorAreaPolygons(
  points: Array<{ x: number; val: number }>,
  yAtVal: (v: number) => number,
  midY: number
): { posPoly: string; negPoly: string; linePts: string } {
  if (points.length < 2) {
    return { posPoly: '', negPoly: '', linePts: '' };
  }

  const mapped = points.map((p) => ({
    x: p.x,
    y: yAtVal(p.val),
    val: p.val,
  }));

  const linePts = mapped.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const posCoords: string[] = [`${mapped[0].x.toFixed(1)},${midY.toFixed(1)}`];
  const negCoords: string[] = [`${mapped[0].x.toFixed(1)},${midY.toFixed(1)}`];

  for (let i = 0; i < mapped.length; i += 1) {
    const curr = mapped[i];
    if (i > 0) {
      const prev = mapped[i - 1];
      if ((prev.val > 0 && curr.val < 0) || (prev.val < 0 && curr.val > 0)) {
        const t = Math.abs(prev.val) / (Math.abs(prev.val) + Math.abs(curr.val));
        const crossX = (prev.x + (curr.x - prev.x) * t).toFixed(1);
        const midStr = midY.toFixed(1);
        posCoords.push(`${crossX},${midStr}`);
        negCoords.push(`${crossX},${midStr}`);
      }
    }

    const xStr = curr.x.toFixed(1);
    const yStr = curr.y.toFixed(1);
    const midStr = midY.toFixed(1);

    if (curr.val >= 0) {
      posCoords.push(`${xStr},${yStr}`);
      negCoords.push(`${xStr},${midStr}`);
    } else {
      posCoords.push(`${xStr},${midStr}`);
      negCoords.push(`${xStr},${yStr}`);
    }
  }

  const lastX = mapped[mapped.length - 1].x.toFixed(1);
  posCoords.push(`${lastX},${midY.toFixed(1)}`);
  negCoords.push(`${lastX},${midY.toFixed(1)}`);

  return {
    posPoly: posCoords.join(' '),
    negPoly: negCoords.join(' '),
    linePts,
  };
}

function sampleSeriesInWindow(
  rawSamples: VelocitySample[],
  startM: number,
  endM: number,
  steps = 120
): VelocitySample[] {
  const samples = ensureTraceGForces(rawSamples);
  if (samples.length < 2) return [];
  const maxM = samples[samples.length - 1].distKm * 1000;
  const clampedStart = Math.max(0, Math.min(startM, maxM));
  const clampedEnd = Math.max(clampedStart + 5, Math.min(endM, maxM));
  if (clampedEnd <= clampedStart) return [];

  const out: VelocitySample[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const distKm = (clampedStart + (i / steps) * (clampedEnd - clampedStart)) / 1000;
    const s = interpolateSampleAtDist(samples, distKm);
    if (s) out.push(s);
  }
  return out;
}

export const FuelTechAnalysisPanel: React.FC<FuelTechAnalysisPanelProps> = React.memo(({
  sessionTrack,
  sessionRuns,
  lap1,
  lap2,
  lap3,
  lap1Samples,
  lap2Samples,
  lap3Samples,
  lapSelectorSlot,
  onSelectRefRun,
  onDeleteSession,
  onDeleteRun,
}) => {
  const panel1Ref = useRef<SVGSVGElement | null>(null);
  const panelTimeSlipRef = useRef<SVGSVGElement | null>(null);
  const panel2Ref = useRef<SVGSVGElement | null>(null);
  const panel3Ref = useRef<SVGSVGElement | null>(null);
  const fsPanelRef = useRef<SVGSVGElement | null>(null);
  const fsTimeSlipRef = useRef<SVGSVGElement | null>(null);
  const isDraggingRef = useRef(false);

  const showLap2 = Boolean(lap2 && lap2Samples.length > 1 && lap2.id !== lap1?.id);
  const showLap3 = Boolean(
    lap3 && lap3Samples.length > 1 && lap3.id !== lap1?.id && lap3.id !== lap2?.id
  );

  const maxDist1 =
    lap1Samples.length > 0 ? lap1Samples[lap1Samples.length - 1].distKm * 1000 : 0;
  const maxDist2 =
    showLap2 && lap2Samples.length > 0
      ? lap2Samples[lap2Samples.length - 1].distKm * 1000
      : 0;
  const maxDist3 =
    showLap3 && lap3Samples.length > 0
      ? lap3Samples[lap3Samples.length - 1].distKm * 1000
      : 0;
  const maxDistM = Math.max(200, maxDist1, maxDist2, maxDist3);

  const [zoomSectorIdx, setZoomSectorIdx] = useState<number | null>(null);
  const [scrubDistM, setScrubDistM] = useState<number>(() => Math.round(maxDistM * 0.35));
  const [mapLayerMode, setMapLayerMode] = useState<MapLayerMode>('laps');
  const [showMapPeaks, setShowMapPeaks] = useState(false);
  const [showMapSplits, setShowMapSplits] = useState(false);
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);
  const [proFullscreen, setProFullscreen] = useState(false);
  const [proReplayPlaying, setProReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<0.25 | 0.5 | 1 | 2>(1);
  const [replayElapsedMs, setReplayElapsedMs] = useState<number | null>(null);
  const replaySpeedRef = useRef(replaySpeed);
  replaySpeedRef.current = replaySpeed;
  const replayElapsedRef = useRef<number | null>(null);
  replayElapsedRef.current = replayElapsedMs;
  const [fsMapStyleIdx, setFsMapStyleIdx] = useState(0);
  const fsMapStyleLabels = ['Satélite', 'Híbrido', 'Ruas'] as const;
  const [replayAutoFollow, setReplayAutoFollow] = useState(true);

  const lap1DurationMs =
    lap1Samples.length > 0
      ? Math.max(lap1?.totalMs || 0, lap1Samples[lap1Samples.length - 1].stageElapsedMs)
      : 0;
  const lap2DurationMs =
    showLap2 && lap2Samples.length > 0
      ? Math.max(lap2?.totalMs || 0, lap2Samples[lap2Samples.length - 1].stageElapsedMs)
      : 0;
  const lap3DurationMs =
    showLap3 && lap3Samples.length > 0
      ? Math.max(lap3?.totalMs || 0, lap3Samples[lap3Samples.length - 1].stageElapsedMs)
      : 0;
  const maxReplayElapsedMs = Math.max(200, lap1DurationMs, lap2DurationMs, lap3DurationMs);

  const activeSectorLaps = useMemo(() => {
    const list: Array<{ slot: 1 | 2 | 3; run: VelocityRun }> = [];
    if (lap1) list.push({ slot: 1, run: lap1 });
    if (showLap2 && lap2) list.push({ slot: 2, run: lap2 });
    if (showLap3 && lap3) list.push({ slot: 3, run: lap3 });
    return list;
  }, [lap1, lap2, lap3, showLap2, showLap3]);

  const sectorComparison = useMemo(
    () => computeMultiLapSectorComparison(sessionTrack, activeSectorLaps),
    [sessionTrack, activeSectorLaps]
  );

  // Active zoom window [viewStartM, viewEndM]
  const { viewStartM, viewEndM } = useMemo(() => {
    if (zoomSectorIdx !== null) {
      const target = sectorComparison.rows.find((r) => r.index === zoomSectorIdx);
      if (target && target.toDistM > target.fromDistM) {
        const span = target.toDistM - target.fromDistM;
        const pad = Math.max(15, Math.round(span * 0.04));
        return {
          viewStartM: Math.max(0, target.fromDistM - pad),
          viewEndM: Math.min(maxDistM, target.toDistM + pad),
        };
      }
    }
    return { viewStartM: 0, viewEndM: maxDistM };
  }, [zoomSectorIdx, sectorComparison.rows, maxDistM]);

  const viewSpanM = Math.max(20, viewEndM - viewStartM);

  useEffect(() => {
    setZoomSectorIdx(null);
    setProReplayPlaying(false);
    setReplayElapsedMs(null);
  }, [lap1?.id, lap2?.id, lap3?.id]);

  useEffect(() => {
    if (replayElapsedMs !== null) return;
    setScrubDistM((prev) => {
      if (prev < viewStartM || prev > viewEndM) {
        return Math.round((viewStartM + viewEndM) / 2);
      }
      return prev;
    });
  }, [viewStartM, viewEndM, replayElapsedMs]);

  useEffect(() => {
    if (!proFullscreen) return;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, [proFullscreen]);

  // Replay sincronizado pelo mesmo TEMPO REAL DECORRIDO (t em ms) com multiplicador 0.25x / 0.5x / 1x / 2x
  useEffect(() => {
    if (!proReplayPlaying) return;
    const startWindowMs =
      zoomSectorIdx !== null
        ? (interpolateSampleAtDist(lap1Samples, viewStartM / 1000)?.stageElapsedMs ?? 0)
        : 0;
    const endWindowMs =
      zoomSectorIdx !== null
        ? Math.max(
            startWindowMs + 200,
            interpolateSampleAtDist(lap1Samples, viewEndM / 1000)?.stageElapsedMs ??
              maxReplayElapsedMs
          )
        : maxReplayElapsedMs;

    let currentSimMs = replayElapsedRef.current ?? startWindowMs;
    if (currentSimMs < startWindowMs || currentSimMs >= endWindowMs) {
      currentSimMs = startWindowMs;
    }

    let lastPerfMs = performance.now();
    let rafId = 0;

    const tick = (nowPerfMs: number) => {
      const dtRealMs = Math.min(120, Math.max(0, nowPerfMs - lastPerfMs));
      lastPerfMs = nowPerfMs;
      currentSimMs = Math.min(endWindowMs, currentSimMs + dtRealMs * replaySpeedRef.current);
      setReplayElapsedMs(currentSimMs);
      const v1AtT = interpolateSampleAtElapsedMs(lap1Samples, currentSimMs);
      if (v1AtT) {
        setScrubDistM(Math.round(v1AtT.distKm * 1000));
      }
      if (currentSimMs >= endWindowMs) {
        setProReplayPlaying(false);
        return;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    proReplayPlaying,
    zoomSectorIdx,
    viewStartM,
    viewEndM,
    maxReplayElapsedMs,
    lap1Samples,
  ]);

  // Matriz completa de voltas & parciais (Referência selecionável pelo piloto ou Melhor Volta)
  const raceChronoMatrix = useMemo(() => {
    const orderedRuns = [...sessionRuns].sort((a, b) => a.runNumber - b.runNumber);
    const sectors = buildTrackSectors(sessionTrack, orderedRuns);
    const validRuns = orderedRuns.filter((r) => r.totalMs > 0);
    const bestRun =
      validRuns.length > 0
        ? [...validRuns].sort((a, b) => a.totalMs - b.totalMs)[0]
        : orderedRuns.length > 0
          ? [...orderedRuns].sort((a, b) => a.totalMs - b.totalMs)[0]
          : null;

    const refRun =
      (lap1 ? orderedRuns.find((r) => r.id === lap1.id) : null) ?? bestRun;

    const perRunMetrics = orderedRuns.map((run) => {
      const metrics = computeRunSectorMetrics(run, sectors);
      let runningCumMs = 0;
      let cumValid = true;
      const cumulativeMsList: Array<number | null> = metrics.map((m, secIdx) => {
        const sec = sectors[secIdx];
        if (sec?.isTrapBased && sec.toTrapId) {
          const isLast = secIdx === sectors.length - 1;
          const trapTime = isLast
            ? run.splitTimesMs[sec.toTrapId] ?? (run.totalMs > 0 ? run.totalMs : null)
            : typeof run.splitTimesMs[sec.toTrapId] === 'number'
              ? run.splitTimesMs[sec.toTrapId]
              : null;
          if (typeof trapTime === 'number' && trapTime > 0) {
            runningCumMs = trapTime;
            return trapTime;
          }
        }
        if (cumValid && typeof m.durationMs === 'number' && m.durationMs > 0) {
          runningCumMs += m.durationMs;
          return runningCumMs;
        }
        cumValid = false;
        return null;
      });
      return {
        run,
        metrics,
        cumulativeMsList,
      };
    });

    const bestRunMetrics =
      bestRun
        ? perRunMetrics.find((item) => item.run.id === bestRun.id)?.metrics ?? []
        : [];
    const refRunEntry = refRun
      ? perRunMetrics.find((item) => item.run.id === refRun.id) ?? null
      : null;
    const refRunMetrics = refRunEntry?.metrics ?? [];
    const refCumulativeMsList = refRunEntry?.cumulativeMsList ?? [];

    const bestSectorMsList: Array<number | null> = sectors.map((_, secIdx) => {
      let best: number | null = null;
      for (const item of perRunMetrics) {
        const d = item.metrics[secIdx]?.durationMs;
        if (typeof d === 'number' && d > 0 && (best === null || d < best)) {
          best = d;
        }
      }
      return best;
    });

    const bestCumulativeMsList: Array<number | null> = sectors.map((_, secIdx) => {
      let best: number | null = null;
      for (const item of perRunMetrics) {
        const c = item.cumulativeMsList[secIdx];
        if (typeof c === 'number' && c > 0 && (best === null || c < best)) {
          best = c;
        }
      }
      return best;
    });

    const hasCompleteTheoretical =
      bestSectorMsList.length > 0 &&
      bestSectorMsList.every((ms): ms is number => typeof ms === 'number' && ms > 0);
    const theoreticalBestMs = hasCompleteTheoretical
      ? bestSectorMsList.reduce((acc, ms) => acc + ms, 0)
      : bestRun?.totalMs ?? null;
    const potentialGainSec =
      theoreticalBestMs !== null && bestRun && bestRun.totalMs > 0
        ? Number(((theoreticalBestMs - bestRun.totalMs) / 1000).toFixed(2))
        : null;

    let consistencyPct: number | null = null;
    if (validRuns.length === 1) {
      consistencyPct = 100;
    } else if (validRuns.length >= 2) {
      const mean = validRuns.reduce((sum, r) => sum + r.totalMs, 0) / validRuns.length;
      if (mean > 0) {
        const variance =
          validRuns.reduce((sum, r) => sum + (r.totalMs - mean) ** 2, 0) / validRuns.length;
        const stdDev = Math.sqrt(variance);
        consistencyPct = Math.max(0, Math.min(100, Math.round((1 - stdDev / mean) * 100)));
      }
    }

    return {
      sectors,
      orderedRuns: perRunMetrics,
      bestRun,
      refRun,
      bestRunMetrics,
      refRunMetrics,
      refCumulativeMsList,
      bestSectorMsList,
      bestCumulativeMsList,
      theoreticalBestMs,
      potentialGainSec,
      consistencyPct,
    };
  }, [sessionRuns, sessionTrack, lap1]);

  const jumpToSectorStart = (fromDistKm: number) => {
    const targetM = Math.max(0, Math.min(Math.round(maxDistM), Math.round(fromDistKm * 1000)));
    setProReplayPlaying(false);
    setReplayElapsedMs(null);
    setZoomSectorIdx(null);
    setScrubDistM(targetM);
  };

  // Resample traces cleanly across the active zoom window [viewStartM, viewEndM]
  const winSamples1 = useMemo(
    () => sampleSeriesInWindow(lap1Samples, viewStartM, viewEndM, 130),
    [lap1Samples, viewStartM, viewEndM]
  );
  const winSamples2 = useMemo(
    () => (showLap2 ? sampleSeriesInWindow(lap2Samples, viewStartM, viewEndM, 130) : []),
    [showLap2, lap2Samples, viewStartM, viewEndM]
  );
  const winSamples3 = useMemo(
    () => (showLap3 ? sampleSeriesInWindow(lap3Samples, viewStartM, viewEndM, 130) : []),
    [showLap3, lap3Samples, viewStartM, viewEndM]
  );

  // Critical points inside active zoom window (TOP = Peak Straight, MIN = Corner Apex)
  const criticalMarkers = useMemo(() => {
    const rawPts = detectTelemetryCriticalPoints(lap1Samples);
    const inView = rawPts
      .filter((p) => (p.type === 'TOP' || p.type === 'APEX') && p.distM >= viewStartM && p.distM <= viewEndM)
      .map((p) => ({
        ...p,
        badge: p.type === 'TOP' ? ('TOP' as const) : ('MIN' as const),
      }));

    // Ensure at least local TOP and MIN when zoomed into a partial
    if (zoomSectorIdx !== null && winSamples1.length >= 4) {
      let localMax = winSamples1[0];
      let localMin = winSamples1[0];
      for (const s of winSamples1) {
        if (s.speedKmh > localMax.speedKmh) localMax = s;
        if (s.speedKmh < localMin.speedKmh) localMin = s;
      }
      if (!inView.some((p) => p.badge === 'TOP') && localMax.speedKmh >= 20) {
        inView.push({
          type: 'TOP',
          badge: 'TOP',
          distM: Math.round(localMax.distKm * 1000),
          speedKmh: Math.round(localMax.speedKmh),
          longG: Number((localMax.accelLongG ?? 0).toFixed(2)),
        });
      }
      if (
        !inView.some((p) => p.badge === 'MIN') &&
        localMax.speedKmh - localMin.speedKmh >= 10
      ) {
        inView.push({
          type: 'APEX',
          badge: 'MIN',
          distM: Math.round(localMin.distKm * 1000),
          speedKmh: Math.round(localMin.speedKmh),
          longG: Number((localMin.accelLongG ?? 0).toFixed(2)),
        });
      }
    }

    return inView;
  }, [lap1Samples, viewStartM, viewEndM, zoomSectorIdx, winSamples1]);

  // Shared SVG geometry for all 3 synchronized AiM/MoTeC panels
  const chartW = 640;
  const padL = 44;
  const padR = 14;
  const plotW = chartW - padL - padR;

  // Panel 1: Speed (km/h) + Accel/Brake zones
  const p1H = 180;
  const p1Top = 20;
  const p1PlotH = 132;
  const p1Bottom = p1Top + p1PlotH;
  const zoneStripY = p1Bottom + 4;
  const zoneStripH = 7;

  // Panel Time Slip (ΔT contínuo em segundos vs REF)
  const pTsH = 124;
  const pTsTop = 16;
  const pTsPlotH = 86;
  const pTsMidY = pTsTop + pTsPlotH / 2;
  const pTsBottom = pTsTop + pTsPlotH;

  // Panel 2: Virtual Pedal (+G Accel / -G Brake)
  const p2H = 130;
  const p2Top = 16;
  const p2PlotH = 92;
  const p2MidY = p2Top + p2PlotH / 2;
  const p2Bottom = p2Top + p2PlotH;

  // Panel 3: Lateral G
  const p3H = 132;
  const p3Top = 16;
  const p3PlotH = 88;
  const p3MidY = p3Top + p3PlotH / 2;
  const p3Bottom = p3Top + p3PlotH;

  const maxSpd = useMemo(() => {
    const peak = Math.max(
      90,
      ...winSamples1.map((s) => s.speedKmh || 0),
      ...winSamples2.map((s) => s.speedKmh || 0),
      ...winSamples3.map((s) => s.speedKmh || 0)
    );
    return Math.ceil(peak / 20) * 20;
  }, [winSamples1, winSamples2, winSamples3]);

  const maxLongGScale = useMemo(() => {
    const peakG = Math.max(
      0.8,
      ...winSamples1.map((s) => Math.abs(s.accelLongG ?? 0)),
      ...winSamples2.map((s) => Math.abs(s.accelLongG ?? 0)),
      ...winSamples3.map((s) => Math.abs(s.accelLongG ?? 0))
    );
    return Math.min(2.5, Math.ceil(peakG * 2) / 2);
  }, [winSamples1, winSamples2, winSamples3]);

  const maxLatGScale = useMemo(() => {
    const peakG = Math.max(
      0.8,
      ...winSamples1.map((s) => Math.abs(s.accelLatG ?? 0)),
      ...winSamples2.map((s) => Math.abs(s.accelLatG ?? 0)),
      ...winSamples3.map((s) => Math.abs(s.accelLatG ?? 0))
    );
    return Math.min(2.5, Math.ceil(peakG * 2) / 2);
  }, [winSamples1, winSamples2, winSamples3]);

  const xAtM = (distM: number) =>
    padL + Math.max(0, Math.min(1, (distM - viewStartM) / viewSpanM)) * plotW;

  const yAtKmh = (kmh: number) =>
    p1Top + p1PlotH - Math.max(0, Math.min(1, kmh / maxSpd)) * p1PlotH;

  const yAtLongG = (gVal: number) => {
    const clamped = Math.max(-maxLongGScale, Math.min(maxLongGScale, gVal));
    return p2MidY - (clamped / maxLongGScale) * (p2PlotH / 2);
  };

  const yAtLatG = (gVal: number) => {
    const clamped = Math.max(-maxLatGScale, Math.min(maxLatGScale, gVal));
    return p3MidY - (clamped / maxLatGScale) * (p3PlotH / 2);
  };

  // Panel 1: V1 has translucent area + solid 2.5px line; V2 solid red 2px; V3 dashed cyan 1.8px
  const { speedLine1, speedArea1 } = useMemo(() => {
    if (winSamples1.length < 2) return { speedLine1: '', speedArea1: '' };
    const pts = winSamples1.map(
      (s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`
    );
    const firstX = xAtM(winSamples1[0].distKm * 1000).toFixed(1);
    const lastX = xAtM(winSamples1[winSamples1.length - 1].distKm * 1000).toFixed(1);
    const baseStr = p1Bottom.toFixed(1);
    return {
      speedLine1: pts.join(' '),
      speedArea1: `${firstX},${baseStr} ${pts.join(' ')} ${lastX},${baseStr}`,
    };
  }, [winSamples1, viewStartM, viewEndM, maxSpd]);

  const speedLine2 = useMemo(
    () =>
      winSamples2
        .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [winSamples2, viewStartM, viewEndM, maxSpd]
  );

  const speedLine3 = useMemo(
    () =>
      winSamples3
        .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [winSamples3, viewStartM, viewEndM, maxSpd]
  );

  // V1 throttle/brake zone segments along bottom of Panel 1
  const v1ZoneSegments = useMemo(() => {
    if (winSamples1.length < 2) return [];
    const segs: Array<{ x1: number; x2: number; kind: 'accel' | 'brake' }> = [];
    for (let i = 0; i < winSamples1.length - 1; i += 1) {
      const s = winSamples1[i];
      const next = winSamples1[i + 1];
      const g = s.accelLongG ?? 0;
      if (g > 0.08 || g < -0.15) {
        segs.push({
          x1: xAtM(s.distKm * 1000),
          x2: xAtM(next.distKm * 1000),
          kind: g > 0.08 ? 'accel' : 'brake',
        });
      }
    }
    return segs;
  }, [winSamples1, viewStartM, viewEndM]);

  // Panel 2: Virtual Pedal (+G Green / -G Red)
  const pedal1 = useMemo(
    () =>
      buildBicolorAreaPolygons(
        winSamples1.map((s) => ({ x: xAtM(s.distKm * 1000), val: s.accelLongG ?? 0 })),
        yAtLongG,
        p2MidY
      ),
    [winSamples1, viewStartM, viewEndM, maxLongGScale]
  );

  const pedalLine2 = useMemo(
    () =>
      winSamples2
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [winSamples2, viewStartM, viewEndM, maxLongGScale]
  );

  const pedalLine3 = useMemo(
    () =>
      winSamples3
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [winSamples3, viewStartM, viewEndM, maxLongGScale]
  );

  // Time Slip / Delta de Tempo Contínuo (ΔT em segundos): negativo = mais rápido que REF (verde), positivo = mais lento (vermelho)
  const timeSlip2Pts = useMemo(() => {
    if (!showLap2 || winSamples1.length < 2 || winSamples2.length < 2) return [];
    const commonMaxM = Math.min(maxDist1, maxDist2);
    const pts: Array<{ distM: number; deltaSec: number }> = [];
    const len = Math.min(winSamples1.length, winSamples2.length);
    for (let i = 0; i < len; i += 1) {
      const s1 = winSamples1[i];
      const s2 = winSamples2[i];
      const dM = s1.distKm * 1000;
      if (dM > commonMaxM + 5) break;
      pts.push({
        distM: dM,
        deltaSec: Number(((s2.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(3)),
      });
    }
    return pts;
  }, [showLap2, winSamples1, winSamples2, maxDist1, maxDist2]);

  const timeSlip3Pts = useMemo(() => {
    if (!showLap3 || winSamples1.length < 2 || winSamples3.length < 2) return [];
    const commonMaxM = Math.min(maxDist1, maxDist3);
    const pts: Array<{ distM: number; deltaSec: number }> = [];
    const len = Math.min(winSamples1.length, winSamples3.length);
    for (let i = 0; i < len; i += 1) {
      const s1 = winSamples1[i];
      const s3 = winSamples3[i];
      const dM = s1.distKm * 1000;
      if (dM > commonMaxM + 5) break;
      pts.push({
        distM: dM,
        deltaSec: Number(((s3.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(3)),
      });
    }
    return pts;
  }, [showLap3, winSamples1, winSamples3, maxDist1, maxDist3]);

  const primaryTimeSlipPts = showLap2 ? timeSlip2Pts : timeSlip3Pts;
  const maxTimeSlipScaleSec = useMemo(() => {
    const peak = Math.max(
      0.5,
      ...timeSlip2Pts.map((p) => Math.abs(p.deltaSec)),
      ...timeSlip3Pts.map((p) => Math.abs(p.deltaSec))
    );
    return Math.min(15, Math.ceil(peak * 2) / 2);
  }, [timeSlip2Pts, timeSlip3Pts]);

  // Convenção visual RaceChrono/Racemator: mais rápido (-ΔT) sobe acima da linha 0.00s (verde), mais lento (+ΔT) desce abaixo (vermelho)
  const yAtTimeSlip = (deltaSec: number) => {
    const clamped = Math.max(-maxTimeSlipScaleSec, Math.min(maxTimeSlipScaleSec, -deltaSec));
    return pTsMidY - (clamped / maxTimeSlipScaleSec) * (pTsPlotH / 2);
  };

  const primaryTimeSlipPolys = useMemo(
    () =>
      buildBicolorAreaPolygons(
        primaryTimeSlipPts.map((p) => ({ x: xAtM(p.distM), val: -p.deltaSec })),
        (gainVal) => yAtTimeSlip(-gainVal),
        pTsMidY
      ),
    [primaryTimeSlipPts, viewStartM, viewEndM, maxTimeSlipScaleSec]
  );

  const timeSlipLine3 = useMemo(() => {
    if (!showLap2 || timeSlip3Pts.length < 2) return '';
    return timeSlip3Pts
      .map((p) => `${xAtM(p.distM).toFixed(1)},${yAtTimeSlip(p.deltaSec).toFixed(1)}`)
      .join(' ');
  }, [showLap2, timeSlip3Pts, viewStartM, viewEndM, maxTimeSlipScaleSec]);

  // Panel 3: Lateral G
  const { latLine1, latArea1 } = useMemo(() => {
    if (winSamples1.length < 2) return { latLine1: '', latArea1: '' };
    const pts = winSamples1.map(
      (s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLatG(s.accelLatG ?? 0).toFixed(1)}`
    );
    const firstX = xAtM(winSamples1[0].distKm * 1000).toFixed(1);
    const lastX = xAtM(winSamples1[winSamples1.length - 1].distKm * 1000).toFixed(1);
    const midStr = p3MidY.toFixed(1);
    return {
      latLine1: pts.join(' '),
      latArea1: `${firstX},${midStr} ${pts.join(' ')} ${lastX},${midStr}`,
    };
  }, [winSamples1, viewStartM, viewEndM, maxLatGScale]);

  const latLine2 = useMemo(
    () =>
      winSamples2
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLatG(s.accelLatG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [winSamples2, viewStartM, viewEndM, maxLatGScale]
  );

  const latLine3 = useMemo(
    () =>
      winSamples3
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLatG(s.accelLatG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [winSamples3, viewStartM, viewEndM, maxLatGScale]
  );

  // Cursor telemetry summary (Time-synchronized during Replay; Distance-aligned during manual scrub)
  const scrubPoint = useMemo(() => {
    const isTimeReplay = replayElapsedMs !== null;
    const s1 = isTimeReplay
      ? interpolateSampleAtElapsedMs(lap1Samples, replayElapsedMs)
      : interpolateSampleAtDist(lap1Samples, scrubDistM / 1000);
    const activeDistM = isTimeReplay && s1 ? Math.round(s1.distKm * 1000) : Math.round(scrubDistM);
    const activeDistKm = activeDistM / 1000;

    const s2 = showLap2
      ? isTimeReplay
        ? interpolateSampleAtElapsedMs(lap2Samples, replayElapsedMs)
        : interpolateSampleAtDist(lap2Samples, activeDistKm)
      : null;
    const s3 = showLap3
      ? isTimeReplay
        ? interpolateSampleAtElapsedMs(lap3Samples, replayElapsedMs)
        : interpolateSampleAtDist(lap3Samples, activeDistKm)
      : null;

    const s2AtDist = showLap2 ? interpolateSampleAtDist(lap2Samples, activeDistKm) : null;
    const s3AtDist = showLap3 ? interpolateSampleAtDist(lap3Samples, activeDistKm) : null;

    const speed1 = s1 ? Math.round(s1.speedKmh) : null;
    const speed2 = s2 ? Math.round(s2.speedKmh) : null;
    const speed3 = s3 ? Math.round(s3.speedKmh) : null;

    const speedDelta2vs1 =
      speed2 !== null && speed1 !== null ? speed2 - speed1 : null;
    const speedDelta3vs1 =
      speed3 !== null && speed1 !== null ? speed3 - speed1 : null;

    const longG1 = s1 && typeof s1.accelLongG === 'number' ? s1.accelLongG : 0;
    const longG2 = s2 && typeof s2.accelLongG === 'number' ? s2.accelLongG : 0;
    const longG3 = s3 && typeof s3.accelLongG === 'number' ? s3.accelLongG : 0;

    const latG1 = s1 && typeof s1.accelLatG === 'number' ? s1.accelLatG : 0;
    const latG2 = s2 && typeof s2.accelLatG === 'number' ? s2.accelLatG : 0;
    const latG3 = s3 && typeof s3.accelLatG === 'number' ? s3.accelLatG : 0;

    const timeDelta2vs1Sec =
      s2AtDist && s1
        ? Number(((s2AtDist.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(2))
        : null;
    const timeDelta3vs1Sec =
      s3AtDist && s1
        ? Number(((s3AtDist.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(2))
        : null;

    return {
      distM: activeDistM,
      distKmStr: (activeDistM / 1000).toFixed(3),
      s1,
      s2,
      s3,
      speed1,
      speed2,
      speed3,
      speedDelta2vs1,
      speedDelta3vs1,
      timeDelta2vs1Sec,
      timeDelta3vs1Sec,
      longG1,
      longG2,
      longG3,
      latG1,
      latG2,
      latG3,
    };
  }, [replayElapsedMs, scrubDistM, lap1Samples, lap2Samples, lap3Samples, showLap2, showLap3]);

  const scrubByManualDist = (targetM: number) => {
    setProReplayPlaying(false);
    setReplayElapsedMs(null);
    setScrubDistM(Math.max(Math.round(viewStartM), Math.min(Math.round(viewEndM), Math.round(targetM))));
  };

  const handleToggleReplay = () => {
    if (proReplayPlaying) {
      setProReplayPlaying(false);
      return;
    }
    const startWindowMs =
      zoomSectorIdx !== null
        ? (interpolateSampleAtDist(lap1Samples, viewStartM / 1000)?.stageElapsedMs ?? 0)
        : 0;
    const endWindowMs =
      zoomSectorIdx !== null
        ? Math.max(
            startWindowMs + 200,
            interpolateSampleAtDist(lap1Samples, viewEndM / 1000)?.stageElapsedMs ??
              maxReplayElapsedMs
          )
        : maxReplayElapsedMs;
    const currentElapsed =
      replayElapsedMs !== null
        ? replayElapsedMs
        : (interpolateSampleAtDist(lap1Samples, scrubDistM / 1000)?.stageElapsedMs ??
          startWindowMs);
    if (currentElapsed >= endWindowMs - 80 || currentElapsed < startWindowMs) {
      setReplayElapsedMs(startWindowMs);
      const v1Start = interpolateSampleAtElapsedMs(lap1Samples, startWindowMs);
      if (v1Start) setScrubDistM(Math.round(v1Start.distKm * 1000));
    } else {
      setReplayElapsedMs(currentElapsed);
    }
    setProReplayPlaying(true);
  };

  const updateScrubFromSvg = (svg: SVGSVGElement | null, clientX: number) => {
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chartW;
    const ratio = Math.max(0, Math.min(1, (svgX - padL) / plotW));
    scrubByManualDist(viewStartM + ratio * viewSpanM);
  };

  const yTicksKmh = [maxSpd, Math.round(maxSpd * 0.5), 0];
  const xTicksM = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(viewStartM + viewSpanM * f));
  const scrubX = xAtM(scrubPoint.distM);

  const visibleSectorDividers = useMemo(
    () =>
      sectorComparison.sectors
        .map((sec) => ({
          shortLabel: sec.shortLabel,
          toM: Math.round(sec.toDistKm * 1000),
          midM: Math.round(((sec.fromDistKm + sec.toDistKm) / 2) * 1000),
        }))
        .filter((s) => s.toM > viewStartM && s.toM < viewEndM),
    [sectorComparison.sectors, viewStartM, viewEndM]
  );

  const renderReplayControlBar = (isFullscreenBar: boolean) => (
    <div
      className={
        isFullscreenBar
          ? 'space-y-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5'
          : 'space-y-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5'
      }
    >
      <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
        <Crosshair className="h-3.5 w-3.5 shrink-0 text-[var(--ps-amber)]" />
        <input
          type="range"
          aria-label="Posição da distância na volta"
          min={Math.round(viewStartM)}
          max={Math.round(viewEndM)}
          value={Math.max(Math.round(viewStartM), Math.min(Math.round(viewEndM), scrubPoint.distM))}
          onChange={(e) => scrubByManualDist(Number(e.target.value))}
          className="h-2 w-full accent-[var(--ps-emerald)]"
        />
        <span className="shrink-0 font-extrabold text-[var(--ps-text)]">
          {scrubPoint.distKmStr} km · {scrubPoint.distM}m
        </span>
        {scrubPoint.speed1 !== null && (
          <span className="shrink-0 rounded bg-[#EF233C]/20 border border-[#EF233C]/40 px-1.5 py-0.5 text-[11px] font-black text-white">
            {scrubPoint.speed1} km/h
          </span>
        )}
        {replayElapsedMs !== null && (
          <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-black text-[var(--ps-emerald)]">
            t {(replayElapsedMs / 1000).toFixed(2)}s
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] font-extrabold">
        <button
          type="button"
          onClick={handleToggleReplay}
          className="pitstop-btn-red flex min-h-[36px] min-w-[96px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 font-black active:scale-95"
        >
          {proReplayPlaying ? (
            <>
              <Pause className="h-3.5 w-3.5 shrink-0" />
              <span>Pausar</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 shrink-0 fill-current" />
              <span>Replay</span>
            </>
          )}
        </button>

        <div
          className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-0.5"
          role="group"
          aria-label="Velocidade de reprodução do replay"
        >
          {([0.25, 0.5, 1, 2] as const).map((spd) => {
            const activeSpd = replaySpeed === spd;
            return (
              <button
                key={`spd_${spd}`}
                type="button"
                onClick={() => setReplaySpeed(spd)}
                className={`min-h-[30px] rounded-md px-2 text-[10px] font-black transition-colors active:scale-95 ${
                  activeSpd
                    ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                {spd}x
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1 font-mono text-[11px] font-extrabold">
        <button
          type="button"
          onClick={() => scrubByManualDist(scrubPoint.distM - 50)}
          className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] hover:border-[var(--ps-accent)] active:scale-95"
        >
          -50m
        </button>
        <button
          type="button"
          onClick={() => scrubByManualDist(scrubPoint.distM - 10)}
          className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] hover:border-[var(--ps-accent)] active:scale-95"
        >
          -10m
        </button>
        <button
          type="button"
          onClick={() => scrubByManualDist(scrubPoint.distM + 10)}
          className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] hover:border-[var(--ps-accent)] active:scale-95"
        >
          +10m
        </button>
        <button
          type="button"
          onClick={() => scrubByManualDist(scrubPoint.distM + 50)}
          className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] hover:border-[var(--ps-accent)] active:scale-95"
        >
          +50m
        </button>
      </div>
    </div>
  );

  const renderSectorZoomButtons = () => {
    if (sectorComparison.rows.length === 0) return null;
    return (
      <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
          <ZoomIn className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
          <span>Zoom:</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setProReplayPlaying(false);
            setReplayElapsedMs(null);
            setZoomSectorIdx(null);
          }}
          className={`shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-extrabold uppercase transition-colors ${
            zoomSectorIdx === null
              ? 'border-[var(--ps-emerald)] bg-emerald-500/15 text-[var(--ps-emerald)]'
              : 'border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
          }`}
        >
          Pista Inteira
        </button>
        {sectorComparison.rows.map((row) => (
          <button
            key={`zoom_btn_${row.index}`}
            type="button"
            onClick={() => {
              setProReplayPlaying(false);
              setReplayElapsedMs(null);
              setZoomSectorIdx(row.index);
            }}
            className={`shrink-0 rounded-lg border px-2.5 py-1 font-mono text-[10px] font-extrabold uppercase transition-colors ${
              zoomSectorIdx === row.index
                ? 'border-[var(--ps-amber)] bg-amber-500/15 text-[var(--ps-amber)]'
                : 'border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
            }`}
          >
            Parcial {row.index} (P{row.index})
          </button>
        ))}
      </div>
    );
  };

  const cornerAnalysis = useMemo(() => {
    const laps: Array<{ slot: 1 | 2 | 3; runNumber: number; samples: VelocitySample[] }> = [];
    if (lap1 && lap1Samples.length >= 6) {
      laps.push({ slot: 1, runNumber: lap1.runNumber, samples: lap1Samples });
    }
    if (showLap2 && lap2 && lap2Samples.length >= 6) {
      laps.push({ slot: 2, runNumber: lap2.runNumber, samples: lap2Samples });
    }
    if (showLap3 && lap3 && lap3Samples.length >= 6) {
      laps.push({ slot: 3, runNumber: lap3.runNumber, samples: lap3Samples });
    }
    if (laps.length === 0) return [];
    return analyzeTrackCornersAndBraking(laps);
  }, [lap1, lap1Samples, showLap2, lap2, lap2Samples, showLap3, lap3, lap3Samples]);

  const improvementDiagnostic = useMemo(() => {
    if (sectorComparison.rows.length === 0) return null;

    let worstLoss: {
      slot: 2 | 3;
      sectorIndex: number;
      timeDeltaSec: number;
      avgSpeedDeltaKmh: number | null;
      maxSpeedDeltaKmh: number | null;
      minSpeedDeltaKmh: number | null;
    } | null = null;

    let bestGain: {
      slot: 2 | 3;
      sectorIndex: number;
      timeDeltaSec: number;
    } | null = null;

    for (const row of sectorComparison.rows) {
      for (const entry of row.entries) {
        if (entry.slot === 1 || entry.timeDeltaSec === null) continue;
        const cmpSlot = entry.slot as 2 | 3;
        if (entry.timeDeltaSec > 0) {
          if (!worstLoss || entry.timeDeltaSec > worstLoss.timeDeltaSec) {
            worstLoss = {
              slot: cmpSlot,
              sectorIndex: row.index,
              timeDeltaSec: entry.timeDeltaSec,
              avgSpeedDeltaKmh: entry.avgSpeedDeltaKmh,
              maxSpeedDeltaKmh: entry.maxSpeedDeltaKmh,
              minSpeedDeltaKmh: entry.minSpeedDeltaKmh,
            };
          }
        } else if (entry.timeDeltaSec < 0) {
          if (!bestGain || entry.timeDeltaSec < bestGain.timeDeltaSec) {
            bestGain = {
              slot: cmpSlot,
              sectorIndex: row.index,
              timeDeltaSec: entry.timeDeltaSec,
            };
          }
        }
      }
    }

    let worstCornerTip: {
      cornerIndex: number;
      refApexDistM: number;
      slot: 2 | 3;
      metricLabel: 'mínima' | 'saída';
      speedDropKmh: number;
    } | null = null;

    for (const corner of cornerAnalysis) {
      for (const e of corner.entries) {
        if (e.slot === 1) continue;
        const cmpSlot = e.slot as 2 | 3;
        if (e.deltaExitKmh !== null && e.deltaExitKmh < 0) {
          const drop = Math.abs(e.deltaExitKmh);
          if (!worstCornerTip || drop > worstCornerTip.speedDropKmh) {
            worstCornerTip = {
              cornerIndex: corner.cornerIndex,
              refApexDistM: corner.refApexDistM,
              slot: cmpSlot,
              metricLabel: 'saída',
              speedDropKmh: drop,
            };
          }
        }
        if (e.deltaApexKmh !== null && e.deltaApexKmh < 0) {
          const drop = Math.abs(e.deltaApexKmh);
          if (!worstCornerTip || drop > worstCornerTip.speedDropKmh) {
            worstCornerTip = {
              cornerIndex: corner.cornerIndex,
              refApexDistM: corner.refApexDistM,
              slot: cmpSlot,
              metricLabel: 'mínima',
              speedDropKmh: drop,
            };
          }
        }
      }
    }

    if (worstLoss) {
      const speedReason =
        worstLoss.avgSpeedDeltaKmh !== null && worstLoss.avgSpeedDeltaKmh < 0
          ? `Velocidade média ${Math.abs(worstLoss.avgSpeedDeltaKmh)} km/h abaixo da VOLTA 1`
          : worstLoss.maxSpeedDeltaKmh !== null && worstLoss.maxSpeedDeltaKmh < 0
            ? `Velocidade máxima ${Math.abs(worstLoss.maxSpeedDeltaKmh)} km/h abaixo da VOLTA 1`
            : worstLoss.minSpeedDeltaKmh !== null && worstLoss.minSpeedDeltaKmh < 0
              ? `Velocidade mínima ${Math.abs(worstLoss.minSpeedDeltaKmh)} km/h abaixo da VOLTA 1`
              : 'Retomada/traçado mais lento que a VOLTA 1';

      return {
        tone: 'loss' as const,
        sectorIndex: worstLoss.sectorIndex,
        slot: worstLoss.slot,
        headline: `Maior perda na VOLTA ${worstLoss.slot} no Setor ${worstLoss.sectorIndex} (+${worstLoss.timeDeltaSec.toFixed(2)}s) · ${speedReason}`,
        subtip: worstCornerTip
          ? `Curva ${worstCornerTip.cornerIndex} (${worstCornerTip.refApexDistM}m): velocidade de ${worstCornerTip.metricLabel} ${worstCornerTip.speedDropKmh} km/h abaixo da VOLTA 1.`
          : null,
        jumpDistM: worstCornerTip?.refApexDistM ?? null,
      };
    }

    if (bestGain) {
      return {
        tone: 'gain' as const,
        sectorIndex: bestGain.sectorIndex,
        slot: bestGain.slot,
        headline: `VOLTA ${bestGain.slot} mais rápida que a VOLTA 1 · Maior ganho no Setor ${bestGain.sectorIndex} (${bestGain.timeDeltaSec.toFixed(2)}s)`,
        subtip: worstCornerTip
          ? `Ajuste fino na Curva ${worstCornerTip.cornerIndex} (${worstCornerTip.refApexDistM}m): ${worstCornerTip.metricLabel} ${worstCornerTip.speedDropKmh} km/h abaixo da VOLTA 1.`
          : 'Manteve ritmo superior em todos os setores comparados.',
        jumpDistM: worstCornerTip?.refApexDistM ?? null,
      };
    }

    let slowestSec = sectorComparison.rows[0];
    for (const row of sectorComparison.rows) {
      const currAvg = row.entries[0]?.metrics.avgSpeedKmh ?? Infinity;
      const slowAvg = slowestSec?.entries[0]?.metrics.avgSpeedKmh ?? Infinity;
      if (currAvg < slowAvg) slowestSec = row;
    }
    const v1Avg = slowestSec?.entries[0]?.metrics.avgSpeedKmh ?? null;
    return {
      tone: 'neutral' as const,
      sectorIndex: slowestSec?.index ?? null,
      slot: 1 as const,
      headline:
        slowestSec && v1Avg !== null
          ? `Setor mais técnico na VOLTA 1: Setor ${slowestSec.index} (média ${v1Avg} km/h) · Selecione VOLTA 2 ou VOLTA 3 para ver onde ganhar tempo.`
          : 'Selecione VOLTA 2 ou VOLTA 3 para identificar onde ganhar tempo por setor.',
      subtip: null,
      jumpDistM: null,
    };
  }, [sectorComparison.rows, cornerAnalysis]);

  const lapSlotColorClass = (slot: 1 | 2 | 3) =>
    slot === 1
      ? 'text-[var(--ps-emerald)]'
      : slot === 2
        ? 'text-[#FF2A2A]'
        : 'text-[#38BDF8]';

  const lapSlotBorderLeftClass = (slot: 1 | 2 | 3) =>
    slot === 1
      ? 'border-l-2 border-l-[#10B981]'
      : slot === 2
        ? 'border-l-2 border-l-[#FF2A2A]'
        : 'border-l-2 border-l-[#38BDF8]';

  const renderSectorComparisonCards = (compact: boolean) => {
    if (sectorComparison.rows.length === 0) return null;
    return (
      <div
        className={`rounded-xl border border-[var(--ps-border)] ${
          compact ? 'bg-[var(--ps-surface)] p-2' : 'bg-[var(--ps-card-deep)] p-2.5'
        } space-y-2 font-mono tabular-nums`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-extrabold tracking-wider text-[var(--ps-muted)] uppercase">
            Comparativo por Setores (S1..S{sectorComparison.rows.length})
          </span>
          <span className="text-[9px] font-bold text-[var(--ps-muted)]">
            <strong className="text-[var(--ps-emerald)]">Verde = Mais rápido</strong> ·{' '}
            <strong className="text-[#FF2A2A]">Vermelho = Mais lento</strong>
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {sectorComparison.rows.map((row) => {
            const fastestDurationMs = row.entries.reduce<number | null>((min, entry) => {
              const d = entry.metrics.durationMs;
              if (d === null || d <= 0) return min;
              return min === null ? d : Math.min(min, d);
            }, null);

            return (
              <button
                key={`sec_cmp_${row.index}`}
                type="button"
                onClick={() => {
                  setProReplayPlaying(false);
                  setReplayElapsedMs(null);
                  setZoomSectorIdx((prev) => (prev === row.index ? null : row.index));
                }}
                className={`rounded-lg border p-2 text-left transition-colors ${
                  zoomSectorIdx === row.index
                    ? 'border-[var(--ps-amber)] bg-amber-500/10'
                    : 'border-[var(--ps-border)] bg-[var(--ps-surface)] hover:border-[var(--ps-border-strong)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--ps-border)] pb-1">
                  <span className="text-[11px] font-black text-[var(--ps-amber)]">
                    S{row.index} · Setor {row.index}
                  </span>
                  <span className="text-[9px] font-bold text-[var(--ps-muted)]">
                    {row.fromDistM}–{row.toDistM}m
                  </span>
                </div>

                <div className="mt-1.5 space-y-1 text-[10px]">
                  {row.entries.map((entry, idx) => {
                    const isBest =
                      fastestDurationMs !== null &&
                      entry.metrics.durationMs !== null &&
                      Math.abs(entry.metrics.durationMs - fastestDurationMs) <= 15;
                    const isFasterThanRef =
                      idx > 0 && entry.timeDeltaSec !== null && entry.timeDeltaSec < 0;
                    const isSlowerThanRef =
                      idx > 0 && entry.timeDeltaSec !== null && entry.timeDeltaSec > 0;
                    const deltaColorCls =
                      isFasterThanRef || (idx > 0 && isBest)
                        ? 'text-[var(--ps-emerald)]'
                        : isSlowerThanRef
                          ? 'text-[#FF2A2A]'
                          : 'text-[var(--ps-muted)]';

                    return (
                      <div
                        key={`sec_${row.index}_v${entry.slot}`}
                        className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded px-1.5 py-1 ${
                          compact ? 'bg-[var(--ps-card-deep)]/80' : 'bg-[var(--ps-card-deep)]'
                        } ${lapSlotBorderLeftClass(entry.slot)}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`font-black ${lapSlotColorClass(entry.slot)}`}>
                            VOLTA {entry.slot}
                          </span>
                          <span className="font-black text-[var(--ps-text)]">
                            {formatSectorSec(entry.metrics.durationMs)}
                          </span>
                          {idx === 0 ? (
                            <span className="rounded bg-emerald-500/15 px-1 py-px text-[8px] font-black text-[var(--ps-emerald)]">
                              REF
                            </span>
                          ) : (
                            entry.timeDeltaSec !== null && (
                              <span className={`font-black ${deltaColorCls}`}>
                                ({formatSignedSec(entry.timeDeltaSec)})
                              </span>
                            )
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-[9px] font-bold text-[var(--ps-muted)]">
                          <span>
                            Méd{' '}
                            <strong className="text-[var(--ps-text)]">
                              {entry.metrics.avgSpeedKmh ?? '--'}
                            </strong>
                          </span>
                          <span>
                            Máx{' '}
                            <strong className="text-[var(--ps-text)]">
                              {entry.metrics.maxSpeedKmh ?? '--'}
                            </strong>{' '}
                            km/h
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderImprovementDiagnosticCard = (compact: boolean) => {
    if (!improvementDiagnostic) return null;
    const borderCls =
      improvementDiagnostic.tone === 'loss'
        ? 'border-red-500/45 bg-red-500/10'
        : improvementDiagnostic.tone === 'gain'
          ? 'border-emerald-500/45 bg-emerald-500/10'
          : 'border-[var(--ps-border)] bg-[var(--ps-surface)]';
    const badgeCls =
      improvementDiagnostic.tone === 'loss'
        ? 'text-[#FF2A2A]'
        : improvementDiagnostic.tone === 'gain'
          ? 'text-[var(--ps-emerald)]'
          : 'text-[var(--ps-amber)]';

    return (
      <div
        className={`rounded-xl border ${borderCls} ${
          compact ? 'px-2.5 py-2' : 'px-3 py-2.5'
        } space-y-1 font-mono tabular-nums`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-black uppercase ${badgeCls}`}>
            <TrendingUp className="h-3.5 w-3.5 shrink-0" />
            <span>Onde Melhorar na Próxima Volta</span>
          </span>
          {improvementDiagnostic.sectorIndex !== null && (
            <button
              type="button"
              onClick={() => {
                setProReplayPlaying(false);
                setReplayElapsedMs(null);
                setZoomSectorIdx(improvementDiagnostic.sectorIndex);
              }}
              className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-1.5 py-0.5 text-[9px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-amber)]"
            >
              Ver Setor {improvementDiagnostic.sectorIndex}
            </button>
          )}
        </div>
        <p className="text-[11px] font-extrabold leading-snug text-[var(--ps-text)]">
          {improvementDiagnostic.headline}
        </p>
        {improvementDiagnostic.subtip && (
          <p className="text-[10px] font-semibold leading-snug text-[var(--ps-muted)]">
            {improvementDiagnostic.subtip}
          </p>
        )}
      </div>
    );
  };

  const renderCriticalCornersComparison = (compact: boolean) => {
    if (lap1Samples.length < 6) return null;
    return (
      <div
        className={`rounded-xl border border-[var(--ps-border)] ${
          compact ? 'bg-[var(--ps-surface)] p-2' : 'bg-[var(--ps-card-deep)] p-2.5'
        } space-y-2 font-mono tabular-nums`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-extrabold tracking-wider text-[var(--ps-muted)] uppercase">
            <Target className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
            <span>Curvas Críticas (Entrada · Mínima · Saída)</span>
          </span>
          <span className="text-[9px] font-bold text-[var(--ps-muted)]">
            <strong className="text-[var(--ps-emerald)]">Verde = Mais rápido</strong> ·{' '}
            <strong className="text-[#FF2A2A]">Vermelho = Mais lento</strong>
          </span>
        </div>

        {cornerAnalysis.length === 0 ? (
          <p className="py-2 text-center text-[10px] text-[var(--ps-muted)]">
            Nenhuma curva com desaceleração acentuada detectada neste traçado.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {cornerAnalysis.map((corner) => (
              <button
                key={`corner_${corner.cornerIndex}`}
                type="button"
                onClick={() => scrubByManualDist(corner.refApexDistM)}
                title={`Ir para Curva ${corner.cornerIndex} (${corner.refApexDistM}m) no mapa e gráficos`}
                className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2 text-left transition-colors hover:border-[var(--ps-amber)]"
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--ps-border)] pb-1">
                  <span className="text-[11px] font-black text-[var(--ps-text)]">
                    {corner.label}
                  </span>
                  <span className="text-[9px] font-bold text-[var(--ps-muted)]">
                    Frenagem {corner.refBrakeStartM}m · Ápice {corner.refApexDistM}m
                  </span>
                </div>

                <div className="mt-1.5 space-y-1 text-[10px]">
                  <div className="grid grid-cols-[62px_1fr_1fr_1fr] gap-1 px-1 text-[8px] font-bold text-[var(--ps-muted)] uppercase">
                    <span>Volta</span>
                    <span className="text-right">Entrada</span>
                    <span className="text-right">Mínima</span>
                    <span className="text-right">Saída</span>
                  </div>

                  {corner.entries.map((entry) => {
                    const apexDeltaCls =
                      entry.deltaApexKmh === null || entry.deltaApexKmh === 0
                        ? 'text-[var(--ps-muted)]'
                        : entry.deltaApexKmh > 0
                          ? 'text-[var(--ps-emerald)]'
                          : 'text-[#FF2A2A]';
                    const exitDeltaCls =
                      entry.deltaExitKmh === null || entry.deltaExitKmh === 0
                        ? 'text-[var(--ps-muted)]'
                        : entry.deltaExitKmh > 0
                          ? 'text-[var(--ps-emerald)]'
                          : 'text-[#FF2A2A]';

                    return (
                      <div
                        key={`corner_${corner.cornerIndex}_v${entry.slot}`}
                        className={`grid grid-cols-[62px_1fr_1fr_1fr] items-center gap-1 rounded px-1.5 py-1 ${
                          compact ? 'bg-[var(--ps-card-deep)]/80' : 'bg-[var(--ps-card-deep)]'
                        } ${lapSlotBorderLeftClass(entry.slot)}`}
                      >
                        <span className={`font-black ${lapSlotColorClass(entry.slot)}`}>
                          VOLTA {entry.slot}
                        </span>
                        <span className="text-right font-bold text-[var(--ps-text)]">
                          {entry.entrySpeedKmh}
                          <span className="text-[8px] text-[var(--ps-muted)]"> km/h</span>
                        </span>
                        <span className="text-right font-extrabold text-[var(--ps-text)]">
                          {entry.apexSpeedKmh}
                          {entry.slot > 1 && entry.deltaApexKmh !== null && entry.deltaApexKmh !== 0 && (
                            <span className={`ml-0.5 text-[9px] font-black ${apexDeltaCls}`}>
                              ({formatSignedKmh(entry.deltaApexKmh)})
                            </span>
                          )}
                        </span>
                        <span className="text-right font-extrabold text-[var(--ps-text)]">
                          {entry.exitSpeedKmh}
                          {entry.slot > 1 && entry.deltaExitKmh !== null && entry.deltaExitKmh !== 0 && (
                            <span className={`ml-0.5 text-[9px] font-black ${exitDeltaCls}`}>
                              ({formatSignedKmh(entry.deltaExitKmh)})
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {/* 1. MELHOR VOLTA & MATRIZ GERAL DE VOLTAS & PARCIAIS NO TOPO */}
      <div className="space-y-2.5">
        <div className="rounded-2xl border border-[#10B981]/50 bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] shadow-sm space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-full border-2 border-[#10B981] bg-[#10B981]/15 font-mono">
                <Award className="h-4 w-4 text-[var(--ps-emerald)]" />
                <span className="text-[9px] font-black text-[var(--ps-emerald)]">
                  {raceChronoMatrix.bestRun ? `#${raceChronoMatrix.bestRun.runNumber}` : '--'}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-extrabold tracking-wider text-[var(--ps-emerald)] uppercase">
                  Melhor Volta · Referência da Sessão
                </p>
                <p className="font-mono text-2xl font-black leading-tight text-[var(--ps-text)] tabular-nums sm:text-3xl truncate">
                  {formatStageDuration(raceChronoMatrix.bestRun?.totalMs ?? null)}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 font-mono text-xs tabular-nums">
              <div>
                <p className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Vel. Máx</p>
                <p className="font-extrabold text-[var(--ps-text)]">
                  {raceChronoMatrix.bestRun ? `${raceChronoMatrix.bestRun.maxSpeedKmh} km/h` : '--'}
                </p>
              </div>
              <div>
                <p className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Vel. Méd</p>
                <p className="font-extrabold text-[var(--ps-emerald)]">
                  {raceChronoMatrix.bestRun
                    ? `${computeSafeAverageSpeedKmh({
                        distanceKm: raceChronoMatrix.bestRun.distanceKm,
                        totalMs: raceChronoMatrix.bestRun.totalMs,
                        maxSpeedKmh: raceChronoMatrix.bestRun.maxSpeedKmh,
                        samples: raceChronoMatrix.bestRun.samples,
                        storedAvgSpeedKmh: raceChronoMatrix.bestRun.avgSpeedKmh,
                      })} km/h`
                    : '--'}
                </p>
              </div>
              <div>
                <p className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Distância</p>
                <p className="font-extrabold text-[var(--ps-text)]">
                  {raceChronoMatrix.bestRun ? `${raceChronoMatrix.bestRun.distanceKm.toFixed(2)} km` : '--'}
                </p>
              </div>
              <div>
                <p className="text-[9px] font-bold text-[var(--ps-muted)] uppercase">Voltas</p>
                <p className="font-extrabold text-[var(--ps-emerald)]">
                  {raceChronoMatrix.orderedRuns.length}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ps-border)] pt-2 font-mono text-[11px] tabular-nums">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                Volta Ideal:
              </span>
              <span className="font-black text-[var(--ps-text)]">
                {formatStageDuration(raceChronoMatrix.theoreticalBestMs)}
              </span>
              {raceChronoMatrix.potentialGainSec !== null && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold ${
                    raceChronoMatrix.potentialGainSec < 0
                      ? 'bg-emerald-500/15 text-[var(--ps-emerald)]'
                      : 'bg-[var(--ps-card)] text-[var(--ps-muted)]'
                  }`}
                >
                  {formatSignedSec(raceChronoMatrix.potentialGainSec)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                Consistência:
              </span>
              <span className="rounded bg-[var(--ps-card)] px-1.5 py-0.5 text-[11px] font-black text-[var(--ps-amber)]">
                {raceChronoMatrix.consistencyPct !== null ? `${raceChronoMatrix.consistencyPct}%` : '--'}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Matriz Geral de Voltas &amp; Parciais
            </h3>
            <button
              type="button"
              onClick={onDeleteSession}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 text-[11px] font-bold text-red-500 hover:bg-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Excluir Sessão</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-[var(--ps-border-strong)] text-[10px] text-[var(--ps-muted)] uppercase">
                  <th className="py-2 pr-2 whitespace-nowrap">Volta</th>
                  <th className="px-2 py-2 whitespace-nowrap">Total</th>
                  <th className="px-2 py-2 text-right whitespace-nowrap">Delta</th>
                  {raceChronoMatrix.sectors.map((sec) => (
                    <th key={`hdr_p_${sec.index}`} className="px-2 py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => jumpToSectorStart(sec.fromDistKm)}
                        title={`Ir para o início da Parcial ${sec.index} no mapa e gráfico`}
                        className="cursor-pointer font-bold uppercase text-[var(--ps-muted)] hover:text-[var(--ps-amber)] hover:underline"
                      >
                        P{sec.index}
                      </button>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right whitespace-nowrap">Dist.</th>
                  {onDeleteRun && <th className="py-2 pl-2 text-right whitespace-nowrap" aria-label="Ações" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ps-border)]">
                {raceChronoMatrix.orderedRuns.map(({ run, metrics, cumulativeMsList }) => {
                  const isBestLap = raceChronoMatrix.bestRun?.id === run.id;
                  const isRefLap = raceChronoMatrix.refRun?.id === run.id;
                  const deltaVsRefSec =
                    raceChronoMatrix.refRun && run.totalMs > 0 && raceChronoMatrix.refRun.totalMs > 0
                      ? Number(((run.totalMs - raceChronoMatrix.refRun.totalMs) / 1000).toFixed(2))
                      : null;
                  const isConfirmingDelete = confirmDeleteRunId === run.id;

                  return (
                    <tr
                      key={`mtx_${run.id}`}
                      className={
                        isRefLap
                          ? 'bg-emerald-500/12'
                          : isBestLap
                            ? 'bg-emerald-500/5'
                            : 'hover:bg-[var(--ps-card)]'
                      }
                    >
                      <td className="py-2 pr-2 whitespace-nowrap font-extrabold text-[var(--ps-text)]">
                        <button
                          type="button"
                          onClick={() => onSelectRefRun?.(run.id)}
                          title={
                            isRefLap
                              ? `Volta #${run.runNumber} fixada como Referência (REF)`
                              : `Toque para fixar Volta #${run.runNumber} como Referência (REF)`
                          }
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-black transition-colors ${
                            isRefLap
                              ? 'border-[var(--ps-emerald)] bg-emerald-500/20 text-[var(--ps-emerald)]'
                              : 'border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-text)] hover:border-[var(--ps-emerald)] hover:text-[var(--ps-emerald)]'
                          }`}
                        >
                          <span>#{run.runNumber}</span>
                          {isRefLap && (
                            <span className="rounded bg-[var(--ps-emerald)] px-1 py-px text-[8px] font-black text-black">
                              REF
                            </span>
                          )}
                          {isBestLap && (
                            <span className="rounded bg-amber-500/20 px-1 py-px text-[8px] font-black text-[var(--ps-amber)]">
                              BEST
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap font-black text-[var(--ps-text)]">
                        {formatStageDuration(run.totalMs)}
                      </td>
                      <td
                        className={`px-2 py-2 text-right whitespace-nowrap font-extrabold ${
                          deltaVsRefSec === null
                            ? 'text-[var(--ps-muted)]'
                            : isRefLap || deltaVsRefSec <= 0
                              ? 'text-[var(--ps-emerald)]'
                              : 'text-[#FF2A2A]'
                        }`}
                      >
                        {deltaVsRefSec === null
                          ? '--'
                          : isRefLap
                            ? '0.00s'
                            : formatSignedSec(deltaVsRefSec)}
                      </td>
                      {metrics.map((m, idx) => {
                        const cumMs = cumulativeMsList[idx] ?? null;
                        const bestCumMs = raceChronoMatrix.bestCumulativeMsList[idx];
                        const refCumMs =
                          raceChronoMatrix.refCumulativeMsList[idx] ?? bestCumMs;
                        const isCumRecord =
                          cumMs !== null &&
                          bestCumMs !== null &&
                          Math.abs(cumMs - bestCumMs) <= 15;
                        const isFasterThanRefCum =
                          cumMs !== null &&
                          refCumMs !== null &&
                          cumMs - refCumMs < -15;
                        const isSlowerCum =
                          cumMs !== null &&
                          refCumMs !== null &&
                          cumMs - refCumMs > 15;
                        const sec = raceChronoMatrix.sectors[idx];

                        return (
                          <td
                            key={`mtx_${run.id}_p_${idx}`}
                            className={`px-2 py-1.5 text-right whitespace-nowrap ${
                              isCumRecord
                                ? 'bg-emerald-500/15 text-[var(--ps-emerald)]'
                                : isFasterThanRefCum
                                  ? 'text-[var(--ps-emerald)]'
                                  : isSlowerCum
                                    ? 'text-[#FF2A2A]'
                                    : 'text-[var(--ps-text)]'
                            }`}
                          >
                            {sec ? (
                              <button
                                type="button"
                                onClick={() => jumpToSectorStart(sec.fromDistKm)}
                                title={`Acumulado até P${sec.index} (Setor isolado: ${formatIsolatedSplit(m.durationMs)}) — toque para ir no mapa`}
                                className="inline-flex cursor-pointer flex-col items-end leading-tight hover:underline"
                              >
                                <span className={isCumRecord ? 'font-black' : 'font-extrabold'}>
                                  {formatAccumulatedSplit(cumMs)}
                                </span>
                                <span className="text-[9px] font-semibold text-[var(--ps-muted)]">
                                  {formatIsolatedSplit(m.durationMs)}
                                </span>
                              </button>
                            ) : (
                              <div className="inline-flex flex-col items-end leading-tight">
                                <span className={isCumRecord ? 'font-black' : 'font-extrabold'}>
                                  {formatAccumulatedSplit(cumMs)}
                                </span>
                                <span className="text-[9px] font-semibold text-[var(--ps-muted)]">
                                  {formatIsolatedSplit(m.durationMs)}
                                </span>
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-right whitespace-nowrap text-[var(--ps-muted)]">
                        {run.distanceKm.toFixed(2)}km
                      </td>
                      {onDeleteRun && (
                        <td className="py-2 pl-2 text-right whitespace-nowrap">
                          {isConfirmingDelete ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  setConfirmDeleteRunId(null);
                                  onDeleteRun(run.id);
                                }}
                                className="rounded bg-red-500 px-1.5 py-0.5 text-[9px] font-black text-white hover:bg-red-600"
                              >
                                Excluir
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteRunId(null)}
                                className="rounded border border-[var(--ps-border)] bg-[var(--ps-card)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                              >
                                Não
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteRunId(run.id)}
                              title={`Excluir volta #${run.runNumber}`}
                              aria-label={`Excluir volta #${run.runNumber}`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--ps-muted)] transition-colors hover:bg-red-500/15 hover:text-red-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 2. SELETORES DE VOLTAS (V1 / V2 / V3) */}
      {lapSelectorSlot}

      {/* 3. BLOCO PRINCIPAL UNIFICADO: MAPA SATÉLITE + DATALOGGER SINCRONIZADO */}
      <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Mapa de Traçado &amp; Datalogger Sincronizado
            </h3>
            <p className="font-mono text-[10px] text-[var(--ps-muted)]">
              Velocidade, Pedal &amp; Força Lateral sincronizados com o replay da volta
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
            <span className="inline-flex items-center gap-1.5 font-bold text-[var(--ps-emerald)]">
              <span className="inline-block h-2.5 w-3.5 rounded-xs border-t-2 border-[#10B981] bg-[#10B981]/20" />
              VOLTA 1
            </span>
            {showLap2 && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[#FF2A2A]">
                <span className="inline-block h-[2.5px] w-3.5 bg-[#FF2A2A]" />
                VOLTA 2
              </span>
            )}
            {showLap3 && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[#38BDF8]">
                <span className="inline-block w-3.5 border-t-2 border-dashed border-[#38BDF8]" />
                VOLTA 3
              </span>
            )}
          </div>
        </div>

        {/* Mapa Satélite Interativo com Seletor Rápido de 3 Camadas Visuais no Topo */}
        {lap1Samples.length > 1 && (
          <div className="overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ps-border)] px-2.5 py-2 font-mono text-[10px] tabular-nums">
              <div className="flex flex-wrap items-center gap-1.5">
                <div
                  className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-0.5"
                  role="tablist"
                  aria-label="Camada visual do traçado no mapa"
                >
                  {(
                    [
                      { id: 'laps', label: 'Por Volta (VOLTA 1/2/3)' },
                      { id: 'speed', label: 'Velocidade (km/h)' },
                      { id: 'accel', label: 'Frenagem / Acel.' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="tab"
                      aria-selected={mapLayerMode === opt.id}
                      onClick={() => setMapLayerMode(opt.id)}
                      className={`rounded-md px-2 py-1 text-[10px] font-extrabold transition-colors ${
                        mapLayerMode === opt.id
                          ? 'pitstop-btn-red'
                          : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  aria-pressed={showMapPeaks}
                  onClick={() => setShowMapPeaks((v) => !v)}
                  className={`rounded-lg border px-2 py-1 text-[10px] font-extrabold transition-colors ${
                    showMapPeaks
                      ? 'border-[var(--ps-amber)] bg-amber-500/15 text-[var(--ps-amber)]'
                      : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                  title="Exibir ou ocultar balões de pico de velocidade sobre o traçado"
                >
                  Picos
                </button>

                <button
                  type="button"
                  aria-pressed={showMapSplits}
                  onClick={() => setShowMapSplits((v) => !v)}
                  className={`rounded-lg border px-2 py-1 text-[10px] font-extrabold transition-colors ${
                    showMapSplits
                      ? 'border-sky-500/70 bg-sky-500/15 text-sky-400'
                      : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                  title="Exibir ou ocultar marcadores de Largada, Parciais (P1..Pn) e Chegada sobre o traçado"
                >
                  Parciais
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[9px] font-bold">
                {mapLayerMode === 'laps' ? (
                  <>
                    <span className="text-[#10B981]">━ VOLTA 1</span>
                    {showLap2 && <span className="text-[#FF2A2A]">━ VOLTA 2</span>}
                    {showLap3 && <span className="text-[#38BDF8]">━ VOLTA 3</span>}
                  </>
                ) : mapLayerMode === 'speed' ? (
                  <>
                    <span className="text-[#10B981]">■ Alta</span>
                    <span className="text-[#F59E0B]">■ Média</span>
                    <span className="text-[#FF2A2A]">■ Baixa</span>
                  </>
                ) : (
                  <>
                    <span className="text-[#10B981]">■ Acel (+G)</span>
                    <span className="text-[#F59E0B]">■ Neutro</span>
                    <span className="text-[#FF2A2A]">■ Freio (-G)</span>
                  </>
                )}
                <span className="text-[var(--ps-muted)]">·</span>
                <span className="text-[var(--ps-text)]">
                  Dist: <strong className="text-[var(--ps-amber)]">{scrubPoint.distKmStr}km</strong>
                </span>
              </div>
            </div>

            <VelocityMapboxView
              trackId={`${sessionTrack?.id || 'session'}_synced`}
              editableTrace={lap1Samples}
              ghostTrace={showLap2 ? lap2Samples : undefined}
              thirdTrace={showLap3 ? lap3Samples : undefined}
              offsetGhostTrace={showLap2 || showLap3}
              orderedTraps={showMapSplits && sessionTrack ? getOrderedTrackTraps(sessionTrack) : []}
              postEditIdx={0}
              vehicleStyle="lap1"
              currentPos={
                scrubPoint.s1
                  ? { lat: scrubPoint.s1.lat, lon: scrubPoint.s1.lon }
                  : null
              }
              navHeadingDeg={scrubPoint.s1?.headingDeg ?? null}
              ghostCar={
                showLap2 && scrubPoint.s2
                  ? {
                      lat: scrubPoint.s2.lat,
                      lon: scrubPoint.s2.lon,
                      headingDeg: scrubPoint.s2.headingDeg,
                    }
                  : null
              }
              thirdCar={
                showLap3 && scrubPoint.s3
                  ? {
                      lat: scrubPoint.s3.lat,
                      lon: scrubPoint.s3.lon,
                      headingDeg: scrubPoint.s3.headingDeg,
                    }
                  : null
              }
              heatmapMode={mapLayerMode}
              showSpeedBadges={showMapPeaks}
              compactCarMarkers={true}
              onFullscreenToggle={() => {
                setReplayAutoFollow(true);
                setProFullscreen(true);
              }}
              containerClassName="relative h-[420px] min-h-[52vh] w-full overflow-hidden bg-[#000000] sm:h-[480px]"
            />
          </div>
        )}

        {/* Barra de Replay & Progresso no TOPO (logo abaixo do mapa) */}
        {lap1Samples.length > 1 && renderReplayControlBar(false)}

        {/* Botões de Zoom por Trecho / Parcial */}
        {renderSectorZoomButtons()}

        {/* Distância atual em destaque + Comparativo Completo V1 / V2 / V3 */}
        {lap1Samples.length > 1 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-1.5 font-mono text-xs tabular-nums">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Distância Atual:
                </span>
                <span className="text-sm font-black text-[var(--ps-amber)]">
                  {scrubPoint.distKmStr} km
                </span>
                <span className="text-[11px] font-bold text-[var(--ps-muted)]">
                  ({scrubPoint.distM}m)
                </span>
                {scrubPoint.speed1 !== null && (
                  <span className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-black text-[var(--ps-emerald)]">
                    V1 {scrubPoint.speed1} km/h
                  </span>
                )}
                {showLap2 && scrubPoint.speed2 !== null && (
                  <span className="rounded-md border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-xs font-black text-[#FF2A2A]">
                    V2 {scrubPoint.speed2} km/h
                  </span>
                )}
                {showLap3 && scrubPoint.speed3 !== null && (
                  <span className="rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-xs font-black text-[#38BDF8]">
                    V3 {scrubPoint.speed3} km/h
                  </span>
                )}
              </div>
              {replayElapsedMs !== null && (
                <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-black text-[var(--ps-emerald)]">
                  REPLAY {replaySpeed}x · {(replayElapsedMs / 1000).toFixed(2)}s
                </span>
              )}
            </div>

            {renderSectorComparisonCards(false)}
            {renderImprovementDiagnosticCard(false)}
            {renderCriticalCornersComparison(false)}
          </div>
        )}

        {/* PAINÉIS SINCRONIZADOS (1: Velocidade, 2: Time Slip, 3: Pedal Virtual, 4: Força Lateral) */}
        {lap1Samples.length > 1 ? (
          <div className="touch-pan-y space-y-2">
            {/* PAINEL 1 — VELOCIDADE (km/h) + ZONAS ACEL/FREIO + TOP/MIN */}
            <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 1 · Velocidade (km/h) &amp; Zonas Acel/Frenagem
                </span>
                <span>TOP = Máxima · MIN = Ápice da Curva</span>
              </div>
              <svg
                ref={panel1Ref}
                viewBox={`0 0 ${chartW} ${p1H}`}
                className="h-44 w-full touch-pan-y select-none cursor-crosshair sm:h-48"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse') {
                    isDraggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  updateScrubFromSvg(panel1Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                    updateScrubFromSvg(panel1Ref.current, e.clientX);
                  }
                }}
                onPointerUp={(e) => {
                  isDraggingRef.current = false;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  isDraggingRef.current = false;
                }}
              >
                {yTicksKmh.map((val) => {
                  const y = yAtKmh(val);
                  return (
                    <g key={`p1_y_${val}`}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke="var(--ps-border-strong)"
                        strokeOpacity="0.65"
                        strokeDasharray={val === 0 ? undefined : '3 3'}
                      />
                      <text
                        x={padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill="var(--ps-muted)"
                        fontSize="9"
                        fontFamily="monospace"
                      >
                        {val}
                      </text>
                    </g>
                  );
                })}

                {visibleSectorDividers.map((sec, idx) => (
                  <line
                    key={`p1_sec_${idx}`}
                    x1={xAtM(sec.toM)}
                    y1={p1Top}
                    x2={xAtM(sec.toM)}
                    y2={p1Bottom}
                    stroke="var(--ps-muted)"
                    strokeOpacity="0.45"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                ))}

                {/* Zonas de Aceleração / Frenagem na pista (faixa inferior) */}
                <rect
                  x={padL}
                  y={zoneStripY}
                  width={plotW}
                  height={zoneStripH}
                  rx="2"
                  fill="var(--ps-surface)"
                />
                {v1ZoneSegments.map((seg, idx) => (
                  <rect
                    key={`zone_${idx}`}
                    x={seg.x1}
                    y={zoneStripY}
                    width={Math.max(1.5, seg.x2 - seg.x1)}
                    height={zoneStripH}
                    fill={seg.kind === 'accel' ? '#10B981' : '#FF2A2A'}
                    fillOpacity="0.82"
                  />
                ))}

                {/* V1 (Ref): Área translúcida verde esmeralda + linha sólida 2.5px */}
                {speedArea1 && (
                  <polygon fill="rgba(16, 185, 129, 0.14)" points={speedArea1} />
                )}
                {speedLine1 && (
                  <polyline
                    fill="none"
                    stroke="#10B981"
                    strokeWidth="2.5"
                    points={speedLine1}
                  />
                )}

                {/* V2 (Comp.A): Linha sólida nítida vermelha 2px sem preenchimento */}
                {showLap2 && speedLine2 && (
                  <polyline
                    fill="none"
                    stroke="#FF2A2A"
                    strokeWidth="2"
                    points={speedLine2}
                  />
                )}

                {/* V3 (Opcional): Linha tracejada ciano 1.8px */}
                {showLap3 && speedLine3 && (
                  <polyline
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="1.8"
                    strokeDasharray="5 3"
                    points={speedLine3}
                  />
                )}

                {/* Marcadores TOP e MIN sobre a curva */}
                {criticalMarkers.map((pt, idx) => {
                  const cx = xAtM(pt.distM);
                  const cy = yAtKmh(pt.speedKmh);
                  const isMin = pt.badge === 'MIN';
                  const badgeW = 26;
                  const badgeH = 12;
                  const bx = Math.max(padL + 2, Math.min(chartW - padR - badgeW - 2, cx - badgeW / 2));
                  const by = Math.max(
                    p1Top + 1,
                    Math.min(p1Bottom - badgeH - 1, isMin ? cy + 7 : cy - badgeH - 7)
                  );
                  const bg = isMin ? '#10B981' : '#F59E0B';
                  const fg = isMin ? '#FFFFFF' : '#050608';
                  return (
                    <g key={`p1_crit_${pt.badge}_${pt.distM}_${idx}`} className="pointer-events-none">
                      <line
                        x1={cx}
                        y1={cy}
                        x2={cx}
                        y2={isMin ? by : by + badgeH}
                        stroke={bg}
                        strokeWidth="1"
                      />
                      <circle cx={cx} cy={cy} r="2.8" fill={bg} stroke="#FFFFFF" strokeWidth="0.9" />
                      <rect x={bx} y={by} width={badgeW} height={badgeH} rx="3" fill={bg} />
                      <text
                        x={bx + badgeW / 2}
                        y={by + 8.8}
                        textAnchor="middle"
                        fill={fg}
                        fontSize="7.5"
                        fontWeight="bold"
                        fontFamily="monospace"
                      >
                        {pt.badge}
                      </text>
                    </g>
                  );
                })}

                {xTicksM.map((mVal, i) => (
                  <text
                    key={`p1_x_${mVal}_${i}`}
                    x={xAtM(mVal)}
                    y={p1H - 4}
                    textAnchor={
                      i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'
                    }
                    fill="var(--ps-muted)"
                    fontSize="8.5"
                    fontFamily="monospace"
                  >
                    {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                  </text>
                ))}

                {/* Crosshair sincronizado vermelho */}
                <line
                  x1={scrubX}
                  y1={p1Top}
                  x2={scrubX}
                  y2={p1Bottom}
                  stroke="#FF2A2A"
                  strokeWidth="1.8"
                />
                {scrubPoint.speed1 !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtKmh(scrubPoint.speed1)}
                    r="4"
                    fill="#10B981"
                    stroke="#FFFFFF"
                    strokeWidth="1.4"
                  />
                )}
                {showLap2 && scrubPoint.speed2 !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtKmh(scrubPoint.speed2)}
                    r="3.5"
                    fill="#FF2A2A"
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
                {showLap3 && scrubPoint.speed3 !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtKmh(scrubPoint.speed3)}
                    r="3.5"
                    fill="#38BDF8"
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
              </svg>
            </div>

            {/* PAINEL 2 — TIME SLIP / DELTA DE TEMPO CONTÍNUO (ΔT vs REF) */}
            <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 2 · Time Slip / Delta de Tempo Contínuo (ΔT vs VOLTA 1)
                </span>
                <span>
                  <strong className="text-[var(--ps-emerald)]">Verde (-s) = Mais Rápido</strong> ·{' '}
                  <strong className="text-[#FF2A2A]">Vermelho (+s) = Mais Lento</strong>
                  {showLap2 && showLap3 ? ' · Tracejado Ciano = VOLTA 3' : ''}
                </span>
              </div>
              {showLap2 || showLap3 ? (
                <svg
                  ref={panelTimeSlipRef}
                  viewBox={`0 0 ${chartW} ${pTsH}`}
                  className="h-28 w-full touch-pan-y select-none cursor-crosshair sm:h-32"
                  onPointerDown={(e) => {
                    if (e.pointerType === 'mouse') {
                      isDraggingRef.current = true;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }
                    updateScrubFromSvg(panelTimeSlipRef.current, e.clientX);
                  }}
                  onPointerMove={(e) => {
                    if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                      updateScrubFromSvg(panelTimeSlipRef.current, e.clientX);
                    }
                  }}
                  onPointerUp={(e) => {
                    isDraggingRef.current = false;
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  }}
                  onPointerCancel={() => {
                    isDraggingRef.current = false;
                  }}
                >
                  <defs>
                    <clipPath id="ts-clip-gain">
                      <rect x={padL} y={pTsTop - 4} width={plotW} height={pTsMidY - pTsTop + 4} />
                    </clipPath>
                    <clipPath id="ts-clip-loss">
                      <rect x={padL} y={pTsMidY} width={plotW} height={pTsBottom - pTsMidY + 4} />
                    </clipPath>
                  </defs>

                  {[-maxTimeSlipScaleSec, 0, maxTimeSlipScaleSec].map((dTick) => {
                    const y = yAtTimeSlip(dTick);
                    return (
                      <g key={`ts_y_${dTick}`}>
                        <line
                          x1={padL}
                          y1={y}
                          x2={chartW - padR}
                          y2={y}
                          stroke={dTick === 0 ? 'var(--ps-muted)' : 'var(--ps-border)'}
                          strokeOpacity={dTick === 0 ? '0.65' : '0.8'}
                          strokeDasharray={dTick === 0 ? undefined : '3 3'}
                        />
                        <text
                          x={padL - 5}
                          y={y + 3}
                          textAnchor="end"
                          fill={
                            dTick < 0 ? '#10B981' : dTick > 0 ? '#FF2A2A' : 'var(--ps-text)'
                          }
                          fontSize="8.5"
                          fontFamily="monospace"
                        >
                          {dTick === 0
                            ? '0.0s'
                            : `${dTick > 0 ? '+' : ''}${dTick.toFixed(1)}s`}
                        </text>
                      </g>
                    );
                  })}

                  {visibleSectorDividers.map((sec, idx) => (
                    <line
                      key={`ts_sec_${idx}`}
                      x1={xAtM(sec.toM)}
                      y1={pTsTop}
                      x2={xAtM(sec.toM)}
                      y2={pTsBottom}
                      stroke="var(--ps-muted)"
                      strokeOpacity="0.45"
                      strokeWidth="1"
                      strokeDasharray="4 4"
                    />
                  ))}

                  {primaryTimeSlipPolys.posPoly && (
                    <polygon fill="#10B981" fillOpacity="0.28" points={primaryTimeSlipPolys.posPoly} />
                  )}
                  {primaryTimeSlipPolys.negPoly && (
                    <polygon fill="#FF2A2A" fillOpacity="0.28" points={primaryTimeSlipPolys.negPoly} />
                  )}
                  {primaryTimeSlipPolys.linePts && (
                    <>
                      <polyline
                        fill="none"
                        stroke="#10B981"
                        strokeWidth="2.2"
                        clipPath="url(#ts-clip-gain)"
                        points={primaryTimeSlipPolys.linePts}
                      />
                      <polyline
                        fill="none"
                        stroke="#FF2A2A"
                        strokeWidth="2.2"
                        clipPath="url(#ts-clip-loss)"
                        points={primaryTimeSlipPolys.linePts}
                      />
                    </>
                  )}

                  {showLap2 && timeSlipLine3 && (
                    <polyline
                      fill="none"
                      stroke="#38BDF8"
                      strokeWidth="1.6"
                      strokeDasharray="4 3"
                      points={timeSlipLine3}
                    />
                  )}

                  <line
                    x1={scrubX}
                    y1={pTsTop}
                    x2={scrubX}
                    y2={pTsBottom}
                    stroke="#FF2A2A"
                    strokeWidth="1.6"
                  />
                  {(showLap2 ? scrubPoint.timeDelta2vs1Sec : scrubPoint.timeDelta3vs1Sec) !==
                    null && (() => {
                    const activeDelta = showLap2
                      ? scrubPoint.timeDelta2vs1Sec!
                      : scrubPoint.timeDelta3vs1Sec!;
                    return (
                      <circle
                        cx={scrubX}
                        cy={yAtTimeSlip(activeDelta)}
                        r="3.8"
                        fill={activeDelta <= 0 ? '#10B981' : '#FF2A2A'}
                        stroke="#FFFFFF"
                        strokeWidth="1.3"
                      />
                    );
                  })()}
                  {showLap2 && showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                    <circle
                      cx={scrubX}
                      cy={yAtTimeSlip(scrubPoint.timeDelta3vs1Sec)}
                      r="3"
                      fill="#38BDF8"
                      stroke="#FFFFFF"
                      strokeWidth="1"
                    />
                  )}
                </svg>
              ) : (
                <p className="py-5 text-center font-mono text-[10px] text-[var(--ps-muted)]">
                  Selecione <strong className="text-[#FF2A2A]">Volta 2</strong> ou{' '}
                  <strong className="text-[#38BDF8]">Volta 3</strong> acima para visualizar o Delta
                  de Tempo contínuo (ΔT).
                </p>
              )}
            </div>

            {/* PAINEL 3 — PEDAL VIRTUAL (+G ACELERAÇÃO vs. -G FRENAGEM) */}
            <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 3 · Pedal Virtual (Aceleração +G vs. Frenagem -G)
                </span>
                <span>
                  <strong className="text-[var(--ps-emerald)]">Verde = Acel</strong> ·{' '}
                  <strong className="text-[#FF2A2A]">Vermelho = Freio</strong>
                  {showLap2 ? ' · Linha Âmbar = VOLTA 2' : ''}
                </span>
              </div>
              <svg
                ref={panel2Ref}
                viewBox={`0 0 ${chartW} ${p2H}`}
                className="h-32 w-full touch-pan-y select-none cursor-crosshair sm:h-36"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse') {
                    isDraggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  updateScrubFromSvg(panel2Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                    updateScrubFromSvg(panel2Ref.current, e.clientX);
                  }
                }}
                onPointerUp={(e) => {
                  isDraggingRef.current = false;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  isDraggingRef.current = false;
                }}
              >
                {[maxLongGScale, 0, -maxLongGScale].map((gTick) => {
                  const y = yAtLongG(gTick);
                  return (
                    <g key={`p2_y_${gTick}`}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke={gTick === 0 ? 'var(--ps-muted)' : 'var(--ps-border)'}
                        strokeOpacity={gTick === 0 ? '0.6' : '0.8'}
                        strokeDasharray={gTick === 0 ? undefined : '3 3'}
                      />
                      <text
                        x={padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill={
                          gTick > 0 ? '#10B981' : gTick < 0 ? '#FF2A2A' : 'var(--ps-text)'
                        }
                        fontSize="8.5"
                        fontFamily="monospace"
                      >
                        {gTick > 0 ? `+${gTick.toFixed(1)}` : gTick.toFixed(1)}
                      </text>
                    </g>
                  );
                })}

                {visibleSectorDividers.map((sec, idx) => (
                  <line
                    key={`p2_sec_${idx}`}
                    x1={xAtM(sec.toM)}
                    y1={p2Top}
                    x2={xAtM(sec.toM)}
                    y2={p2Bottom}
                    stroke="var(--ps-muted)"
                    strokeOpacity="0.45"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                ))}

                {/* Área Bicolor V1 (+G Verde Aceleração / -G Vermelho Frenagem) */}
                {pedal1.posPoly && (
                  <polygon fill="#10B981" fillOpacity="0.34" points={pedal1.posPoly} />
                )}
                {pedal1.negPoly && (
                  <polygon fill="#FF2A2A" fillOpacity="0.38" points={pedal1.negPoly} />
                )}
                {pedal1.linePts && (
                  <polyline
                    fill="none"
                    stroke="var(--ps-text)"
                    strokeWidth="1.6"
                    strokeOpacity="0.82"
                    points={pedal1.linePts}
                  />
                )}

                {/* V2 sobreposto para comparar freada/retomada */}
                {showLap2 && pedalLine2 && (
                  <polyline
                    fill="none"
                    stroke="#FBBF24"
                    strokeWidth="2"
                    points={pedalLine2}
                  />
                )}

                {/* V3 tracejado */}
                {showLap3 && pedalLine3 && (
                  <polyline
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="1.6"
                    strokeDasharray="4 3"
                    points={pedalLine3}
                  />
                )}

                <line
                  x1={scrubX}
                  y1={p2Top}
                  x2={scrubX}
                  y2={p2Bottom}
                  stroke="#FF2A2A"
                  strokeWidth="1.6"
                />
                <circle
                  cx={scrubX}
                  cy={yAtLongG(scrubPoint.longG1)}
                  r="3.5"
                  fill={scrubPoint.longG1 >= 0 ? '#10B981' : '#FF2A2A'}
                  stroke="#FFFFFF"
                  strokeWidth="1.2"
                />
                {showLap2 && (
                  <circle
                    cx={scrubX}
                    cy={yAtLongG(scrubPoint.longG2)}
                    r="3.2"
                    fill="#FBBF24"
                    stroke="#050608"
                    strokeWidth="1"
                  />
                )}
                {showLap3 && (
                  <circle
                    cx={scrubX}
                    cy={yAtLongG(scrubPoint.longG3)}
                    r="3"
                    fill="#38BDF8"
                    stroke="#FFFFFF"
                    strokeWidth="1"
                  />
                )}
              </svg>
            </div>

            {/* PAINEL 4 — FORÇA LATERAL EM CURVA (LAT G) */}
            <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 4 · Força Lateral em Curva (Lat G)
                </span>
                <span>Aderência lateral (+Esq / -Dir)</span>
              </div>
              <svg
                ref={panel3Ref}
                viewBox={`0 0 ${chartW} ${p3H}`}
                className="h-32 w-full touch-pan-y select-none cursor-crosshair sm:h-36"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse') {
                    isDraggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  updateScrubFromSvg(panel3Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                    updateScrubFromSvg(panel3Ref.current, e.clientX);
                  }
                }}
                onPointerUp={(e) => {
                  isDraggingRef.current = false;
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  isDraggingRef.current = false;
                }}
              >
                {[maxLatGScale, 0, -maxLatGScale].map((gTick) => {
                  const y = yAtLatG(gTick);
                  return (
                    <g key={`p3_y_${gTick}`}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke={gTick === 0 ? 'var(--ps-muted)' : 'var(--ps-border)'}
                        strokeOpacity={gTick === 0 ? '0.6' : '0.8'}
                        strokeDasharray={gTick === 0 ? undefined : '3 3'}
                      />
                      <text
                        x={padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill="var(--ps-muted)"
                        fontSize="8.5"
                        fontFamily="monospace"
                      >
                        {gTick > 0 ? `+${gTick.toFixed(1)}` : gTick.toFixed(1)}
                      </text>
                    </g>
                  );
                })}

                {visibleSectorDividers.map((sec, idx) => (
                  <line
                    key={`p3_sec_${idx}`}
                    x1={xAtM(sec.toM)}
                    y1={p3Top}
                    x2={xAtM(sec.toM)}
                    y2={p3Bottom}
                    stroke="var(--ps-muted)"
                    strokeOpacity="0.45"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                  />
                ))}

                {latArea1 && <polygon fill="rgba(16, 185, 129, 0.14)" points={latArea1} />}
                {latLine1 && (
                  <polyline fill="none" stroke="#10B981" strokeWidth="2.2" points={latLine1} />
                )}
                {showLap2 && latLine2 && (
                  <polyline fill="none" stroke="#FF2A2A" strokeWidth="1.9" points={latLine2} />
                )}
                {showLap3 && latLine3 && (
                  <polyline
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="1.7"
                    strokeDasharray="5 3"
                    points={latLine3}
                  />
                )}

                {xTicksM.map((mVal, i) => (
                  <text
                    key={`p3_x_${mVal}_${i}`}
                    x={xAtM(mVal)}
                    y={p3H - 4}
                    textAnchor={
                      i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'
                    }
                    fill="var(--ps-muted)"
                    fontSize="8.5"
                    fontFamily="monospace"
                  >
                    {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                  </text>
                ))}

                <line
                  x1={scrubX}
                  y1={p3Top}
                  x2={scrubX}
                  y2={p3Bottom}
                  stroke="#FF2A2A"
                  strokeWidth="1.6"
                />
                <circle
                  cx={scrubX}
                  cy={yAtLatG(scrubPoint.latG1)}
                  r="3.5"
                  fill="#10B981"
                  stroke="#FFFFFF"
                  strokeWidth="1.2"
                />
                {showLap2 && (
                  <circle
                    cx={scrubX}
                    cy={yAtLatG(scrubPoint.latG2)}
                    r="3.2"
                    fill="#FF2A2A"
                    stroke="#FFFFFF"
                    strokeWidth="1.1"
                  />
                )}
                {showLap3 && (
                  <circle
                    cx={scrubX}
                    cy={yAtLatG(scrubPoint.latG3)}
                    r="3"
                    fill="#38BDF8"
                    stroke="#FFFFFF"
                    strokeWidth="1"
                  />
                )}
              </svg>
            </div>
          </div>
        ) : (
          <p className="py-12 text-center font-mono text-xs text-[var(--ps-muted)]">
            Dados insuficientes para gerar as curvas de telemetria.
          </p>
        )}

      </div>

      {/* MODO ANÁLISE PRO EM TELA CHEIA (Portal direto no document.body) */}
      {proFullscreen && lap1Samples.length > 1 && typeof document !== 'undefined' && (() => {
        const activeTimeDelta = showLap2
          ? scrubPoint.timeDelta2vs1Sec
          : showLap3
            ? scrubPoint.timeDelta3vs1Sec
            : null;
        return createPortal(
          <div
            className="fixed inset-0 z-[9999] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#090A0D] text-[var(--ps-text)]"
            role="dialog"
            aria-modal="true"
            aria-label="Análise Pro em Tela Cheia"
          >
            {/* Barra Única Superior (Esquerda: Voltas/Vel/Freio/Picos/Parciais/Satélite | Direita: Sair Tela Cheia) */}
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#11141B] px-2.5 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap font-mono text-[10px] font-bold [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {(
                  [
                    { id: 'laps', label: 'Voltas' },
                    { id: 'speed', label: 'Vel.' },
                    { id: 'accel', label: 'Freio/Acel' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={`fs_layer_${opt.id}`}
                    type="button"
                    onClick={() => setMapLayerMode(opt.id)}
                    className={`shrink-0 rounded-md px-2 py-1.5 font-extrabold transition-colors ${
                      mapLayerMode === opt.id
                        ? 'pitstop-btn-red'
                        : 'bg-white/5 text-slate-300 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
                <span className="mx-0.5 h-3.5 w-px shrink-0 bg-white/15" />
                <button
                  type="button"
                  aria-pressed={showMapPeaks}
                  onClick={() => setShowMapPeaks((v) => !v)}
                  className={`shrink-0 rounded-md px-2 py-1.5 font-extrabold transition-colors ${
                    showMapPeaks
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-white/5 text-slate-300 hover:text-white'
                  }`}
                >
                  Picos
                </button>
                <button
                  type="button"
                  aria-pressed={showMapSplits}
                  onClick={() => setShowMapSplits((v) => !v)}
                  className={`shrink-0 rounded-md px-2 py-1.5 font-extrabold transition-colors ${
                    showMapSplits
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'bg-white/5 text-slate-300 hover:text-white'
                  }`}
                >
                  Parciais
                </button>
                <span className="mx-0.5 h-3.5 w-px shrink-0 bg-white/15" />
                <button
                  type="button"
                  onClick={() => setFsMapStyleIdx((v) => (v + 1) % 3)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1.5 font-extrabold text-white hover:bg-white/10"
                  aria-label="Alternar camada do mapa"
                >
                  <Layers className="h-3 w-3 text-amber-400" />
                  <span>{fsMapStyleLabels[fsMapStyleIdx % 3]}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={replayAutoFollow}
                  onClick={() => setReplayAutoFollow((v) => !v)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 font-extrabold transition-colors ${
                    replayAutoFollow
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                      : 'bg-white/5 text-slate-300 hover:text-white'
                  }`}
                  aria-label="Alternar seguir carro ou ver pista inteira"
                >
                  <span>{replayAutoFollow ? 'Seguir Carro' : 'Pista Inteira'}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setProFullscreen(false);
                  setProReplayPlaying(false);
                }}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-[#1B1F2A] px-2.5 text-[11px] font-extrabold text-white hover:border-[#E10600]"
                aria-label="Sair da tela cheia"
              >
                <Minimize2 className="h-3.5 w-3.5 text-[#E10600]" />
                <span>Sair Tela Cheia</span>
              </button>
            </header>

            {/* Mapa Satélite Interativo Fixo no Topo */}
            <div className="relative h-[46dvh] w-full shrink-0 overflow-hidden border-b border-white/10 bg-[#000000] sm:h-[50dvh]">
              <VelocityMapboxView
                trackId={`${sessionTrack?.id || 'session'}_pro_fs`}
                editableTrace={lap1Samples}
                ghostTrace={showLap2 ? lap2Samples : undefined}
                thirdTrace={showLap3 ? lap3Samples : undefined}
                offsetGhostTrace={showLap2 || showLap3}
                orderedTraps={showMapSplits && sessionTrack ? getOrderedTrackTraps(sessionTrack) : []}
                postEditIdx={0}
                vehicleStyle="lap1"
                currentPos={
                  scrubPoint.s1
                    ? { lat: scrubPoint.s1.lat, lon: scrubPoint.s1.lon }
                    : null
                }
                navHeadingDeg={scrubPoint.s1?.headingDeg ?? null}
                ghostCar={
                  showLap2 && scrubPoint.s2
                    ? {
                        lat: scrubPoint.s2.lat,
                        lon: scrubPoint.s2.lon,
                        headingDeg: scrubPoint.s2.headingDeg,
                      }
                    : null
                }
                thirdCar={
                  showLap3 && scrubPoint.s3
                    ? {
                        lat: scrubPoint.s3.lat,
                        lon: scrubPoint.s3.lon,
                        headingDeg: scrubPoint.s3.headingDeg,
                      }
                    : null
                }
                heatmapMode={mapLayerMode}
                showSpeedBadges={showMapPeaks}
                compactCarMarkers={true}
                autoFollowCar={replayAutoFollow}
                onAutoFollowPausedByUser={() => setReplayAutoFollow(false)}
                isExternalFullscreen={true}
                mapStyleIndex={fsMapStyleIdx}
                onCycleMapStyle={() => setFsMapStyleIdx((v) => (v + 1) % 3)}
                containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
              />
            </div>

            {/* Metade Inferior: Barra de Replay no Topo + Zoom por Setor + 3 Cards V1/V2/V3 + Gráficos com touch-pan-y */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#090A0D]">
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden p-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {/* Barra de Controle de Replay no Topo da Análise */}
                {renderReplayControlBar(true)}

                {/* Botões Rápidos de Zoom por Setor em Tela Cheia */}
                {renderSectorZoomButtons()}

                {/* Distância Atual em Destaque */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-1.5 font-mono text-xs tabular-nums">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                      Distância Atual:
                    </span>
                    <span className="text-sm font-black text-[var(--ps-amber)]">
                      {scrubPoint.distKmStr} km
                    </span>
                    <span className="text-[11px] font-bold text-[var(--ps-muted)]">
                      ({scrubPoint.distM}m)
                    </span>
                    {scrubPoint.speed1 !== null && (
                      <span className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-black text-[var(--ps-emerald)]">
                        V1 {scrubPoint.speed1} km/h
                      </span>
                    )}
                    {showLap2 && scrubPoint.speed2 !== null && (
                      <span className="rounded-md border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-xs font-black text-[#FF2A2A]">
                        V2 {scrubPoint.speed2} km/h
                      </span>
                    )}
                    {showLap3 && scrubPoint.speed3 !== null && (
                      <span className="rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-xs font-black text-[#38BDF8]">
                        V3 {scrubPoint.speed3} km/h
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => scrubByManualDist(viewStartM)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 py-0.5 text-[10px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Início</span>
                  </button>
                </div>

                {/* Comparativo por Setores + Diagnóstico + Curvas Críticas */}
                {renderSectorComparisonCards(true)}
                {renderImprovementDiagnosticCard(true)}
                {renderCriticalCornersComparison(true)}

                {/* Gráfico de Velocidade & Zonas Acel/Frenagem sincronizado */}
                <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                    <span className="font-bold uppercase">
                      Velocidade (km/h) &amp; Zonas Acel/Frenagem (Toque)
                    </span>
                    <span className="flex items-center gap-2 font-bold">
                      <span className="text-[var(--ps-emerald)]">VOLTA 1</span>
                      {showLap2 && <span className="text-[#FF2A2A]">VOLTA 2</span>}
                      {showLap3 && <span className="text-[#38BDF8]">VOLTA 3</span>}
                    </span>
                  </div>
                  <svg
                    ref={fsPanelRef}
                    viewBox={`0 0 ${chartW} ${p1H}`}
                    className="h-[148px] min-h-[140px] w-full touch-pan-y select-none cursor-crosshair sm:h-52"
                    onPointerDown={(e) => {
                      if (e.pointerType === 'mouse') {
                        isDraggingRef.current = true;
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }
                      updateScrubFromSvg(fsPanelRef.current, e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                        updateScrubFromSvg(fsPanelRef.current, e.clientX);
                      }
                    }}
                    onPointerUp={(e) => {
                      isDraggingRef.current = false;
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                    onPointerCancel={() => {
                      isDraggingRef.current = false;
                    }}
                  >
                  {yTicksKmh.map((val) => {
                    const y = yAtKmh(val);
                    return (
                      <g key={`fs_p1_y_${val}`}>
                        <line
                          x1={padL}
                          y1={y}
                          x2={chartW - padR}
                          y2={y}
                          stroke="var(--ps-border-strong)"
                          strokeOpacity="0.65"
                          strokeDasharray={val === 0 ? undefined : '3 3'}
                        />
                        <text
                          x={padL - 5}
                          y={y + 3}
                          textAnchor="end"
                          fill="var(--ps-muted)"
                          fontSize="9"
                          fontFamily="monospace"
                        >
                          {val}
                        </text>
                      </g>
                    );
                  })}

                  <rect
                    x={padL}
                    y={zoneStripY}
                    width={plotW}
                    height={zoneStripH}
                    rx="2"
                    fill="var(--ps-card-deep)"
                  />
                  {v1ZoneSegments.map((seg, idx) => (
                    <rect
                      key={`fs_zone_${idx}`}
                      x={seg.x1}
                      y={zoneStripY}
                      width={Math.max(1.5, seg.x2 - seg.x1)}
                      height={zoneStripH}
                      fill={seg.kind === 'accel' ? '#10B981' : '#FF2A2A'}
                      fillOpacity="0.82"
                    />
                  ))}

                  {speedArea1 && (
                    <polygon fill="rgba(16, 185, 129, 0.14)" points={speedArea1} />
                  )}
                  {speedLine1 && (
                    <polyline
                      fill="none"
                      stroke="#10B981"
                      strokeWidth="2.5"
                      points={speedLine1}
                    />
                  )}
                  {showLap2 && speedLine2 && (
                    <polyline
                      fill="none"
                      stroke="#FF2A2A"
                      strokeWidth="2"
                      points={speedLine2}
                    />
                  )}
                  {showLap3 && speedLine3 && (
                    <polyline
                      fill="none"
                      stroke="#38BDF8"
                      strokeWidth="1.8"
                      strokeDasharray="5 3"
                      points={speedLine3}
                    />
                  )}

                  {criticalMarkers.map((pt, idx) => {
                    const cx = xAtM(pt.distM);
                    const cy = yAtKmh(pt.speedKmh);
                    const isMin = pt.badge === 'MIN';
                    const badgeW = 26;
                    const badgeH = 12;
                    const bx = Math.max(
                      padL + 2,
                      Math.min(chartW - padR - badgeW - 2, cx - badgeW / 2)
                    );
                    const by = Math.max(
                      p1Top + 1,
                      Math.min(p1Bottom - badgeH - 1, isMin ? cy + 7 : cy - badgeH - 7)
                    );
                    const bg = isMin ? '#10B981' : '#F59E0B';
                    const fg = isMin ? '#FFFFFF' : '#050608';
                    return (
                      <g
                        key={`fs_crit_${pt.badge}_${pt.distM}_${idx}`}
                        className="pointer-events-none"
                      >
                        <line
                          x1={cx}
                          y1={cy}
                          x2={cx}
                          y2={isMin ? by : by + badgeH}
                          stroke={bg}
                          strokeWidth="1"
                        />
                        <circle
                          cx={cx}
                          cy={cy}
                          r="2.8"
                          fill={bg}
                          stroke="#FFFFFF"
                          strokeWidth="0.9"
                        />
                        <rect x={bx} y={by} width={badgeW} height={badgeH} rx="3" fill={bg} />
                        <text
                          x={bx + badgeW / 2}
                          y={by + 8.8}
                          textAnchor="middle"
                          fill={fg}
                          fontSize="7.5"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          {pt.badge}
                        </text>
                      </g>
                    );
                  })}

                  {xTicksM.map((mVal, i) => (
                    <text
                      key={`fs_x_${mVal}_${i}`}
                      x={xAtM(mVal)}
                      y={p1H - 4}
                      textAnchor={
                        i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'
                      }
                      fill="var(--ps-muted)"
                      fontSize="8.5"
                      fontFamily="monospace"
                    >
                      {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                    </text>
                  ))}

                  <line
                    x1={scrubX}
                    y1={p1Top}
                    x2={scrubX}
                    y2={p1Bottom}
                    stroke="#FF2A2A"
                    strokeWidth="2"
                  />
                  {scrubPoint.speed1 !== null && (
                    <circle
                      cx={scrubX}
                      cy={yAtKmh(scrubPoint.speed1)}
                      r="4.2"
                      fill="#10B981"
                      stroke="#FFFFFF"
                      strokeWidth="1.4"
                    />
                  )}
                  {showLap2 && scrubPoint.speed2 !== null && (
                    <circle
                      cx={scrubX}
                      cy={yAtKmh(scrubPoint.speed2)}
                      r="3.8"
                      fill="#FF2A2A"
                      stroke="#FFFFFF"
                      strokeWidth="1.2"
                    />
                  )}
                  {showLap3 && scrubPoint.speed3 !== null && (
                    <circle
                      cx={scrubX}
                      cy={yAtKmh(scrubPoint.speed3)}
                      r="3.8"
                      fill="#38BDF8"
                      stroke="#FFFFFF"
                      strokeWidth="1.2"
                    />
                  )}
                </svg>
              </div>

              {(showLap2 || showLap3) && (
                <div className="touch-pan-y rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                    <span className="font-bold uppercase">
                      Time Slip · Delta de Tempo (ΔT vs VOLTA 1)
                    </span>
                    <span>
                      <strong className="text-[var(--ps-emerald)]">Verde = Mais Rápido</strong> ·{' '}
                      <strong className="text-[#FF2A2A]">Vermelho = Mais Lento</strong>
                    </span>
                  </div>
                  <svg
                    ref={fsTimeSlipRef}
                    viewBox={`0 0 ${chartW} ${pTsH}`}
                    className="h-[140px] min-h-[140px] w-full touch-pan-y select-none cursor-crosshair sm:h-40"
                    onPointerDown={(e) => {
                      if (e.pointerType === 'mouse') {
                        isDraggingRef.current = true;
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }
                      updateScrubFromSvg(fsTimeSlipRef.current, e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (e.pointerType === 'mouse' && (isDraggingRef.current || e.buttons === 1)) {
                        updateScrubFromSvg(fsTimeSlipRef.current, e.clientX);
                      }
                    }}
                    onPointerUp={(e) => {
                      isDraggingRef.current = false;
                      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }
                    }}
                    onPointerCancel={() => {
                      isDraggingRef.current = false;
                    }}
                  >
                    <defs>
                      <clipPath id="fs-ts-clip-gain">
                        <rect x={padL} y={pTsTop - 4} width={plotW} height={pTsMidY - pTsTop + 4} />
                      </clipPath>
                      <clipPath id="fs-ts-clip-loss">
                        <rect x={padL} y={pTsMidY} width={plotW} height={pTsBottom - pTsMidY + 4} />
                      </clipPath>
                    </defs>

                    {[-maxTimeSlipScaleSec, 0, maxTimeSlipScaleSec].map((dTick) => {
                      const y = yAtTimeSlip(dTick);
                      return (
                        <g key={`fs_ts_y_${dTick}`}>
                          <line
                            x1={padL}
                            y1={y}
                            x2={chartW - padR}
                            y2={y}
                            stroke={dTick === 0 ? 'var(--ps-muted)' : 'var(--ps-border)'}
                            strokeOpacity={dTick === 0 ? '0.65' : '0.8'}
                            strokeDasharray={dTick === 0 ? undefined : '3 3'}
                          />
                          <text
                            x={padL - 5}
                            y={y + 3}
                            textAnchor="end"
                            fill={
                              dTick < 0 ? '#10B981' : dTick > 0 ? '#FF2A2A' : 'var(--ps-text)'
                            }
                            fontSize="8.5"
                            fontFamily="monospace"
                          >
                            {dTick === 0
                              ? '0.0s'
                              : `${dTick > 0 ? '+' : ''}${dTick.toFixed(1)}s`}
                          </text>
                        </g>
                      );
                    })}

                    {primaryTimeSlipPolys.posPoly && (
                      <polygon fill="#10B981" fillOpacity="0.28" points={primaryTimeSlipPolys.posPoly} />
                    )}
                    {primaryTimeSlipPolys.negPoly && (
                      <polygon fill="#FF2A2A" fillOpacity="0.28" points={primaryTimeSlipPolys.negPoly} />
                    )}
                    {primaryTimeSlipPolys.linePts && (
                      <>
                        <polyline
                          fill="none"
                          stroke="#10B981"
                          strokeWidth="2.2"
                          clipPath="url(#fs-ts-clip-gain)"
                          points={primaryTimeSlipPolys.linePts}
                        />
                        <polyline
                          fill="none"
                          stroke="#FF2A2A"
                          strokeWidth="2.2"
                          clipPath="url(#fs-ts-clip-loss)"
                          points={primaryTimeSlipPolys.linePts}
                        />
                      </>
                    )}
                    {showLap2 && timeSlipLine3 && (
                      <polyline
                        fill="none"
                        stroke="#38BDF8"
                        strokeWidth="1.6"
                        strokeDasharray="4 3"
                        points={timeSlipLine3}
                      />
                    )}
                    <line
                      x1={scrubX}
                      y1={pTsTop}
                      x2={scrubX}
                      y2={pTsBottom}
                      stroke="#FF2A2A"
                      strokeWidth="1.8"
                    />
                    {(showLap2 ? scrubPoint.timeDelta2vs1Sec : scrubPoint.timeDelta3vs1Sec) !==
                      null && (() => {
                      const activeDelta = showLap2
                        ? scrubPoint.timeDelta2vs1Sec!
                        : scrubPoint.timeDelta3vs1Sec!;
                      return (
                        <circle
                          cx={scrubX}
                          cy={yAtTimeSlip(activeDelta)}
                          r="3.8"
                          fill={activeDelta <= 0 ? '#10B981' : '#FF2A2A'}
                          stroke="#FFFFFF"
                          strokeWidth="1.3"
                        />
                      );
                    })()}
                  </svg>
                </div>
              )}
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
});
