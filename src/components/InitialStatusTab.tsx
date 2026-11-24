import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Satellite, Wifi, WifiOff } from 'lucide-react';
import { APP_VERSION } from '../version';
import { PitStopLogo } from './PitStopLogo';

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

export const InitialStatusTab: React.FC = () => {
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
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
    <div className="pitstop-home-motorsport-bg relative flex h-full w-full flex-1 flex-col items-center justify-between overflow-hidden px-4 py-3 text-center sm:py-5">
      {/* Brilho radial vermelho suave centralizado atrás da marca */}
      <div
        aria-hidden="true"
        className="pitstop-home-radial-glow pointer-events-none absolute inset-0"
      />

      {/* Espaçador superior sutil para manter o conjunto óptico perfeitamente centralizado */}
      <div aria-hidden="true" className="h-2 shrink-0 sm:h-4" />

      {/* Bloco Central: Logotipo original PITSTOP SPORTS + Slogan com luz animada */}
      <div className="relative z-10 mx-auto my-auto flex w-full max-w-3xl flex-col items-center justify-center text-center">
        <div className="mx-auto flex w-full max-w-[320px] flex-col items-center justify-center sm:max-w-[420px]">
          <PitStopLogo variant="full" animated className="mx-auto w-full" />
        </div>

        <div className="mt-1.5 flex w-full max-w-md items-center justify-center gap-3 px-2">
          <span
            aria-hidden="true"
            className="pitstop-divider-beam h-[2px] max-w-[68px] flex-1 rounded-full"
          />
          <p className="pitstop-slogan-text shrink-0 font-['Barlow_Condensed'] text-xs font-extrabold italic tracking-[0.26em] uppercase sm:text-sm">
            Rotas na medida exata
          </p>
          <span
            aria-hidden="true"
            className="pitstop-divider-beam pitstop-divider-beam-right h-[2px] max-w-[68px] flex-1 rounded-full"
          />
        </div>
      </div>

      {/* Rodapé Minimalista: Linha de status dinâmica + Assinatura */}
      <footer className="relative z-10 flex w-full shrink-0 flex-col items-center justify-center gap-1 pb-safe text-[11px] text-zinc-400">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 font-mono text-[11px] tabular-nums">
          <span className="inline-flex items-center gap-1">
            <Satellite
              className={`h-3 w-3 ${
                gpsActive ? 'text-emerald-400' : 'text-[#E10600]'
              }`}
            />
            <span>
              {gpsActive ? `GPS (±${gpsAccuracy ?? '--'}m)` : 'GPS (aguardando)'}
            </span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="inline-flex items-center gap-1">
            <Battery className="h-3 w-3" />
            <span>Bateria {batteryPct !== null ? `${batteryPct}%` : '--'}</span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="inline-flex items-center gap-1">
            {isOnline ? (
              <Wifi className="h-3 w-3 text-emerald-400" />
            ) : (
              <WifiOff className="h-3 w-3 text-amber-400" />
            )}
            <span
              className={
                isOnline
                  ? 'font-semibold text-emerald-400'
                  : 'font-semibold text-amber-400'
              }
            >
              {isOnline ? 'Online' : 'Offline'}
            </span>
          </span>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="font-semibold text-zinc-300">{APP_VERSION}</span>
        </div>
        <p className="text-[11px] tracking-wide text-zinc-500">
          Desenvolvido por Márlon Zill · PitStop-Sports
        </p>
      </footer>
    </div>
  );
};
