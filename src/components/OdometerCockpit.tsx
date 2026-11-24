import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Gauge, Minus, Pause, Pencil, Play, Plus, RotateCcw, Satellite, SlidersHorizontal } from 'lucide-react';
import {
  calibrationPctFromWValue,
  useNavSettings,
  wValueFromCalibrationPct,
} from '../utils/navSettings';
import {
  createGpsKalmanProcessor,
  getCapacitorGpsWatchOptions,
  WEB_GPS_WATCH_OPTIONS,
} from '../utils/velocityEngine';

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
  const [isCounting, setIsCounting] = useState(true);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('10.00');
  const [editingTotalOdo, setEditingTotalOdo] = useState(false);
  const [totalOdoInput, setTotalOdoInput] = useState('0');
  const [editingTripOdo, setEditingTripOdo] = useState(false);
  const [tripOdoInput, setTripOdoInput] = useState('0');
  const [odoEditUnit, setOdoEditUnit] = useState<'m' | 'km'>('m');

  const kalmanRef = useRef(createGpsKalmanProcessor());
  const isCountingRef = useRef(isCounting);
  isCountingRef.current = isCounting;
  const calFactorRef = useRef(settings.calibrationPct / 100);
  calFactorRef.current = settings.calibrationPct / 100;

  useEffect(() => {
    if (!isActive) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [isActive]);

  // Continuous GPS watcher with 2D Kalman Filter
  useEffect(() => {
    if (!isActive || source !== 'gps') return;
    let cancelled = false;
    let webWid: number | null = null;
    let capWid: string | null = null;
    kalmanRef.current.reset();

    const handlePos = (lat: number, lon: number, rawSpeedMs: number | null, accM: number | null, ts: number) => {
      if (cancelled) return;
      setGpsError(null);
      const filtered = kalmanRef.current.update({
        lat,
        lon,
        accuracyM: accM,
        rawSpeedMs,
        rawHeadingDeg: null,
        timestampMs: ts,
      });
      setGpsAccuracy(filtered.accuracyM);

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
          capWid = await Geolocation.watchPosition(
            getCapacitorGpsWatchOptions(),
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

  // Indoor Simulator engine
  useEffect(() => {
    if (!isActive || source !== 'simulator' || !simRunning) return;
    const id = window.setInterval(() => {
      const kmTick = ((simSpeedKmh / 3600) * 0.25) * calFactorRef.current;
      if (isCountingRef.current) {
        setTotalKm((v) => v + kmTick);
        setTripKm((v) => v + kmTick);
        if (simSpeedKmh >= 2) {
          setMaxSpeedKmh((m) => Math.max(m, simSpeedKmh));
          setAvgSpeedSamples((arr) => [...arr.slice(-119), simSpeedKmh]);
        }
      }
      setSpeedKmh(simSpeedKmh);
    }, 250);
    return () => window.clearInterval(id);
  }, [isActive, source, simRunning, simSpeedKmh]);

  const applyOdoEdit = (which: 'total' | 'trip', rawText: string) => {
    const n = Number(rawText.replace(',', '.'));
    if (Number.isFinite(n) && n >= 0) {
      const nextKm = odoEditUnit === 'm' ? n / 1000 : n;
      if (which === 'total') setTotalKm(nextKm);
      else setTripKm(regressive ? Math.max(0, targetKm - nextKm) : nextKm);
    }
    if (which === 'total') setEditingTotalOdo(false);
    else setEditingTripOdo(false);
  };

  const adjustCalPct = (delta: number) => {
    const next = Math.min(130, Math.max(70, Number((settings.calibrationPct + delta).toFixed(2))));
    updateSettings({ calibrationPct: next });
  };

  const displayedTripKm = regressive ? Math.max(0, targetKm - tripKm) : tripKm;
  const totalMeters = Math.round(totalKm * 1000);
  const tripMeters = Math.round(displayedTripKm * 1000);
  const avgSpeedKmh =
    avgSpeedSamples.length > 0
      ? Math.round(avgSpeedSamples.reduce((a, b) => a + b, 0) / avgSpeedSamples.length)
      : 0;
  const activeW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
  const officialClockMs = nowMs + settings.clockOffsetMs;

  return (
    <div className="mx-auto max-w-4xl space-y-3 text-[var(--ps-text)]">
      {/* Top Bar: Mode & GPS/Simulator Switch */}
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-[var(--ps-accent)]" />
          <div>
            <h1 className="font-['Barlow_Condensed'] text-xl font-extrabold italic tracking-wide uppercase sm:text-2xl">
              Hodômetro Digital &amp; W Fino
            </h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
            <button
              type="button"
              onClick={() => {
                setSource('gps');
                setSimRunning(false);
              }}
              className={`min-h-[34px] rounded-md px-3 text-xs font-bold ${
                source === 'gps'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              GPS {gpsAccuracy !== null ? `±${gpsAccuracy}m` : ''}
            </button>
            <button
              type="button"
              onClick={() => setSource('simulator')}
              className={`min-h-[34px] rounded-md px-3 text-xs font-bold ${
                source === 'simulator'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              Simulador
            </button>
          </div>

          <span className="font-mono text-xs font-bold text-[var(--ps-muted)] tabular-nums">
            <Satellite className="mr-1 inline h-3.5 w-3.5 text-[var(--ps-emerald)]" />
            {formatClockTime(officialClockMs)}
          </span>
        </div>
      </section>

      {source === 'simulator' && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSimRunning((v) => !v)}
              className={`min-h-[44px] rounded-lg px-4 text-xs font-extrabold uppercase ${
                simRunning ? 'pitstop-btn-metal' : 'pitstop-btn-red'
              }`}
            >
              {simRunning ? 'Pausar Simulador' : 'Iniciar Simulador'}
            </button>
            <span className="font-mono text-xs font-bold text-[var(--ps-amber)] tabular-nums">
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
            className="flex-1 min-w-[160px] accent-[var(--ps-accent)]"
            aria-label="Velocidade do simulador"
          />
        </section>
      )}

      {gpsError && source === 'gps' && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs text-[var(--ps-amber)]">
          {gpsError}
        </div>
      )}

      <section className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => setIsCounting((v) => !v)}
          className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl border px-4 text-sm font-extrabold uppercase ${
            isCounting
              ? 'border-amber-500/60 bg-amber-500/15 text-[var(--ps-amber)]'
              : 'border-emerald-500/60 bg-emerald-500/15 text-[var(--ps-emerald)]'
          }`}
        >
          {isCounting ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          <span>{isCounting ? 'Pausar Contagem' : 'Play Contagem'}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setTotalKm(0);
            setTripKm(0);
            setMaxSpeedKmh(0);
            setAvgSpeedSamples([]);
          }}
          className="pitstop-btn-metal flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold uppercase"
        >
          <RotateCcw className="h-4 w-4 text-[var(--ps-accent)]" />
          <span>Zerar Tudo</span>
        </button>
      </section>

      {/* Giant Daylight-Readable Total & Trip Odometers */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs font-bold tracking-widest text-[var(--ps-muted)] uppercase">
              Hodômetro Total
            </span>
            <button
              type="button"
              onClick={() => setTotalKm(0)}
              className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Zerar Total</span>
            </button>
          </div>
          {editingTotalOdo ? (
            <div className="my-2 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={totalOdoInput}
                  onChange={(e) => setTotalOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdoEdit('total', totalOdoInput);
                    if (e.key === 'Escape') setEditingTotalOdo(false);
                  }}
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-3 text-center font-mono text-2xl font-black text-[var(--ps-text)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextUnit = odoEditUnit === 'm' ? 'km' : 'm';
                    setOdoEditUnit(nextUnit);
                    setTotalOdoInput(nextUnit === 'm' ? String(totalMeters) : totalKm.toFixed(3));
                  }}
                  className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-amber)] uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTotalOdo(false)}
                  className="min-h-[36px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-xs font-bold text-[var(--ps-muted)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdoEdit('total', totalOdoInput)}
                  className="pitstop-btn-red min-h-[36px] rounded-lg text-xs font-extrabold"
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
              className="group my-2 flex flex-col items-center justify-center rounded-xl py-1 hover:bg-[var(--ps-card)]"
            >
              <span className="font-mono text-4xl font-black tracking-tight text-[var(--ps-text)] tabular-nums sm:text-5xl">
                {totalMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-lg font-bold text-[var(--ps-muted)]">m</span>
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-[var(--ps-muted)] tabular-nums">
                <span>{totalKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 opacity-60 group-hover:text-[var(--ps-accent)]" />
              </span>
            </button>
          )}
        </div>

        <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setRegressive((v) => !v)}
              className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-bold uppercase ${
                regressive
                  ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                  : 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-amber)]'
              }`}
            >
              Trip: {regressive ? 'Regressivo' : 'Progressivo'}
            </button>

            {regressive && (
              editingTarget ? (
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
                  className="w-24 rounded border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-2 py-0.5 text-center font-mono text-xs font-bold text-[var(--ps-text)] focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setTargetInput(targetKm.toFixed(2));
                    setEditingTarget(true);
                  }}
                  className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2 py-0.5 font-mono text-[11px] font-bold text-[var(--ps-muted)]"
                >
                  Alvo: {targetKm.toFixed(2)} km
                </button>
              )
            )}
          </div>

          {editingTripOdo ? (
            <div className="my-2 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  autoFocus
                  value={tripOdoInput}
                  onChange={(e) => setTripOdoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyOdoEdit('trip', tripOdoInput);
                    if (e.key === 'Escape') setEditingTripOdo(false);
                  }}
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-3 text-center font-mono text-2xl font-black text-[var(--ps-amber)] focus:outline-none"
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
                  className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-amber)] uppercase"
                >
                  {odoEditUnit}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingTripOdo(false)}
                  className="min-h-[36px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-xs font-bold text-[var(--ps-muted)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => applyOdoEdit('trip', tripOdoInput)}
                  className="pitstop-btn-red min-h-[36px] rounded-lg text-xs font-extrabold"
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
              className="group my-2 flex flex-col items-center justify-center rounded-xl py-1 hover:bg-[var(--ps-card)]"
            >
              <span className="font-mono text-4xl font-black tracking-tight text-[var(--ps-amber)] tabular-nums sm:text-5xl">
                {tripMeters.toLocaleString('pt-BR')}{' '}
                <span className="text-lg font-bold opacity-75">m</span>
              </span>
              <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-sm font-bold text-[var(--ps-amber)] opacity-85 tabular-nums">
                <span>{displayedTripKm.toFixed(2).replace('.', ',')} km</span>
                <Pencil className="h-3 w-3 opacity-60 group-hover:text-[var(--ps-accent)]" />
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setTripKm(0)}
            className="pitstop-btn-red min-h-[48px] w-full rounded-xl text-sm font-extrabold uppercase tracking-wider"
          >
            Zerar Trip
          </button>
        </div>
      </section>

      {/* Live Speed Metrics */}
      <section className="grid grid-cols-3 gap-2.5 font-mono tabular-nums">
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Vel. Atual</p>
          <p className="mt-0.5 text-2xl font-black text-[var(--ps-text)] sm:text-3xl">{speedKmh}</p>
          <p className="text-[10px] font-bold text-[var(--ps-accent)]">KM/H</p>
        </div>
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Vel. Média</p>
          <p className="mt-0.5 text-2xl font-black text-[var(--ps-emerald)] sm:text-3xl">{avgSpeedKmh}</p>
          <p className="text-[10px] text-[var(--ps-muted)]">KM/H</p>
        </div>
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 text-center">
          <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Vel. Máxima</p>
          <p className="mt-0.5 text-2xl font-black text-[var(--ps-amber)] sm:text-3xl">{maxSpeedKmh}</p>
          <button
            type="button"
            onClick={() => {
              setMaxSpeedKmh(0);
              setAvgSpeedSamples([]);
            }}
            className="text-[10px] text-[var(--ps-muted)] hover:text-[var(--ps-text)] underline"
          >
            limpar
          </button>
        </div>
      </section>

      {/* Inline Quick W Fino Adjustment */}
      <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[var(--ps-accent)]" />
            <span className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide uppercase">
              Ajuste Rápido W Fino ({settings.sensorMode === 'blue' ? `W ${activeW}` : `${settings.calibrationPct.toFixed(2)}%`})
            </span>
          </div>
          <span className="font-mono text-[11px] text-[var(--ps-muted)]">
            Base W {settings.wBaseValue}
          </span>
        </div>

        <div className="grid grid-cols-5 gap-1.5 font-mono">
          <button
            type="button"
            onClick={() => adjustCalPct(-1)}
            className="min-h-[48px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-xs font-extrabold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
          >
            -1%
          </button>
          <button
            type="button"
            onClick={() => adjustCalPct(-0.1)}
            className="min-h-[48px] inline-flex items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-sm font-black text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
          >
            <Minus className="h-4 w-4" />
          </button>
          <div className="flex flex-col items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2 text-center tabular-nums">
            <span className="text-sm font-black text-[var(--ps-text)]">
              {settings.sensorMode === 'blue' ? `W ${activeW}` : `${settings.calibrationPct.toFixed(2)}%`}
            </span>
            <span className="text-[9px] text-[var(--ps-muted)]">
              {calibrationPctFromWValue(activeW, settings.wBaseValue).toFixed(1)}%
            </span>
          </div>
          <button
            type="button"
            onClick={() => adjustCalPct(0.1)}
            className="min-h-[48px] inline-flex items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-sm font-black text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => adjustCalPct(1)}
            className="min-h-[48px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-xs font-extrabold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
          >
            +1%
          </button>
        </div>
      </section>
    </div>
  );
};
