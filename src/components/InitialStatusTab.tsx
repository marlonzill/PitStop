import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Calculator, Flag, Route, Satellite, Settings } from 'lucide-react';
import type { ActiveTab } from '../types/rally';
import { useNavSettings } from '../utils/navSettings';
import { listSavedRoadbooks } from '../utils/roadbookStorage';
import { APP_VERSION } from '../version';
import { PitStopLogo } from './PitStopLogo';

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

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({ onNavigate }) => {
  const [settings] = useNavSettings();
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState(0);

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
    <div className="relative flex min-h-[calc(100dvh-9.5rem)] flex-col items-center justify-center px-2 py-2 text-center sm:px-3 sm:py-4">
      {/* Integrated PitStop-Sports Hero Centerpiece */}
      <div className="relative flex w-full max-w-4xl flex-col items-center">
        <PitStopLogo variant="full" animated className="w-full max-w-sm sm:max-w-xl" />

        <h1 className="mt-4 font-['Barlow_Condensed'] text-2xl font-extrabold italic tracking-wide text-white uppercase sm:mt-5 sm:text-4xl">
          Rotas <span className="text-[#E10600]">na medida exata</span>
        </h1>

        {/* Primary Motorsport Launch Actions — clean 4-button grid */}
        <div className="mt-4 grid w-full max-w-3xl grid-cols-2 gap-2 sm:mt-6 lg:grid-cols-4 sm:gap-2.5">
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

        {/* Minimal Unboxed Readiness Line */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 font-mono text-[11px] text-[#B5B5B5] tabular-nums">
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
      <span className="pointer-events-none absolute right-2 bottom-0.5 font-mono text-[11px] font-semibold tracking-wider text-zinc-500 tabular-nums">
        {APP_VERSION}
      </span>
    </div>
  );
};
