import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, RotateCcw, ZoomIn } from 'lucide-react';
import {
  computeBrakePointOffsetNearDist,
  computeLapDeltaSeries,
  computeLapTelemetrySummary,
  computeMultiLapSectorComparison,
  detectTelemetryCriticalPoints,
  ensureTraceGForces,
  formatStageDuration,
  interpolateSampleAtDist,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
} from '../utils/velocityEngine';

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
  onDeleteSession: () => void;
}

const SLOT_COLORS = {
  1: { hex: '#10B981', text: 'text-[#10B981]', border: 'border-[#10B981]/50', label: 'V1 Ref' },
  2: { hex: '#FF2A2A', text: 'text-[#FF2A2A]', border: 'border-[#FF2A2A]/50', label: 'V2 Comp.A' },
  3: { hex: '#38BDF8', text: 'text-[#38BDF8]', border: 'border-[#38BDF8]/50', label: 'V3 Comp.B' },
} as const;

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

function formatG(gVal: number | null): string {
  if (gVal === null || !Number.isFinite(gVal)) return '--';
  return `${gVal > 0 ? '+' : ''}${gVal.toFixed(2)}G`;
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
  sessionOptimal,
  lap1,
  lap2,
  lap3,
  lap1Samples,
  lap2Samples,
  lap3Samples,
  onDeleteSession,
}) => {
  const panel1Ref = useRef<SVGSVGElement | null>(null);
  const panel2Ref = useRef<SVGSVGElement | null>(null);
  const panel3Ref = useRef<SVGSVGElement | null>(null);
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
    setScrubDistM((prev) => {
      if (prev < viewStartM || prev > viewEndM) {
        return Math.round((viewStartM + viewEndM) / 2);
      }
      return prev;
    });
  }, [viewStartM, viewEndM]);

  const deltaSeries2 = useMemo(
    () => (showLap2 ? computeLapDeltaSeries(lap1Samples, lap2Samples, 140) : []),
    [showLap2, lap1Samples, lap2Samples]
  );

  const deltaSeries3 = useMemo(
    () => (showLap3 ? computeLapDeltaSeries(lap1Samples, lap3Samples, 140) : []),
    [showLap3, lap1Samples, lap3Samples]
  );

  const summaryCards = useMemo(() => {
    const list: Array<{
      slot: 1 | 2 | 3;
      run: VelocityRun;
      summary: ReturnType<typeof computeLapTelemetrySummary>;
      totalDeltaSec: number | null;
    }> = [];

    if (lap1) {
      list.push({
        slot: 1,
        run: lap1,
        summary: computeLapTelemetrySummary(lap1),
        totalDeltaSec: null,
      });
    }
    if (showLap2 && lap2) {
      list.push({
        slot: 2,
        run: lap2,
        summary: computeLapTelemetrySummary(lap2, deltaSeries2),
        totalDeltaSec: Number(((lap2.totalMs - (lap1?.totalMs ?? lap2.totalMs)) / 1000).toFixed(2)),
      });
    }
    if (showLap3 && lap3) {
      list.push({
        slot: 3,
        run: lap3,
        summary: computeLapTelemetrySummary(lap3, deltaSeries3),
        totalDeltaSec: Number(((lap3.totalMs - (lap1?.totalMs ?? lap3.totalMs)) / 1000).toFixed(2)),
      });
    }
    return list;
  }, [lap1, lap2, lap3, showLap2, showLap3, deltaSeries2, deltaSeries3]);

  // Max absolute partial delta for scaling the horizontal bar chart
  const maxPartialDeltaAbsSec = useMemo(() => {
    let peak = 0.25;
    sectorComparison.rows.forEach((row) => {
      row.entries.forEach((e) => {
        if (e.timeDeltaSec !== null) {
          peak = Math.max(peak, Math.abs(e.timeDeltaSec));
        }
      });
    });
    return Number((Math.ceil(peak * 4) / 4).toFixed(2));
  }, [sectorComparison.rows]);

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

    const brakeOffset2 = showLap2
      ? computeBrakePointOffsetNearDist(lap1Samples, lap2Samples, scrubDistM)
      : null;
    const brakeOffset3 = showLap3
      ? computeBrakePointOffsetNearDist(lap1Samples, lap3Samples, scrubDistM)
      : null;

    return {
      distM: Math.round(scrubDistM),
      speed1,
      speed2,
      speed3,
      speedDelta2vs1,
      speedDelta3vs1,
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

  return (
    <div className="space-y-3">
      {/* 1. CARDS DE RESUMO COMPARATIVO (V1, V2, V3 + Volta Ideal) */}
      <div className="space-y-2">
        <div
          className={`grid grid-cols-1 gap-2 ${
            summaryCards.length === 3
              ? 'md:grid-cols-3'
              : summaryCards.length === 2
                ? 'sm:grid-cols-2'
                : 'grid-cols-1'
          }`}
        >
          {summaryCards.map(({ slot, run, summary, totalDeltaSec }) => {
            const style = SLOT_COLORS[slot];
            const isRef = slot === 1;
            const totalBar = Math.max(1, summary.accelPct + summary.brakePct);
            const accelWidth = Math.round((summary.accelPct / Math.max(100, totalBar)) * 100);
            const brakeWidth = Math.round((summary.brakePct / Math.max(100, totalBar)) * 100);

            return (
              <div
                key={`summary_card_${slot}_${run.id}`}
                className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2"
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--ps-border)] pb-1.5">
                  <span className={`font-mono text-[11px] font-black uppercase ${style.text}`}>
                    {style.label} · #{run.runNumber}
                  </span>
                  <div className="text-right font-mono tabular-nums">
                    <span className="text-sm font-black text-[var(--ps-text)]">
                      {formatStageDuration(run.totalMs)}
                    </span>
                    {!isRef && totalDeltaSec !== null && (
                      <span
                        className={`ml-1.5 text-xs font-extrabold ${
                          totalDeltaSec <= 0 ? 'text-[var(--ps-emerald)]' : 'text-[#FF2A2A]'
                        }`}
                      >
                        {formatSignedSec(totalDeltaSec)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px] tabular-nums">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-[var(--ps-muted)] uppercase">Vel. Máx</span>
                    <strong className="text-[var(--ps-text)]">{summary.maxSpeedKmh} km/h</strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-[var(--ps-muted)] uppercase">Vel. Méd</span>
                    <strong className="text-[var(--ps-text)]">{summary.avgSpeedKmh} km/h</strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-[var(--ps-muted)] uppercase">Vantagem</span>
                    <strong className={isRef ? 'text-[var(--ps-muted)]' : 'text-[var(--ps-emerald)]'}>
                      {isRef
                        ? 'Ref. 0.00s'
                        : summary.bestAdvantageSec !== null
                          ? formatSignedSec(summary.bestAdvantageSec)
                          : '--'}
                    </strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-[var(--ps-muted)] uppercase">Atraso</span>
                    <strong className={isRef ? 'text-[var(--ps-muted)]' : 'text-[#FF2A2A]'}>
                      {isRef
                        ? 'Base 0.00s'
                          : summary.worstDelaySec !== null
                            ? formatSignedSec(summary.worstDelaySec)
                            : '--'}
                    </strong>
                  </div>
                </div>

                <div className="space-y-1 pt-0.5 font-mono text-[10px] tabular-nums">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[var(--ps-emerald)]">Acel {summary.accelPct}%</span>
                    <span className="text-[var(--ps-muted)]">
                      Cruzeiro {Math.max(0, 100 - summary.accelPct - summary.brakePct)}%
                    </span>
                    <span className="font-bold text-[#FF2A2A]">Freio {summary.brakePct}%</span>
                  </div>
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--ps-card-deep)]">
                    <div className="h-full bg-[#10B981]" style={{ width: `${accelWidth}%` }} />
                    <div
                      className="h-full bg-[var(--ps-muted)]/45"
                      style={{ width: `${Math.max(0, 100 - accelWidth - brakeWidth)}%` }}
                    />
                    <div className="h-full bg-[#FF2A2A]" style={{ width: `${brakeWidth}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 font-mono text-xs tabular-nums">
          <span className="font-bold text-[var(--ps-amber)] uppercase">
            Volta Ideal Teórica (Melhores Parciais)
          </span>
          <span className="text-sm font-black text-[var(--ps-amber)]">
            {formatStageDuration(sessionOptimal.optimalTotalMs)}
          </span>
        </div>
      </div>

      {/* 2. GRÁFICO DE BARRAS HORIZONTAIS DE GANHO / PERDA POR PARCIAL (P1, P2, P3...) */}
      {(showLap2 || showLap3) && sectorComparison.rows.length > 0 && (
        <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
                Ganho &amp; Perda por Parcial (P1, P2, P3...)
              </h3>
              <p className="font-mono text-[10px] text-[var(--ps-muted)]">
                Esquerda = Tempo Ganho (-s) · Direita = Tempo Perdido (+s) vs V1 · Toque para ampliar
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-[10px] font-bold">
              <span className="text-[var(--ps-emerald)]">← Ganho (-s)</span>
              <span className="text-[#FF2A2A]">Perda (+s) →</span>
            </div>
          </div>

          <div className="space-y-1.5">
            {sectorComparison.rows.map((row) => {
              const pCode = `P${row.index}`;
              const compEntries = row.entries.filter((e) => e.slot !== 1);
              const isZoomed = zoomSectorIdx === row.index;

              return (
                <button
                  key={`bar_split_${row.index}`}
                  type="button"
                  onClick={() => setZoomSectorIdx(isZoomed ? null : row.index)}
                  className={`w-full rounded-xl border px-2.5 py-2 text-left transition-colors ${
                    isZoomed
                      ? 'border-[var(--ps-amber)] bg-amber-500/10'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-[var(--ps-border-strong)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {/* Identificação da Parcial */}
                    <div className="w-20 shrink-0 font-mono">
                      <p className="text-xs font-black text-[var(--ps-text)]">{pCode}</p>
                      <p className="text-[9px] text-[var(--ps-muted)] tabular-nums">
                        {row.fromDistM}–{row.toDistM}m
                      </p>
                    </div>

                    {/* Barras saindo do centro: Esquerda Verde (-s) / Direita Vermelho (+s) */}
                    <div className="flex-1 space-y-1">
                      {compEntries.map((entry) => {
                        const d = entry.timeDeltaSec;
                        const isGain = d !== null && d <= 0;
                        const pct =
                          d === null
                            ? 0
                            : Math.min(100, Math.max(6, (Math.abs(d) / maxPartialDeltaAbsSec) * 100));

                        return (
                          <div
                            key={`bar_${row.index}_${entry.slot}`}
                            className="flex items-center gap-2 font-mono text-[10px] tabular-nums"
                          >
                            <span
                              className={`w-6 shrink-0 font-extrabold ${SLOT_COLORS[entry.slot].text}`}
                            >
                              V{entry.slot}
                            </span>

                            <div className="relative flex h-4 flex-1 items-center rounded bg-[var(--ps-surface)] border border-[var(--ps-border)] overflow-hidden">
                              {/* Linha Central Neutra */}
                              <div className="absolute inset-y-0 left-1/2 z-10 w-[1.5px] -translate-x-1/2 bg-[var(--ps-muted)]/70" />
                              {d !== null && Math.abs(d) >= 0.005 && isGain && (
                                <div
                                  className="absolute inset-y-0.5 right-1/2 rounded-l bg-[#10B981]"
                                  style={{ width: `${pct / 2}%` }}
                                />
                              )}
                              {d !== null && Math.abs(d) >= 0.005 && !isGain && (
                                <div
                                  className="absolute inset-y-0.5 left-1/2 rounded-r bg-[#FF2A2A]"
                                  style={{ width: `${pct / 2}%` }}
                                />
                              )}
                            </div>

                            <span
                              className={`w-14 shrink-0 text-right font-extrabold ${
                                d === null
                                  ? 'text-[var(--ps-muted)]'
                                  : isGain
                                    ? 'text-[var(--ps-emerald)]'
                                    : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedSec(d)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. DATALOGGER AiM / MoTeC — 3 PAINÉIS SINCRONIZADOS + ZOOM POR PARCIAL */}
      <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Datalogger de Pilotagem · Velocidade, Pedal &amp; Força Lateral
            </h3>
            <p className="font-mono text-[10px] text-[var(--ps-muted)]">
              3 painéis sincronizados · selecione uma Parcial abaixo para ampliar retas e curvas
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

        {/* Resumo Prático Fixo ao Tocar no Gráfico */}
        {lap1Samples.length > 1 && (
          <div className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-2 font-mono text-[10px] tabular-nums sm:grid-cols-3 sm:text-[11px]">
            {/* 1. Vel V1 vs V2 (Δ km/h) */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">
                Vel V1 vs V2 @ {scrubPoint.distM}m
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

            {/* 2. Frenagem / Aceleração (G) & Carga Lateral */}
            <div>
              <span className="text-[var(--ps-muted)] uppercase">Frenagem / Aceleração &amp; Lat G</span>
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

            {/* 3. Distância do Ponto de Frenagem */}
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

                {/* Crosshair sincronizado */}
                <line
                  x1={scrubX}
                  y1={p1Top}
                  x2={scrubX}
                  y2={p1Bottom}
                  stroke="#FACC15"
                  strokeWidth="1.5"
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

            {/* PAINEL 2 — PEDAL VIRTUAL (+G ACELERAÇÃO vs. -G FRENAGEM) */}
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 2 · Pedal Virtual (Aceleração +G vs. Frenagem -G)
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
                  stroke="#FACC15"
                  strokeWidth="1.3"
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

            {/* PAINEL 3 — FORÇA LATERAL EM CURVA (LAT G) */}
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5">
              <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1 px-1 font-mono text-[9px] text-[var(--ps-muted)]">
                <span className="font-bold uppercase">
                  Painel 3 · Força Lateral em Curva (Lat G)
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
                  stroke="#FACC15"
                  strokeWidth="1.5"
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

        {/* Slider fino de posição sincronizado com os 3 painéis */}
        {lap1Samples.length > 1 && (
          <div className="flex items-center gap-2 pt-0.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-[var(--ps-amber)]" />
            <input
              type="range"
              aria-label="Cursor de distância sincronizado nos 3 painéis"
              min={Math.round(viewStartM)}
              max={Math.round(viewEndM)}
              value={Math.max(Math.round(viewStartM), Math.min(Math.round(viewEndM), scrubDistM))}
              onChange={(e) => setScrubDistM(Number(e.target.value))}
              className="w-full accent-[var(--ps-emerald)]"
            />
            <button
              type="button"
              onClick={() => setScrubDistM(Math.round(viewStartM))}
              className="inline-flex h-7 items-center gap-1 rounded border border-[var(--ps-border)] bg-[var(--ps-card)] px-2 font-mono text-[10px] font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              title="Voltar cursor ao início do trecho"
            >
              <RotateCcw className="h-3 w-3" />
              <span>{Math.round(viewStartM)}m</span>
            </button>
          </div>
        )}
      </div>

      {/* 4. TABELA EXPANDIDA POR TRECHO (SETORES — ATÉ 3 VOLTAS LADO A LADO) */}
      <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)] space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Telemetria por Trecho (Parciais)
            </h3>
            <p className="font-mono text-[10px] text-[var(--ps-muted)]">
              {sectorComparison.rows.some((r) => r.isTrapBased)
                ? 'Marcos oficiais (Traps) · toque no trecho para ampliar zoom no datalogger'
                : '4 parciais iguais · toque no trecho para ampliar zoom no datalogger'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <span className="font-bold text-[var(--ps-emerald)]">V1 #{lap1?.runNumber ?? '-'}</span>
            {showLap2 && (
              <span className="font-bold text-[#FF2A2A]">V2 #{lap2?.runNumber ?? '-'}</span>
            )}
            {showLap3 && (
              <span className="font-bold text-[#38BDF8]">V3 #{lap3?.runNumber ?? '-'}</span>
            )}
          </div>
        </div>

        {sectorComparison.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-[var(--ps-border)] text-[10px] text-[var(--ps-muted)] uppercase">
                  <th className="py-2 pr-2">Parcial</th>
                  <th className="px-1.5 py-2">Volta</th>
                  <th className="px-1.5 py-2 text-right">Tempo (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Máx (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Mín (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Méd (Δ)</th>
                  <th className="py-2 pl-1.5 text-right">Freio / Acel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ps-border)]">
                {sectorComparison.rows.map((row) => {
                  const isScrubInside =
                    scrubDistM >= row.fromDistM && scrubDistM <= row.toDistM;

                  return row.entries.map((entry, entryIdx) => {
                    const slotStyle = SLOT_COLORS[entry.slot];
                    const isFirstInSector = entryIdx === 0;
                    const isLastInSector = entryIdx === row.entries.length - 1;
                    const rowBorder = isLastInSector
                      ? 'border-b border-[var(--ps-border-strong)]'
                      : 'border-b border-[var(--ps-border)]';

                    return (
                      <tr
                        key={`${row.index}_${entry.slot}`}
                        onClick={() => {
                          setZoomSectorIdx(row.index);
                          setScrubDistM(Math.round((row.fromDistM + row.toDistM) / 2));
                        }}
                        className={`cursor-pointer transition-colors hover:bg-[var(--ps-card)] ${rowBorder} ${
                          isScrubInside ? 'bg-[var(--ps-card)]' : ''
                        }`}
                      >
                        {isFirstInSector && (
                          <td
                            rowSpan={row.entries.length}
                            className="py-2 pr-2 align-top whitespace-nowrap border-r border-[var(--ps-border)]"
                          >
                            <span className="font-sans text-xs font-extrabold text-[var(--ps-text)]">
                              P{row.index} · {row.label}
                            </span>
                            <span className="block text-[10px] text-[var(--ps-muted)]">
                              {row.fromDistM}–{row.toDistM}m
                            </span>
                          </td>
                        )}

                        <td className="px-1.5 py-1.5 whitespace-nowrap">
                          <span className={`font-extrabold ${slotStyle.text}`}>
                            V{entry.slot} #{entry.runNumber}
                          </span>
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-[var(--ps-text)]">
                            {formatSectorSec(entry.metrics.durationMs)}
                          </span>
                          {entry.timeDeltaSec !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.timeDeltaSec <= 0
                                  ? 'text-[var(--ps-emerald)]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedSec(entry.timeDeltaSec)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-[var(--ps-text)]">
                            {entry.metrics.maxSpeedKmh ?? '--'}
                          </span>
                          {entry.maxSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.maxSpeedDeltaKmh >= 0
                                  ? 'text-[var(--ps-emerald)]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedKmh(entry.maxSpeedDeltaKmh)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-[var(--ps-text)]">
                            {entry.metrics.minSpeedKmh ?? '--'}
                          </span>
                          {entry.minSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.minSpeedDeltaKmh >= 0
                                  ? 'text-[var(--ps-emerald)]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedKmh(entry.minSpeedDeltaKmh)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-[var(--ps-text)]">
                            {entry.metrics.avgSpeedKmh ?? '--'}
                          </span>
                          {entry.avgSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.avgSpeedDeltaKmh >= 0
                                  ? 'text-[var(--ps-emerald)]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedKmh(entry.avgSpeedDeltaKmh)}
                            </span>
                          )}
                        </td>

                        <td className="py-1.5 pl-1.5 text-right whitespace-nowrap">
                          <span className="text-[#FF2A2A] font-bold">
                            {formatG(entry.metrics.peakBrakeG)}
                          </span>
                          <span className="block text-[10px] text-[var(--ps-emerald)] font-bold">
                            {formatG(entry.metrics.peakAccelG)}
                          </span>
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-4 text-xs text-[var(--ps-muted)]">
            Grave ou selecione voltas com amostras GPS para calcular as parciais comparativas.
          </p>
        )}
      </div>

      {/* 5. VOLTA IDEAL POR PARCIAIS */}
      {sessionOptimal.sectors.length > 0 && (
        <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 text-[var(--ps-text)]">
          <h3 className="text-xs font-bold tracking-wider text-[var(--ps-amber)] uppercase">
            Volta Ideal por Parciais (Marcos)
          </h3>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {sessionOptimal.sectors.map((sec) => (
              <div
                key={sec.sectorIndex}
                className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 font-mono"
              >
                <p className="font-sans text-xs font-bold text-[var(--ps-text)]">{sec.label}</p>
                <p className="mt-0.5 text-lg font-extrabold text-[var(--ps-amber)] tabular-nums">
                  {formatStageDuration(sec.bestMs)}
                </p>
                <p className="text-[10px] text-[var(--ps-muted)]">
                  {sec.bestRunNumber ? `Volta #${sec.bestRunNumber}` : 'Sem registro'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. VOLTAS DA SESSÃO */}
      <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 text-[var(--ps-text)]">
        <div className="flex items-center justify-between">
          <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
            Voltas da Sessão ({sessionRuns.length})
          </h3>
          <button
            type="button"
            onClick={onDeleteSession}
            className="min-h-[36px] px-2 text-xs font-semibold text-red-500 hover:text-red-400"
          >
            Excluir Sessão
          </button>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-[var(--ps-border)] text-[var(--ps-muted)]">
                <th className="py-2 pr-2">Volta</th>
                <th className="px-2 py-2">Tempo</th>
                <th className="px-2 py-2 text-right">Dist.</th>
                <th className="py-2 pl-2 text-right">Máx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ps-border)]">
              {sessionRuns.map((run) => {
                const isBest = run.id === sessionOptimal.bestRunId;
                return (
                  <tr key={run.id} className={isBest ? 'bg-emerald-500/10' : ''}>
                    <td className="py-2 pr-2 font-sans font-bold text-[var(--ps-text)]">
                      #{run.runNumber}{' '}
                      {isBest && <span className="text-[var(--ps-emerald)]">(Melhor)</span>}
                    </td>
                    <td className="px-2 py-2 font-extrabold text-[var(--ps-text)]">
                      {formatStageDuration(run.totalMs)}
                    </td>
                    <td className="px-2 py-2 text-right text-[var(--ps-muted)]">
                      {run.distanceKm.toFixed(2)} km
                    </td>
                    <td className="py-2 pl-2 text-right text-[var(--ps-amber)]">
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
};
