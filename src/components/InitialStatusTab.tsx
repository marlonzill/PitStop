import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Calculator, ChevronDown, Flag, Route, Satellite, Settings, Wifi, WifiOff } from 'lucide-react';
import type { ActiveTab, RallyMode } from '../types/rally';
import { useNavSettings } from '../utils/navSettings';
import { listSavedRoadbooks } from '../utils/roadbookStorage';
import { APP_VERSION } from '../version';

interface InitialStatusTabProps {
  rallyMode: RallyMode;
  onSelectMode: (mode: RallyMode) => void;
  onNavigate: (tab: ActiveTab) => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

const HOME_BG_URL = `${import.meta.env.BASE_URL}assets/aistudio/image_973de89f_6ba539fe.jpg`;

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({
  rallyMode,
  onSelectMode,
  onNavigate,
}) => {
  const [settings] = useNavSettings();
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    listSavedRoadbooks()
      .then((list) => setSavedCount(list.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') return;
    let mounted = true;
    nav
      .getBattery()
      .then((bm) => {
        if (!mounted) return;
        setBatteryPct(Math.round(bm.level * 100));
        const onLvl = () => {
          if (mounted) setBatteryPct(Math.round(bm.level * 100));
        };
        bm.addEventListener('levelchange', onLvl);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const probeGps = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const pos = await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 8000,
          });
          if (!mounted) return;
          setGpsActive(true);
          setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
        } else if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (!mounted) return;
              setGpsActive(true);
              setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
            },
            () => {
              if (mounted) setGpsActive(false);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
          );
        }
      } catch {
        if (mounted) setGpsActive(false);
      }
    };
    probeGps();
    return () => {
      mounted = false;
    };
  }, []);

  const isSolar = settings.appTheme === 'solar';

  return (
    <div className="relative -mx-2.5 -mt-2.5 flex min-h-[calc(100dvh-7.8rem)] flex-col items-center justify-end overflow-hidden bg-[var(--ps-bg)] px-3 pt-36 pb-5 text-center sm:-mx-6 sm:-mt-5 sm:min-h-[calc(100dvh-8.4rem)] sm:px-6 sm:pt-48 sm:pb-7">
      {/* Clean Full-Bleed PitStop-Sports Hero Background */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 overflow-hidden select-none ${
          isSolar ? 'h-[52%] bg-[#080B0D]' : 'inset-0'
        }`}
      >
        {/* Centered portrait emblem canvas */}
        <div className="relative mx-auto h-full w-full max-w-[540px] overflow-hidden">
          <img
            src={HOME_BG_URL}
            alt=""
            className="h-full w-full object-cover object-[50%_20%] opacity-95"
          />

          {/* Seamless radial & edge blend on dark themes */}
          <div
            className="absolute inset-0"
            style={{
              background: isSolar
                ? 'radial-gradient(ellipse 68% 62% at 50% 40%, transparent 52%, rgba(8,11,13,0.75) 85%, #080B0D 100%)'
                : 'radial-gradient(ellipse 64% 58% at 50% 34%, transparent 48%, color-mix(in srgb, var(--ps-bg) 72%, transparent) 82%, var(--ps-bg) 100%)',
            }}
          />
        </div>

        {/* Top & Bottom Fades for Clean Integration and Crisp Button Contrast */}
        <div
          className="absolute inset-x-0 top-0 h-14"
          style={{
            background: isSolar
              ? 'linear-gradient(to bottom, #080B0D, transparent)'
              : 'linear-gradient(to bottom, var(--ps-bg), transparent)',
          }}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-[48%]"
          style={{
            background: isSolar
              ? 'linear-gradient(to top, var(--ps-bg) 4%, rgba(8,11,13,0.78) 46%, transparent)'
              : 'linear-gradient(to top, var(--ps-bg) 20%, color-mix(in srgb, var(--ps-bg) 88%, transparent) 60%, transparent)',
          }}
        />
      </div>

      {/* Foreground Interactive Controls */}
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center">
        <div className="flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-px w-6 bg-gradient-to-r from-transparent to-[var(--ps-border-strong)] sm:w-10"
          />
          <p className="font-['Barlow_Condensed'] text-xs font-bold italic tracking-[0.26em] text-[var(--ps-muted)] uppercase sm:text-sm">
            Rotas na medida exata
          </p>
          <span
            aria-hidden="true"
            className="h-px w-6 bg-gradient-to-l from-transparent to-[var(--ps-border-strong)] sm:w-10"
          />
        </div>

        {/* Seletor Único de Modalidade do Rally */}
        <div className="mt-3.5 w-full max-w-md sm:mt-5">
          <label className="block text-left">
            <span className="mb-1.5 block text-center font-mono text-[10px] font-semibold tracking-widest text-[var(--ps-muted)] uppercase">
              Modalidade do Rally
            </span>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--ps-accent)]">
                {rallyMode === 'velocidade' ? (
                  <Flag className="h-4 w-4" />
                ) : (
                  <Route className="h-4 w-4" />
                )}
              </span>
              <select
                value={rallyMode}
                onChange={(e) => {
                  const nextMode = e.target.value === 'velocidade' ? 'velocidade' : 'regularidade';
                  onSelectMode(nextMode);
                }}
                aria-label="Modalidade do Rally"
                className="min-h-[48px] w-full cursor-pointer appearance-none rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] pr-10 pl-10 text-sm font-extrabold tracking-wide text-[var(--ps-text)] shadow-sm transition-colors focus:border-[var(--ps-accent)] focus:outline-none"
              >
                <option value="regularidade">Rally Regularidade</option>
                <option value="velocidade">Rally Velocidade</option>
              </select>
              <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 h-4 w-4 -translate-y-1/2 text-[var(--ps-muted)]" />
            </div>
          </label>

          {/* Atalhos Rápidos: Calculadora e Configurações */}
          <div className="mt-3 grid w-full grid-cols-2 gap-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => onNavigate('calculadora')}
              className="pitstop-btn-metal inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-2xl px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
            >
              <Calculator className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
              <span>Calculadora</span>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('configuracoes')}
              className="pitstop-btn-metal inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-2xl px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
            >
              <Settings className="h-4 w-4 shrink-0 text-[var(--ps-muted)]" />
              <span>Configurações</span>
            </button>
          </div>
        </div>

        {/* Minimal Unboxed Readiness Line with Internet Signal & Clean Version */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <Satellite
              className={`h-3.5 w-3.5 ${
                gpsActive ? 'text-[var(--ps-emerald)]' : 'text-[var(--ps-accent)]'
              }`}
            />
            <span>
              {gpsActive ? `GPS ±${gpsAccuracy ?? '--'}m` : 'GPS aguardando'}
            </span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Battery className="h-3.5 w-3.5" />
            <span>Bateria {batteryPct !== null ? `${batteryPct}%` : '--'}</span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="inline-flex items-center gap-1.5">
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
            )}
            <span className={isOnline ? 'text-[var(--ps-emerald)] font-semibold' : 'text-[var(--ps-amber)] font-semibold'}>
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span>
            {savedCount} {savedCount === 1 ? 'planilha offline' : 'planilhas offline'}
          </span>
          {settings.pairing.enabled && (
            <>
              <span aria-hidden="true" className="opacity-40">·</span>
              <span className="text-[var(--ps-accent)] font-bold">
                Sala {settings.pairing.roomCode}
              </span>
            </>
          )}
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="font-semibold opacity-75">{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
};
