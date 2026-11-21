import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Gauge, Minus, Plus, RotateCcw, Satellite, SlidersHorizontal } from 'lucide-react';
import {
  calibrationPctFromWValue,
  useNavSettings,
  wValueFromCalibrationPct,
} from '../utils/navSettings';
import { haversineMeters } from '../utils/rallyEngine';

type DriveMode = 'gps' | 'simulator';

function formatClockTime(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

interface OdometerCockpitProps {
  isActive?: boolean;
}

export const OdometerCockpit: React.FC<OdometerCockpitProps> = ({ isActive = true }) => {
  const [settings, updateSettings] = useNavSettings();
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('10.00');

  const lastFixRef = useRef<{ lat: number; lon: number; ts: number } | null>(null);
  const calFactorRef = useRef(settings.calibrationPct / 100);
  calFactorRef.current = settings.calibrationPct / 100;

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [isActive]);

  // Real GPS watcher
  useEffect(() => {
    if (!isActive || source !== 'gps') return;
    let cancelled = false;
    let webWid: number | null = null;
    let capWid: string | null = null;

    const handlePos = (lat: number, lon: number, rawSpeedMs: number | null, accM: number | null, ts: number) => {
      if (cancelled) return;
      setGpsError(null);
      setGpsAccuracy(accM !== null ? Math.round(accM) : null);

      const prev = lastFixRef.current;
      let spd = rawSpeedMs !== null && Number.isFinite(rawSpeedMs) ? Math.max(0, rawSpeedMs * 3.6) : 0;

      if (prev) {
        const distM = haversineMeters(prev.lat, prev.lon, lat, lon);
        if (distM >= 0.45 && distM < 450) {
          const scaledKm = (distM / 1000) * calFactorRef.current;
          setTotalKm((v) => Math.max(0, v + scaledKm));
          setTripKm((v) => Math.max(0, v + scaledKm));
          const dtSec = Math.max(0.2, (ts - prev.ts) / 1000);
          if (rawSpeedMs === null || rawSpeedMs <= 0) {
            spd = (distM / dtSec) * 3.6;
          }
        }
      }
      lastFixRef.current = { lat, lon, ts };
      const spdRounded = Math.round(spd);
      setSpeedKmh(spdRounded);
      if (spdRounded > 3) {
        setMaxSpeedKmh((m) => Math.max(m, spdRounded));
        setAvgSpeedSamples((arr) => [...arr.slice(-119), spdRounded]);
      }
    };

    const start = async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          await Geolocation.requestPermissions();
          capWid = await Geolocation.watchPosition(
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
            (pos, err) => {
              if (!err && pos) {
                handlePos(
                  pos.coords.latitude,
                  pos.coords.longitude,
                  pos.coords.speed ?? null,
                  pos.coords.accuracy ?? null,
                  pos.timestamp || Date.now()
                );
              }
            }
          );
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
              pos.coords.accuracy ?? null,
              pos.timestamp || Date.now()
            ),
          () => {
            if (!cancelled) setGpsError('GPS aguardando sinal (ou use o Simulador).');
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
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

  // Indoor Simulator engine
  useEffect(() => {
    if (!isActive || source !== 'simulator' || !simRunning) return;
    const id = window.setInterval(() => {
      const kmTick = ((simSpeedKmh / 3600) * 0.25) * calFactorRef.current;
      setTotalKm((v) => v + kmTick);
      setTripKm((v) => v + kmTick);
      setSpeedKmh(simSpeedKmh);
      if (simSpeedKmh > 3) {
        setMaxSpeedKmh((m) => Math.max(m, simSpeedKmh));
        setAvgSpeedSamples((arr) => [...arr.slice(-119), simSpeedKmh]);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [isActive, source, simRunning, simSpeedKmh]);

  const adjustDistanceMeters = (deltaMeters: number) => {
    const deltaKm = deltaMeters / 1000;
    setTotalKm((v) => Math.max(0, v + deltaKm));
    setTripKm((v) => Math.max(0, v + deltaKm));
  };

  const adjustCalPct = (delta: number) => {
    const next = Math.min(130, Math.max(70, Number((settings.calibrationPct + delta).toFixed(2))));
    updateSettings({ calibrationPct: next });
  };

  const displayedTripKm = regressive ? Math.max(0, targetKm - tripKm) : tripKm;
  const avgSpeedKmh =
    avgSpeedSamples.length > 0
      ? Math.round(avgSpeedSamples.reduce((a, b) => a + b, 0) / avgSpeedSamples.length)
      : 0;
  const activeW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
  const officialClockMs = nowMs + settings.clockOffsetMs;

  return (
    <div className="mx-auto max-w-4xl space-y-3 text-white">
      {/* Top Bar: Mode & GPS/Simulator Switch */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#111214] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-[#E10600]" />
          <div>
            <h1 className="font-['Barlow_Condensed'] text-xl font-extrabold italic tracking-wide uppercase sm:text-2xl">
              Hodômetro Digital &amp; W Fino
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-800 bg-[#080B0D] p-0.5">
            <button
              type="button"
              onClick={() => {
                setSource('gps');
                setSimRunning(false);
              }}
              className={`min-h-[34px] rounded-md px-3 text-xs font-bold ${
                source === 'gps' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
              }`}
            >
              GPS {gpsAccuracy !== null ? `±${gpsAccuracy}m` : ''}
            </button>
            <button
              type="button"
              onClick={() => setSource('simulator')}
              className={`min-h-[34px] rounded-md px-3 text-xs font-bold ${
                source === 'simulator' ? 'bg-[#E10600] text-white' : 'text-[#B5B5B5] hover:text-white'
              }`}
            >
              Simulador
            </button>
          </div>

          <span className="font-mono text-xs font-bold text-[#C0C4C9] tabular-nums">
            <Satellite className="mr-1 inline h-3.5 w-3.5 text-emerald-400" />
            {formatClockTime(officialClockMs)}
          </span>
        </div>
      </section>

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

      {/* Giant Daylight-Readable Total & Trip Odometers */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-[#000000] p-4 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold tracking-widest text-[#B5B5B5] uppercase">
              Hodômetro Total (km)
            </span>
            <button
              type="button"
              onClick={() => setTotalKm(0)}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-[#14161A] px-2.5 py-1 text-[11px] font-bold text-[#C0C4C9] hover:text-white"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Zerar Total</span>
            </button>
          </div>
          <div className="my-2 text-center font-mono text-4xl font-black tracking-tight text-white tabular-nums sm:text-5xl">
            {totalKm.toFixed(3).replace('.', ',')}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[-100, -10, 10, 100].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => adjustDistanceMeters(m)}
                className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#14161A] font-mono text-xs font-extrabold text-white hover:border-[#E10600] active:scale-[0.97]"
              >
                {m > 0 ? `+${m}m` : `${m}m`}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-[#000000] p-4 sm:p-5 flex flex-col justify-between">
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

            {regressive && (
              editingTarget ? (
                <input
                  type="text"
                  inputMode="decimal"
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
              )
            )}
          </div>

          <div className="my-2 text-center font-mono text-4xl font-black tracking-tight text-amber-300 tabular-nums sm:text-5xl">
            {displayedTripKm.toFixed(3).replace('.', ',')}
          </div>

          <button
            type="button"
            onClick={() => setTripKm(0)}
            className="pitstop-btn-red min-h-[48px] w-full rounded-xl text-sm font-extrabold text-white uppercase tracking-wider"
          >
            Zerar Trip
          </button>
        </div>
      </section>

      {/* Live Speed Metrics */}
      <section className="grid grid-cols-3 gap-2.5 font-mono tabular-nums">
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Atual</p>
          <p className="mt-0.5 text-2xl font-black text-white sm:text-3xl">{speedKmh}</p>
          <p className="text-[10px] font-bold text-[#E10600]">KM/H</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Média</p>
          <p className="mt-0.5 text-2xl font-black text-emerald-400 sm:text-3xl">{avgSpeedKmh}</p>
          <p className="text-[10px] text-zinc-400">KM/H</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[#B5B5B5] uppercase">Vel. Máxima</p>
          <p className="mt-0.5 text-2xl font-black text-amber-300 sm:text-3xl">{maxSpeedKmh}</p>
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
      </section>

      {/* Inline Quick W Fino Adjustment */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[#E10600]" />
            <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
              Ajuste Rápido W Fino ({settings.sensorMode === 'blue' ? `W ${activeW}` : `${settings.calibrationPct.toFixed(2)}%`})
            </span>
          </div>
          <span className="font-mono text-[11px] text-[#B5B5B5]">
            Base W {settings.wBaseValue}
          </span>
        </div>

        <div className="grid grid-cols-5 gap-1.5 font-mono">
          <button
            type="button"
            onClick={() => adjustCalPct(-1)}
            className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#080B0D] text-xs font-extrabold text-[#C0C4C9] hover:text-white"
          >
            -1%
          </button>
          <button
            type="button"
            onClick={() => adjustCalPct(-0.1)}
            className="min-h-[42px] inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-[#1E1E22] text-sm font-black text-white hover:border-[#E10600]"
          >
            <Minus className="h-4 w-4" />
          </button>
          <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-700 bg-black px-2 text-center tabular-nums">
            <span className="text-sm font-black text-white">
              {settings.sensorMode === 'blue' ? `W ${activeW}` : `${settings.calibrationPct.toFixed(2)}%`}
            </span>
            <span className="text-[9px] text-[#B5B5B5]">
              {calibrationPctFromWValue(activeW, settings.wBaseValue).toFixed(1)}%
            </span>
          </div>
          <button
            type="button"
            onClick={() => adjustCalPct(0.1)}
            className="min-h-[42px] inline-flex items-center justify-center rounded-lg border border-zinc-700 bg-[#1E1E22] text-sm font-black text-white hover:border-[#E10600]"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => adjustCalPct(1)}
            className="min-h-[42px] rounded-lg border border-zinc-700 bg-[#080B0D] text-xs font-extrabold text-[#C0C4C9] hover:text-white"
          >
            +1%
          </button>
        </div>
      </section>
    </div>
  );
};
