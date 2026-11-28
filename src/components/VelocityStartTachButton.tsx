import React, { useEffect, useMemo, useRef, useState } from 'react';

interface VelocityStartTachButtonProps {
  onConfirm: () => void;
  sweepTrigger: number;
  isPro?: boolean;
  subtitle?: string;
  gpsSignalOk?: boolean;
}

const TOTAL_SEGMENTS = 54;
const START_ANGLE_DEG = 138; // Esquerda inferior (~7:30) sentido horário até direita inferior (~4:30)
const SWEEP_SPAN_DEG = 264;
const OPEN_SWEEP_DURATION_MS = 900;
const LAUNCH_DURATION_MS = 450;

// Corte de giro contínuo a 6.000 RPM (oscilando exatamente na marca do 6 até o limite antes do 7)
const REV_LIMITER_SEQUENCE = [
  51, 45, 50, 44, 52, 46, 49, 44, 51, 45, 50, 43, 52, 46, 49, 45,
];
const REV_LIMITER_INTERVALS_MS = [
  66, 52, 62, 56, 74, 54, 60, 70, 50, 64, 56, 76, 52, 64, 54, 68,
];

const RPM_NUMBERS = [
  { label: '1', t: 0.04, red: false },
  { label: '2', t: 0.2, red: false },
  { label: '3', t: 0.36, red: false },
  { label: '4', t: 0.52, red: false },
  { label: '5', t: 0.68, red: false },
  { label: '6', t: 0.84, red: true },
  { label: '7', t: 1.0, red: true },
] as const;

type LaunchPhase = 'idle' | 'flash1' | 'gap1' | 'flash2' | 'gap2' | 'flash3';

interface SegmentGeom {
  index: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  tx1: number;
  ty1: number;
  tx2: number;
  ty2: number;
  isMajorTick: boolean;
  baseColor: string;
  zone: 'white' | 'amber' | 'red';
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function getSegmentMeta(index: number, total: number): {
  color: string;
  zone: 'white' | 'amber' | 'red';
} {
  const t = index / Math.max(1, total - 1);
  if (t < 0.34) return { color: '#FFFFFF', zone: 'white' };
  if (t < 0.48) return { color: '#FDE047', zone: 'amber' };
  if (t < 0.66) return { color: '#F97316', zone: 'amber' };
  if (t < 0.8) return { color: '#EF4444', zone: 'red' };
  return { color: '#FF1A1A', zone: 'red' };
}

function playTelemetryArmBeep(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(1046.5, now);
    osc.frequency.setValueAtTime(1318.5, now + 0.055);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 300);
  } catch {
    // Ignore audio context restriction
  }
}

export const VelocityStartTachButton: React.FC<VelocityStartTachButtonProps> = ({
  onConfirm,
  sweepTrigger,
  isPro = true,
  subtitle = 'ARMAR ESPECIAL',
  gpsSignalOk = true,
}) => {
  const [litSegments, setLitSegments] = useState<number>(TOTAL_SEGMENTS);
  const [revLimiterActive, setRevLimiterActive] = useState<boolean>(false);
  const [revStep, setRevStep] = useState<number>(0);
  const [launchPhase, setLaunchPhase] = useState<LaunchPhase>('idle');

  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const launchingRef = useRef(false);
  const launchTimersRef = useRef<number[]>([]);

  const segments = useMemo<SegmentGeom[]>(() => {
    const step = SWEEP_SPAN_DEG / Math.max(1, TOTAL_SEGMENTS - 1);
    const list: SegmentGeom[] = [];
    for (let i = 0; i < TOTAL_SEGMENTS; i += 1) {
      const angle = START_ANGLE_DEG + i * step;
      const isMajorTick = i % 6 === 0 || i === TOTAL_SEGMENTS - 1;
      const pIn = polarToCartesian(110, 110, 86.2, angle);
      const pOut = polarToCartesian(110, 110, 94.6, angle);
      const cIn = polarToCartesian(110, 110, 87.3, angle);
      const cOut = polarToCartesian(110, 110, 93.5, angle);
      const tIn = polarToCartesian(110, 110, isMajorTick ? 79.2 : 81.0, angle);
      const tOut = polarToCartesian(110, 110, 84.0, angle);
      const meta = getSegmentMeta(i, TOTAL_SEGMENTS);
      list.push({
        index: i,
        x1: pIn.x,
        y1: pIn.y,
        x2: pOut.x,
        y2: pOut.y,
        cx1: cIn.x,
        cy1: cIn.y,
        cx2: cOut.x,
        cy2: cOut.y,
        tx1: tIn.x,
        ty1: tIn.y,
        tx2: tOut.x,
        ty2: tOut.y,
        isMajorTick,
        baseColor: meta.color,
        zone: meta.zone,
      });
    }
    return list;
  }, []);

  const rpmLabels = useMemo(() => {
    return RPM_NUMBERS.map((item) => {
      const angle = START_ANGLE_DEG + item.t * SWEEP_SPAN_DEG;
      const pos = polarToCartesian(110, 110, 72.2, angle);
      return {
        ...item,
        x: pos.x,
        y: pos.y,
      };
    });
  }, []);

  // 1) Varredura inicial horária (~900ms) -> 2) Entra em corte de giro contínuo na marca do 6
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setLitSegments(TOTAL_SEGMENTS);
      setRevLimiterActive(false);
      return;
    }

    setLitSegments(0);
    setRevLimiterActive(false);
    setRevStep(0);

    let rafId = 0;
    const startTs = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTs;
      const linear = Math.min(1, Math.max(0, elapsed / OPEN_SWEEP_DURATION_MS));
      const eased = 1 - Math.pow(1 - linear, 2.15);
      const count = Math.min(TOTAL_SEGMENTS, Math.round(eased * TOTAL_SEGMENTS));
      setLitSegments(count);
      if (linear < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        setLitSegments(TOTAL_SEGMENTS);
        setRevLimiterActive(true);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [sweepTrigger]);

  // Loop contínuo de corte de giro a 6.000 RPM
  useEffect(() => {
    if (!revLimiterActive || launchPhase !== 'idle') return;
    if (typeof window === 'undefined') return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    const stepIdx = revStep % REV_LIMITER_SEQUENCE.length;
    const nextLit = REV_LIMITER_SEQUENCE[stepIdx];
    const delayMs = REV_LIMITER_INTERVALS_MS[stepIdx];

    setLitSegments(nextLit);

    const timer = window.setTimeout(() => {
      setRevStep((s) => (s + 1) % REV_LIMITER_SEQUENCE.length);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [revLimiterActive, revStep, launchPhase]);

  useEffect(() => {
    return () => {
      for (const t of launchTimersRef.current) {
        window.clearTimeout(t);
      }
      launchTimersRef.current = [];
    };
  }, []);

  const clearLaunchTimers = () => {
    for (const t of launchTimersRef.current) {
      window.clearTimeout(t);
    }
    launchTimersRef.current = [];
  };

  const handlePress = () => {
    if (launchingRef.current) return;

    playTelemetryArmBeep();

    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate([40, 30, 80]);
      } catch {
        // Ignore vibration restrictions
      }
    }

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      onConfirmRef.current();
      return;
    }

    launchingRef.current = true;
    clearLaunchTimers();
    setLaunchPhase('flash1');

    launchTimersRef.current = [
      window.setTimeout(() => setLaunchPhase('gap1'), 75),
      window.setTimeout(() => setLaunchPhase('flash2'), 150),
      window.setTimeout(() => setLaunchPhase('gap2'), 225),
      window.setTimeout(() => setLaunchPhase('flash3'), 300),
      window.setTimeout(() => {
        launchingRef.current = false;
        setLaunchPhase('idle');
        onConfirmRef.current();
      }, LAUNCH_DURATION_MS),
    ];
  };

  const isLaunching = launchPhase !== 'idle';
  const isRevPeak = revLimiterActive && !isLaunching && litSegments >= 50;

  return (
    <div className="relative flex flex-col items-center justify-center py-0.5 sm:py-2">
      {!isPro && (
        <span className="mb-1 rounded border border-amber-500/60 bg-[var(--ps-card-deep)] px-2 py-0.5 font-mono text-[10px] font-black text-[var(--ps-amber)] shadow">
          PRO
        </span>
      )}

      {/* Aro Metálico Externo Fixo (apenas o miolo central afunda no clique) */}
      <button
        type="button"
        onClick={handlePress}
        aria-label={`Iniciar e ${subtitle.toLowerCase()}`}
        className="group relative flex h-[clamp(138px,21.5dvh,204px)] w-[clamp(138px,21.5dvh,204px)] items-center justify-center rounded-full touch-manipulation select-none transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF2A2A] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--ps-bg)]"
        style={{
          background: [
            'linear-gradient(135deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.06) 28%, rgba(0,0,0,0.45) 60%, rgba(255,255,255,0.22) 100%)',
            'conic-gradient(from 210deg, #9CA3AF 0deg, #1F2329 48deg, #717680 105deg, #111317 175deg, #8F96A2 230deg, #252930 292deg, #686D76 332deg, #9CA3AF 360deg)',
          ].join(', '),
          boxShadow:
            launchPhase === 'flash3'
              ? '0 20px 44px rgba(0,0,0,0.88), 0 0 28px rgba(16,185,129,0.58), inset 0 1px 1.5px rgba(255,255,255,0.65), inset 0 -1.5px 3px rgba(0,0,0,0.9)'
              : launchPhase === 'flash1' || launchPhase === 'flash2' || isRevPeak
                ? '0 20px 44px rgba(0,0,0,0.88), 0 0 22px rgba(255,26,26,0.42), inset 0 1px 1.5px rgba(255,255,255,0.65), inset 0 -1.5px 3px rgba(0,0,0,0.9)'
                : '0 20px 44px rgba(0,0,0,0.88), inset 0 1px 1.5px rgba(255,255,255,0.6), inset 0 -1.5px 3px rgba(0,0,0,0.9)',
        }}
      >
        {/* Chanfro interno fino + Cavidade 3D Profunda do Mostrador */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-[4.3%] rounded-full border border-white/25"
          style={{
            background:
              'radial-gradient(circle at 50% 50%, #090A0D 62%, #040507 84%, #101216 97%, #2A2E35 100%)',
            boxShadow:
              'inset 0 10px 24px rgba(0,0,0,0.95), inset 0 -4px 12px rgba(0,0,0,0.9)',
          }}
        />

        {/* SVG: Escala 1..7, Ticks, 54 LEDs com Glow, Micro-tag GPS FRACO e Segundo Anel Metálico */}
        <svg
          viewBox="0 0 220 220"
          aria-hidden="true"
          className="pointer-events-none relative z-10 h-full w-full"
        >
          <defs>
            <linearGradient id="ps-bezel-chrome-dark" x1="12%" y1="8%" x2="88%" y2="92%">
              <stop offset="0%" stopColor="#9CA3AF" />
              <stop offset="26%" stopColor="#262930" />
              <stop offset="52%" stopColor="#757B86" />
              <stop offset="80%" stopColor="#14161A" />
              <stop offset="100%" stopColor="#8A8F98" />
            </linearGradient>

            <linearGradient id="ps-inner-ring-chrome" x1="15%" y1="10%" x2="85%" y2="90%">
              <stop offset="0%" stopColor="#A1A7B3" />
              <stop offset="32%" stopColor="#272A31" />
              <stop offset="65%" stopColor="#6D737D" />
              <stop offset="100%" stopColor="#17191E" />
            </linearGradient>

            <radialGradient id="ps-cavity-ambient" cx="50%" cy="50%" r="50%">
              <stop offset="64%" stopColor="rgba(0,0,0,0)" />
              <stop
                offset="84%"
                stopColor={
                  launchPhase === 'flash3'
                    ? 'rgba(16,185,129,0.22)'
                    : isRevPeak || launchPhase === 'flash1'
                      ? 'rgba(255,26,26,0.16)'
                      : 'rgba(249,115,22,0.08)'
                }
              />
              <stop offset="100%" stopColor="rgba(0,0,0,0)" />
            </radialGradient>

            <filter id="ps-glow-white" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="1.9" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id="ps-glow-amber" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.1" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id="ps-glow-red" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="2.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id="ps-glow-green" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="2.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Iluminação ambiente dentro da cavidade do mostrador */}
          <circle cx="110" cy="110" r="97" fill="url(#ps-cavity-ambient)" />

          {/* Base fechada discreta na parte inferior (entre 46° e 134°) */}
          <path
            d="M 178.4 180.8 A 98.5 98.5 0 0 1 41.6 180.8 L 62.9 158.8 A 68.0 68.0 0 0 0 157.1 158.8 Z"
            fill="url(#ps-bezel-chrome-dark)"
            fillOpacity="0.32"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="0.6"
          />

          {/* Marcações finas internas + 54 LEDs segmentados */}
          {segments.map((seg) => {
            let stroke = 'rgba(255, 255, 255, 0.08)';
            let isLit = false;
            let glowFilter: string | undefined;

            if (isLaunching) {
              if (launchPhase === 'flash1') {
                stroke = seg.index % 2 === 0 ? '#FF2424' : '#F97316';
                isLit = true;
                glowFilter = 'url(#ps-glow-red)';
              } else if (launchPhase === 'gap1' || launchPhase === 'gap2') {
                stroke = 'rgba(255, 255, 255, 0.07)';
                isLit = false;
              } else if (launchPhase === 'flash2') {
                stroke = seg.index % 2 === 0 ? '#F97316' : '#FDE047';
                isLit = true;
                glowFilter = 'url(#ps-glow-amber)';
              } else if (launchPhase === 'flash3') {
                stroke = seg.index % 3 === 0 ? '#34D399' : '#10B981';
                isLit = true;
                glowFilter = 'url(#ps-glow-green)';
              }
            } else if (seg.index < litSegments) {
              stroke = seg.baseColor;
              isLit = true;
              if (seg.zone === 'red') {
                glowFilter = 'url(#ps-glow-red)';
              } else if (seg.zone === 'amber') {
                glowFilter = 'url(#ps-glow-amber)';
              } else {
                glowFilter = 'url(#ps-glow-white)';
              }
            }

            return (
              <g key={seg.index}>
                <line
                  x1={seg.tx1}
                  y1={seg.ty1}
                  x2={seg.tx2}
                  y2={seg.ty2}
                  stroke={
                    isLit
                      ? seg.zone === 'red'
                        ? 'rgba(255,80,80,0.7)'
                        : 'rgba(255,255,255,0.52)'
                      : 'rgba(255,255,255,0.14)'
                  }
                  strokeWidth={seg.isMajorTick ? '1.15' : '0.65'}
                  strokeLinecap="round"
                />

                <g filter={glowFilter}>
                  <line
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={stroke}
                    strokeWidth="2.05"
                    strokeLinecap="round"
                    strokeOpacity={isLit ? 1 : 0.3}
                  />
                  {isLit && (
                    <line
                      x1={seg.cx1}
                      y1={seg.cy1}
                      x2={seg.cx2}
                      y2={seg.cy2}
                      stroke="#FFFFFF"
                      strokeWidth="0.72"
                      strokeLinecap="round"
                      strokeOpacity={
                        launchPhase === 'flash3'
                          ? 0.6
                          : seg.zone === 'red'
                            ? 0.55
                            : 0.5
                      }
                    />
                  )}
                </g>
              </g>
            );
          })}

          {/* Números de Escala de RPM (1 a 5 cinza-prata translúcido, 6 e 7 vermelho) */}
          {rpmLabels.map((rpm) => (
            <text
              key={rpm.label}
              x={rpm.x}
              y={rpm.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="Barlow Condensed, sans-serif"
              fontSize="8.6"
              fontWeight="800"
              fill={rpm.red ? '#FF2A2A' : 'rgba(203, 213, 225, 0.72)'}
              style={
                rpm.red
                  ? { filter: 'drop-shadow(0 0 3px rgba(255,42,42,0.7))' }
                  : undefined
              }
            >
              {rpm.label}
            </text>
          ))}

          {/* Micro-tag âmbar discreta na base interna do mostrador quando GPS estiver fraco/sem fix */}
          {!gpsSignalOk && (
            <text
              x="110"
              y="191.5"
              textAnchor="middle"
              dominantBaseline="central"
              fontFamily="JetBrains Mono, monospace"
              fontSize="6.8"
              fontWeight="800"
              letterSpacing="1.2"
              fill="#FBBF24"
              fillOpacity="0.92"
            >
              GPS FRACO
            </text>
          )}

          {/* Segundo anel metálico fino separando a escala do miolo físico pressionável */}
          <circle
            cx="110"
            cy="110"
            r="65.2"
            fill="none"
            stroke="url(#ps-inner-ring-chrome)"
            strokeWidth="2.1"
          />
          <circle
            cx="110"
            cy="110"
            r="66.3"
            fill="none"
            stroke="rgba(255,255,255,0.28)"
            strokeWidth="0.55"
          />
          <circle
            cx="110"
            cy="110"
            r="64.0"
            fill="none"
            stroke="rgba(0,0,0,0.92)"
            strokeWidth="1.0"
          />
        </svg>

        {/* Miolo Central Pressionável (apenas ele afunda com group-active:scale-[0.96]) */}
        <span
          className="pointer-events-none absolute inset-[21%] z-20 flex flex-col items-center justify-center rounded-full px-2 text-center transition-transform duration-100 ease-out group-hover:scale-[1.01] group-active:scale-[0.96]"
          style={{
            backgroundColor: '#08090C',
            backgroundImage: [
              'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.88) 100%)',
              'repeating-linear-gradient(-45deg, rgba(255,255,255,0.045) 0px, rgba(255,255,255,0.045) 2px, transparent 2px, transparent 5px)',
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.024) 0px, rgba(255,255,255,0.024) 2px, rgba(0,0,0,0.52) 2px, rgba(0,0,0,0.52) 5px)',
            ].join(', '),
            boxShadow:
              'inset 0 10px 22px rgba(0,0,0,0.95), inset 0 -4px 12px rgba(0,0,0,0.88)',
          }}
        >
          {/* Pequeno ponto LED verde acima da bandeira quando o sinal GPS estiver bom */}
          {gpsSignalOk && (
            <span
              aria-hidden="true"
              className="mb-1 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.95)]"
            />
          )}

          {/* Bandeira sólida em branco */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="mb-0.5 h-[clamp(13px,2.2dvh,18px)] w-[clamp(13px,2.2dvh,18px)] drop-shadow-[0_2px_4px_rgba(0,0,0,0.95)]"
          >
            <path
              fill={launchPhase === 'flash3' ? '#34D399' : '#FFFFFF'}
              d="M5 3.5a1 1 0 0 1 1 1v.65c1.85-.72 3.85-.72 5.7.08 1.78.77 3.63.84 5.52.23a1 1 0 0 1 1.28.96v7.15a1 1 0 0 1-.69.95c-2.06.66-4.18.6-6.21-.27-1.6-.69-3.35-.73-5.1-.13V20a1 1 0 1 1-2 0V4.5a1 1 0 0 1 1-1Z"
            />
          </svg>

          <span className="font-['Barlow_Condensed'] text-[clamp(20px,3.6dvh,31px)] font-black italic leading-none tracking-wider text-white uppercase drop-shadow-[0_3px_8px_rgba(0,0,0,0.98)]">
            INICIAR
          </span>

          <span className="mt-1 whitespace-nowrap font-mono text-[clamp(7px,1.15dvh,8.5px)] font-bold tracking-[0.16em] text-slate-300 uppercase leading-none drop-shadow-[0_1px_4px_rgba(0,0,0,0.98)]">
            {subtitle}
          </span>
        </span>

        {/* Lente de Vidro 3D Convexa (Glass Dome) sobre todo o mostrador interno */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-[4.6%] z-30 overflow-hidden rounded-full"
          style={{
            boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.16)',
          }}
        >
          <span
            className="absolute -top-[18%] left-[6%] right-[6%] h-[62%] rounded-[50%]"
            style={{
              background:
                'linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.04) 48%, rgba(255,255,255,0) 100%)',
            }}
          />
          <span
            className="absolute inset-0 rounded-full"
            style={{
              background:
                'radial-gradient(ellipse 80% 45% at 50% 12%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 70%)',
            }}
          />
        </span>
      </button>
    </div>
  );
};
