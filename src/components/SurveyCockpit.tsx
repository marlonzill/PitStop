import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Compass,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  MapPin,
  Navigation,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Satellite,
  ShieldAlert,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useNavSettings } from '../utils/navSettings';
import {
  bearingBetweenDeg,
  createGpsKalmanProcessor,
  getCapacitorGpsWatchOptions,
  haversineMetersVel,
  parseTrackFileToTrack,
  WEB_GPS_WATCH_OPTIONS,
  type VelocitySample,
  type VelocityTrack,
  type VelocityTrap,
} from '../utils/velocityEngine';
import { VelocityMapboxView } from './VelocityMapboxView';

type DriveMode = 'gps' | 'simulator';

type ManeuverKind =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'slight-right'
  | 'right'
  | 'uturn'
  | 'finish';

interface WazeGuidance {
  kind: ManeuverKind;
  instruction: string;
  targetLabel: string;
  distToManeuverM: number;
  remainingTotalKm: number;
  progressPct: number;
  closestIdx: number;
}

interface ReccePrefs {
  enabled: boolean;
  speedLimitKmh: number;
  warningMarginKmh: number;
  soundEnabled: boolean;
}

const RECCE_PREFS_KEY = 'pitstop_recce_speed_prefs_v1';

const DEFAULT_RECCE_PREFS: ReccePrefs = {
  enabled: true,
  speedLimitKmh: 60,
  warningMarginKmh: 5,
  soundEnabled: true,
};

function loadReccePrefs(): ReccePrefs {
  try {
    const raw = localStorage.getItem(RECCE_PREFS_KEY);
    if (!raw) return DEFAULT_RECCE_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReccePrefs>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      speedLimitKmh:
        typeof parsed.speedLimitKmh === 'number' && parsed.speedLimitKmh >= 10
          ? Math.min(200, Math.round(parsed.speedLimitKmh))
          : 60,
      warningMarginKmh:
        typeof parsed.warningMarginKmh === 'number' && parsed.warningMarginKmh >= 1
          ? Math.min(30, Math.round(parsed.warningMarginKmh))
          : 5,
      soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
    };
  } catch {
    return DEFAULT_RECCE_PREFS;
  }
}

let sharedRecceAudioCtx: AudioContext | null = null;

function getRecceAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedRecceAudioCtx && sharedRecceAudioCtx.state !== 'closed') {
    if (sharedRecceAudioCtx.state === 'suspended') {
      sharedRecceAudioCtx.resume().catch(() => {});
    }
    return sharedRecceAudioCtx;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  sharedRecceAudioCtx = new AudioCtx();
  return sharedRecceAudioCtx;
}

function playRecceAlertTone(level: 'warning' | 'over') {
  try {
    const ctx = getRecceAudioContext();
    if (!ctx) return;

    const triggerPulse = (freq: number, startOffset: number, dur: number, gainPeak: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = level === 'over' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(gainPeak, ctx.currentTime + startOffset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startOffset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + dur + 0.02);
    };

    if (level === 'over') {
      triggerPulse(1320, 0, 0.14, 0.22);
      triggerPulse(980, 0.16, 0.14, 0.22);
    } else {
      triggerPulse(880, 0, 0.12, 0.14);
    }
  } catch {
    // Ignore audio context restriction
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

const SurveyClockBadge: React.FC<{ clockOffsetMs: number }> = ({ clockOffsetMs }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-xs font-bold text-[#C0C4C9] tabular-nums">
      <Satellite className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
      {formatClockTime(nowMs + clockOffsetMs)}
    </span>
  );
};

function signedAngleDiffDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function classifyTurn(signedDeg: number): { kind: ManeuverKind; label: string } {
  const abs = Math.abs(signedDeg);
  if (abs >= 135) return { kind: 'uturn', label: 'Faça o retorno' };
  if (signedDeg <= -30) return { kind: 'left', label: 'Vire à esquerda' };
  if (signedDeg < -12) return { kind: 'slight-left', label: 'Mantenha à esquerda' };
  if (signedDeg >= 30) return { kind: 'right', label: 'Vire à direita' };
  if (signedDeg > 12) return { kind: 'slight-right', label: 'Mantenha à direita' };
  return { kind: 'straight', label: 'Siga em frente' };
}

function renderManeuverIcon(kind: ManeuverKind) {
  const cls = 'h-5 w-5 text-white shrink-0';
  switch (kind) {
    case 'left':
      return <CornerUpLeft className={cls} />;
    case 'slight-left':
      return <ArrowUpLeft className={cls} />;
    case 'right':
      return <CornerUpRight className={cls} />;
    case 'slight-right':
      return <ArrowUpRight className={cls} />;
    case 'uturn':
      return <RotateCcw className={cls} />;
    case 'finish':
      return <Flag className={cls} />;
    default:
      return <ArrowUp className={cls} />;
  }
}

interface SurveyCockpitProps {
  isActive?: boolean;
}

export const SurveyCockpit: React.FC<SurveyCockpitProps> = ({ isActive = true }) => {
  const [settings] = useNavSettings();
  const [source, setSource] = useState<DriveMode>('gps');
  const [totalKm, setTotalKm] = useState(0);
  const [tripKm, setTripKm] = useState(0);
  const [regressive, setRegressive] = useState(false);
  const [targetKm, setTargetKm] = useState(10.0);
  const [speedKmh, setSpeedKmh] = useState(0);
  const [maxSpeedKmh, setMaxSpeedKmh] = useState(0);
  const [avgSpeedSamples, setAvgSpeedSamples] = useState<number[]>([]);
  const [simSpeedKmh, setSimSpeedKmh] = useState(50);
  const [simRunning, setSimRunning] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isCounting, setIsCounting] = useState(true);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('10.00');
  const [editingTotalOdo, setEditingTotalOdo] = useState(false);
  const [totalOdoInput, setTotalOdoInput] = useState('0');
  const [editingTripOdo, setEditingTripOdo] = useState(false);
  const [tripOdoInput, setTripOdoInput] = useState('0');
  const [odoEditUnit, setOdoEditUnit] = useState<'m' | 'km'>('m');

  // Limite de Velocidade configurável com alerta visual e sonoro
  const [reccePrefs, setReccePrefs] = useState<ReccePrefs>(() => loadReccePrefs());
  const [recceOverCount, setRecceOverCount] = useState(0);
  const [reccePeakSpeedKmh, setReccePeakSpeedKmh] = useState(0);
  const lastRecceAlertTsRef = useRef<number>(0);
  const wasOverLimitRef = useRef<boolean>(false);

  // KML / KMZ & Waze Navigation State
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [loadedTrack, setLoadedTrack] = useState<VelocityTrack | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [wazeNavActive, setWazeNavActive] = useState(false);
  const [wazeVoiceEnabled, setWazeVoiceEnabled] = useState(true);
  const [currentPos, setCurrentPos] = useState<{ lat: number; lon: number } | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);

  const kalmanRef = useRef(createGpsKalmanProcessor());
  const isCountingRef = useRef(isCounting);
  isCountingRef.current = isCounting;
  const simProgressKmRef = useRef(0);
  const lastSpokenStepKeyRef = useRef<string>('');
  const calFactorRef = useRef(settings.calibrationPct / 100);
  calFactorRef.current = settings.calibrationPct / 100;

  useEffect(() => {
    try {
      localStorage.setItem(RECCE_PREFS_KEY, JSON.stringify(reccePrefs));
    } catch {
      // ignore storage errors
    }
  }, [reccePrefs]);

  // Build ordered navigable points from KML/KMZ (either polyline trace or traps fallback)
  const routeSamples: VelocitySample[] = useMemo(() => {
    if (!loadedTrack) return [];
    if (loadedTrack.baseTrace && loadedTrack.baseTrace.length >= 2) {
      return loadedTrack.baseTrace;
    }
    if (loadedTrack.traps.length >= 2) {
      let accKm = 0;
      return loadedTrack.traps.map((t, idx) => {
        if (idx > 0) {
          const prev = loadedTrack.traps[idx - 1];
          accKm += haversineMetersVel(prev.lat, prev.lon, t.lat, t.lon) / 1000;
        }
        return {
          lat: t.lat,
          lon: t.lon,
          speedKmh: 0,
          accuracyM: 5,
          headingDeg: t.bearingDeg,
          altitudeM: null,
          timestampMs: loadedTrack.createdAtMs + idx * 1000,
          distKm: accKm,
          stageElapsedMs: idx * 1000,
        };
      });
    }
    return [];
  }, [loadedTrack]);

  const orderedTraps: VelocityTrap[] = useMemo(
    () => (loadedTrack ? loadedTrack.traps : []),
    [loadedTrack]
  );

  // Continuous High-Accuracy GPS watcher with 2D Kalman Filter (detects walking step-by-step)
  useEffect(() => {
    if (!isActive || source !== 'gps') return;
    let cancelled = false;
    let webWid: number | null = null;
    let capWid: string | null = null;
    kalmanRef.current.reset();

    const handlePos = (
      lat: number,
      lon: number,
      rawSpeedMs: number | null,
      rawHeading: number | null,
      accM: number | null,
      ts: number
    ) => {
      if (cancelled) return;
      setGpsError(null);

      const filtered = kalmanRef.current.update({
        lat,
        lon,
        accuracyM: accM,
        rawSpeedMs,
        rawHeadingDeg: rawHeading,
        timestampMs: ts,
      });

      setGpsAccuracy(filtered.accuracyM);
      setCurrentPos({ lat: filtered.lat, lon: filtered.lon });
      if (filtered.headingDeg !== null) {
        setHeadingDeg(filtered.headingDeg);
      }

      if (isCountingRef.current && filtered.distStepM > 0) {
        const scaledKm = (filtered.distStepM / 1000) * calFactorRef.current;
        setTotalKm((v) => Math.max(0, v + scaledKm));
        setTripKm((v) => Math.max(0, v + scaledKm));
      }

      const spdRounded = Math.round(filtered.speedKmh);
      setSpeedKmh(spdRounded);
      if (isCountingRef.current && spdRounded >= 2) {
        setMaxSpeedKmh((m) => Math.max(m, spdRounded));
        setAvgSpeedSamples((arr) => [...arr.slice(-119), spdRounded]);
      }
    };

    const start = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          await Geolocation.requestPermissions();
          if (cancelled) return;
          const wid = await Geolocation.watchPosition(
            getCapacitorGpsWatchOptions(),
            (pos, err) => {
              if (!cancelled && !err && pos) {
                handlePos(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.speed ?? null,
                  pos.coords.heading ?? null,
                  pos.coords.accuracy ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
          if (cancelled) {
            Geolocation.clearWatch({ id: wid }).catch(() => {});
            return;
          }
          capWid = wid;
        } catch {
          if (!cancelled) setGpsError('Erro ao acessar GPS nativo.');
        }
      } else if ('geolocation' in navigator) {
        webWid = navigator.geolocation.watchPosition(
          (pos) =>
            handlePos(
              pos.coords.latitude,
              pos.coords.longitude,
              pos.coords.speed ?? null,
              pos.coords.heading ?? null,
              pos.coords.accuracy ?? null,
              pos.timestamp || Date.now()
            ),
          () => {
            if (!cancelled) setGpsError('GPS aguardando sinal (ou use o Simulador).');
          },
          WEB_GPS_WATCH_OPTIONS
        );
      } else {
        setGpsError('GPS indisponível neste dispositivo.');
      }
    };

    start();
    return () => {
      cancelled = true;
      if (webWid !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(webWid);
      if (capWid !== null) Geolocation.clearWatch({ id: capWid }).catch(() => {});
    };
  }, [isActive, source]);

  // Indoor Simulator (follows KML/KMZ route trace when imported!)
  useEffect(() => {
    if (source !== 'simulator' || !simRunning) return;
    const totalRouteKm =
      routeSamples.length > 1 ? routeSamples[routeSamples.length - 1].distKm : 0;

    const id = window.setInterval(() => {
      const kmTick = (simSpeedKmh / 3600) * 0.25 * calFactorRef.current;
      if (isCountingRef.current) {
        setTotalKm((v) => v + kmTick);
        setTripKm((v) => v + kmTick);
        if (simSpeedKmh >= 2) {
          setMaxSpeedKmh((m) => Math.max(m, simSpeedKmh));
          setAvgSpeedSamples((arr) => [...arr.slice(-119), simSpeedKmh]);
        }
      }
      setSpeedKmh(simSpeedKmh);

      if (routeSamples.length >= 2 && totalRouteKm > 0.005) {
        const nextDist = simProgressKmRef.current + kmTick;
        simProgressKmRef.current = nextDist > totalRouteKm ? 0 : nextDist;
        const d = simProgressKmRef.current;

        let segIdx = 0;
        for (let i = 1; i < routeSamples.length; i += 1) {
          if (routeSamples[i].distKm >= d) {
            segIdx = i - 1;
            break;
          }
        }
        const a = routeSamples[segIdx];
        const b = routeSamples[Math.min(routeSamples.length - 1, segIdx + 1)];
        const segSpanKm = Math.max(1e-6, b.distKm - a.distKm);
        const frac = Math.max(0, Math.min(1, (d - a.distKm) / segSpanKm));
        const lat = a.lat + (b.lat - a.lat) * frac;
        const lon = a.lon + (b.lon - a.lon) * frac;
        const brg = bearingBetweenDeg(a.lat, a.lon, b.lat, b.lon);
        setCurrentPos({ lat, lon });
        setHeadingDeg(brg);
      }
    }, 250);

    return () => window.clearInterval(id);
  }, [source, simRunning, simSpeedKmh, routeSamples]);

  // Modo Recce: Evaluate speed zone + trigger audible & haptic alerts
  const warnThresholdKmh = Math.max(1, reccePrefs.speedLimitKmh - reccePrefs.warningMarginKmh);
  const recceZone: 'off' | 'ok' | 'warning' | 'over' = !reccePrefs.enabled
    ? 'off'
    : speedKmh >= reccePrefs.speedLimitKmh
      ? 'over'
      : speedKmh >= warnThresholdKmh
        ? 'warning'
        : 'ok';

  useEffect(() => {
    if (!reccePrefs.enabled) {
      wasOverLimitRef.current = false;
      return;
    }

    if (speedKmh >= reccePrefs.speedLimitKmh) {
      setReccePeakSpeedKmh((p) => Math.max(p, speedKmh));
      if (!wasOverLimitRef.current) {
        wasOverLimitRef.current = true;
        setRecceOverCount((c) => c + 1);
      }
    } else {
      wasOverLimitRef.current = false;
    }

    if (!reccePrefs.soundEnabled) return;
    if (recceZone !== 'warning' && recceZone !== 'over') return;

    const now = Date.now();
    const minIntervalMs = recceZone === 'over' ? 750 : 1800;
    if (now - lastRecceAlertTsRef.current < minIntervalMs) return;
    lastRecceAlertTsRef.current = now;

    playRecceAlertTone(recceZone);
    if (recceZone === 'over' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([120, 60, 120]);
      } catch {
        // ignore vibration error
      }
    }
  }, [reccePrefs.enabled, reccePrefs.speedLimitKmh, reccePrefs.soundEnabled, recceZone, speedKmh]);

  // Compute Waze-style turn-by-turn guidance from current position + loaded KML/KMZ
  const guidance: WazeGuidance | null = useMemo(() => {
    if (!loadedTrack || routeSamples.length < 2) return null;
    const totalRouteKm = routeSamples[routeSamples.length - 1].distKm;
    let closestIdx = 0;

    if (currentPos) {
      let bestDistM = Infinity;
      for (let i = 0; i < routeSamples.length; i += 1) {
        const dM = haversineMetersVel(
          currentPos.lat,
          currentPos.lon,
          routeSamples[i].lat,
          routeSamples[i].lon
        );
        if (dM < bestDistM) {
          bestDistM = dM;
          closestIdx = i;
        }
      }
    }

    const currentSample = routeSamples[closestIdx];
    const remainingTotalKm = Math.max(0, totalRouteKm - currentSample.distKm);
    const progressPct =
      totalRouteKm > 0.001
        ? Math.min(100, Math.max(0, (currentSample.distKm / totalRouteKm) * 100))
        : 0;

    // Look ahead along vertices to find next significant bend (>= 14 deg) or route finish
    let turnIdx = routeSamples.length - 1;
    let maneuver: { kind: ManeuverKind; label: string } = {
      kind: 'finish',
      label: 'Chegada ao final do traçado',
    };

    for (let i = Math.max(1, closestIdx + 1); i < routeSamples.length - 1; i += 1) {
      const prev = routeSamples[i - 1];
      const curr = routeSamples[i];
      const next = routeSamples[i + 1];
      const b1 = bearingBetweenDeg(prev.lat, prev.lon, curr.lat, curr.lon);
      const b2 = bearingBetweenDeg(curr.lat, curr.lon, next.lat, next.lon);
      const signed = signedAngleDiffDeg(b1, b2);
      if (Math.abs(signed) >= 14) {
        turnIdx = i;
        maneuver = classifyTurn(signed);
        break;
      }
    }

    const turnPoint = routeSamples[turnIdx];
    const distToManeuverM = currentPos
      ? Math.max(0, Math.round((turnPoint.distKm - currentSample.distKm) * 1000))
      : Math.round(turnPoint.distKm * 1000);

    // Match nearest named KML/KMZ placemark near that turn or ahead on route
    let targetLabel = loadedTrack.name;
    let nearestTrapDistM = Infinity;
    for (const tr of orderedTraps) {
      const dToTurn = haversineMetersVel(turnPoint.lat, turnPoint.lon, tr.lat, tr.lon);
      if (dToTurn < nearestTrapDistM && dToTurn <= 180) {
        nearestTrapDistM = dToTurn;
        targetLabel = tr.name;
      }
    }
    if (nearestTrapDistM === Infinity && maneuver.kind !== 'finish') {
      targetLabel = `Ponto ${turnIdx + 1} do trajeto`;
    }

    return {
      kind: maneuver.kind,
      instruction: maneuver.label,
      targetLabel,
      distToManeuverM,
      remainingTotalKm,
      progressPct,
      closestIdx,
    };
  }, [loadedTrack, routeSamples, orderedTraps, currentPos]);

  // Optional pt-BR Waze Voice Guidance
  useEffect(() => {
    if (!wazeNavActive || !wazeVoiceEnabled || !guidance) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const dM = guidance.distToManeuverM;
    const bucket = dM <= 45 ? 'now' : dM <= 180 ? '150m' : dM <= 500 ? '400m' : '';
    if (!bucket) return;
    const key = `${guidance.targetLabel}-${guidance.kind}-${bucket}`;
    if (lastSpokenStepKeyRef.current === key) return;
    lastSpokenStepKeyRef.current = key;

    const spokenText =
      bucket === 'now'
        ? guidance.instruction
        : `Em ${Math.round(dM / 10) * 10} metros, ${guidance.instruction.toLowerCase()}`;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(spokenText);
      utter.lang = 'pt-BR';
      utter.rate = 1.08;
      window.speechSynthesis.speak(utter);
    } catch {
      // ignore speech errors
    }
  }, [wazeNavActive, wazeVoiceEnabled, guidance]);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const track = await parseTrackFileToTrack(file);
      setLoadedTrack(track);
      simProgressKmRef.current = 0;
      const firstPt = track.baseTrace?.[0] ?? track.traps[0];
      if (firstPt && source === 'simulator') {
        setCurrentPos({ lat: firstPt.lat, lon: firstPt.lon });
        if (track.baseTrace && track.baseTrace.length >= 2) {
          setHeadingDeg(
            bearingBetweenDeg(
              track.baseTrace[0].lat,
              track.baseTrace[0].lon,
              track.baseTrace[1].lat,
              track.baseTrace[1].lon
            )
          );
        }
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Falha ao ler KML/KMZ.');
    } finally {
      e.target.value = '';
    }
  };

  const applyOdometerKeyboardValue = (which: 'total' | 'trip', rawText: string) => {
    const num = Number(rawText.replace(',', '.'));
    if (Number.isFinite(num) && num >= 0) {
      const nextKm = odoEditUnit === 'm' ? num / 1000 : num;
      if (which === 'total') {
        setTotalKm(nextKm);
      } else {
        setTripKm(regressive ? Math.max(0, targetKm - nextKm) : nextKm);
      }
    }
    if (which === 'total') setEditingTotalOdo(false);
    else setEditingTripOdo(false);
  };

  const handleResetAllSurvey = () => {
    setTotalKm(0);
    setTripKm(0);
    setMaxSpeedKmh(0);
    setAvgSpeedSamples([]);
    setRecceOverCount(0);
    setReccePeakSpeedKmh(0);
    simProgressKmRef.current = 0;
  };

  const displayedTripKm = regressive ? Math.max(0, targetKm - tripKm) : tripKm;
  const totalMeters = Math.round(totalKm * 1000);
  const tripMeters = Math.round(displayedTripKm * 1000);
  const avgSpeedKmh =
    avgSpeedSamples.length > 0
      ? Math.round(avgSpeedSamples.reduce((a, b) => a + b, 0) / avgSpeedSamples.length)
      : 0;

  const toggleWazeNavigation = () => {
    setWazeNavActive((prev) => {
      const next = !prev;
      if (next && !currentPos && routeSamples.length > 0) {
        setCurrentPos({ lat: routeSamples[0].lat, lon: routeSamples[0].lon });
        setHeadingDeg(
          bearingBetweenDeg(
            routeSamples[0].lat,
            routeSamples[0].lon,
            routeSamples[1].lat,
            routeSamples[1].lon
          )
        );
      }
      return next;
    });
  };

  const speedPctOfLimit = Math.min(
    100,
    Math.max(0, (speedKmh / Math.max(1, reccePrefs.speedLimitKmh)) * 100)
  );

  return (
    <div
      className={`mx-auto max-w-5xl space-y-2.5 text-white rounded-2xl transition-all ${
        recceZone === 'over'
          ? 'ring-2 ring-red-500 bg-red-950/20 p-1.5 shadow-[0_0_32px_rgba(239,68,68,0.45)]'
          : ''
      }`}
    >
      {/* Top Header: Levantamento & Hodômetro + GPS/Simulador + Importar KML/KMZ */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3 py-2">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-[#E10600]" />
          <h1 className="font-['Barlow_Condensed'] text-lg font-extrabold italic tracking-wide uppercase">
            Levantamento &amp; Hodômetro
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
            <button
              type="button"
              onClick={() => {
                setSource('gps');
                setSimRunning(false);
              }}
              className={`min-h-[34px] rounded-md px-2.5 text-xs font-bold ${
                source === 'gps' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
              }`}
            >
              GPS {gpsAccuracy !== null ? `±${gpsAccuracy}m` : ''}
            </button>
            <button
              type="button"
              onClick={() => setSource('simulator')}
              className={`min-h-[34px] rounded-md px-2.5 text-xs font-bold ${
                source === 'simulator' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
              }`}
            >
              Sim
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".kml,.kmz,.gpx,.geojson,.json"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-2.5 text-xs font-bold text-white hover:border-[#E10600]"
          >
            <Upload className="h-3.5 w-3.5 text-[#E10600]" />
            <span>KML/KMZ</span>
          </button>

          <SurveyClockBadge clockOffsetMs={settings.clockOffsetMs} />
        </div>
      </section>

      {/* Compact Top Alert Strip (only shown when warning/exceeding limit) */}
      {(recceZone === 'over' || recceZone === 'warning') && (
        <section
          className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
            recceZone === 'over'
              ? 'animate-pulse border-red-500 bg-red-950/85 text-red-200'
              : 'border-amber-400 bg-amber-950/60 text-amber-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {recceZone === 'over'
                ? `ACIMA DO LIMITE: ${speedKmh} / ${reccePrefs.speedLimitKmh} km/h — REDUZA!`
                : `Próximo do limite: ${speedKmh} / ${reccePrefs.speedLimitKmh} km/h`}
            </span>
          </div>
          <span className="font-mono text-[11px] tabular-nums">
            Pico {Math.max(reccePeakSpeedKmh, speedKmh)}
          </span>
        </section>
      )}

      {importError && (
        <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-3.5 py-2 text-xs text-red-200">
          {importError}
        </div>
      )}

      {source === 'simulator' && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-[#111214] px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSimRunning((v) => !v)}
              className={`min-h-[38px] rounded-lg px-4 text-xs font-extrabold uppercase ${
                simRunning ? 'bg-zinc-700 text-white' : 'pitstop-btn-red text-white'
              }`}
            >
              {simRunning ? 'Pausar Simulador' : 'Iniciar Simulador'}
            </button>
            <span className="font-mono text-xs font-bold text-amber-300 tabular-nums">
              {simSpeedKmh} km/h
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={140}
            step={2}
            value={simSpeedKmh}
            onChange={(e) => setSimSpeedKmh(Number(e.target.value))}
            className="flex-1 min-w-[160px] accent-[#E10600]"
            aria-label="Velocidade do simulador"
          />
        </section>
      )}

      {gpsError && source === 'gps' && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3.5 py-2 text-xs text-amber-200">
          {gpsError}
        </div>
      )}

      {/* Compact Map & Navegar HUD */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 sm:p-3">
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-1.5 min-w-0">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-[#E10600]" />
            <p className="truncate text-xs font-bold text-white">
              {loadedTrack
                ? `${loadedTrack.name} · ${loadedTrack.referenceDistanceKm.toFixed(1).replace('.', ',')} km`
                : 'Mapa (Erechim / GPS)'}
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {wazeNavActive && (
              <button
                type="button"
                onClick={() => setWazeVoiceEnabled((v) => !v)}
                title={wazeVoiceEnabled ? 'Silenciar voz' : 'Ativar voz'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white"
              >
                {wazeVoiceEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5" />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={toggleWazeNavigation}
              className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[11px] font-extrabold uppercase transition-colors ${
                wazeNavActive
                  ? 'bg-sky-500 text-slate-950'
                  : 'pitstop-btn-red text-white'
              }`}
            >
              <Navigation className="h-3 w-3" />
              <span>{wazeNavActive ? 'Navegando' : 'Navegar'}</span>
            </button>
          </div>
        </div>

        {/* Slim Waze Turn-by-Turn Strip */}
        {wazeNavActive && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-sky-400/40 bg-[#081A2E] px-2.5 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-500/20 border border-sky-400/30">
                {guidance ? renderManeuverIcon(guidance.kind) : <Navigation className="h-4 w-4 text-sky-300" />}
              </div>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-xs font-extrabold text-white">
                  <span className="font-mono text-sky-300 mr-1.5 tabular-nums">
                    {guidance
                      ? guidance.distToManeuverM >= 1000
                        ? `${(guidance.distToManeuverM / 1000).toFixed(1).replace('.', ',')}km`
                        : `${guidance.distToManeuverM}m`
                      : 'GPS'}
                  </span>
                  {guidance ? guidance.instruction : 'Mapa livre'}
                </p>
                {guidance && (
                  <p className="truncate font-mono text-[10px] text-sky-200/75">
                    {guidance.targetLabel}
                  </p>
                )}
              </div>
            </div>

            {guidance && (
              <div className="shrink-0 text-right font-mono text-[11px] leading-tight tabular-nums">
                <span className="font-bold text-white">
                  {guidance.remainingTotalKm.toFixed(1).replace('.', ',')}km
                </span>
                <span className="ml-1.5 text-amber-300">
                  {headingDeg !== null ? `${headingDeg}°` : ''}
                </span>
              </div>
            )}
          </div>
        )}

        <VelocityMapboxView
          trackId={loadedTrack?.id ?? 'levantamento-erechim'}
          editableTrace={routeSamples}
          orderedTraps={orderedTraps}
          postEditIdx={guidance ? guidance.closestIdx : 0}
          currentPos={currentPos}
          navigationMode={wazeNavActive}
          navHeadingDeg={headingDeg}
          containerClassName="relative mt-2 h-56 w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#000000] sm:h-72"
        />
      </section>

      {/* Primary Controls: PLAY / PAUSE & ZERAR */}
      <section className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => {
            setIsCounting((prev) => {
              const next = !prev;
              if (source === 'simulator') setSimRunning(next);
              return next;
            });
          }}
          className={`flex min-h-[50px] items-center justify-center gap-2 rounded-xl border px-4 text-sm font-extrabold tracking-wider uppercase transition-colors ${
            isCounting
              ? 'border-amber-500/70 bg-amber-600/20 text-amber-300 hover:bg-amber-600/30'
              : 'border-emerald-500/70 bg-emerald-600/25 text-emerald-300 hover:bg-emerald-600/35'
          }`}
        >
          {isCounting ? (
            <>
              <Pause className="h-4 w-4 fill-current" />
              <span>Pausar Contagem</span>
            </>
          ) : (
            <>
              <Play className="h-4 w-4 fill-current" />
              <span>Play Contagem</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={handleResetAllSurvey}
          className="pitstop-btn-metal flex min-h-[50px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold tracking-wider text-white uppercase"
        >
          <RotateCcw className="h-4 w-4 text-[#E10600]" />
          <span>Zerar Tudo</span>
        </button>
      </section>

      {/* Unified Odometer Total & Trip Blocks (Meters + KM, Tap-to-Edit Keyboard Input) */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-[#000000] p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs font-bold tracking-widest text-[#B5B5B5] uppercase">
              Odômetro Total
            </span>
            <button
              type="button"
              onClick={() => {
                setTotalKm(0);
                simProgressKmRef.current = 0;
              }}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#14161A] px-2.5 py-1 text-[11px] font-bold text-[#C0C4C9] hover:text-white"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Zerar</span>
            </button>
          </div>

          {editingTotalOdo ? (
            <div className="my-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={totalOdoInput}
                  onChange={(e) => setTotalOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdometerKeyboardValue('total', totalOdoInput);
                    if (e.key === 'Escape') setEditingTotalOdo(false);
                  }}
                  aria-label="Editar Odômetro Total"
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[#E10600] bg-[#14161A] px-3 text-center font-mono text-2xl font-black text-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextUnit = odoEditUnit === 'm' ? 'km' : 'm';
                    setOdoEditUnit(nextUnit);
                    setTotalOdoInput(
                      nextUnit === 'm' ? String(totalMeters) : totalKm.toFixed(3)
                    );
                  }}
                  className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#14161A] px-3 font-mono text-xs font-extrabold text-amber-300 uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTotalOdo(false)}
                  className="min-h-[36px] rounded-lg border border-zinc-700 bg-[#14161A] text-xs font-bold text-zinc-300"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdometerKeyboardValue('total', totalOdoInput)}
                  className="pitstop-btn-red min-h-[36px] rounded-lg text-xs font-extrabold text-white"
                >
                  Confirmar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTotalOdoInput(odoEditUnit === 'm' ? String(totalMeters) : totalKm.toFixed(3));
                setEditingTotalOdo(true);
              }}
              title="Toque para digitar a metragem desejada"
              className="group my-2 flex flex-col items-center justify-center rounded-xl border border-transparent py-1.5 transition-colors hover:border-zinc-700 hover:bg-[#0D0F12]"
            >
              <span className="font-mono text-4xl font-black tracking-tight text-white tabular-nums sm:text-5xl">
                {totalMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-lg font-bold text-zinc-400">m</span>
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-zinc-400 tabular-nums">
                <span>{totalKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 text-zinc-500 group-hover:text-[#E10600]" />
              </span>
            </button>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-[#000000] p-4 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRegressive((v) => !v)}
              className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-bold uppercase ${
                regressive
                  ? 'border-[#E10600] bg-[#E10600]/20 text-white'
                  : 'border-zinc-700 bg-[#14161A] text-amber-300'
              }`}
            >
              Trip: {regressive ? 'Regressivo' : 'Progressivo'}
            </button>

            <div className="flex items-center gap-1.5">
              {regressive &&
                (editingTarget ? (
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    autoFocus
                    value={targetInput}
                    onChange={(e) => setTargetInput(e.target.value)}
                    onBlur={() => {
                      const n = Number(targetInput.replace(',', '.'));
                      if (Number.isFinite(n) && n > 0) setTargetKm(n);
                      setEditingTarget(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const n = Number(targetInput.replace(',', '.'));
                        if (Number.isFinite(n) && n > 0) setTargetKm(n);
                        setEditingTarget(false);
                      }
                    }}
                    className="w-24 rounded border border-[#E10600] bg-[#14161A] px-2 py-0.5 text-center font-mono text-xs font-bold text-white focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setTargetInput(targetKm.toFixed(2));
                      setEditingTarget(true);
                    }}
                    className="rounded border border-zinc-700 bg-[#14161A] px-2 py-0.5 font-mono text-[11px] font-bold text-[#C0C4C9]"
                  >
                    Alvo: {targetKm.toFixed(2)} km
                  </button>
                ))}

              <button
                type="button"
                onClick={() => setTripKm(0)}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#14161A] px-2.5 py-1 text-[11px] font-bold text-[#C0C4C9] hover:text-white"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Zerar Trip</span>
              </button>
            </div>
          </div>

          {editingTripOdo ? (
            <div className="my-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={tripOdoInput}
                  onChange={(e) => setTripOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdometerKeyboardValue('trip', tripOdoInput);
                    if (e.key === 'Escape') setEditingTripOdo(false);
                  }}
                  aria-label="Editar Trip Parcial"
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[#E10600] bg-[#14161A] px-3 text-center font-mono text-2xl font-black text-amber-300 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextUnit = odoEditUnit === 'm' ? 'km' : 'm';
                    setOdoEditUnit(nextUnit);
                    setTripOdoInput(
                      nextUnit === 'm' ? String(tripMeters) : displayedTripKm.toFixed(3)
                    );
                  }}
                  className="min-h-[44px] rounded-lg border border-zinc-700 bg-[#14161A] px-3 font-mono text-xs font-extrabold text-amber-300 uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTripOdo(false)}
                  className="min-h-[36px] rounded-lg border border-zinc-700 bg-[#14161A] text-xs font-bold text-zinc-300"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdometerKeyboardValue('trip', tripOdoInput)}
                  className="pitstop-btn-red min-h-[36px] rounded-lg text-xs font-extrabold text-white"
                >
                  Confirmar
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTripOdoInput(
                  odoEditUnit === 'm' ? String(tripMeters) : displayedTripKm.toFixed(3)
                );
                setEditingTripOdo(true);
              }}
              title="Toque para digitar a metragem do Trip"
              className="group my-2 flex flex-col items-center justify-center rounded-xl border border-transparent py-1.5 transition-colors hover:border-zinc-700 hover:bg-[#0D0F12]"
            >
              <span className="font-mono text-4xl font-black tracking-tight text-amber-300 tabular-nums sm:text-5xl">
                {tripMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-lg font-bold text-amber-200/70">m</span>
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-amber-200/80 tabular-nums">
                <span>{displayedTripKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 text-amber-300/60 group-hover:text-[#E10600]" />
              </span>
            </button>
          )}
        </div>
      </section>

      {/* Live Speed Metrics + Limite de Velocidade (Levantamento) */}
      <section className="space-y-3">
        <div className="grid grid-cols-3 gap-2.5 font-mono tabular-nums">
          <div
            className={`rounded-xl border p-3 text-center transition-colors ${
              recceZone === 'over'
                ? 'animate-pulse border-red-500 bg-red-950/80'
                : 'border-zinc-800 bg-[#111214]'
            }`}
          >
            <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Atual</p>
            <p
              className={`mt-0.5 text-3xl font-black sm:text-4xl ${
                recceZone === 'over'
                  ? 'text-[#FF2A2A]'
                  : recceZone === 'warning'
                    ? 'text-amber-300'
                    : 'text-white'
              }`}
            >
              {speedKmh}
            </p>
            <p className="text-[10px] font-bold text-[#E10600]">KM/H</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-center">
            <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Média</p>
            <p className="mt-0.5 text-3xl font-black text-emerald-400 sm:text-4xl">{avgSpeedKmh}</p>
            <p className="text-[10px] text-zinc-400">KM/H</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 text-center">
            <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Máxima</p>
            <p className="mt-0.5 text-3xl font-black text-amber-300 sm:text-4xl">{maxSpeedKmh}</p>
            <button
              type="button"
              onClick={() => {
                setMaxSpeedKmh(0);
                setAvgSpeedSamples([]);
              }}
              className="text-[10px] text-zinc-500 hover:text-white underline"
            >
              limpar
            </button>
          </div>
        </div>

        {/* Limite de Velocidade (Clean & Simples) */}
        <div
          className={`rounded-xl border p-3 transition-colors ${
            recceZone === 'over'
              ? 'border-red-500 bg-red-950/80'
              : recceZone === 'warning'
                ? 'border-amber-400 bg-amber-950/50'
                : 'border-zinc-800 bg-[#111214]'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {recceZone === 'over' || recceZone === 'warning' ? (
                <AlertTriangle
                  className={`h-4 w-4 shrink-0 ${
                    recceZone === 'over' ? 'text-red-300' : 'text-amber-300'
                  }`}
                />
              ) : (
                <ShieldAlert className="h-4 w-4 shrink-0 text-[#E10600]" />
              )}
              <span className="text-xs font-extrabold tracking-wide uppercase">
                Limite de Velocidade
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {reccePrefs.enabled && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setReccePrefs((p) => ({
                        ...p,
                        speedLimitKmh: Math.max(10, p.speedLimitKmh - 5),
                      }))
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] font-mono text-sm font-black text-white hover:border-[#E10600]"
                    aria-label="Diminuir limite em 5 km/h"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={10}
                    max={200}
                    step={5}
                    value={reccePrefs.speedLimitKmh}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) {
                        setReccePrefs((p) => ({
                          ...p,
                          speedLimitKmh: Math.min(200, Math.max(10, Math.round(n))),
                        }));
                      }
                    }}
                    aria-label="Limite de velocidade em km/h"
                    className="h-8 w-14 rounded-lg border border-zinc-700 bg-[#080B0D] text-center font-mono text-xs font-extrabold text-white focus:border-[#E10600] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setReccePrefs((p) => ({
                        ...p,
                        speedLimitKmh: Math.min(200, p.speedLimitKmh + 5),
                      }))
                    }
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] font-mono text-sm font-black text-white hover:border-[#E10600]"
                    aria-label="Aumentar limite em 5 km/h"
                  >
                    +
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() =>
                  setReccePrefs((p) => ({ ...p, soundEnabled: !p.soundEnabled }))
                }
                title={reccePrefs.soundEnabled ? 'Silenciar alerta' : 'Ativar alerta'}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-white hover:border-[#E10600]"
              >
                {reccePrefs.soundEnabled ? (
                  <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5 text-zinc-500" />
                )}
              </button>

              <button
                type="button"
                onClick={() =>
                  setReccePrefs((p) => ({ ...p, enabled: !p.enabled }))
                }
                className={`h-8 rounded-lg px-2.5 text-[11px] font-extrabold uppercase ${
                  reccePrefs.enabled
                    ? 'pitstop-btn-red text-white'
                    : 'border border-zinc-700 bg-[#080B0D] text-zinc-400'
                }`}
              >
                {reccePrefs.enabled ? 'Ativo' : 'Off'}
              </button>
            </div>
          </div>

          {reccePrefs.enabled && (
            <div className="mt-2.5 space-y-1.5">
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-[#080B0D]">
                <div
                  className={`h-full transition-all duration-150 ${
                    recceZone === 'over'
                      ? 'bg-[#FF2A2A]'
                      : recceZone === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${speedPctOfLimit}%` }}
                />
              </div>

              <div className="flex items-center justify-between font-mono text-[11px] text-[#C0C4C9] tabular-nums">
                <span>
                  {speedKmh} / {reccePrefs.speedLimitKmh} km/h
                </span>
                {recceOverCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setRecceOverCount(0);
                      setReccePeakSpeedKmh(0);
                    }}
                    className="text-red-300 underline hover:text-white"
                  >
                    {recceOverCount}x acima (Pico {reccePeakSpeedKmh}) · limpar
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
