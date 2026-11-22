import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Calculator, Flag, Route, Satellite, Settings, Wifi, WifiOff } from 'lucide-react';
import type { ActiveTab } from '../types/rally';
import { useNavSettings } from '../utils/navSettings';
import { listSavedRoadbooks } from '../utils/roadbookStorage';
import { APP_VERSION } from '../version';

interface InitialStatusTabProps {
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

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({ onNavigate }) => {
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

  return (
    <div className="relative -mx-2 -mt-2.5 flex min-h-[calc(100dvh-7.8rem)] flex-col items-center justify-end overflow-hidden bg-[#080B0D] px-3 pt-44 pb-7 text-center sm:-mx-6 sm:-mt-5 sm:min-h-[calc(100dvh-8.4rem)] sm:px-6 sm:pt-56 sm:pb-8">
      {/* Clean Full-Bleed PitStop-Sports Hero Background */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      >
        {/* Centered portrait emblem canvas */}
        <div className="relative mx-auto h-full w-full max-w-[540px] overflow-hidden">
          <img
            src={HOME_BG_URL}
            alt=""
            className="h-full w-full object-cover object-[50%_20%] opacity-95"
          />

          {/* Seamless radial & edge blend into #080B0D on wide viewports */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 64% 58% at 50% 34%, transparent 48%, rgba(8,11,13,0.72) 82%, #080B0D 100%)',
            }}
          />
        </div>

        {/* Top & Bottom Dark Asphalt Fades for Clean Integration and Crisp Button Contrast */}
        <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-[#080B0D] via-[#080B0D]/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-[48%] bg-gradient-to-t from-[#080B0D] via-[#080B0D]/88 to-transparent" />
      </div>

      {/* Foreground Interactive Controls */}
      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center">
        <div className="flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-px w-6 bg-gradient-to-r from-transparent to-zinc-600/60 sm:w-10"
          />
          <p className="pitstop-slogan-text font-['Barlow_Condensed'] text-xs font-bold italic tracking-[0.28em] uppercase sm:text-sm">
            Rotas na medida exata
          </p>
          <span
            aria-hidden="true"
            className="h-px w-6 bg-gradient-to-l from-transparent to-zinc-600/60 sm:w-10"
          />
        </div>

        {/* Primary Motorsport Launch Actions — clean 4-button grid */}
        <div className="mt-4 grid w-full grid-cols-2 gap-2 sm:mt-5 lg:grid-cols-4 sm:gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate('navegacao')}
            className="pitstop-btn-red inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-extrabold tracking-wider text-white uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Route className="h-4 w-4 shrink-0" />
            <span>Regularidade</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('velocidade')}
            className="pitstop-btn-metal inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Flag className="h-4 w-4 shrink-0 text-[#E10600]" />
            <span>Velocidade</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('calculadora')}
            className="pitstop-btn-metal inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Calculator className="h-4 w-4 shrink-0 text-[#E10600]" />
            <span>Calculadora</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('configuracoes')}
            className="pitstop-btn-metal inline-flex h-[46px] sm:h-[50px] w-full items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-bold tracking-wider text-[#C0C4C9] uppercase whitespace-nowrap transition-transform hover:text-white active:scale-[0.98] sm:text-sm"
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span>Configurações</span>
          </button>
        </div>

        {/* Minimal Unboxed Readiness Line with Internet Signal */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 font-mono text-[11px] text-[#B5B5B5] tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <Satellite className={`h-3.5 w-3.5 ${gpsActive ? 'text-emerald-400' : 'text-[#E10600]'}`} />
            <span>
              {gpsActive ? `GPS ±${gpsAccuracy ?? '--'}m` : 'GPS aguardando'}
            </span>
          </span>
          <span aria-hidden="true" className="text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Battery className="h-3.5 w-3.5 text-[#C0C4C9]" />
            <span>Bateria {batteryPct !== null ? `${batteryPct}%` : '--'}</span>
          </span>
          <span aria-hidden="true" className="text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1.5">
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-amber-400" />
            )}
            <span className={isOnline ? 'text-emerald-400' : 'text-amber-300'}>
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </span>
          <span aria-hidden="true" className="text-zinc-700">·</span>
          <span>
            {savedCount} {savedCount === 1 ? 'planilha offline' : 'planilhas offline'}
          </span>
          {settings.pairing.enabled && (
            <>
              <span aria-hidden="true" className="text-zinc-700">·</span>
              <span className="text-[#E10600] font-bold">
                Sala {settings.pairing.roomCode}
              </span>
            </>
          )}
        </div>
      </div>

      {/* App Version in Bottom Corner */}
      <span className="pointer-events-none absolute right-3 bottom-1 z-10 font-mono text-[11px] font-semibold tracking-wider text-zinc-500 tabular-nums">
        {APP_VERSION}
      </span>
    </div>
  );
};
