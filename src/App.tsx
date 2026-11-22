import { Suspense, lazy, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Calculator, Flag, Home, Route, Settings } from 'lucide-react';
import { InitialStatusTab } from './components/InitialStatusTab';
import { NavigationCockpit } from './components/NavigationCockpit';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PitStopLogo } from './components/PitStopLogo';
import { PublicStandingsView } from './components/PublicStandingsView';
import { SettingsTab } from './components/SettingsTab';
import { TimeCalculatorTab } from './components/TimeCalculatorModal';
import { VelocityCockpit } from './components/VelocityCockpit';
import type { ActiveTab, CompetitorResultFile, RallyMode } from './types/rally';
import { applyAppThemeToDocument, updateNavSettings, useNavSettings } from './utils/navSettings';
import { normalizeRoomCode, normalizeRoomPin } from './utils/pairingClient';
import { bootstrapFirstRunPermissions } from './utils/permissionsBootstrap';

const isCompetitorEnv = import.meta.env.VITE_APP_TARGET === 'competitor';
const isNativeAndroid =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const RALLY_MODE_STORAGE_KEY = 'pitstop_rally_mode_v1';

function readSavedRallyMode(): RallyMode {
  if (typeof window === 'undefined') return 'regularidade';
  try {
    const saved = window.localStorage.getItem(RALLY_MODE_STORAGE_KEY);
    return saved === 'velocidade' ? 'velocidade' : 'regularidade';
  } catch {
    return 'regularidade';
  }
}

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
  | 'theme'
  | 'collector'
  | 'roadbooks'
  | 'pairing'
  | 'pilot'
  | 'calibration'
  | 'alerts'
  | 'clock'
  | 'gopro'
  | 'backup'
  | 'system';

export default function App() {
  const [navSettings] = useNavSettings();
  const [{ isApuracao, publicResultSlug }, setRouteState] = useState(() =>
    readUrlRoute()
  );
  const [activeTab, setActiveTabState] = useState<ActiveTab>('inicial');
  const [rallyMode, setRallyModeState] = useState<RallyMode>(() => readSavedRallyMode());
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(() => new Set(['inicial']));
  const [settingsMenu, setSettingsMenu] = useState<SettingsSubMenu>('hub');
  const [backofficeResults, setBackofficeResults] = useState<CompetitorResultFile[]>([]);

  const setActiveTab = (tab: ActiveTab) => {
    setActiveTabState(tab);
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  };

  const updateRallyMode = (mode: RallyMode) => {
    setRallyModeState(mode);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(RALLY_MODE_STORAGE_KEY, mode);
      }
    } catch {
      // Ignore storage errors in restricted WebViews
    }
  };

  const handleSelectModeFromHome = (mode: RallyMode) => {
    updateRallyMode(mode);
    setActiveTab(mode === 'velocidade' ? 'velocidade' : 'navegacao');
  };

  // Request Location and Storage permissions cleanly on first launch
  useEffect(() => {
    bootstrapFirstRunPermissions();
  }, []);

  // Auto-open Droid Piloto screen when launched via ?piloto=ROOM&pin=PIN
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const pilotoParam = params.get('piloto');
    const pinParam = params.get('pin');
    if (pilotoParam) {
      const normalized = normalizeRoomCode(pilotoParam);
      const normalizedPin = pinParam ? normalizeRoomPin(pinParam) : '';
      updateNavSettings((prev) => ({
        ...prev,
        pairing: {
          ...prev.pairing,
          enabled: true,
          role: 'pilot',
          roomCode: normalized || prev.pairing.roomCode,
          roomPin: normalizedPin || prev.pairing.roomPin,
        },
      }));
      updateRallyMode('regularidade');
      setActiveTab('navegacao');
    }
  }, []);

  // Sync active theme attribute to <html>
  useEffect(() => {
    applyAppThemeToDocument(navSettings.appTheme);
  }, [navSettings.appTheme]);

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
    <div className="min-h-screen w-full overflow-x-hidden bg-rally-asphalt text-[var(--ps-text)] flex flex-col">
      {/* PitStop-Sports Top Header (flush at top on native Android WebView) */}
      <header
        className={`sticky top-0 z-30 border-b border-[var(--ps-border)] bg-[var(--ps-header)] text-[var(--ps-text)] backdrop-blur-md ${
          isNativeAndroid ? '' : 'pt-safe'
        }`}
      >
        <div className="relative overflow-hidden">
          <div className="relative mx-auto flex min-h-[54px] max-w-7xl items-center justify-between gap-2 px-2.5 py-1.5 sm:min-h-[58px] sm:gap-3 sm:px-4 lg:px-8">
            {/* Stylized PitStop P badge (transparent background) */}
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
              className="flex items-center whitespace-nowrap shrink-0 group bg-transparent"
              aria-label="PitStop-Sports Início"
            >
              <PitStopLogo
                variant="icon"
                className="h-9 w-9 sm:h-10 sm:w-10 transition-transform group-hover:scale-105 bg-transparent drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
              />
            </a>

            {/* 4 Ordered Tabs filtered by active rallyMode (Início, Regul. OR Veloc., Calc., Config.) */}
            {!isApuracao && !publicResultSlug ? (
              <nav
                aria-label="Menu principal"
                className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-1 lg:flex-none lg:gap-1.5"
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('inicial')}
                  aria-label="Início"
                  title="Início"
                  className={`min-w-0 flex-1 lg:flex-none inline-flex min-h-[44px] flex-col lg:min-h-[38px] lg:flex-row items-center justify-center gap-0.5 lg:gap-2 rounded-xl px-1.5 py-1 sm:px-3.5 lg:px-4 text-[10px] sm:text-[11px] lg:text-xs font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'inicial'
                      ? 'pitstop-btn-red'
                      : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <Home className="h-4 w-4 shrink-0" />
                  <span className="truncate leading-none">Início</span>
                </button>

                {rallyMode === 'regularidade' ? (
                  <button
                    type="button"
                    onClick={() => {
                      updateRallyMode('regularidade');
                      setActiveTab('navegacao');
                    }}
                    aria-label="Regularidade"
                    title="Regularidade"
                    className={`min-w-0 flex-1 lg:flex-none inline-flex min-h-[44px] flex-col lg:min-h-[38px] lg:flex-row items-center justify-center gap-0.5 lg:gap-2 rounded-xl px-1.5 py-1 sm:px-3.5 lg:px-4 text-[10px] sm:text-[11px] lg:text-xs font-bold transition-colors whitespace-nowrap ${
                      activeTab === 'navegacao'
                        ? 'pitstop-btn-red'
                        : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    <Route className="h-4 w-4 shrink-0" />
                    <span className="truncate leading-none lg:hidden">Regul.</span>
                    <span className="hidden lg:inline">Regularidade</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      updateRallyMode('velocidade');
                      setActiveTab('velocidade');
                    }}
                    aria-label="Velocidade"
                    title="Velocidade"
                    className={`min-w-0 flex-1 lg:flex-none inline-flex min-h-[44px] flex-col lg:min-h-[38px] lg:flex-row items-center justify-center gap-0.5 lg:gap-2 rounded-xl px-1.5 py-1 sm:px-3.5 lg:px-4 text-[10px] sm:text-[11px] lg:text-xs font-bold transition-colors whitespace-nowrap ${
                      activeTab === 'velocidade'
                        ? 'pitstop-btn-red'
                        : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    <Flag className="h-4 w-4 shrink-0" />
                    <span className="truncate leading-none lg:hidden">Veloc.</span>
                    <span className="hidden lg:inline">Velocidade</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setActiveTab('calculadora')}
                  aria-label="Calculadora"
                  title="Calculadora"
                  className={`min-w-0 flex-1 lg:flex-none inline-flex min-h-[44px] flex-col lg:min-h-[38px] lg:flex-row items-center justify-center gap-0.5 lg:gap-2 rounded-xl px-1.5 py-1 sm:px-3.5 lg:px-4 text-[10px] sm:text-[11px] lg:text-xs font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'calculadora'
                      ? 'pitstop-btn-red'
                      : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <Calculator className="h-4 w-4 shrink-0" />
                  <span className="truncate leading-none lg:hidden">Calc.</span>
                  <span className="hidden lg:inline">Calculadora</span>
                </button>

                <button
                  type="button"
                  onClick={() => openSettingsSection('hub')}
                  aria-label="Configurações"
                  title="Configurações"
                  className={`min-w-0 flex-1 lg:flex-none inline-flex min-h-[44px] flex-col lg:min-h-[38px] lg:flex-row items-center justify-center gap-0.5 lg:gap-2 rounded-xl px-1.5 py-1 sm:px-3.5 lg:px-4 text-[10px] sm:text-[11px] lg:text-xs font-bold transition-colors whitespace-nowrap ${
                    activeTab === 'configuracoes'
                      ? 'pitstop-btn-red'
                      : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  <Settings className="h-4 w-4 shrink-0" />
                  <span className="truncate leading-none lg:hidden">Config.</span>
                  <span className="hidden lg:inline">Configurações</span>
                </button>
              </nav>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-bold tracking-wider text-[var(--ps-accent)] uppercase">
                  {publicResultSlug ? 'Resultado Oficial' : 'Portal de Apuração'}
                </span>
                <button
                  type="button"
                  onClick={exitPortalToApp}
                  className="pitstop-btn-metal rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
                >
                  Ir p/ App
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Checkered flag speed streak flush under top navigation bar */}
        <div
          aria-hidden="true"
          className="pitstop-racing-line h-[5px] w-full sm:h-[7px]"
        />
      </header>

      {/* Main Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-2.5 pt-2.5 pb-4 sm:px-6 sm:pt-5 lg:px-8">
        {publicResultSlug ? (
          <PublicStandingsView slug={publicResultSlug} />
        ) : isApuracao && OrganizerBackoffice ? (
          <Suspense
            fallback={
              <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-8 text-center text-sm text-[var(--ps-muted)]">
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
            <div className={activeTab === 'inicial' ? '' : 'hidden'}>
              <InitialStatusTab
                rallyMode={rallyMode}
                onSelectMode={handleSelectModeFromHome}
                onNavigate={(tab) => {
                  if (tab === 'configuracoes') openSettingsSection('hub');
                  else setActiveTab(tab);
                }}
              />
            </div>
            {visitedTabs.has('navegacao') && (
              <div className={activeTab === 'navegacao' ? '' : 'hidden'}>
                <NavigationCockpit
                  onOpenRoadbookSettings={() => openSettingsSection('roadbooks')}
                />
              </div>
            )}
            {visitedTabs.has('velocidade') && (
              <div className={activeTab === 'velocidade' ? '' : 'hidden'}>
                <VelocityCockpit isActive={activeTab === 'velocidade'} />
              </div>
            )}
            {activeTab === 'calculadora' && <TimeCalculatorTab />}
            {visitedTabs.has('configuracoes') && (
              <div className={activeTab === 'configuracoes' ? '' : 'hidden'}>
                <SettingsTab
                  initialMenu={settingsMenu}
                  onMenuChange={setSettingsMenu}
                  onOpenNavigation={() => {
                    updateRallyMode('regularidade');
                    setActiveTab('navegacao');
                  }}
                  onOpenApuracao={!isCompetitorEnv ? openApuracaoPortal : undefined}
                />
              </div>
            )}
          </>
        )}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-4 pb-safe pt-2 text-center">
        <p className="text-[11px] tracking-wide text-[var(--ps-muted)]">
          Desenvolvido por Márlon Zill · PitStop-Sports
        </p>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
