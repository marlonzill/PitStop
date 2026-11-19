import { Suspense, lazy, useEffect, useState } from 'react';
import { Calculator, Compass, Flag, Gauge, Home, Route, Settings } from 'lucide-react';
import { CompetitorCollector } from './components/CompetitorCollector';
import { InitialStatusTab } from './components/InitialStatusTab';
import { NavigationCockpit } from './components/NavigationCockpit';
import { OdometerCockpit } from './components/OdometerCockpit';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PitStopLogo } from './components/PitStopLogo';
import { PublicStandingsView } from './components/PublicStandingsView';
import { SettingsTab } from './components/SettingsTab';
import { TimeCalculatorTab } from './components/TimeCalculatorModal';
import { VelocityCockpit } from './components/VelocityCockpit';
import type { ActiveTab, CompetitorResultFile } from './types/rally';
import { useNavSettings } from './utils/navSettings';
import { bootstrapFirstRunPermissions } from './utils/permissionsBootstrap';

const isCompetitorEnv = import.meta.env.VITE_APP_TARGET === 'competitor';

function readUrlRoute(): {
  isApuracao: boolean;
  publicResultSlug: string | null;
} {
  if (typeof window === 'undefined') {
    return { isApuracao: false, publicResultSlug: null };
  }
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.toLowerCase();
  const publicResultSlug = params.get('resultado')?.trim() || null;
  const isApuracao =
    !isCompetitorEnv &&
    !publicResultSlug &&
    (params.get('apuracao') === '1' ||
      params.get('modo') === 'apuracao' ||
      path === '/apuracao' ||
      path === '/apuracao/');
  return { isApuracao, publicResultSlug };
}

const OrganizerBackoffice = isCompetitorEnv
  ? null
  : lazy(() =>
      import('./components/OrganizerBackoffice').then((m) => ({
        default: m.OrganizerBackoffice,
      }))
    );

export type SettingsSubMenu =
  | 'hub'
  | 'roadbooks'
  | 'pairing'
  | 'pilot'
  | 'calibration'
  | 'alerts'
  | 'clock'
  | 'gopro'
  | 'system';

export default function App() {
  const [navSettings] = useNavSettings();
  const [{ isApuracao, publicResultSlug }, setRouteState] = useState(() =>
    readUrlRoute()
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>('inicial');
  const [settingsMenu, setSettingsMenu] = useState<SettingsSubMenu>('hub');
  const [backofficeResults, setBackofficeResults] = useState<CompetitorResultFile[]>([]);

  // Request Location, Storage, and Microphone permissions cleanly on first launch
  useEffect(() => {
    bootstrapFirstRunPermissions();
  }, []);

  // Apply screen orientation preference whenever available on mobile browsers / WebView
  useEffect(() => {
    if (typeof window === 'undefined' || !window.screen?.orientation) return;
    const ori = window.screen.orientation as ScreenOrientation & {
      lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
      unlock?: () => void;
    };
    try {
      if (navSettings.screenOrientation === 'auto') {
        ori.unlock?.();
      } else if (typeof ori.lock === 'function') {
        ori.lock(navSettings.screenOrientation).catch(() => {});
      }
    } catch {
      // Orientation lock unsupported in desktop browsers / unfullscreen mode
    }
  }, [navSettings.screenOrientation]);

  const handleAddBackofficeResults = (newItems: CompetitorResultFile[]) => {
    setBackofficeResults((prev) => {
      const merged = [...prev];
      for (const item of newItems) {
        const existingIdx = merged.findIndex(
          (x) =>
            x.id === item.id ||
            (x.carNumber === item.carNumber && x.fileName === item.fileName)
        );
        if (existingIdx >= 0) {
          merged[existingIdx] = item;
        } else {
          merged.push(item);
        }
      }
      return merged;
    });
  };

  const handleRemoveBackofficeResult = (id: string) => {
    setBackofficeResults((prev) => prev.filter((r) => r.id !== id));
  };

  const openSettingsSection = (menu: SettingsSubMenu = 'hub') => {
    setSettingsMenu(menu);
    setActiveTab('configuracoes');
  };

  const openApuracaoPortal = () => {
    if (isCompetitorEnv) return;
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('resultado');
      url.searchParams.set('apuracao', '1');
      window.history.pushState({}, '', url.toString());
    }
    setRouteState({ isApuracao: true, publicResultSlug: null });
  };

  const exitPortalToApp = () => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('apuracao');
      url.searchParams.delete('modo');
      url.searchParams.delete('resultado');
      if (url.pathname.toLowerCase().startsWith('/apuracao')) {
        url.pathname = '/';
      }
      window.history.replaceState({}, '', url.toString());
    }
    setRouteState({ isApuracao: false, publicResultSlug: null });
    setActiveTab('inicial');
  };

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-rally-asphalt text-[#F4F4F4] flex flex-col">
      {/* PitStop-Sports Safe-Area Top Header */}
      <header className="sticky top-0 z-30 pt-safe bg-[#080B0D]/95 text-white backdrop-blur-md">
        <div className="relative overflow-hidden">
          <div className="relative mx-auto flex min-h-[50px] max-w-7xl items-center justify-between gap-1.5 px-2 py-1 sm:min-h-[56px] sm:gap-3 sm:px-4 sm:py-1.5 lg:px-8">
            {/* Compact stylized P badge on both mobile and desktop */}
            <a
              href={import.meta.env.BASE_URL}
              onClick={(e) => {
                e.preventDefault();
                if (isApuracao || publicResultSlug) {
                  exitPortalToApp();
                } else {
                  setActiveTab('inicial');
                }
              }}
              className="flex items-center whitespace-nowrap shrink-0 group"
              aria-label="PitStop-Sports Início"
            >
              <PitStopLogo
                variant="icon"
                className="h-9 w-9 sm:h-10 sm:w-10 transition-transform group-hover:scale-105"
              />
            </a>

            {/* 7 Ordered Tabs: 4+3 wrap on narrow portrait mobile, 1 single row on landscape/desktop */}
            {!isApuracao && !publicResultSlug ? (
              <nav
                aria-label="Menu principal"
                className="grid flex-1 grid-cols-4 gap-1 rounded-lg border border-zinc-800 bg-[#111214] p-1 sm:grid-cols-7 sm:flex-none sm:items-center lg:gap-1"
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('inicial')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'inicial'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Home className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span>Início</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('navegacao')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'navegacao'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Route className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Regul.</span>
                  <span className="hidden lg:inline">Regularidade</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('velocidade')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'velocidade'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Flag className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Veloc.</span>
                  <span className="hidden lg:inline">Velocidade</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('hodometro')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'hodometro'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Gauge className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Hodo.</span>
                  <span className="hidden lg:inline">Hodômetro</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('competidor')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'competidor'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Compass className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Colet.</span>
                  <span className="hidden lg:inline">Coletor</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('calculadora')}
                  className={`inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'calculadora'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Calculator className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Calc.</span>
                  <span className="hidden lg:inline">Calculadora</span>
                </button>

                <button
                  type="button"
                  onClick={() => openSettingsSection('hub')}
                  className={`col-span-2 sm:col-span-1 inline-flex min-h-[38px] items-center justify-center gap-1 rounded-md px-1.5 sm:px-2 lg:px-3 text-[11px] sm:text-xs lg:text-sm font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'configuracoes'
                      ? 'pitstop-btn-red text-white'
                      : 'text-[#B5B5B5] hover:text-white'
                  }`}
                >
                  <Settings className="h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4" />
                  <span className="lg:hidden">Config.</span>
                  <span className="hidden lg:inline">Configurações</span>
                </button>
              </nav>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-bold tracking-wider text-[#E10600] uppercase">
                  {publicResultSlug ? 'Resultado Oficial' : 'Portal de Apuração'}
                </span>
                <button
                  type="button"
                  onClick={exitPortalToApp}
                  className="rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-1.5 text-xs font-semibold text-[#F4F4F4] hover:bg-zinc-800 whitespace-nowrap"
                >
                  Ir p/ App
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Checkered flag speed streak (faixa.png) flush under top navigation bar */}
        <div
          aria-hidden="true"
          className="pitstop-racing-line h-[6px] w-full sm:h-[8px]"
        />
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-2 pt-2.5 pb-4 sm:px-6 sm:pt-5 lg:px-8">
        {publicResultSlug ? (
          <PublicStandingsView slug={publicResultSlug} />
        ) : isApuracao && OrganizerBackoffice ? (
          <Suspense
            fallback={
              <div className="rounded-xl border border-zinc-800 bg-[#111214] p-8 text-center text-sm text-[#B5B5B5]">
                Carregando portal de apuração PitStop-Sports...
              </div>
            }
          >
            <OrganizerBackoffice
              results={backofficeResults}
              onAddResults={handleAddBackofficeResults}
              onRemoveResult={handleRemoveBackofficeResult}
              onClearAll={() => setBackofficeResults([])}
            />
          </Suspense>
        ) : (
          <>
            {activeTab === 'inicial' && (
              <InitialStatusTab
                onNavigate={(tab) => {
                  if (tab === 'configuracoes') openSettingsSection('hub');
                  else setActiveTab(tab);
                }}
              />
            )}
            {activeTab === 'navegacao' && (
              <NavigationCockpit
                onOpenRoadbookSettings={() => openSettingsSection('roadbooks')}
              />
            )}
            {activeTab === 'velocidade' && <VelocityCockpit />}
            {activeTab === 'hodometro' && <OdometerCockpit />}
            {activeTab === 'competidor' && <CompetitorCollector />}
            {activeTab === 'calculadora' && <TimeCalculatorTab />}
            {activeTab === 'configuracoes' && (
              <SettingsTab
                initialMenu={settingsMenu}
                onMenuChange={setSettingsMenu}
                onOpenNavigation={() => setActiveTab('navegacao')}
                onOpenApuracao={!isCompetitorEnv ? openApuracaoPortal : undefined}
              />
            )}
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-safe pt-2 text-center">
        <p className="text-[11px] tracking-wide text-zinc-500">
          Desenvolvido por Márlon Zill · PitStop-Sports
        </p>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
