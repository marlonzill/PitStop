import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Crosshair, RotateCcw } from 'lucide-react';
import {
  computeSectorComparisonRows,
  formatStageDuration,
  interpolateSampleAtDist,
  type LapComparisonSummary,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
  type VelocityTrack,
} from '../utils/velocityEngine';

interface FuelTechAnalysisPanelProps {
  sessionTrack: VelocityTrack | null;
  sessionRuns: VelocityRun[];
  sessionOptimal: OptimalStageSummary;
  lapA: VelocityRun | null;
  lapB: VelocityRun | null;
  lapASamples: VelocitySample[];
  lapBSamples: VelocitySample[];
  comparisonSummary: LapComparisonSummary | null;
  coachLoading: boolean;
  coachError: string | null;
  coachAdvice: string | null;
  onRequestAiCoach: () => void;
  onDeleteSession: () => void;
}

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

export const FuelTechAnalysisPanel: React.FC<FuelTechAnalysisPanelProps> = ({
  sessionTrack,
  sessionRuns,
  sessionOptimal,
  lapA,
  lapB,
  lapASamples,
  lapBSamples,
  comparisonSummary,
  coachLoading,
  coachError,
  coachAdvice,
  onRequestAiCoach,
  onDeleteSession,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const isDraggingRef = useRef(false);

  const maxDistA =
    lapASamples.length > 0 ? lapASamples[lapASamples.length - 1].distKm * 1000 : 0;
  const maxDistB =
    lapBSamples.length > 0 ? lapBSamples[lapBSamples.length - 1].distKm * 1000 : 0;
  const maxDistM = Math.max(200, maxDistA, maxDistB);

  const [scrubDistM, setScrubDistM] = useState<number>(() => Math.round(maxDistM * 0.35));

  // Keep scrubber clamped when changing laps
  useEffect(() => {
    setScrubDistM((prev) => {
      if (prev <= 0 || prev > maxDistM) return Math.round(maxDistM * 0.35);
      return prev;
    });
  }, [lapA?.id, lapB?.id, maxDistM]);

  const sectorComparison = useMemo(() => {
    if (!lapA || !lapB) return null;
    return computeSectorComparisonRows(sessionTrack, lapA, lapB);
  }, [sessionTrack, lapA, lapB]);

  // SVG Layout geometry (dual-track FuelTech datalogger: Top = Speed, Bottom = Longitudinal G)
  const chartW = 640;
  const chartH = 290;
  const padL = 42;
  const padR = 14;
  const plotW = chartW - padL - padR;

  const spdTop = 20;
  const spdH = 144;
  const spdBottom = spdTop + spdH; // 164

  const gTop = 186;
  const gH = 74;
  const gBottom = gTop + gH; // 260
  const gMidY = gTop + gH / 2; // 223

  const maxSpd = useMemo(() => {
    const peak = Math.max(
      100,
      ...lapASamples.map((s) => s.speedKmh || 0),
      ...lapBSamples.map((s) => s.speedKmh || 0)
    );
    return Math.ceil(peak / 20) * 20;
  }, [lapASamples, lapBSamples]);

  const maxGScale = useMemo(() => {
    const peakG = Math.max(
      0.8,
      ...lapASamples.map((s) => Math.abs(s.accelLongG ?? 0)),
      ...lapBSamples.map((s) => Math.abs(s.accelLongG ?? 0))
    );
    return Math.min(2.5, Math.ceil(peakG * 2) / 2);
  }, [lapASamples, lapBSamples]);

  const xAtM = (distM: number) =>
    padL + Math.max(0, Math.min(1, distM / maxDistM)) * plotW;

  const yAtKmh = (kmh: number) =>
    spdTop + spdH - Math.max(0, Math.min(1, kmh / maxSpd)) * spdH;

  const yAtLongG = (gVal: number) => {
    const clamped = Math.max(-maxGScale, Math.min(maxGScale, gVal));
    return gMidY - (clamped / maxGScale) * (gH / 2);
  };

  const speedPolyA = useMemo(
    () =>
      lapASamples
        .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [lapASamples, maxDistM, maxSpd]
  );

  const speedPolyB = useMemo(
    () =>
      lapBSamples
        .map((s) => `${xAtM(s.distKm * 1000).toFixed(1)},${yAtKmh(s.speedKmh).toFixed(1)}`)
        .join(' '),
    [lapBSamples, maxDistM, maxSpd]
  );

  const longGPolyA = useMemo(
    () =>
      lapASamples
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [lapASamples, maxDistM, maxGScale]
  );

  const longGPolyB = useMemo(
    () =>
      lapBSamples
        .map(
          (s) =>
            `${xAtM(s.distKm * 1000).toFixed(1)},${yAtLongG(s.accelLongG ?? 0).toFixed(1)}`
        )
        .join(' '),
    [lapBSamples, maxDistM, maxGScale]
  );

  const scrubPoint = useMemo(() => {
    const distKm = scrubDistM / 1000;
    const sA = interpolateSampleAtDist(lapASamples, distKm);
    const sB = interpolateSampleAtDist(lapBSamples, distKm);
    const speedA = sA ? Math.round(sA.speedKmh) : null;
    const speedB = sB ? Math.round(sB.speedKmh) : null;
    const speedDelta =
      speedA !== null && speedB !== null ? speedA - speedB : null;
    const timeAMs = sA ? sA.stageElapsedMs : null;
    const timeBMs = sB ? sB.stageElapsedMs : null;
    const timeDeltaSec =
      timeAMs !== null && timeBMs !== null
        ? Number(((timeAMs - timeBMs) / 1000).toFixed(2))
        : null;
    const longGA = sA && typeof sA.accelLongG === 'number' ? sA.accelLongG : 0;
    const longGB = sB && typeof sB.accelLongG === 'number' ? sB.accelLongG : 0;
    return {
      distM: Math.round(scrubDistM),
      speedA,
      speedB,
      speedDelta,
      timeAMs,
      timeBMs,
      timeDeltaSec,
      longGA,
      longGB,
    };
  }, [scrubDistM, lapASamples, lapBSamples]);

  const updateScrubFromPointer = (clientX: number) => {
    const svg = svgRef.current;
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

  const sectorBoundaries = useMemo(() => {
    if (!sectorComparison) return [];
    return sectorComparison.sectors.map((sec) => ({
      shortLabel: sec.shortLabel,
      fromM: Math.round(sec.fromDistKm * 1000),
      toM: Math.round(sec.toDistKm * 1000),
      midM: Math.round(((sec.fromDistKm + sec.toDistKm) / 2) * 1000),
    }));
  }, [sectorComparison]);

  const showLapB = Boolean(lapB && lapBSamples.length > 1 && lapB.id !== lapA?.id);

  return (
    <div className="space-y-3">
      {/* KPI Strip — FuelTech FT600 Pure Black Hairline Cards */}
      {comparisonSummary && (
        <div className="grid grid-cols-3 gap-2 font-mono text-center tabular-nums">
          <div className="rounded-xl border border-zinc-800 bg-[#050608] p-2.5">
            <p className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
              Delta A vs B
            </p>
            <p
              className={`mt-0.5 text-sm font-extrabold sm:text-base ${
                comparisonSummary.totalDeltaSec <= 0
                  ? 'text-[#10B981]'
                  : 'text-[#FF2A2A]'
              }`}
            >
              {formatSignedSec(comparisonSummary.totalDeltaSec)}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#050608] p-2.5">
            <p className="text-[10px] font-bold tracking-wider text-[#10B981] uppercase">
              Melhor Volta
            </p>
            <p className="mt-0.5 text-sm font-extrabold text-[#10B981] sm:text-base">
              {formatStageDuration(sessionOptimal.bestRunTotalMs)}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#050608] p-2.5">
            <p className="text-[10px] font-bold tracking-wider text-amber-400 uppercase">
              Volta Ideal
            </p>
            <p className="mt-0.5 text-sm font-extrabold text-amber-300 sm:text-base">
              {formatStageDuration(sessionOptimal.optimalTotalMs)}
            </p>
          </div>
        </div>
      )}

      {/* 1. FUELTECH DUAL-TRACK SVG DATALOGGER (Velocidade + Força G Longitudinal vs Distância) */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Datalogger FuelTech · Velocidade &amp; G-Longitudinal
            </h3>
            <p className="font-mono text-[10px] text-zinc-400">
              Toque ou deslize o dedo no gráfico para ler metro a metro
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px]">
            <span className="inline-flex items-center gap-1.5 font-bold text-[#FF2A2A]">
              <span className="inline-block h-[2.5px] w-4 bg-[#FF2A2A]" />
              Volta #{lapA?.runNumber ?? '-'}
            </span>
            {showLapB && (
              <span className="inline-flex items-center gap-1.5 font-bold text-[#10B981]">
                <span className="inline-block w-4 border-t-2 border-dashed border-[#10B981]" />
                Ref #{lapB?.runNumber ?? '-'}
              </span>
            )}
          </div>
        </div>

        {/* Live Cursor Telemetry Readout HUD */}
        {lapASamples.length > 1 && (
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
              <span className="text-zinc-500 uppercase">Velocidade</span>
              <p className="font-extrabold">
                <span className="text-[#FF2A2A]">{scrubPoint.speedA ?? '--'}</span>
                {showLapB && (
                  <>
                    <span className="text-zinc-500"> / </span>
                    <span className="text-[#10B981]">{scrubPoint.speedB ?? '--'}</span>
                    <span className="text-zinc-400"> km/h </span>
                    <span
                      className={
                        (scrubPoint.speedDelta ?? 0) >= 0
                          ? 'text-[#10B981]'
                          : 'text-[#FF2A2A]'
                      }
                    >
                      ({formatSignedKmh(scrubPoint.speedDelta)})
                    </span>
                  </>
                )}
                {!showLapB && <span className="text-zinc-400"> km/h</span>}
              </p>
            </div>

            <div>
              <span className="text-zinc-500 uppercase">Tempo Acum.</span>
              <p className="font-extrabold">
                <span className="text-white">
                  {formatStageDuration(scrubPoint.timeAMs)}
                </span>
                {showLapB && scrubPoint.timeDeltaSec !== null && (
                  <span
                    className={`ml-1.5 ${
                      scrubPoint.timeDeltaSec <= 0
                        ? 'text-[#10B981]'
                        : 'text-[#FF2A2A]'
                    }`}
                  >
                    ({formatSignedSec(scrubPoint.timeDeltaSec)})
                  </span>
                )}
              </p>
            </div>

            <div>
              <span className="text-zinc-500 uppercase">Força G-Long</span>
              <p className="font-extrabold">
                <span
                  className={
                    scrubPoint.longGA < -0.05
                      ? 'text-[#FF2A2A]'
                      : scrubPoint.longGA > 0.05
                        ? 'text-[#10B981]'
                        : 'text-white'
                  }
                >
                  {scrubPoint.longGA >= 0 ? '+' : ''}
                  {scrubPoint.longGA.toFixed(2)} G
                </span>
                {showLapB && (
                  <span className="text-zinc-400">
                    {' '}
                    / {scrubPoint.longGB >= 0 ? '+' : ''}
                    {scrubPoint.longGB.toFixed(2)}
                  </span>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Dual-Channel SVG */}
        <div className="relative rounded-lg border border-zinc-800/90 bg-[#050608] p-1.5">
          {lapASamples.length > 1 ? (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${chartW} ${chartH}`}
              className="h-64 w-full touch-none select-none cursor-crosshair sm:h-72"
              onPointerDown={(e) => {
                isDraggingRef.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                updateScrubFromPointer(e.clientX);
              }}
              onPointerMove={(e) => {
                if (!isDraggingRef.current && e.pointerType === 'touch') return;
                if (isDraggingRef.current || e.buttons === 1) {
                  updateScrubFromPointer(e.clientX);
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
                y={spdTop - 6}
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
                    y={chartH - 8}
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

              {/* Speed Trace B (Emerald Reference) */}
              {showLapB && (
                <polyline
                  fill="none"
                  stroke="#10B981"
                  strokeWidth="2"
                  strokeDasharray="5 3"
                  strokeOpacity="0.9"
                  points={speedPolyB}
                />
              )}

              {/* Speed Trace A (FuelTech Red) */}
              <polyline
                fill="none"
                stroke="#FF2A2A"
                strokeWidth="2.4"
                points={speedPolyA}
              />

              {/* Longitudinal G Trace B (Emerald) */}
              {showLapB && (
                <polyline
                  fill="none"
                  stroke="#10B981"
                  strokeWidth="1.6"
                  strokeDasharray="4 3"
                  strokeOpacity="0.8"
                  points={longGPolyB}
                />
              )}

              {/* Longitudinal G Trace A (Red) */}
              <polyline
                fill="none"
                stroke="#FF2A2A"
                strokeWidth="2"
                points={longGPolyA}
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
              {scrubPoint.speedA !== null && (
                <circle
                  cx={scrubX}
                  cy={yAtKmh(scrubPoint.speedA)}
                  r="4"
                  fill="#FF2A2A"
                  stroke="#FFFFFF"
                  strokeWidth="1.5"
                />
              )}
              {showLapB && scrubPoint.speedB !== null && (
                <circle
                  cx={scrubX}
                  cy={yAtKmh(scrubPoint.speedB)}
                  r="3.5"
                  fill="#10B981"
                  stroke="#FFFFFF"
                  strokeWidth="1.2"
                />
              )}
              <circle
                cx={scrubX}
                cy={yAtLongG(scrubPoint.longGA)}
                r="3.5"
                fill="#FF2A2A"
                stroke="#FFFFFF"
                strokeWidth="1.2"
              />
              {showLapB && (
                <circle
                  cx={scrubX}
                  cy={yAtLongG(scrubPoint.longGB)}
                  r="3"
                  fill="#10B981"
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
        {lapASamples.length > 1 && (
          <div className="flex items-center gap-2 pt-0.5">
            <Crosshair className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <input
              type="range"
              aria-label="Cursor de distância no gráfico"
              min={0}
              max={Math.round(maxDistM)}
              value={Math.min(Math.round(maxDistM), scrubDistM)}
              onChange={(e) => setScrubDistM(Number(e.target.value))}
              className="w-full accent-[#FF2A2A]"
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

      {/* 2. TABELA COMPARATIVA POR TRECHO (SETORES — ESTILO PAINEL FUELTECH) */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3 text-white space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-base font-bold tracking-wide uppercase sm:text-lg">
              Comparativo por Trecho (Setores)
            </h3>
            <p className="font-mono text-[10px] text-zinc-400">
              {sectorComparison?.rows.some((r) => r.isTrapBased)
                ? 'Divisão exata pelos Marcos (Traps) da pista · toque no setor para inspecionar'
                : 'Divisão automática em 4 trechos iguais de distância · toque no setor para inspecionar'}
            </p>
          </div>
          <span className="font-mono text-[10px] text-zinc-400">
            Volta #{lapA?.runNumber ?? '-'} vs #{lapB?.runNumber ?? '-'}
          </span>
        </div>

        {sectorComparison && sectorComparison.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums sm:text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400">
                  <th className="py-2 pr-2">Trecho</th>
                  <th className="px-2 py-2 text-right">Tempo</th>
                  <th className="px-2 py-2 text-right">Vel. Máx</th>
                  <th className="px-2 py-2 text-right">Vel. Méd</th>
                  <th className="py-2 pl-2 text-right">Vel. Saída</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {sectorComparison.rows.map((row) => {
                  const timeFaster = row.timeDeltaSec !== null && row.timeDeltaSec <= 0;
                  const maxHigher =
                    row.maxSpeedDeltaKmh !== null && row.maxSpeedDeltaKmh >= 0;
                  const avgHigher =
                    row.avgSpeedDeltaKmh !== null && row.avgSpeedDeltaKmh >= 0;
                  const exitHigher =
                    row.exitSpeedDeltaKmh !== null && row.exitSpeedDeltaKmh >= 0;

                  const isScrubInside =
                    scrubDistM >= row.fromDistM && scrubDistM <= row.toDistM;

                  return (
                    <tr
                      key={row.index}
                      onClick={() =>
                        setScrubDistM(Math.round((row.fromDistM + row.toDistM) / 2))
                      }
                      className={`cursor-pointer transition-colors hover:bg-zinc-900/70 ${
                        isScrubInside ? 'bg-zinc-900/90' : ''
                      }`}
                    >
                      <td className="py-2.5 pr-2 whitespace-nowrap">
                        <span className="font-sans text-xs font-extrabold text-white">
                          {row.label}
                        </span>
                        <span className="block text-[10px] text-zinc-500">
                          {row.fromDistM}–{row.toDistM}m
                        </span>
                      </td>

                      <td className="px-2 py-2.5 text-right whitespace-nowrap">
                        <span className="font-bold text-white">
                          {formatSectorSec(row.lapA.durationMs)}
                        </span>
                        {showLapB && row.timeDeltaSec !== null && (
                          <span
                            className={`block text-[10px] font-bold ${
                              timeFaster ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                            }`}
                          >
                            {formatSignedSec(row.timeDeltaSec)}
                          </span>
                        )}
                      </td>

                      <td className="px-2 py-2.5 text-right whitespace-nowrap">
                        <span className="font-bold text-white">
                          {row.lapA.maxSpeedKmh ?? '--'}{' '}
                          <span className="text-[9px] text-zinc-500">km/h</span>
                        </span>
                        {showLapB && row.maxSpeedDeltaKmh !== null && (
                          <span
                            className={`block text-[10px] font-bold ${
                              maxHigher ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                            }`}
                          >
                            {formatSignedKmh(row.maxSpeedDeltaKmh)} km/h
                          </span>
                        )}
                      </td>

                      <td className="px-2 py-2.5 text-right whitespace-nowrap">
                        <span className="font-bold text-white">
                          {row.lapA.avgSpeedKmh ?? '--'}{' '}
                          <span className="text-[9px] text-zinc-500">km/h</span>
                        </span>
                        {showLapB && row.avgSpeedDeltaKmh !== null && (
                          <span
                            className={`block text-[10px] font-bold ${
                              avgHigher ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                            }`}
                          >
                            {formatSignedKmh(row.avgSpeedDeltaKmh)} km/h
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 pl-2 text-right whitespace-nowrap">
                        <span className="font-bold text-white">
                          {row.lapA.exitSpeedKmh ?? '--'}{' '}
                          <span className="text-[9px] text-zinc-500">km/h</span>
                        </span>
                        {showLapB && row.exitSpeedDeltaKmh !== null && (
                          <span
                            className={`block text-[10px] font-bold ${
                              exitHigher ? 'text-[#10B981]' : 'text-[#FF2A2A]'
                            }`}
                          >
                            {formatSignedKmh(row.exitSpeedDeltaKmh)} km/h
                          </span>
                        )}
                      </td>
                    </tr>
                  );
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

      {/* 3. CARD DO TREINADOR IA */}
      <div className="rounded-xl border border-zinc-800 bg-[#050608] p-3.5 text-white space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
              Treinador IA
            </h3>
            <p className="text-xs text-zinc-400">
              Feedback tático direto comparando Volta #{lapA?.runNumber ?? '-'} com Volta #
              {lapB?.runNumber ?? '-'}.
            </p>
          </div>

          <button
            type="button"
            disabled={coachLoading || !comparisonSummary}
            onClick={onRequestAiCoach}
            className="pitstop-btn-red inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold text-white disabled:opacity-50"
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

      {/* 4. VOLTA IDEAL POR SETORES */}
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

      {/* 5. VOLTAS DA SESSÃO */}
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
