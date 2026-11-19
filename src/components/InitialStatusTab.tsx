import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Calculator, Compass, Flag, Gauge, Route, Satellite, Settings } from 'lucide-react';
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
    <div className="relative flex min-h-[calc(100vh-12rem)] flex-col items-center justify-center px-2 py-3 text-center sm:px-3 sm:py-5">
      {/* Integrated PitStop-Sports Hero Centerpiece */}
      <div className="relative flex w-full max-w-4xl flex-col items-center">
        <PitStopLogo variant="full" animated className="w-full max-w-xl sm:max-w-2xl" />

        <h1 className="mt-3 font-['Barlow_Condensed'] text-3xl font-extrabold italic tracking-wide text-white uppercase sm:mt-5 sm:text-5xl">
          Rotas <span className="text-[#E10600]">na medida exata</span>
        </h1>

        {/* Primary Motorsport Launch Actions — all equal size in exact menu order */}
        <div className="mt-6 grid w-full max-w-4xl grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6 sm:gap-3">
          <button
            type="button"
            onClick={() => onNavigate('navegacao')}
            className="pitstop-btn-red inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-extrabold tracking-wider text-white uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Route className="h-4 w-4 shrink-0" />
            <span>Regularidade</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('velocidade')}
            className="pitstop-btn-metal inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Flag className="h-4 w-4 shrink-0 text-[#E10600]" />
            <span>Velocidade</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('hodometro')}
            className="pitstop-btn-metal inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Gauge className="h-4 w-4 shrink-0 text-[#E10600]" />
            <span>Hodômetro</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('competidor')}
            className="pitstop-btn-metal inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Compass className="h-4 w-4 shrink-0 text-[#C0C4C9]" />
            <span>Coletor</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('calculadora')}
            className="pitstop-btn-metal inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold tracking-wider uppercase whitespace-nowrap transition-transform active:scale-[0.98] sm:text-sm"
          >
            <Calculator className="h-4 w-4 shrink-0 text-[#E10600]" />
            <span>Calculadora</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('configuracoes')}
            className="pitstop-btn-metal inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg px-3 text-xs font-bold tracking-wider text-[#C0C4C9] uppercase whitespace-nowrap transition-transform hover:text-white active:scale-[0.98] sm:text-sm"
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span>Configurações</span>
          </button>
        </div>

        {/* Minimal Unboxed Readiness Line */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-xs text-[#B5B5B5] tabular-nums">
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
