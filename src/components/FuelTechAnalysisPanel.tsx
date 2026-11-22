import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, RotateCcw } from 'lucide-react';
import {
  computeLapDeltaSeries,
  computeLapTelemetrySummary,
  computeMultiLapSectorComparison,
  detectTelemetryCriticalPoints,
  formatStageDuration,
  interpolateSampleAtDist,
  type LapDeltaSample,
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
 * Gera polígonos separados de preenchimento acima (positivo/ganho) e abaixo (negativo/perda)
 * da linha neutra (midY), interpolando cruzamentos exatos em zero.
 */
function buildSplitAreaPolygons(
  points: Array<{ x: number; val: number }>,
  yAtVal: (v: number) => number,
  midY: number,
  invertPositive: boolean
): { gainPoly: string; lossPoly: string; linePts: string } {
  if (points.length < 2) {
    return { gainPoly: '', lossPoly: '', linePts: '' };
  }

  // score > 0 means "above center (green gain)", score < 0 means "below center (red loss)"
  const signed = points.map((p) => ({
    x: p.x,
    y: yAtVal(p.val),
    score: invertPositive ? -p.val : p.val,
  }));

  const linePts = signed.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const gainCoords: string[] = [];
  const lossCoords: string[] = [];

  const firstX = signed[0].x.toFixed(1);
  gainCoords.push(`${firstX},${midY.toFixed(1)}`);
  lossCoords.push(`${firstX},${midY.toFixed(1)}`);

  for (let i = 0; i < signed.length; i += 1) {
    const curr = signed[i];
    if (i > 0) {
      const prev = signed[i - 1];
      if ((prev.score > 0 && curr.score < 0) || (prev.score < 0 && curr.score > 0)) {
        const t = Math.abs(prev.score) / (Math.abs(prev.score) + Math.abs(curr.score));
        const crossX = (prev.x + (curr.x - prev.x) * t).toFixed(1);
        const crossY = midY.toFixed(1);
        gainCoords.push(`${crossX},${crossY}`);
        lossCoords.push(`${crossX},${crossY}`);
      }
    }

    const xStr = curr.x.toFixed(1);
    const yStr = curr.y.toFixed(1);
    const midStr = midY.toFixed(1);

    if (curr.score >= 0) {
      gainCoords.push(`${xStr},${yStr}`);
      lossCoords.push(`${xStr},${midStr}`);
    } else {
      gainCoords.push(`${xStr},${midStr}`);
      lossCoords.push(`${xStr},${yStr}`);
    }
  }

  const lastX = signed[signed.length - 1].x.toFixed(1);
  gainCoords.push(`${lastX},${midY.toFixed(1)}`);
  lossCoords.push(`${lastX},${midY.toFixed(1)}`);

  return {
    gainPoly: gainCoords.join(' '),
    lossPoly: lossCoords.join(' '),
    linePts,
  };
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
  const speedSvgRef = useRef<SVGSVGElement | null>(null);
  const deltaTimeSvgRef = useRef<SVGSVGElement | null>(null);
  const deltaSpeedSvgRef = useRef<SVGSVGElement | null>(null);
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

  const [scrubDistM, setScrubDistM] = useState<number>(() => Math.round(maxDistM * 0.35));
  const [showCriticalMarkers, setShowCriticalMarkers] = useState(true);

  useEffect(() => {
    setScrubDistM((prev) => {
      if (prev <= 0 || prev > maxDistM) return Math.round(maxDistM * 0.35);
      return prev;
    });
  }, [lap1?.id, lap2?.id, lap3?.id, maxDistM]);

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

  const deltaSeries2 = useMemo<LapDeltaSample[]>(
    () => (showLap2 ? computeLapDeltaSeries(lap1Samples, lap2Samples, 140) : []),
    [showLap2, lap1Samples, lap2Samples]
  );

  const deltaSeries3 = useMemo<LapDeltaSample[]>(
    () => (showLap3 ? computeLapDeltaSeries(lap1Samples, lap3Samples, 140) : []),
    [showLap3, lap1Samples, lap3Samples]
  );

  const criticalPoints = useMemo(
    () => detectTelemetryCriticalPoints(lap1Samples),
    [lap1Samples]
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

  // Shared SVG X-axis geometry
  const chartW = 640;
  const padL = 46;
  const padR = 14;
  const plotW = chartW - padL - padR;

  // Main chart geometry (Speed + G-Long)
  const chartH = 304;
  const spdTop = 24;
  const spdH = 148;
  const gTop = 194;
  const gH = 78;
  const gBottom = gTop + gH;
  const gMidY = gTop + gH / 2;

  // Delta Time & Delta Speed sub-charts geometry
  const deltaChartH = 142;
  const deltaTop = 18;
  const deltaH = 98;
  const deltaMidY = deltaTop + deltaH / 2;
  const deltaBottom = deltaTop + deltaH;

  const maxSpd = useMemo(() => {
    const peak = Math.max(
      100,
      ...lap1Samples.map((s) => s.speedKmh || 0),
      ...(showLap2 ? lap2Samples.map((s) => s.speedKmh || 0) : [0]),
      ...(showLap3 ? lap3Samples.map((s) => s.speedKmh || 0) : [0])
    );
    return Math.ceil(peak / 20) * 20;
  }, [lap1Samples, lap2Samples, lap3Samples, showLap2, showLap3]);

  const maxGScale = useMemo(() => {
    const peakG = Math.max(
      0.8,
      ...lap1Samples.map((s) => Math.abs(s.accelLongG ?? 0)),
      ...(showLap2 ? lap2Samples.map((s) => Math.abs(s.accelLongG ?? 0)) : [0]),
      ...(showLap3 ? lap3Samples.map((s) => Math.abs(s.accelLongG ?? 0)) : [0])
    );
    return Math.min(2.5, Math.ceil(peakG * 2) / 2);
  }, [lap1Samples, lap2Samples, lap3Samples, showLap2, showLap3]);

  const maxAbsDeltaTimeSec = useMemo(() => {
    const peak = Math.max(
      0.5,
      ...deltaSeries2.map((p) => Math.abs(p.timeDeltaSec)),
      ...deltaSeries3.map((p) => Math.abs(p.timeDeltaSec))
    );
    return Number((Math.ceil(peak * 2) / 2).toFixed(1));
  }, [deltaSeries2, deltaSeries3]);

  const maxAbsDeltaSpeedKmh = useMemo(() => {
    const peak = Math.max(
      10,
      ...deltaSeries2.map((p) => Math.abs(p.speedDeltaKmh)),
      ...deltaSeries3.map((p) => Math.abs(p.speedDeltaKmh))
    );
    return Math.ceil(peak / 5) * 5;
  }, [deltaSeries2, deltaSeries3]);

  const xAtM = (distM: number) =>
    padL + Math.max(0, Math.min(1, distM / maxDistM)) * plotW;

  const yAtKmh = (kmh: number) =>
    spdTop + spdH - Math.max(0, Math.min(1, kmh / maxSpd)) * spdH;

  const yAtLongG = (gVal: number) => {
    const clamped = Math.max(-maxGScale, Math.min(maxGScale, gVal));
    return gMidY - (clamped / maxGScale) * (gH / 2);
  };

  // Gain (< 0s) goes ABOVE center line, Loss (> 0s) goes BELOW center line
  const yAtDeltaTime = (sec: number) => {
    const clamped = Math.max(-maxAbsDeltaTimeSec, Math.min(maxAbsDeltaTimeSec, sec));
    return deltaMidY + (clamped / maxAbsDeltaTimeSec) * (deltaH / 2);
  };

  // Faster (+km/h) goes ABOVE center line, Slower (-km/h) goes BELOW center line
  const yAtDeltaSpeed = (kmhDelta: number) => {
    const clamped = Math.max(-maxAbsDeltaSpeedKmh, Math.min(maxAbsDeltaSpeedKmh, kmhDelta));
    return deltaMidY - (clamped / maxAbsDeltaSpeedKmh) * (deltaH / 2);
  };

  const speedPoly1 = useMemo(
    () =>
      lap1Samples
        .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [lap1Samples, maxDistM, maxSpd]
  );

  const speedPoly2 = useMemo(
    () =>
      showLap2
        ? lap2Samples
            .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
            .join(' ')
        : '',
    [lap2Samples, showLap2, maxDistM, maxSpd]
  );

  const speedPoly3 = useMemo(
    () =>
      showLap3
        ? lap3Samples
            .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
            .join(' ')
        : '',
    [lap3Samples, showLap3, maxDistM, maxSpd]
  );

  const longGPoly1 = useMemo(
    () =>
      lap1Samples
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [lap1Samples, maxDistM, maxGScale]
  );

  const longGPoly2 = useMemo(
    () =>
      showLap2
        ? lap2Samples
            .map(
              (s) =>
                `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
            )
            .join(' ')
        : '',
    [lap2Samples, showLap2, maxDistM, maxGScale]
  );

  const longGPoly3 = useMemo(
    () =>
      showLap3
        ? lap3Samples
            .map(
              (s) =>
                `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
            )
            .join(' ')
        : '',
    [lap3Samples, showLap3, maxDistM, maxGScale]
  );

  const deltaTimeShapes2 = useMemo(
    () =>
      buildSplitAreaPolygons(
        deltaSeries2.map((p) => ({ x: xAtM(p.distM), val: p.timeDeltaSec })),
        yAtDeltaTime,
        deltaMidY,
        true
      ),
    [deltaSeries2, maxDistM, maxAbsDeltaTimeSec]
  );

  const deltaTimeShapes3 = useMemo(
    () =>
      buildSplitAreaPolygons(
        deltaSeries3.map((p) => ({ x: xAtM(p.distM), val: p.timeDeltaSec })),
        yAtDeltaTime,
        deltaMidY,
        true
      ),
    [deltaSeries3, maxDistM, maxAbsDeltaTimeSec]
  );

  const deltaSpeedShapes2 = useMemo(
    () =>
      buildSplitAreaPolygons(
        deltaSeries2.map((p) => ({ x: xAtM(p.distM), val: p.speedDeltaKmh })),
        yAtDeltaSpeed,
        deltaMidY,
        false
      ),
    [deltaSeries2, maxDistM, maxAbsDeltaSpeedKmh]
  );

  const deltaSpeedShapes3 = useMemo(
    () =>
      buildSplitAreaPolygons(
        deltaSeries3.map((p) => ({ x: xAtM(p.distM), val: p.speedDeltaKmh })),
        yAtDeltaSpeed,
        deltaMidY,
        false
      ),
    [deltaSeries3, maxDistM, maxAbsDeltaSpeedKmh]
  );

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

    const time1Ms = s1 ? s1.stageElapsedMs : null;
    const time2Ms = s2 ? s2.stageElapsedMs : null;
    const time3Ms = s3 ? s3.stageElapsedMs : null;

    const timeDelta2vs1Sec =
      time2Ms !== null && time1Ms !== null
        ? Number(((time2Ms - time1Ms) / 1000).toFixed(2))
        : null;
    const timeDelta3vs1Sec =
      time3Ms !== null && time1Ms !== null
        ? Number(((time3Ms - time1Ms) / 1000).toFixed(2))
        : null;

    const longG1 = s1 && typeof s1.accelLongG === 'number' ? s1.accelLongG : 0;
    const longG2 = s2 && typeof s2.accelLongG === 'number' ? s2.accelLongG : 0;
    const longG3 = s3 && typeof s3.accelLongG === 'number' ? s3.accelLongG : 0;

    return {
      distM: Math.round(scrubDistM),
      speed1,
      speed2,
      speed3,
      speedDelta2vs1,
      speedDelta3vs1,
      time1Ms,
      time2Ms,
      time3Ms,
      timeDelta2vs1Sec,
      timeDelta3vs1Sec,
      longG1,
      longG2,
      longG3,
    };
  }, [scrubDistM, lap1Samples, lap2Samples, lap3Samples, showLap2, showLap3]);

  const updateScrubFromSvg = (svg: SVGSVGElement | null, clientX: number) => {
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chartW;
    const ratio = Math.max(0, Math.min(1, (svgX - padL) / plotW));
    setScrubDistM(Math.round(ratio * maxDistM));
  };

  const yTicksKmh = [maxSpd, Math.round(maxSpd * 0.5), 0];
  const xTicksM = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxDistM * f));
  const scrubX = xAtM(scrubDistM);

  const sectorBoundaries = useMemo(
    () =>
      sectorComparison.sectors.map((sec) => ({
        shortLabel: sec.shortLabel,
        fromM: Math.round(sec.fromDistKm * 1000),
        toM: Math.round(sec.toDistKm * 1000),
        midM: Math.round(((sec.fromDistKm + sec.toDistKm) / 2) * 1000),
      })),
    [sectorComparison]
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
                className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-2"
              >
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-1.5">
                  <div className="min-w-0">
                    <span className={`font-mono text-[11px] font-black uppercase ${style.text}`}>
                      {style.label} · #{run.runNumber}
                    </span>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <span className="text-sm font-black text-white">
                      {formatStageDuration(run.totalMs)}
                    </span>
                    {!isRef && totalDeltaSec !== null && (
                      <span
                        className={`ml-1.5 text-xs font-extrabold ${
                          totalDeltaSec <= 0 ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                        }`}
                      >
                        {formatSignedSec(totalDeltaSec)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px] tabular-nums">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-zinc-500 uppercase">Vel. Máx</span>
                    <strong className="text-white">{summary.maxSpeedKmh} km/h</strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-zinc-500 uppercase">Vel. Méd</span>
                    <strong className="text-zinc-200">{summary.avgSpeedKmh} km/h</strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-zinc-500 uppercase">Vantagem</span>
                    <strong className={isRef ? 'text-zinc-400' : 'text-[#10B981]'}>
                      {isRef
                        ? 'Ref. 0.00s'
                        : summary.bestAdvantageSec !== null
                          ? formatSignedSec(summary.bestAdvantageSec)
                          : '--'}
                    </strong>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] text-zinc-500 uppercase">Atraso</span>
                    <strong className={isRef ? 'text-zinc-400' : 'text-[#FF2A2A]'}>
                      {isRef
                        ? 'Base 0.00s'
                        : summary.worstDelaySec !== null
                          ? formatSignedSec(summary.worstDelaySec)
                          : '--'}
                    </strong>
                  </div>
                </div>

                {/* % da Volta em Aceleração vs. Frenagem */}
                <div className="space-y-1 pt-0.5 font-mono text-[10px] tabular-nums">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[#10B981]">
                      Acel {summary.accelPct}%
                    </span>
                    <span className="text-zinc-500">
                      Cruzeiro {Math.max(0, 100 - summary.accelPct - summary.brakePct)}%
                    </span>
                    <span className="font-bold text-[#FF2A2A]">
                      Freio {summary.brakePct}%
                    </span>
                  </div>
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full bg-[#10B981]"
                      style={{ width: `${accelWidth}%` }}
                    />
                    <div
                      className="h-full bg-zinc-600"
                      style={{
                        width: `${Math.max(0, 100 - accelWidth - brakeWidth)}%`,
                      }}
                    />
                    <div
                      className="h-full bg-[#FF2A2A]"
                      style={{ width: `${brakeWidth}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Linha compacta de Volta Ideal por Setores */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#050608] px-3 py-2 font-mono text-xs tabular-nums">
          <span className="font-bold text-amber-400 uppercase">
            Volta Ideal Teórica (Soma Melhores Setores)
          </span>
          <span className="text-sm font-black text-amber-300">
            {formatStageDuration(sessionOptimal.optimalTotalMs)}
          </span>
        </div>
      </div>

      {/* 2. FUELTECH DUAL-TRACK SVG DATALOGGER + PONTOS CRÍTICOS (TOP / BRK / APEX) */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Datalogger Telemetria · Velocidade &amp; G-Longitudinal
            </h3>
            <p className="font-mono text-[10px] text-zinc-400">
              Toque ou deslize no gráfico · marcadores TOP, BRK (&lt;-0.35G) e APEX
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <button
              type="button"
              onClick={() => setShowCriticalMarkers((v) => !v)}
              className={`rounded border px-2 py-1 text-[10px] font-bold uppercase ${
                showCriticalMarkers
                  ? 'border-amber-500/60 bg-amber-950/30 text-amber-300'
                  : 'border-zinc-700 bg-[#0A0C10] text-zinc-400'
              }`}
            >
              TOP / BRK / APEX
            </button>
            <span className="inline-flex items-center gap-1.5 font-bold text-[#10B981]">
              <span className="inline-block h-[2.5px] w-3.5 bg-[#10B981]" />
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

        {/* Live Cursor Telemetry Readout HUD */}
        {lap1Samples.length > 1 && (
          <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-[#0A0C10] px-2.5 py-2 font-mono text-[10px] tabular-nums sm:grid-cols-4 sm:text-[11px]">
            <div>
              <span className="text-zinc-500 uppercase">Posição</span>
              <p className="font-extrabold text-amber-300">
                {scrubPoint.distM} m
                {maxDistM >= 1000 && (
                  <span className="ml-1 font-normal text-zinc-400">
                    ({(scrubPoint.distM / 1000).toFixed(2)} km)
                  </span>
                )}
              </p>
            </div>

            <div>
              <span className="text-zinc-500 uppercase">Velocidade (km/h)</span>
              <p className="font-extrabold">
                <span className="text-[#10B981]">{scrubPoint.speed1 ?? '--'}</span>
                {showLap2 && (
                  <>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-[#FF2A2A]">{scrubPoint.speed2 ?? '--'}</span>
                    <span
                      className={`ml-1 text-[9px] ${
                        (scrubPoint.speedDelta2vs1 ?? 0) >= 0
                          ? 'text-[#10B981]'
                          : 'text-[#FF2A2A]'
                      }`}
                    >
                      ({formatSignedKmh(scrubPoint.speedDelta2vs1)})
                    </span>
                  </>
                )}
                {showLap3 && (
                  <>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-[#38BDF8]">{scrubPoint.speed3 ?? '--'}</span>
                    <span
                      className={`ml-1 text-[9px] ${
                        (scrubPoint.speedDelta3vs1 ?? 0) >= 0
                          ? 'text-[#10B981]'
                          : 'text-[#FF2A2A]'
                      }`}
                    >
                      ({formatSignedKmh(scrubPoint.speedDelta3vs1)})
                    </span>
                  </>
                )}
              </p>
            </div>

            <div>
              <span className="text-zinc-500 uppercase">Tempo Acum. / Δ</span>
              <p className="font-extrabold">
                <span className="text-white">
                  {formatStageDuration(scrubPoint.time1Ms)}
                </span>
                {showLap2 && scrubPoint.timeDelta2vs1Sec !== null && (
                  <span
                    className={`ml-1 text-[9px] ${
                      scrubPoint.timeDelta2vs1Sec <= 0
                        ? 'text-[#10B981]'
                        : 'text-[#FF2A2A]'
                    }`}
                  >
                    V2:{formatSignedSec(scrubPoint.timeDelta2vs1Sec)}
                  </span>
                )}
                {showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                  <span
                    className={`ml-1 text-[9px] ${
                      scrubPoint.timeDelta3vs1Sec <= 0
                        ? 'text-[#10B981]'
                        : 'text-[#38BDF8]'
                    }`}
                  >
                    V3:{formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                  </span>
                )}
              </p>
            </div>

            <div>
              <span className="text-zinc-500 uppercase">Força G-Long</span>
              <p className="font-extrabold">
                <span className="text-[#10B981]">
                  {scrubPoint.longG1 >= 0 ? '+' : ''}
                  {scrubPoint.longG1.toFixed(2)}
                </span>
                {showLap2 && (
                  <span className="text-[#FF2A2A]">
                    {' '}
                    / {scrubPoint.longG2 >= 0 ? '+' : ''}
                    {scrubPoint.longG2.toFixed(2)}
                  </span>
                )}
                {showLap3 && (
                  <span className="text-[#38BDF8]">
                    {' '}
                    / {scrubPoint.longG3 >= 0 ? '+' : ''}
                    {scrubPoint.longG3.toFixed(2)}
                  </span>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Dual-Channel SVG: Velocidade + Pontos Críticos + Força G Longitudinal */}
        <div className="relative rounded-lg border border-zinc-800/90 bg-[#050608] p-1.5">
          {lap1Samples.length > 1 ? (
            <svg
              ref={speedSvgRef}
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="h-64 w-full touch-none select-none cursor-crosshair sm:h-72"
              onPointerDown={(e) => {
                isDraggingRef.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                updateScrubFromSvg(speedSvgRef.current, e.clientX);
              }}
              onPointerMove={(e) => {
                if (!isDraggingRef.current && e.pointerType === 'touch') return;
                if (isDraggingRef.current || e.buttons === 1) {
                  updateScrubFromSvg(speedSvgRef.current, e.clientX);
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
              {/* TOP CHANNEL: VELOCIDADE (km/h) */}
              <text
                x={padL + 4}
                y={spdTop - 8}
                fill="#A1A1AA"
                fontSize="9"
                fontWeight="bold"
                fontFamily="monospace"
              >
                VELOCIDADE (KM/H)
              </text>

              {yTicksKmh.map((val) => {
                const y = yAtKmh(val);
                return (
                  <g key={`spd_${val}`}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke="#1F222A"
                      strokeDasharray={val === 0 ? undefined : '3 3'}
                    />
                    <text
                      x={padL - 5}
                      y={y + 3}
                      textAnchor="end"
                      fill="#71717A"
                      fontSize="9"
                      fontFamily="monospace"
                    >
                      {val}
                    </text>
                  </g>
                );
              })}

              {/* BOTTOM CHANNEL: FORÇA G LONGITUDINAL */}
              <text
                x={padL + 4}
                y={gTop - 6}
                fill="#A1A1AA"
                fontSize="9"
                fontWeight="bold"
                fontFamily="monospace"
              >
                FORÇA G LONGITUDINAL (+ACEL / -FREIO)
              </text>

              {[maxGScale, 0, -maxGScale].map((gTick) => {
                const y = yAtLongG(gTick);
                return (
                  <g key={`g_${gTick}`}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke={gTick === 0 ? '#3F3F46' : '#181A20'}
                      strokeDasharray={gTick === 0 ? undefined : '3 3'}
                    />
                    <text
                      x={padL - 5}
                      y={y + 3}
                      textAnchor="end"
                      fill={
                        gTick > 0 ? '#10B981' : gTick < 0 ? '#FF2A2A' : '#A1A1AA'
                      }
                      fontSize="8.5"
                      fontFamily="monospace"
                    >
                      {gTick > 0 ? `+${gTick.toFixed(1)}` : gTick.toFixed(1)}
                    </text>
                  </g>
                );
              })}

              {/* SECTOR VERTICAL DASHED BOUNDARIES (S1, S2, S3...) */}
              {sectorBoundaries.map((sec, i) => {
                const xEnd = xAtM(sec.toM);
                const xMid = xAtM(sec.midM);
                return (
                  <g key={`sec_line_${sec.shortLabel}_${i}`}>
                    <text
                      x={xMid}
                      y={spdTop + 10}
                      textAnchor="middle"
                      fill="#71717A"
                      fontSize="9.5"
                      fontWeight="bold"
                      fontFamily="monospace"
                    >
                      {sec.shortLabel}
                    </text>
                    {i < sectorBoundaries.length - 1 && (
                      <line
                        x1={xEnd}
                        y1={spdTop}
                        x2={xEnd}
                        y2={gBottom}
                        stroke="#52525B"
                        strokeWidth="1"
                        strokeDasharray="4 4"
                      />
                    )}
                  </g>
                );
              })}

              {/* Distance X Grid Labels */}
              {xTicksM.map((mVal, i) => {
                const x = xAtM(mVal);
                return (
                  <text
                    key={`x_${mVal}_${i}`}
                    x={x}
                    y={chartH - 7}
                    textAnchor={
                      i === 0
                        ? 'start'
                        : i === xTicksM.length - 1
                          ? 'end'
                          : 'middle'
                    }
                    fill="#A1A1AA"
                    fontSize="9"
                    fontFamily="monospace"
                  >
                    {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                  </text>
                );
              })}

              {/* Speed Trace 3 (Cyan Dashed) */}
              {showLap3 && speedPoly3 && (
                <polyline
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth="1.9"
                  strokeDasharray="5 3"
                  strokeOpacity="0.92"
                  points={speedPoly3}
                />
              )}

              {/* Speed Trace 2 (Red) */}
              {showLap2 && speedPoly2 && (
                <polyline
                  fill="none"
                  stroke="#FF2A2A"
                  strokeWidth="2.1"
                  strokeOpacity="0.95"
                  points={speedPoly2}
                />
              )}

              {/* Speed Trace 1 (Emerald Reference) */}
              <polyline
                fill="none"
                stroke="#10B981"
                strokeWidth="2.4"
                points={speedPoly1}
              />

              {/* Critical Point Badges on V1 Curve: TOP / BRK / APEX */}
              {showCriticalMarkers &&
                criticalPoints.map((pt, idx) => {
                  const cx = xAtM(pt.distM);
                  const cy = yAtKmh(pt.speedKmh);
                  const isApex = pt.type === 'APEX';
                  const badgeW = pt.type === 'APEX' ? 30 : 25;
                  const badgeH = 12;
                  const clampedBx = Math.max(
                    padL + 2,
                    Math.min(chartW - padR - badgeW - 2, cx - badgeW / 2)
                  );
                  const rawBy = isApex ? cy + 7 : cy - badgeH - 7;
                  const clampedBy = Math.max(
                    spdTop + 2,
                    Math.min(spdTop + spdH - badgeH - 2, rawBy)
                  );
                  const bg =
                    pt.type === 'TOP'
                      ? '#F59E0B'
                      : pt.type === 'BRK'
                        ? '#E10600'
                        : '#059669';
                  const txtColor = pt.type === 'TOP' ? '#050608' : '#FFFFFF';

                  return (
                    <g key={`crit_${pt.type}_${pt.distM}_${idx}`} className="pointer-events-none">
                      <line
                        x1={cx}
                        y1={cy}
                        x2={cx}
                        y2={isApex ? clampedBy : clampedBy + badgeH}
                        stroke={bg}
                        strokeWidth="1"
                        strokeOpacity="0.8"
                      />
                      <circle cx={cx} cy={cy} r="2.7" fill={bg} stroke="#FFFFFF" strokeWidth="0.9" />
                      <rect
                        x={clampedBx}
                        y={clampedBy}
                        width={badgeW}
                        height={badgeH}
                        rx="3"
                        fill={bg}
                      />
                      <text
                        x={clampedBx + badgeW / 2}
                        y={clampedBy + 8.8}
                        textAnchor="middle"
                        fill={txtColor}
                        fontSize="7.5"
                        fontWeight="bold"
                        fontFamily="monospace"
                      >
                        {pt.type}
                      </text>
                    </g>
                  );
                })}

              {/* Longitudinal G Trace 3 (Cyan Dashed) */}
              {showLap3 && longGPoly3 && (
                <polyline
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  strokeOpacity="0.85"
                  points={longGPoly3}
                />
              )}

              {/* Longitudinal G Trace 2 (Red) */}
              {showLap2 && longGPoly2 && (
                <polyline
                  fill="none"
                  stroke="#FF2A2A"
                  strokeWidth="1.7"
                  strokeOpacity="0.9"
                  points={longGPoly2}
                />
              )}

              {/* Longitudinal G Trace 1 (Emerald Reference) */}
              <polyline
                fill="none"
                stroke="#10B981"
                strokeWidth="2"
                points={longGPoly1}
              />

              {/* Interactive Crosshair Scrubber */}
              <line
                x1={scrubX}
                y1={spdTop}
                x2={scrubX}
                y2={gBottom}
                stroke="#FACC15"
                strokeWidth="1.3"
              />
              {scrubPoint.speed1 !== null && (
                <circle
                  cx={scrubX}
                  cy={yAtKmh(scrubPoint.speed1)}
                  r="4"
                  fill="#10B981"
                  stroke="#FFFFFF"
                  strokeWidth="1.5"
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
              <circle
                cx={scrubX}
                cy={yAtLongG(scrubPoint.longG1)}
                r="3.5"
                fill="#10B981"
                stroke="#FFFFFF"
                strokeWidth="1.2"
              />
              {showLap2 && (
                <circle
                  cx={scrubX}
                  cy={yAtLongG(scrubPoint.longG2)}
                  r="3"
                  fill="#FF2A2A"
                  stroke="#FFFFFF"
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
          ) : (
            <p className="py-12 text-center font-mono text-xs text-zinc-500">
              Dados insuficientes para gerar as curvas de telemetria.
            </p>
          )}
        </div>

        {/* Fine scrubber slider for one-handed precision */}
        {lap1Samples.length > 1 && (
          <div className="flex items-center gap-2 pt-0.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <input
              type="range"
              aria-label="Cursor de distância no gráfico"
              min={0}
              max={Math.round(maxDistM)}
              value={Math.min(Math.round(maxDistM), scrubDistM)}
              onChange={(e) => setScrubDistM(Number(e.target.value))}
              className="w-full accent-[#10B981]"
            />
            <button
              type="button"
              onClick={() => setScrubDistM(0)}
              className="inline-flex h-7 items-center gap-1 rounded border border-zinc-800 bg-[#0A0C10] px-2 font-mono text-[10px] font-bold text-zinc-400 hover:text-white"
              title="Voltar cursor ao início"
            >
              <RotateCcw className="h-3 w-3" />
              <span>0m</span>
            </button>
          </div>
        )}
      </div>

      {/* 3. GRÁFICO DE DIFERENÇA DE TEMPO (DELTA TIME Δs x DISTÂNCIA) + DIFERENÇA DE VELOCIDADE (Δ km/h) */}
      {(showLap2 || showLap3) && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* DELTA TIME Δs x Distância */}
          <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase">
                  Diferença de Tempo (Delta Time Δs x Distância)
                </h3>
                <p className="font-mono text-[10px] text-zinc-400">
                  Acima de 0.00s = Ganho (-s) · Abaixo = Perda (+s) vs V1 Ref
                </p>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] font-bold tabular-nums">
                {showLap2 && scrubPoint.timeDelta2vs1Sec !== null && (
                  <span
                    className={
                      scrubPoint.timeDelta2vs1Sec <= 0 ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                    }
                  >
                    V2: {formatSignedSec(scrubPoint.timeDelta2vs1Sec)}
                  </span>
                )}
                {showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                  <span className="text-[#38BDF8]">
                    V3: {formatSignedSec(scrubPoint.timeDelta3vs1Sec)}
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800/90 bg-[#050608] p-1">
              <svg
                ref={deltaTimeSvgRef}
                viewBox={`0 0 ${chartW} ${deltaChartH}`}
                className="h-36 w-full touch-none select-none cursor-crosshair sm:h-40"
                onPointerDown={(e) => {
                  isDraggingRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateScrubFromSvg(deltaTimeSvgRef.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingRef.current && e.pointerType === 'touch') return;
                  if (isDraggingRef.current || e.buttons === 1) {
                    updateScrubFromSvg(deltaTimeSvgRef.current, e.clientX);
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
                {[-maxAbsDeltaTimeSec, 0, maxAbsDeltaTimeSec].map((tickVal) => {
                  const y = yAtDeltaTime(tickVal);
                  return (
                    <g key={`dt_tick_${tickVal}`}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke={tickVal === 0 ? '#52525B' : '#181A20'}
                        strokeDasharray={tickVal === 0 ? undefined : '3 3'}
                      />
                      <text
                        x={padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill={
                          tickVal < 0
                            ? '#10B981'
                            : tickVal > 0
                              ? '#FF2A2A'
                              : '#D4D4D8'
                        }
                        fontSize="8.5"
                        fontFamily="monospace"
                      >
                        {tickVal === 0
                          ? '0.00s'
                          : `${tickVal > 0 ? '+' : ''}${tickVal.toFixed(1)}s`}
                      </text>
                    </g>
                  );
                })}

                {/* Area Fills (Green above 0.00s for Gain, Red below 0.00s for Delay) */}
                {showLap2 && deltaTimeShapes2.gainPoly && (
                  <polygon fill="#10B981" fillOpacity="0.28" points={deltaTimeShapes2.gainPoly} />
                )}
                {showLap2 && deltaTimeShapes2.lossPoly && (
                  <polygon fill="#FF2A2A" fillOpacity="0.28" points={deltaTimeShapes2.lossPoly} />
                )}

                {!showLap2 && showLap3 && deltaTimeShapes3.gainPoly && (
                  <polygon fill="#10B981" fillOpacity="0.28" points={deltaTimeShapes3.gainPoly} />
                )}
                {!showLap2 && showLap3 && deltaTimeShapes3.lossPoly && (
                  <polygon fill="#FF2A2A" fillOpacity="0.28" points={deltaTimeShapes3.lossPoly} />
                )}

                {showLap3 && deltaTimeShapes3.linePts && (
                  <polyline
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="2"
                    strokeDasharray="4 3"
                    points={deltaTimeShapes3.linePts}
                  />
                )}
                {showLap2 && deltaTimeShapes2.linePts && (
                  <polyline
                    fill="none"
                    stroke="#F4F4F5"
                    strokeWidth="2"
                    points={deltaTimeShapes2.linePts}
                  />
                )}

                {xTicksM.map((mVal, i) => (
                  <text
                    key={`dt_x_${mVal}_${i}`}
                    x={xAtM(mVal)}
                    y={deltaChartH - 6}
                    textAnchor={
                      i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'
                    }
                    fill="#71717A"
                    fontSize="8.5"
                    fontFamily="monospace"
                  >
                    {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                  </text>
                ))}

                {/* Synchronized Crosshair */}
                <line
                  x1={scrubX}
                  y1={deltaTop}
                  x2={scrubX}
                  y2={deltaBottom}
                  stroke="#FACC15"
                  strokeWidth="1.2"
                />
                {showLap2 && scrubPoint.timeDelta2vs1Sec !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtDeltaTime(scrubPoint.timeDelta2vs1Sec)}
                    r="3.5"
                    fill={scrubPoint.timeDelta2vs1Sec <= 0 ? '#10B981' : '#FF2A2A'}
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
                {showLap3 && scrubPoint.timeDelta3vs1Sec !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtDeltaTime(scrubPoint.timeDelta3vs1Sec)}
                    r="3.5"
                    fill="#38BDF8"
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
              </svg>
            </div>
          </div>

          {/* DELTA SPEED Δ km/h x Distância */}
          <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase">
                  Diferença de Velocidade (Δ km/h x Distância)
                </h3>
                <p className="font-mono text-[10px] text-zinc-400">
                  Acima de 0 = Mais rápido (+km/h) · Abaixo = Mais lento (-km/h)
                </p>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] font-bold tabular-nums">
                {showLap2 && scrubPoint.speedDelta2vs1 !== null && (
                  <span
                    className={
                      scrubPoint.speedDelta2vs1 >= 0 ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                    }
                  >
                    V2: {formatSignedKmh(scrubPoint.speedDelta2vs1)} km/h
                  </span>
                )}
                {showLap3 && scrubPoint.speedDelta3vs1 !== null && (
                  <span className="text-[#38BDF8]">
                    V3: {formatSignedKmh(scrubPoint.speedDelta3vs1)} km/h
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800/90 bg-[#050608] p-1">
              <svg
                ref={deltaSpeedSvgRef}
                viewBox={`0 0 ${chartW} ${deltaChartH}`}
                className="h-36 w-full touch-none select-none cursor-crosshair sm:h-40"
                onPointerDown={(e) => {
                  isDraggingRef.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  updateScrubFromSvg(deltaSpeedSvgRef.current, e.clientX);
                }}
                onPointerMove={(e) => {
                  if (!isDraggingRef.current && e.pointerType === 'touch') return;
                  if (isDraggingRef.current || e.buttons === 1) {
                    updateScrubFromSvg(deltaSpeedSvgRef.current, e.clientX);
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
                {[maxAbsDeltaSpeedKmh, 0, -maxAbsDeltaSpeedKmh].map((tickVal) => {
                  const y = yAtDeltaSpeed(tickVal);
                  return (
                    <g key={`ds_tick_${tickVal}`}>
                      <line
                        x1={padL}
                        y1={y}
                        x2={chartW - padR}
                        y2={y}
                        stroke={tickVal === 0 ? '#52525B' : '#181A20'}
                        strokeDasharray={tickVal === 0 ? undefined : '3 3'}
                      />
                      <text
                        x={padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fill={
                          tickVal > 0
                            ? '#10B981'
                            : tickVal < 0
                              ? '#FF2A2A'
                              : '#D4D4D8'
                        }
                        fontSize="8.5"
                        fontFamily="monospace"
                      >
                        {tickVal > 0 ? `+${tickVal}` : tickVal}
                      </text>
                    </g>
                  );
                })}

                {showLap2 && deltaSpeedShapes2.gainPoly && (
                  <polygon fill="#10B981" fillOpacity="0.25" points={deltaSpeedShapes2.gainPoly} />
                )}
                {showLap2 && deltaSpeedShapes2.lossPoly && (
                  <polygon fill="#FF2A2A" fillOpacity="0.25" points={deltaSpeedShapes2.lossPoly} />
                )}

                {!showLap2 && showLap3 && deltaSpeedShapes3.gainPoly && (
                  <polygon fill="#10B981" fillOpacity="0.25" points={deltaSpeedShapes3.gainPoly} />
                )}
                {!showLap2 && showLap3 && deltaSpeedShapes3.lossPoly && (
                  <polygon fill="#FF2A2A" fillOpacity="0.25" points={deltaSpeedShapes3.lossPoly} />
                )}

                {showLap3 && deltaSpeedShapes3.linePts && (
                  <polyline
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="2"
                    strokeDasharray="4 3"
                    points={deltaSpeedShapes3.linePts}
                  />
                )}
                {showLap2 && deltaSpeedShapes2.linePts && (
                  <polyline
                    fill="none"
                    stroke="#FF2A2A"
                    strokeWidth="2"
                    points={deltaSpeedShapes2.linePts}
                  />
                )}

                {xTicksM.map((mVal, i) => (
                  <text
                    key={`ds_x_${mVal}_${i}`}
                    x={xAtM(mVal)}
                    y={deltaChartH - 6}
                    textAnchor={
                      i === 0 ? 'start' : i === xTicksM.length - 1 ? 'end' : 'middle'
                    }
                    fill="#71717A"
                    fontSize="8.5"
                    fontFamily="monospace"
                  >
                    {mVal >= 1000 ? `${(mVal / 1000).toFixed(2)}km` : `${mVal}m`}
                  </text>
                ))}

                {/* Synchronized Crosshair */}
                <line
                  x1={scrubX}
                  y1={deltaTop}
                  x2={scrubX}
                  y2={deltaBottom}
                  stroke="#FACC15"
                  strokeWidth="1.2"
                />
                {showLap2 && scrubPoint.speedDelta2vs1 !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtDeltaSpeed(scrubPoint.speedDelta2vs1)}
                    r="3.5"
                    fill="#FF2A2A"
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
                {showLap3 && scrubPoint.speedDelta3vs1 !== null && (
                  <circle
                    cx={scrubX}
                    cy={yAtDeltaSpeed(scrubPoint.speedDelta3vs1)}
                    r="3.5"
                    fill="#38BDF8"
                    stroke="#FFFFFF"
                    strokeWidth="1.2"
                  />
                )}
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* 4. TABELA EXPANDIDA POR TRECHO (SETORES — ATÉ 3 VOLTAS LADO A LADO) */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Telemetria por Trecho (Setores)
            </h3>
            <p className="font-mono text-[10px] text-zinc-400">
              {sectorComparison.rows.some((r) => r.isTrapBased)
                ? 'Marcos oficiais (Traps) · toque no setor para posicionar o cursor'
                : '4 trechos iguais · toque no setor para posicionar o cursor'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <span className="font-bold text-[#10B981]">V1 #{lap1?.runNumber ?? '-'}</span>
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
                <tr className="border-b border-zinc-800 text-[10px] text-zinc-400 uppercase">
                  <th className="py-2 pr-2">Trecho</th>
                  <th className="px-1.5 py-2">Volta</th>
                  <th className="px-1.5 py-2 text-right">Tempo (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Máx (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Mín (Δ)</th>
                  <th className="px-1.5 py-2 text-right">V.Méd (Δ)</th>
                  <th className="py-2 pl-1.5 text-right">Freio / Acel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {sectorComparison.rows.map((row) => {
                  const isScrubInside =
                    scrubDistM >= row.fromDistM && scrubDistM <= row.toDistM;

                  return row.entries.map((entry, entryIdx) => {
                    const slotStyle = SLOT_COLORS[entry.slot];
                    const isFirstInSector = entryIdx === 0;
                    const isLastInSector = entryIdx === row.entries.length - 1;
                    const rowBorder = isLastInSector
                      ? 'border-b border-zinc-700/80'
                      : 'border-b border-zinc-900';

                    return (
                      <tr
                        key={`${row.index}_${entry.slot}`}
                        onClick={() =>
                          setScrubDistM(Math.round((row.fromDistM + row.toDistM) / 2))
                        }
                        className={`cursor-pointer transition-colors hover:bg-zinc-900/70 ${rowBorder} ${
                          isScrubInside ? 'bg-zinc-900/85' : ''
                        }`}
                      >
                        {isFirstInSector && (
                          <td
                            rowSpan={row.entries.length}
                            className="py-2 pr-2 align-top whitespace-nowrap border-r border-zinc-800/70"
                          >
                            <span className="font-sans text-xs font-extrabold text-white">
                              {row.label}
                            </span>
                            <span className="block text-[10px] text-zinc-500">
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
                          <span className="font-bold text-white">
                            {formatSectorSec(entry.metrics.durationMs)}
                          </span>
                          {entry.timeDeltaSec !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.timeDeltaSec <= 0
                                  ? 'text-[#10B981]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedSec(entry.timeDeltaSec)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-white">
                            {entry.metrics.maxSpeedKmh ?? '--'}
                          </span>
                          {entry.maxSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.maxSpeedDeltaKmh >= 0
                                  ? 'text-[#10B981]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedKmh(entry.maxSpeedDeltaKmh)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-white">
                            {entry.metrics.minSpeedKmh ?? '--'}
                          </span>
                          {entry.minSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.minSpeedDeltaKmh >= 0
                                  ? 'text-[#10B981]'
                                  : 'text-[#FF2A2A]'
                              }`}
                            >
                              {formatSignedKmh(entry.minSpeedDeltaKmh)}
                            </span>
                          )}
                        </td>

                        <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
                          <span className="font-bold text-white">
                            {entry.metrics.avgSpeedKmh ?? '--'}
                          </span>
                          {entry.avgSpeedDeltaKmh !== null && (
                            <span
                              className={`block text-[10px] font-bold ${
                                entry.avgSpeedDeltaKmh >= 0
                                  ? 'text-[#10B981]'
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
                          <span className="block text-[10px] text-[#10B981] font-bold">
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
          <p className="py-4 text-xs text-zinc-500">
            Grave ou selecione voltas com amostras GPS para calcular os setores comparativos.
          </p>
        )}
      </div>

      {/* 5. VOLTA IDEAL POR SETORES */}
      {sessionOptimal.sectors.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3.5 text-white">
          <h3 className="text-xs font-bold tracking-wider text-amber-400 uppercase">
            Volta Ideal por Setores (Marcos)
          </h3>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {sessionOptimal.sectors.map((sec) => (
              <div
                key={sec.sectorIndex}
                className="rounded-lg border border-zinc-800 bg-[#0A0C10] px-3 py-2 font-mono"
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

      {/* 6. VOLTAS DA SESSÃO */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3.5 text-white">
        <div className="flex items-center justify-between">
          <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
            Voltas da Sessão ({sessionRuns.length})
          </h3>
          <button
            type="button"
            onClick={onDeleteSession}
            className="min-h-[36px] px-2 text-xs font-semibold text-red-400 hover:text-red-300"
          >
            Excluir Sessão
          </button>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
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
                      {isBest && <span className="text-[#10B981]">(Melhor)</span>}
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
};
