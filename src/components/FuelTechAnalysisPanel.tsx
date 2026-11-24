import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Award,
  Crosshair,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import {
  buildTrackSectors,
  computeBrakePointOffsetNearDist,
  computeMultiLapSectorComparison,
  computeRunSectorMetrics,
  detectTelemetryCriticalPoints,
  ensureTraceGForces,
  formatStageDuration,
  getOrderedTrackTraps,
  interpolateSampleAtDist,
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

export const FuelTechAnalysisPanel: React.FC<FuelTechAnalysisPanelProps> = ({
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
  }, [lap1?.id, lap2?.id, lap3?.id]);

  useEffect(() => {
    if (proFullscreen) return;
    setScrubDistM((prev) => {
      if (prev < viewStartM || prev > viewEndM) {
        return Math.round((viewStartM + viewEndM) / 2);
      }
      return prev;
    });
  }, [viewStartM, viewEndM, proFullscreen]);

  useEffect(() => {
    if (!proReplayPlaying) return;
    const minM = proFullscreen ? 0 : Math.round(viewStartM);
    const totalM = proFullscreen ? Math.round(maxDistM) : Math.round(viewEndM);
    const stepM = Math.max(4, Math.round((totalM - minM) / 220));
    const timer = window.setInterval(() => {
      setScrubDistM((prev) => {
        const next = prev + stepM;
        if (next >= totalM) {
          setProReplayPlaying(false);
          return totalM;
        }
        return next;
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [proFullscreen, proReplayPlaying, maxDistM, viewStartM, viewEndM]);

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

    const perRunMetrics = orderedRuns.map((run) => ({
      run,
      metrics: computeRunSectorMetrics(run, sectors),
    }));

    const bestRunMetrics =
      bestRun
        ? perRunMetrics.find((item) => item.run.id === bestRun.id)?.metrics ?? []
        : [];
    const refRunMetrics =
      refRun
        ? perRunMetrics.find((item) => item.run.id === refRun.id)?.metrics ?? []
        : [];

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
      bestSectorMsList,
      theoreticalBestMs,
      potentialGainSec,
      consistencyPct,
    };
  }, [sessionRuns, sessionTrack, lap1]);

  const jumpToSectorStart = (fromDistKm: number) => {
    const targetM = Math.max(0, Math.min(Math.round(maxDistM), Math.round(fromDistKm * 1000)));
    setProReplayPlaying(false);
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

  // Cursor telemetry summary (Vel V1 vs V2, Long/Lat G, Brake Point Offset in meters)
  const scrubPoint = useMemo(() => {
    const distKm = scrubDistM / 1000;
    const s1 = interpolateSampleAtDist(lap1Samples, distKm);
    const s2 = showLap2 ? interpolateSampleAtDist(lap2Samples, distKm) : null;
    const s3 = showLap3 ? interpolateSampleAtDist(lap3Samples, distKm) : null;

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
      s2 && s1
        ? Number(((s2.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(2))
        : null;
    const timeDelta3vs1Sec =
      s3 && s1
        ? Number(((s3.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(2))
        : null;

    const brakeOffset2 = showLap2
      ? computeBrakePointOffsetNearDist(lap1Samples, lap2Samples, scrubDistM)
      : null;
    const brakeOffset3 = showLap3
      ? computeBrakePointOffsetNearDist(lap1Samples, lap3Samples, scrubDistM)
      : null;

    return {
      distM: Math.round(scrubDistM),
      distKmStr: (scrubDistM / 1000).toFixed(3),
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
      brakeOffset2,
      brakeOffset3,
    };
  }, [scrubDistM, lap1Samples, lap2Samples, lap3Samples, showLap2, showLap3]);

  const updateScrubFromSvg = (svg: SVGSVGElement | null, clientX: number) => {
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chartW;
    const ratio = Math.max(0, Math.min(1, (svgX - padL) / plotW));
    setScrubDistM(Math.round(viewStartM + ratio * viewSpanM));
  };

  const yTicksKmh = [maxSpd, Math.round(maxSpd * 0.5), 0];
  const xTicksM = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(viewStartM + viewSpanM * f));
  const scrubX = xAtM(scrubDistM);

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

  // Fullscreen full-lap series (0m .. maxDistM) so scrubber and graph span the entire lap smoothly
  const fsSamples1 = useMemo(
    () => sampleSeriesInWindow(lap1Samples, 0, maxDistM, 150),
    [lap1Samples, maxDistM]
  );
  const fsSamples2 = useMemo(
    () => (showLap2 ? sampleSeriesInWindow(lap2Samples, 0, maxDistM, 150) : []),
    [showLap2, lap2Samples, maxDistM]
  );
  const fsSamples3 = useMemo(
    () => (showLap3 ? sampleSeriesInWindow(lap3Samples, 0, maxDistM, 150) : []),
    [showLap3, lap3Samples, maxDistM]
  );
  const fsMaxSpd = useMemo(() => {
    const peak = Math.max(
      90,
      ...fsSamples1.map((s) => s.speedKmh || 0),
      ...fsSamples2.map((s) => s.speedKmh || 0),
      ...fsSamples3.map((s) => s.speedKmh || 0)
    );
    return Math.ceil(peak / 20) * 20;
  }, [fsSamples1, fsSamples2, fsSamples3]);

  const fsXAtM = (distM: number) =>
    padL + Math.max(0, Math.min(1, distM / Math.max(20, maxDistM))) * plotW;
  const fsYAtKmh = (kmh: number) =>
    p1Top + p1PlotH - Math.max(0, Math.min(1, kmh / fsMaxSpd)) * p1PlotH;

  const { fsSpeedLine1, fsSpeedArea1 } = useMemo(() => {
    if (fsSamples1.length < 2) return { fsSpeedLine1: '', fsSpeedArea1: '' };
    const pts = fsSamples1.map(
      (s) => `${fsXAtM(s.distKm * 1000).toFixed(1)},${fsYAtKmh(s.speedKmh).toFixed(1)}`
    );
    const firstX = fsXAtM(fsSamples1[0].distKm * 1000).toFixed(1);
    const lastX = fsXAtM(fsSamples1[fsSamples1.length - 1].distKm * 1000).toFixed(1);
    const baseStr = p1Bottom.toFixed(1);
    return {
      fsSpeedLine1: pts.join(' '),
      fsSpeedArea1: `${firstX},${baseStr} ${pts.join(' ')} ${lastX},${baseStr}`,
    };
  }, [fsSamples1, maxDistM, fsMaxSpd]);

  const fsSpeedLine2 = useMemo(
    () =>
      fsSamples2
        .map((s) => `${fsXAtM(s.distKm * 1000).toFixed(1)},${fsYAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [fsSamples2, maxDistM, fsMaxSpd]
  );
  const fsSpeedLine3 = useMemo(
    () =>
      fsSamples3
        .map((s) => `${fsXAtM(s.distKm * 1000).toFixed(1)},${fsYAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [fsSamples3, maxDistM, fsMaxSpd]
  );
  const fsZoneSegments = useMemo(() => {
    if (fsSamples1.length < 2) return [];
    const segs: Array<{ x1: number; x2: number; kind: 'accel' | 'brake' }> = [];
    for (let i = 0; i < fsSamples1.length - 1; i += 1) {
      const s = fsSamples1[i];
      const next = fsSamples1[i + 1];
      const g = s.accelLongG ?? 0;
      if (g > 0.08 || g < -0.15) {
        segs.push({
          x1: fsXAtM(s.distKm * 1000),
          x2: fsXAtM(next.distKm * 1000),
          kind: g > 0.08 ? 'accel' : 'brake',
        });
      }
    }
    return segs;
  }, [fsSamples1, maxDistM]);

  const fsCriticalMarkers = useMemo(
    () =>
      detectTelemetryCriticalPoints(lap1Samples)
        .filter((p) => p.type === 'TOP' || p.type === 'APEX')
        .map((p) => ({
          ...p,
          badge: p.type === 'TOP' ? ('TOP' as const) : ('MIN' as const),
        })),
    [lap1Samples]
  );

  const fsTimeSlip2Pts = useMemo(() => {
    if (!showLap2 || fsSamples1.length < 2 || fsSamples2.length < 2) return [];
    const commonMaxM = Math.min(maxDist1, maxDist2);
    const pts: Array<{ distM: number; deltaSec: number }> = [];
    const len = Math.min(fsSamples1.length, fsSamples2.length);
    for (let i = 0; i < len; i += 1) {
      const s1 = fsSamples1[i];
      const s2 = fsSamples2[i];
      const dM = s1.distKm * 1000;
      if (dM > commonMaxM + 5) break;
      pts.push({
        distM: dM,
        deltaSec: Number(((s2.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(3)),
      });
    }
    return pts;
  }, [showLap2, fsSamples1, fsSamples2, maxDist1, maxDist2]);

  const fsTimeSlip3Pts = useMemo(() => {
    if (!showLap3 || fsSamples1.length < 2 || fsSamples3.length < 2) return [];
    const commonMaxM = Math.min(maxDist1, maxDist3);
    const pts: Array<{ distM: number; deltaSec: number }> = [];
    const len = Math.min(fsSamples1.length, fsSamples3.length);
    for (let i = 0; i < len; i += 1) {
      const s1 = fsSamples1[i];
      const s3 = fsSamples3[i];
      const dM = s1.distKm * 1000;
      if (dM > commonMaxM + 5) break;
      pts.push({
        distM: dM,
        deltaSec: Number(((s3.stageElapsedMs - s1.stageElapsedMs) / 1000).toFixed(3)),
      });
    }
    return pts;
  }, [showLap3, fsSamples1, fsSamples3, maxDist1, maxDist3]);

  const fsPrimaryTimeSlipPts = showLap2 ? fsTimeSlip2Pts : fsTimeSlip3Pts;
  const fsMaxTimeSlipScaleSec = useMemo(() => {
    const peak = Math.max(
      0.5,
      ...fsTimeSlip2Pts.map((p) => Math.abs(p.deltaSec)),
      ...fsTimeSlip3Pts.map((p) => Math.abs(p.deltaSec))
    );
    return Math.min(15, Math.ceil(peak * 2) / 2);
  }, [fsTimeSlip2Pts, fsTimeSlip3Pts]);

  const fsYAtTimeSlip = (deltaSec: number) => {
    const clamped = Math.max(-fsMaxTimeSlipScaleSec, Math.min(fsMaxTimeSlipScaleSec, -deltaSec));
    return pTsMidY - (clamped / fsMaxTimeSlipScaleSec) * (pTsPlotH / 2);
  };

  const fsPrimaryTimeSlipPolys = useMemo(
    () =>
      buildBicolorAreaPolygons(
        fsPrimaryTimeSlipPts.map((p) => ({ x: fsXAtM(p.distM), val: -p.deltaSec })),
        (gainVal) => fsYAtTimeSlip(-gainVal),
        pTsMidY
      ),
    [fsPrimaryTimeSlipPts, maxDistM, fsMaxTimeSlipScaleSec]
  );

  const fsTimeSlipLine3 = useMemo(() => {
    if (!showLap2 || fsTimeSlip3Pts.length < 2) return '';
    return fsTimeSlip3Pts
      .map((p) => `${fsXAtM(p.distM).toFixed(1)},${fsYAtTimeSlip(p.deltaSec).toFixed(1)}`)
      .join(' ');
  }, [showLap2, fsTimeSlip3Pts, maxDistM, fsMaxTimeSlipScaleSec]);

  const fsYTicksKmh = [fsMaxSpd, Math.round(fsMaxSpd * 0.5), 0];
  const fsXTicksM = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxDistM * f));
  const fsScrubX = fsXAtM(scrubDistM);

  const updateFsScrubFromSvg = (svg: SVGSVGElement | null, clientX: number) => {
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chartW;
    const ratio = Math.max(0, Math.min(1, (svgX - padL) / plotW));
    setScrubDistM(Math.round(ratio * maxDistM));
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
                {raceChronoMatrix.orderedRuns.map(({ run, metrics }) => {
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
                        const secBest = raceChronoMatrix.bestSectorMsList[idx];
                        const refLapSecMs =
                          raceChronoMatrix.refRunMetrics[idx]?.durationMs ?? secBest;
                        const isSecRecord =
                          m.durationMs !== null &&
                          secBest !== null &&
                          Math.abs(m.durationMs - secBest) <= 15;
                        const isFasterThanRefLap =
                          m.durationMs !== null &&
                          refLapSecMs !== null &&
                          m.durationMs - refLapSecMs < -15;
                        const isSlower =
                          m.durationMs !== null &&
                          refLapSecMs !== null &&
                          m.durationMs - refLapSecMs > 15;
                        const sec = raceChronoMatrix.sectors[idx];

                        return (
                          <td
                            key={`mtx_${run.id}_p_${idx}`}
                            className={`px-2 py-2 text-right whitespace-nowrap font-bold ${
                              isSecRecord
                                ? 'bg-emerald-500/15 text-[var(--ps-emerald)] font-black'
                                : isFasterThanRefLap
                                  ? 'text-[var(--ps-emerald)]'
                                  : isSlower
                                    ? 'text-[#FF2A2A]'
                                    : 'text-[var(--ps-text)]'
                            }`}
                          >
                            {sec ? (
                              <button
                                type="button"
                                onClick={() => jumpToSectorStart(sec.fromDistKm)}
                                title={`Ir para P${sec.index} no mapa e gráfico`}
                                className="cursor-pointer hover:underline"
                              >
                                {formatSectorSec(m.durationMs)}
                              </button>
                            ) : (
                              formatSectorSec(m.durationMs)
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
              V1 #{lap1?.runNumber ?? '-'}
            </span>
            {showLap2 && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[#FF2A2A]">
                <span className="inline-block h-[2.5px] w-3.5 bg-[#FF2A2A]" />
                V2 #{lap2?.runNumber ?? '-'}
              </span>
            )}
            {showLap3 && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[#38BDF8]">
                <span className="inline-block w-3.5 border-t-2 border-dashed border-[#38BDF8]" />
                V3 #{lap3?.runNumber ?? '-'}
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
                      { id: 'laps', label: 'Por Volta (V1/V2/V3)' },
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
                    <span className="text-[#10B981]">━ V1</span>
                    {showLap2 && <span className="text-[#FF2A2A]">━ V2</span>}
                    {showLap3 && <span className="text-[#38BDF8]">━ V3</span>}
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
              onFullscreenToggle={() => setProFullscreen(true)}
              containerClassName="relative h-60 w-full overflow-hidden bg-[#000000] sm:h-80"
            />
          </div>
        )}

        {/* Botões de Zoom por Trecho / Parcial */}
        {sectorComparison.rows.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
              <ZoomIn className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
              <span>Zoom:</span>
            </span>
            <button
              type="button"
              onClick={() => setZoomSectorIdx(null)}
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
                onClick={() => setZoomSectorIdx(row.index)}
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
        )}

        {/* Resumo Prático Fixo ao Tocar no Gráfico (VEL + ΔT TIME SLIP + ACEL/FREIO G + FRENAGEM) */}
        {lap1Samples.length > 1 && (
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-2 font-mono text-[10px] tabular-nums lg:grid-cols-4 sm:text-[11px]">
            {/* 1. Vel V1 vs V2 (Δ km/h) */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">
                Vel V1 vs V2 @ {scrubPoint.distKmStr} km
              </span>
              <p className="mt-0.5 font-extrabold">
                <span className="text-[var(--ps-emerald)]">{scrubPoint.speed1 ?? '--'}</span>
                {showLap2 ? (
                  <>
                    <span className="text-[var(--ps-muted)]"> vs </span>
                    <span className="text-[#FF2A2A]">{scrubPoint.speed2 ?? '--'} km/h</span>
                    <span
                      className={`ml-1.5 ${
                        (scrubPoint.speedDelta2vs1 ?? 0) >= 0
                          ? 'text-[var(--ps-emerald)]'
                          : 'text-[#FF2A2A]'
                      }`}
                    >
                      ({formatSignedKmh(scrubPoint.speedDelta2vs1)} km/h)
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--ps-muted)]"> km/h</span>
                )}
                {showLap3 && (
                  <span className="ml-2 text-[#38BDF8]">
                    · V3: {scrubPoint.speed3 ?? '--'} ({formatSignedKmh(scrubPoint.speedDelta3vs1)})
                  </span>
                )}
              </p>
            </div>

            {/* 2. Time Slip / Delta de Tempo Instantâneo (ΔT) */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">
                Time Slip (ΔT) @ {scrubPoint.distM}m
              </span>
              <p className="mt-0.5 font-extrabold">
                {showLap2 && scrubPoint.timeDelta2vs1Sec !== null ? (
                  <>
                    <span
                      className={
                        scrubPoint.timeDelta2vs1Sec <= 0
                          ? 'text-[var(--ps-emerald)]'
                          : 'text-[#FF2A2A]'
                      }
                    >
                      V2 {formatSignedSec(scrubPoint.timeDelta2vs1Sec)}
                    </span>
                    <span
                      className={`ml-1.5 rounded px-1 py-0.5 text-[9px] font-black ${
                        scrubPoint.timeDelta2vs1Sec <= 0
                          ? 'bg-emerald-500/15 text-[var(--ps-emerald)]'
                          : 'bg-red-500/15 text-[#FF2A2A]'
                      }`}
                    >
                      {scrubPoint.timeDelta2vs1Sec <= 0 ? 'GANHO' : 'PERDA'}
                    </span>
                  </>
                ) : showLap3 && scrubPoint.timeDelta3vs1Sec !== null ? (
                  <span
                    className={
                      scrubPoint.timeDelta3vs1Sec <= 0
                        ? 'text-[var(--ps-emerald)]'
                        : 'text-[#FF2A2A]'
                    }
                  >
                    V3 {formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                  </span>
                ) : (
                  <span className="text-[var(--ps-muted)]">--.--s (selecione V2)</span>
                )}
                {showLap2 && showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                  <span className="ml-2 text-[#38BDF8]">
                    · V3 {formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                  </span>
                )}
              </p>
            </div>

            {/* 3. Frenagem / Aceleração (G) & Carga Lateral */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">Acel / Frenagem &amp; Lat G</span>
              <p className="mt-0.5 font-extrabold">
                <span className="text-[var(--ps-emerald)]">
                  {scrubPoint.longG1 >= 0 ? '+' : ''}
                  {scrubPoint.longG1.toFixed(2)}G
                </span>
                {showLap2 && (
                  <span className="text-[var(--ps-amber)]">
                    {' '}
                    / V2 {scrubPoint.longG2 >= 0 ? '+' : ''}
                    {scrubPoint.longG2.toFixed(2)}G
                  </span>
                )}
                <span className="text-[var(--ps-muted)]">
                  {' '}
                  · Lat {Math.abs(scrubPoint.latG1).toFixed(2)}G
                  {showLap2 ? `/${Math.abs(scrubPoint.latG2).toFixed(2)}G` : ''}
                </span>
              </p>
            </div>

            {/* 4. Distância do Ponto de Frenagem */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">Ponto de Frenagem (V2 vs V1)</span>
              <p className="mt-0.5 font-extrabold">
                {!showLap2 ? (
                  <span className="text-[var(--ps-muted)]">Selecione V2 para comparar freada</span>
                ) : scrubPoint.brakeOffset2 ? (
                  scrubPoint.brakeOffset2.offsetM > 0 ? (
                    <span className="text-[var(--ps-emerald)]">
                      V2 freou +{scrubPoint.brakeOffset2.offsetM}m mais tarde
                    </span>
                  ) : scrubPoint.brakeOffset2.offsetM < 0 ? (
                    <span className="text-[#FF2A2A]">
                      V2 freou {Math.abs(scrubPoint.brakeOffset2.offsetM)}m antes
                    </span>
                  ) : (
                    <span className="text-[var(--ps-amber)]">Mesmo ponto de freada (0m)</span>
                  )
                ) : (
                  <span className="text-[var(--ps-muted)]">Trecho de reta / sem freada próxima</span>
                )}
              </p>
            </div>
          </div>
        )}

        {/* PAINÉIS SINCRONIZADOS (1: Velocidade, 2: Pedal Virtual, 3: Força Lateral) */}
        {lap1Samples.length > 1 ? (
          <div className="space-y-2">
            {/* PAINEL 1 — VELOCIDADE (km/h) + ZONAS ACEL/FREIO + TOP/MIN */}
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 1 · Velocidade (km/h) &amp; Zonas Acel/Frenagem
                </span>
                <span>TOP = Máxima · MIN = Ápice da Curva</span>
              </div>
              <svg
                ref={panel1Ref}
                viewBox={`0 0 ${chartW} ${p1H}`}
                className="h-44 w-full touch-none select-none cursor-crosshair sm:h-48"
                onPointerDown={(e) => {
                  isDraggingRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateScrubFromSvg(panel1Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingRef.current && e.pointerType === 'touch') return;
                  if (isDraggingRef.current || e.buttons === 1) {
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
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 2 · Time Slip / Delta de Tempo Contínuo (ΔT vs V1)
                </span>
                <span>
                  <strong className="text-[var(--ps-emerald)]">Verde (-s) = Mais Rápido</strong> ·{' '}
                  <strong className="text-[#FF2A2A]">Vermelho (+s) = Mais Lento</strong>
                  {showLap2 && showLap3 ? ' · Tracejado Ciano = V3' : ''}
                </span>
              </div>
              {showLap2 || showLap3 ? (
                <svg
                  ref={panelTimeSlipRef}
                  viewBox={`0 0 ${chartW} ${pTsH}`}
                  className="h-28 w-full touch-none select-none cursor-crosshair sm:h-32"
                  onPointerDown={(e) => {
                    isDraggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    updateScrubFromSvg(panelTimeSlipRef.current, e.clientX);
                  }}
                  onPointerMove={(e) => {
                    if (!isDraggingRef.current && e.pointerType === 'touch') return;
                    if (isDraggingRef.current || e.buttons === 1) {
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
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 3 · Pedal Virtual (Aceleração +G vs. Frenagem -G)
                </span>
                <span>
                  <strong className="text-[var(--ps-emerald)]">Verde = Acel</strong> ·{' '}
                  <strong className="text-[#FF2A2A]">Vermelho = Freio</strong>
                  {showLap2 ? ' · Linha Âmbar = V2' : ''}
                </span>
              </div>
              <svg
                ref={panel2Ref}
                viewBox={`0 0 ${chartW} ${p2H}`}
                className="h-32 w-full touch-none select-none cursor-crosshair sm:h-36"
                onPointerDown={(e) => {
                  isDraggingRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateScrubFromSvg(panel2Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingRef.current && e.pointerType === 'touch') return;
                  if (isDraggingRef.current || e.buttons === 1) {
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
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 4 · Força Lateral em Curva (Lat G)
                </span>
                <span>Aderência lateral (+Esq / -Dir)</span>
              </div>
              <svg
                ref={panel3Ref}
                viewBox={`0 0 ${chartW} ${p3H}`}
                className="h-32 w-full touch-none select-none cursor-crosshair sm:h-36"
                onPointerDown={(e) => {
                  isDraggingRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateScrubFromSvg(panel3Ref.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingRef.current && e.pointerType === 'touch') return;
                  if (isDraggingRef.current || e.buttons === 1) {
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

        {/* Slider fino de posição + Replay sincronizado com Mapa e os 3 painéis */}
        {lap1Samples.length > 1 && (
          <div className="space-y-2 pt-0.5">
            <div className="flex items-center gap-2">
              <Crosshair className="h-3.5 w-3.5 shrink-0 text-[var(--ps-amber)]" />
              <input
                type="range"
                aria-label="Cursor de distância sincronizado nos 3 painéis"
                min={Math.round(viewStartM)}
                max={Math.round(viewEndM)}
                value={Math.max(Math.round(viewStartM), Math.min(Math.round(viewEndM), scrubDistM))}
                onChange={(e) => {
                  setProReplayPlaying(false);
                  setScrubDistM(Number(e.target.value));
                }}
                className="w-full accent-[var(--ps-emerald)]"
              />
              <span className="shrink-0 font-mono text-[10px] font-bold text-[var(--ps-muted)] tabular-nums">
                {scrubPoint.distM}m/{Math.round(viewEndM)}m
              </span>
            </div>

            <div className="grid grid-cols-4 gap-1.5 font-mono text-[11px] font-extrabold">
              <button
                type="button"
                onClick={() => {
                  setProReplayPlaying(false);
                  setScrubDistM((prev) => Math.max(Math.round(viewStartM), prev - 10));
                }}
                className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-text)] hover:border-[var(--ps-border-strong)] active:scale-95"
              >
                -10m
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!proReplayPlaying && scrubDistM >= Math.round(viewEndM) - 5) {
                    setScrubDistM(Math.round(viewStartM));
                  }
                  setProReplayPlaying((v) => !v);
                }}
                className="pitstop-btn-red flex min-h-[34px] items-center justify-center gap-1 rounded-lg px-2 font-black active:scale-95"
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
              <button
                type="button"
                onClick={() => {
                  setProReplayPlaying(false);
                  setScrubDistM((prev) => Math.min(Math.round(viewEndM), prev + 10));
                }}
                className="flex min-h-[34px] items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-text)] hover:border-[var(--ps-border-strong)] active:scale-95"
              >
                +10m
              </button>
              <button
                type="button"
                onClick={() => {
                  setProReplayPlaying(false);
                  setScrubDistM(Math.round(viewStartM));
                }}
                className="flex min-h-[34px] items-center justify-center gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 text-[var(--ps-muted)] hover:text-[var(--ps-text)] active:scale-95"
                title="Voltar cursor ao início do trecho"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Início</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* MODO ANÁLISE PRO EM TELA CHEIA (MAPA ~45% + TELEMETRIA/GRÁFICO + CONTROLES ~55%) */}
      {proFullscreen && lap1Samples.length > 1 && (
        <div
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--ps-bg)] text-[var(--ps-text)]"
          role="dialog"
          aria-modal="true"
          aria-label="Análise Pro em Tela Cheia"
        >
          {/* Barra Superior Compacta */}
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--ps-border)] bg-[var(--ps-surface)] px-2.5 py-2 font-mono text-[11px] tabular-nums">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setProFullscreen(false);
                  setProReplayPlaying(false);
                }}
                className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                <ArrowLeft className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                <span>Voltar</span>
              </button>
              <span className="font-bold text-[var(--ps-text)]">
                Dist: <strong className="text-[var(--ps-amber)]">{scrubPoint.distKmStr} km</strong>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-extrabold">
              <span>
                <span className="text-[var(--ps-emerald)]">V1: {scrubPoint.speed1 ?? '--'}</span>
                {showLap2 && (
                  <>
                    <span className="text-[var(--ps-muted)]"> vs </span>
                    <span className="text-[#FF2A2A]">V2: {scrubPoint.speed2 ?? '--'}</span>
                  </>
                )}
                {showLap3 && (
                  <>
                    <span className="text-[var(--ps-muted)]"> vs </span>
                    <span className="text-[#38BDF8]">V3: {scrubPoint.speed3 ?? '--'}</span>
                  </>
                )}
                <span className="text-[var(--ps-muted)]"> km/h</span>
              </span>

              {showLap2 && scrubPoint.timeDelta2vs1Sec !== null && (
                <span
                  className={
                    scrubPoint.timeDelta2vs1Sec <= 0
                      ? 'text-[var(--ps-emerald)]'
                      : 'text-[#FF2A2A]'
                  }
                >
                  Δ Tempo V2: {formatSignedSec(scrubPoint.timeDelta2vs1Sec)}
                </span>
              )}
            </div>
          </header>

          {/* Metade Superior (~44%): Mapa Satélite Interativo Fixo */}
          <div className="relative h-[44dvh] shrink-0 border-b border-[var(--ps-border)] bg-[#000000]">
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
              isExternalFullscreen={true}
              onFullscreenToggle={() => {
                setProFullscreen(false);
                setProReplayPlaying(false);
              }}
              topLeftOverlay={
                <div className="pointer-events-auto inline-flex items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 p-1 font-mono text-[9px] font-bold backdrop-blur-xs">
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
                      className={`rounded px-1.5 py-0.5 font-extrabold transition-colors ${
                        mapLayerMode === opt.id
                          ? 'pitstop-btn-red'
                          : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <span className="mx-0.5 h-3 w-px bg-[var(--ps-border)]" />
                  <button
                    type="button"
                    aria-pressed={showMapPeaks}
                    onClick={() => setShowMapPeaks((v) => !v)}
                    className={`rounded px-1.5 py-0.5 font-extrabold transition-colors ${
                      showMapPeaks
                        ? 'bg-amber-500/20 text-[var(--ps-amber)]'
                        : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    Picos
                  </button>
                  <button
                    type="button"
                    aria-pressed={showMapSplits}
                    onClick={() => setShowMapSplits((v) => !v)}
                    className={`rounded px-1.5 py-0.5 font-extrabold transition-colors ${
                      showMapSplits
                        ? 'bg-sky-500/20 text-sky-400'
                        : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    Parciais
                  </button>
                </div>
              }
              containerClassName="relative h-full w-full overflow-hidden bg-[#000000]"
            />
          </div>

          {/* Metade Inferior (~56%): Leituras instantâneas + Gráfico + Controles ergonômicos */}
          <div className="flex min-h-0 flex-1 flex-col bg-[var(--ps-bg)]">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
              {/* Card de Leitura Instantânea */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 font-mono text-[10px] tabular-nums lg:grid-cols-4 sm:text-[11px]">
                <div>
                  <span className="text-[var(--ps-muted)] uppercase">
                    Velocidade @ {scrubPoint.distKmStr} km
                  </span>
                  <p className="mt-0.5 font-extrabold">
                    <span className="text-[var(--ps-emerald)]">V1 {scrubPoint.speed1 ?? '--'}</span>
                    {showLap2 && (
                      <>
                        <span className="text-[var(--ps-muted)]"> vs </span>
                        <span className="text-[#FF2A2A]">V2 {scrubPoint.speed2 ?? '--'}</span>
                        <span
                          className={`ml-1 ${
                            (scrubPoint.speedDelta2vs1 ?? 0) >= 0
                              ? 'text-[var(--ps-emerald)]'
                              : 'text-[#FF2A2A]'
                          }`}
                        >
                          ({formatSignedKmh(scrubPoint.speedDelta2vs1)} km/h)
                        </span>
                      </>
                    )}
                    {showLap3 && (
                      <span className="ml-1.5 text-[#38BDF8]">
                        · V3 {scrubPoint.speed3 ?? '--'} ({formatSignedKmh(scrubPoint.speedDelta3vs1)})
                      </span>
                    )}
                  </p>
                </div>

                <div>
                  <span className="text-[var(--ps-muted)] uppercase">
                    Time Slip (ΔT) @ {scrubPoint.distM}m
                  </span>
                  <p className="mt-0.5 font-extrabold">
                    {showLap2 && scrubPoint.timeDelta2vs1Sec !== null ? (
                      <span
                        className={
                          scrubPoint.timeDelta2vs1Sec <= 0
                            ? 'text-[var(--ps-emerald)]'
                            : 'text-[#FF2A2A]'
                        }
                      >
                        V2 {formatSignedSec(scrubPoint.timeDelta2vs1Sec)}
                      </span>
                    ) : showLap3 && scrubPoint.timeDelta3vs1Sec !== null ? (
                      <span
                        className={
                          scrubPoint.timeDelta3vs1Sec <= 0
                            ? 'text-[var(--ps-emerald)]'
                            : 'text-[#FF2A2A]'
                        }
                      >
                        V3 {formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                      </span>
                    ) : (
                      <span className="text-[var(--ps-muted)]">--.--s</span>
                    )}
                    {showLap2 && showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                      <span className="ml-1.5 text-[#38BDF8]">
                        · V3 {formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                      </span>
                    )}
                  </p>
                </div>

                <div>
                  <span className="text-[var(--ps-muted)] uppercase">
                    Acel / Frenagem &amp; Lat G
                  </span>
                  <p className="mt-0.5 font-extrabold">
                    <span className="text-[var(--ps-emerald)]">
                      {scrubPoint.longG1 >= 0 ? '+' : ''}
                      {scrubPoint.longG1.toFixed(2)}G
                    </span>
                    {showLap2 && (
                      <span className="text-[var(--ps-amber)]">
                        {' '}
                        / V2 {scrubPoint.longG2 >= 0 ? '+' : ''}
                        {scrubPoint.longG2.toFixed(2)}G
                      </span>
                    )}
                    <span className="text-[var(--ps-muted)]">
                      {' '}
                      · Lat {Math.abs(scrubPoint.latG1).toFixed(2)}G
                      {showLap2 ? `/${Math.abs(scrubPoint.latG2).toFixed(2)}G` : ''}
                    </span>
                  </p>
                </div>

                <div>
                  <span className="text-[var(--ps-muted)] uppercase">
                    Ponto de Frenagem (V2 vs V1)
                  </span>
                  <p className="mt-0.5 font-extrabold">
                    {!showLap2 ? (
                      <span className="text-[var(--ps-muted)]">Selecione V2 para comparar</span>
                    ) : scrubPoint.brakeOffset2 ? (
                      scrubPoint.brakeOffset2.offsetM > 0 ? (
                        <span className="text-[var(--ps-emerald)]">
                          V2 freou +{scrubPoint.brakeOffset2.offsetM}m mais tarde
                        </span>
                      ) : scrubPoint.brakeOffset2.offsetM < 0 ? (
                        <span className="text-[#FF2A2A]">
                          V2 freou {Math.abs(scrubPoint.brakeOffset2.offsetM)}m antes
                        </span>
                      ) : (
                        <span className="text-[var(--ps-amber)]">Mesmo ponto de freada (0m)</span>
                      )
                    ) : (
                      <span className="text-[var(--ps-muted)]">Sem freada próxima</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Gráfico de Velocidade & Zonas Acel/Frenagem sincronizado */}
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                  <span className="font-bold uppercase">
                    Velocidade (km/h) &amp; Zonas Acel/Frenagem (Toque/Arraste)
                  </span>
                  <span className="flex items-center gap-2 font-bold">
                    <span className="text-[var(--ps-emerald)]">V1 #{lap1?.runNumber ?? '-'}</span>
                    {showLap2 && <span className="text-[#FF2A2A]">V2 #{lap2?.runNumber ?? '-'}</span>}
                    {showLap3 && <span className="text-[#38BDF8]">V3 #{lap3?.runNumber ?? '-'}</span>}
                  </span>
                </div>
                <svg
                  ref={fsPanelRef}
                  viewBox={`0 0 ${chartW} ${p1H}`}
                  className="h-44 w-full touch-none select-none cursor-crosshair sm:h-52"
                  onPointerDown={(e) => {
                    isDraggingRef.current = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    updateFsScrubFromSvg(fsPanelRef.current, e.clientX);
                  }}
                  onPointerMove={(e) => {
                    if (!isDraggingRef.current && e.pointerType === 'touch') return;
                    if (isDraggingRef.current || e.buttons === 1) {
                      updateFsScrubFromSvg(fsPanelRef.current, e.clientX);
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
                  {fsYTicksKmh.map((val) => {
                    const y = fsYAtKmh(val);
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

                  {/* Faixa de Aceleração / Frenagem */}
                  <rect
                    x={padL}
                    y={zoneStripY}
                    width={plotW}
                    height={zoneStripH}
                    rx="2"
                    fill="var(--ps-card-deep)"
                  />
                  {fsZoneSegments.map((seg, idx) => (
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

                  {fsSpeedArea1 && (
                    <polygon fill="rgba(16, 185, 129, 0.14)" points={fsSpeedArea1} />
                  )}
                  {fsSpeedLine1 && (
                    <polyline
                      fill="none"
                      stroke="#10B981"
                      strokeWidth="2.5"
                      points={fsSpeedLine1}
                    />
                  )}
                  {showLap2 && fsSpeedLine2 && (
                    <polyline
                      fill="none"
                      stroke="#FF2A2A"
                      strokeWidth="2"
                      points={fsSpeedLine2}
                    />
                  )}
                  {showLap3 && fsSpeedLine3 && (
                    <polyline
                      fill="none"
                      stroke="#38BDF8"
                      strokeWidth="1.8"
                      strokeDasharray="5 3"
                      points={fsSpeedLine3}
                    />
                  )}

                  {fsCriticalMarkers.map((pt, idx) => {
                    const cx = fsXAtM(pt.distM);
                    const cy = fsYAtKmh(pt.speedKmh);
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

                  {fsXTicksM.map((mVal, i) => (
                    <text
                      key={`fs_x_${mVal}_${i}`}
                      x={fsXAtM(mVal)}
                      y={p1H - 4}
                      textAnchor={
                        i === 0 ? 'start' : i === fsXTicksM.length - 1 ? 'end' : 'middle'
                      }
                      fill="var(--ps-muted)"
                      fontSize="8.5"
                      fontFamily="monospace"
                    >
                      {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                    </text>
                  ))}

                  <line
                    x1={fsScrubX}
                    y1={p1Top}
                    x2={fsScrubX}
                    y2={p1Bottom}
                    stroke="#FF2A2A"
                    strokeWidth="2"
                  />
                  {scrubPoint.speed1 !== null && (
                    <circle
                      cx={fsScrubX}
                      cy={fsYAtKmh(scrubPoint.speed1)}
                      r="4.2"
                      fill="#10B981"
                      stroke="#FFFFFF"
                      strokeWidth="1.4"
                    />
                  )}
                  {showLap2 && scrubPoint.speed2 !== null && (
                    <circle
                      cx={fsScrubX}
                      cy={fsYAtKmh(scrubPoint.speed2)}
                      r="3.8"
                      fill="#FF2A2A"
                      stroke="#FFFFFF"
                      strokeWidth="1.2"
                    />
                  )}
                  {showLap3 && scrubPoint.speed3 !== null && (
                    <circle
                      cx={fsScrubX}
                      cy={fsYAtKmh(scrubPoint.speed3)}
                      r="3.8"
                      fill="#38BDF8"
                      stroke="#FFFFFF"
                      strokeWidth="1.2"
                    />
                  )}
                </svg>
              </div>

              {(showLap2 || showLap3) && (
                <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                    <span className="font-bold uppercase">
                      Time Slip · Delta de Tempo (ΔT vs V1)
                    </span>
                    <span>
                      <strong className="text-[var(--ps-emerald)]">Verde = Mais Rápido</strong> ·{' '}
                      <strong className="text-[#FF2A2A]">Vermelho = Mais Lento</strong>
                    </span>
                  </div>
                  <svg
                    ref={fsTimeSlipRef}
                    viewBox={`0 0 ${chartW} ${pTsH}`}
                    className="h-24 w-full touch-none select-none cursor-crosshair sm:h-28"
                    onPointerDown={(e) => {
                      isDraggingRef.current = true;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      updateFsScrubFromSvg(fsTimeSlipRef.current, e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (!isDraggingRef.current && e.pointerType === 'touch') return;
                      if (isDraggingRef.current || e.buttons === 1) {
                        updateFsScrubFromSvg(fsTimeSlipRef.current, e.clientX);
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

                    {[-fsMaxTimeSlipScaleSec, 0, fsMaxTimeSlipScaleSec].map((dTick) => {
                      const y = fsYAtTimeSlip(dTick);
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

                    {fsPrimaryTimeSlipPolys.posPoly && (
                      <polygon fill="#10B981" fillOpacity="0.28" points={fsPrimaryTimeSlipPolys.posPoly} />
                    )}
                    {fsPrimaryTimeSlipPolys.negPoly && (
                      <polygon fill="#FF2A2A" fillOpacity="0.28" points={fsPrimaryTimeSlipPolys.negPoly} />
                    )}
                    {fsPrimaryTimeSlipPolys.linePts && (
                      <>
                        <polyline
                          fill="none"
                          stroke="#10B981"
                          strokeWidth="2.2"
                          clipPath="url(#fs-ts-clip-gain)"
                          points={fsPrimaryTimeSlipPolys.linePts}
                        />
                        <polyline
                          fill="none"
                          stroke="#FF2A2A"
                          strokeWidth="2.2"
                          clipPath="url(#fs-ts-clip-loss)"
                          points={fsPrimaryTimeSlipPolys.linePts}
                        />
                      </>
                    )}
                    {showLap2 && fsTimeSlipLine3 && (
                      <polyline
                        fill="none"
                        stroke="#38BDF8"
                        strokeWidth="1.6"
                        strokeDasharray="4 3"
                        points={fsTimeSlipLine3}
                      />
                    )}
                    <line
                      x1={fsScrubX}
                      y1={pTsTop}
                      x2={fsScrubX}
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
                          cx={fsScrubX}
                          cy={fsYAtTimeSlip(activeDelta)}
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

            {/* Controles Ergonômicos de Replay e Distância na Base */}
            <div className="shrink-0 space-y-2 border-t border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                <span className="shrink-0 font-bold text-[var(--ps-muted)]">0m</span>
                <input
                  type="range"
                  aria-label="Posição da distância na volta completa"
                  min={0}
                  max={Math.round(maxDistM)}
                  value={Math.max(0, Math.min(Math.round(maxDistM), scrubDistM))}
                  onChange={(e) => {
                    setProReplayPlaying(false);
                    setScrubDistM(Number(e.target.value));
                  }}
                  className="h-2 w-full accent-[var(--ps-accent)]"
                />
                <span className="shrink-0 font-bold text-[var(--ps-text)]">
                  {scrubPoint.distM}m / {Math.round(maxDistM)}m
                </span>
              </div>

              <div className="grid grid-cols-5 gap-1.5 font-mono text-xs font-extrabold">
                <button
                  type="button"
                  onClick={() => {
                    setProReplayPlaying(false);
                    setScrubDistM((prev) => Math.max(0, prev - 50));
                  }}
                  className="flex min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] active:scale-95"
                >
                  -50m
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProReplayPlaying(false);
                    setScrubDistM((prev) => Math.max(0, prev - 10));
                  }}
                  className="flex min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] active:scale-95"
                >
                  -10m
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!proReplayPlaying && scrubDistM >= Math.round(maxDistM) - 5) {
                      setScrubDistM(0);
                    }
                    setProReplayPlaying((v) => !v);
                  }}
                  className="pitstop-btn-red flex min-h-[42px] items-center justify-center gap-1 rounded-xl px-2 font-black active:scale-95"
                >
                  {proReplayPlaying ? (
                    <>
                      <Pause className="h-4 w-4 shrink-0" />
                      <span>Pausar</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 shrink-0 fill-current" />
                      <span>Replay</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProReplayPlaying(false);
                    setScrubDistM((prev) => Math.min(Math.round(maxDistM), prev + 10));
                  }}
                  className="flex min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] active:scale-95"
                >
                  +10m
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProReplayPlaying(false);
                    setScrubDistM((prev) => Math.min(Math.round(maxDistM), prev + 50));
                  }}
                  className="flex min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] active:scale-95"
                >
                  +50m
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
