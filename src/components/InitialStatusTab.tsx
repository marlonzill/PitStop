import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Calculator, ChevronDown, Crown, Flag, Lock, Route, Satellite, Settings, Wifi, WifiOff } from 'lucide-react';
import type { ActiveTab, RallyMode } from '../types/rally';
import { useAuthSession } from '../utils/authSubscription';
import { useNavSettings } from '../utils/navSettings';
import { listSavedRoadbooks } from '../utils/roadbookStorage';
import { APP_VERSION } from '../version';
import { PitStopLogo } from './PitStopLogo';

interface InitialStatusTabProps {
  rallyMode: RallyMode;
  onSelectMode: (mode: RallyMode) => void;
  onNavigate: (tab: ActiveTab) => void;
  onOpenAccount?: () => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

export const InitialStatusTab: React.FC<InitialStatusTabProps> = ({
  rallyMode,
  onSelectMode,
  onNavigate,
  onOpenAccount,
}) => {
  const [settings] = useNavSettings();
  const { user, isPro } = useAuthSession();
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
  const accountBadgeLabel = isPro
    ? `PRO · ${(user?.name?.split(' ')[0] || 'ATIVO').toUpperCase()}`
    : 'FREE';

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7.8rem)] w-full flex-col items-center justify-center py-3 text-center sm:min-h-[calc(100dvh-8.4rem)] sm:py-6">
      {/* Container 100% Centralizado: Logotipo PITSTOP SPORTS + Frase com Luz Animada */}
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-center text-center">
        <div
          className={`mx-auto flex w-full max-w-[340px] flex-col items-center justify-center sm:max-w-[430px] ${
            isSolar ? 'rounded-3xl bg-[#090A0D] px-4 py-2.5 shadow-xl' : ''
          }`}
        >
          <PitStopLogo variant="full" animated className="mx-auto w-full" />
        </div>

        <div className="mt-1 flex w-full max-w-md items-center justify-center gap-3 px-2">
          <span
            aria-hidden="true"
            className="pitstop-divider-beam h-[2px] flex-1 max-w-[68px] rounded-full"
          />
          <p className="pitstop-slogan-text shrink-0 font-['Barlow_Condensed'] text-xs font-extrabold italic tracking-[0.26em] uppercase sm:text-sm">
            Rotas na medida exata
          </p>
          <span
            aria-hidden="true"
            className="pitstop-divider-beam pitstop-divider-beam-right h-[2px] flex-1 max-w-[68px] rounded-full"
          />
        </div>

        {/* Seletor Único de Modalidade do Rally */}
        <div className="mx-auto mt-4 w-full max-w-md sm:mt-5">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="font-mono text-[10px] font-semibold tracking-widest text-[var(--ps-muted)] uppercase">
              Modalidade do Rally
            </span>
          </div>
          <label className="block text-left">
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
                <option value="regularidade">
                  {isPro ? 'Rally Regularidade' : 'Rally Regularidade (PRO)'}
                </option>
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

        {/* Barra Discreta de Status no Rodapé com Plano/Conta imediatamente antes da Versão */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
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
          {rallyMode === 'regularidade' && (
            <>
              <span aria-hidden="true" className="opacity-40">·</span>
              <span>
                {savedCount} {savedCount === 1 ? 'planilha offline' : 'planilhas offline'}
              </span>
            </>
          )}
          {settings.pairing.enabled && (
            <>
              <span aria-hidden="true" className="opacity-40">·</span>
              <span className="text-[var(--ps-accent)] font-bold">
                Sala {settings.pairing.roomCode}
              </span>
            </>
          )}
          <span aria-hidden="true" className="opacity-40">·</span>
          {onOpenAccount ? (
            <button
              type="button"
              onClick={onOpenAccount}
              className={`inline-flex items-center gap-1 font-bold uppercase transition-opacity hover:opacity-80 ${
                isPro ? 'text-[var(--ps-emerald)]' : 'text-[var(--ps-amber)]'
              }`}
            >
              {isPro ? <Crown className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              <span>{accountBadgeLabel}</span>
            </button>
          ) : (
            <span
              className={`inline-flex items-center gap-1 font-bold uppercase ${
                isPro ? 'text-[var(--ps-emerald)]' : 'text-[var(--ps-amber)]'
              }`}
            >
              {isPro ? <Crown className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              <span>{accountBadgeLabel}</span>
            </span>
          )}
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="font-semibold opacity-75">{APP_VERSION}</span>
        </div>
      </div>
    </div>
  );
};
