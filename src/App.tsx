import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Crown, Lock, X } from 'lucide-react';
import { AdminSecretLoginModal } from './components/AdminSecretLoginModal';
import { DeviceLicenseGateScreen } from './components/DeviceLicenseGateScreen';
import { InitialStatusTab } from './components/InitialStatusTab';
import { OfflineIndicator } from './components/OfflineIndicator';

const NavigationCockpit = lazy(() =>
  import('./components/NavigationCockpit').then((m) => ({ default: m.NavigationCockpit }))
);
const PublicStandingsView = lazy(() =>
  import('./components/PublicStandingsView').then((m) => ({ default: m.PublicStandingsView }))
);
const SettingsTab = lazy(() =>
  import('./components/SettingsTab').then((m) => ({ default: m.SettingsTab }))
);
const TimeCalculatorTab = lazy(() =>
  import('./components/TimeCalculatorModal').then((m) => ({ default: m.TimeCalculatorTab }))
);
const VelocityCockpit = lazy(() =>
  import('./components/VelocityCockpit').then((m) => ({ default: m.VelocityCockpit }))
);
import {
  type DeviceLicenseStatus,
  getCachedLicenseStatusSync,
  useAdminLicenseSession,
  verifyDeviceLicense,
} from './services/deviceLicenseService';
import type { ActiveTab, CompetitorResultFile, RallyMode } from './types/rally';
import {
  ENABLE_SUBSCRIPTION_GATE,
  openProUpgradeModal,
  type ProUpgradePromptPayload,
  subscribeProUpgradeModal,
  useAuthSession,
} from './utils/authSubscription';
import { applyAppThemeToDocument, updateNavSettings, useNavSettings } from './utils/navSettings';
import { normalizeRoomCode, normalizeRoomPin } from './utils/pairingClient';
import { bootstrapFirstRunPermissions } from './utils/permissionsBootstrap';

const isCompetitorEnv = import.meta.env.VITE_APP_TARGET === 'competitor';
const isNativeAndroid =
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

const RALLY_MODE_STORAGE_KEY = 'pitstop_rally_mode_v1';

function readSavedRallyMode(): RallyMode {
  if (typeof window === 'undefined') return 'velocidade';
  try {
    const saved = window.localStorage.getItem(RALLY_MODE_STORAGE_KEY);
    return saved === 'regularidade' ? 'regularidade' : 'velocidade';
  } catch {
    return 'velocidade';
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

const TopNavIcon: React.FC<{
  kind: 'home' | 'velocity' | 'regularity' | 'calc' | 'settings';
  active: boolean;
}> = ({ kind, active }) => {
  const strokeCls = active ? 'text-white' : 'text-[var(--ps-muted)]';
  const accentStroke = active ? '#E10600' : 'currentColor';
  switch (kind) {
    case 'home':
      return (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 ${strokeCls}`} fill="none" aria-hidden="true">
          <path
            d="M3.5 10.5 L12 3.5 L20.5 10.5 V19.5 C20.5 20.1 20.1 20.5 19.5 20.5 H14.5 V14.5 H9.5 V20.5 H4.5 C3.9 20.5 3.5 20.1 3.5 19.5 Z"
            fill="currentColor"
            fillOpacity={active ? 0.16 : 0.06}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path d="M9.5 10.5 H14.5" stroke={accentStroke} strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case 'velocity':
      return (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 ${strokeCls}`} fill="none" aria-hidden="true">
          <path
            d="M4.5 16.5 A8.5 8.5 0 1 1 19.5 16.5"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path
            d="M7.5 16.5 A5.2 5.2 0 1 1 16.5 16.5"
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1.4"
            strokeDasharray="2.5 2.5"
            strokeLinecap="round"
          />
          <path d="M12 13.5 L16.8 8.7" stroke={accentStroke} strokeWidth="2.3" strokeLinecap="round" />
          <circle cx="12" cy="13.5" r="2.1" fill={accentStroke} />
          <rect x="8.5" y="18" width="7" height="2.4" rx="1.2" fill="currentColor" fillOpacity="0.6" />
        </svg>
      );
    case 'regularity':
      return (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 ${strokeCls}`} fill="none" aria-hidden="true">
          <path
            d="M5 18.5 C5 13 10.5 13 12 10 C13.5 7 19 7 19 4.5"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <circle cx="5" cy="18.5" r="2.4" fill="currentColor" />
          <circle cx="19" cy="5.5" r="2.6" fill={accentStroke} />
          <path d="M9 6.5 H13 M11 4.5 V8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
        </svg>
      );
    case 'calc':
      return (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 ${strokeCls}`} fill="none" aria-hidden="true">
          <rect
            x="4.5"
            y="3"
            width="15"
            height="18"
            rx="3"
            fill="currentColor"
            fillOpacity={active ? 0.14 : 0.05}
            stroke="currentColor"
            strokeWidth="2"
          />
          <rect x="7.5" y="6" width="9" height="3.5" rx="1" fill={accentStroke} fillOpacity={active ? 0.9 : 0.45} />
          <circle cx="8.5" cy="13" r="1.15" fill="currentColor" />
          <circle cx="12" cy="13" r="1.15" fill="currentColor" />
          <circle cx="15.5" cy="13" r="1.15" fill="currentColor" />
          <circle cx="8.5" cy="16.8" r="1.15" fill="currentColor" />
          <path d="M11.2 16.8 H16.3" stroke={accentStroke} strokeWidth="2.1" strokeLinecap="round" />
        </svg>
      );
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 ${strokeCls}`} fill="none" aria-hidden="true">
          <path
            d="M12 2.8 L14 4.8 L16.8 4.4 L17.6 7.1 L20.2 8.2 L19.6 11 L21.2 13.2 L19.2 15.2 L19.6 18 L16.9 18.8 L15.8 21.4 L13 20.8 L10.8 22.4 L8.8 20.4 L6 20.8 L5.2 18.1 L2.6 17 L3.2 14.2 L1.6 12 L3.6 10 L3.2 7.2 L5.9 6.4 L7 3.8 L9.8 4.4 Z"
            fill="currentColor"
            fillOpacity={active ? 0.16 : 0.06}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="3.4" stroke={accentStroke} strokeWidth="2.2" />
        </svg>
      );
  }
};

const OrganizerBackoffice = isCompetitorEnv
  ? null
  : lazy(() =>
      import('./components/OrganizerBackoffice').then((m) => ({
        default: m.OrganizerBackoffice,
      }))
    );

export type SettingsSubMenu =
  | 'hub'
  | 'modality'
  | 'velocity'
  | 'account'
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
  const { isPro, user, refresh: refreshAuth } = useAuthSession();
  const [proModal, setProModal] = useState<ProUpgradePromptPayload | null>(null);
  const [{ isApuracao, publicResultSlug }, setRouteState] = useState(() =>
    readUrlRoute()
  );
  const [activeTab, setActiveTabState] = useState<ActiveTab>('inicial');
  const [rallyMode, setRallyModeState] = useState<RallyMode>(() => readSavedRallyMode());
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(() => new Set(['inicial']));
  const [settingsMenu, setSettingsMenu] = useState<SettingsSubMenu>('hub');
  const [backofficeResults, setBackofficeResults] = useState<CompetitorResultFile[]>([]);
  const adminSession = useAdminLicenseSession();
  const [deviceLicense, setDeviceLicense] = useState<DeviceLicenseStatus>(() =>
    getCachedLicenseStatusSync()
  );
  const [checkingDeviceLicense, setCheckingDeviceLicense] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [footerTapCount, setFooterTapCount] = useState(0);

  useEffect(() => {
    if (footerTapCount === 0) return;
    const t = window.setTimeout(() => setFooterTapCount(0), 2500);
    return () => window.clearTimeout(t);
  }, [footerTapCount]);

  const handleFooterSecretTap = () => {
    const next = footerTapCount + 1;
    if (next >= 5) {
      setFooterTapCount(0);
      if (adminSession) {
        openSettingsSection('system');
      } else {
        setAdminModalOpen(true);
      }
      return;
    }
    setFooterTapCount(next);
  };

  const runDeviceLicenseCheck = useCallback(async () => {
    setCheckingDeviceLicense(true);
    try {
      const nextStatus = await verifyDeviceLicense();
      setDeviceLicense(nextStatus);
    } finally {
      setCheckingDeviceLicense(false);
    }
  }, []);

  // Registra e verifica licença do dispositivo no Supabase na inicialização (e ao reconectar / alternar sessão admin)
  useEffect(() => {
    void runDeviceLicenseCheck();
    const onOnline = () => {
      void runDeviceLicenseCheck();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [runDeviceLicenseCheck, adminSession?.loggedInAtIso]);

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

  // Sync user account/subscription cleanly when online (only when gate is enabled)
  useEffect(() => {
    if (!ENABLE_SUBSCRIPTION_GATE) return;
    void refreshAuth();
  }, [refreshAuth]);

  // Listen to PRO upgrade modal prompts from any cockpit component
  useEffect(() => {
    if (!ENABLE_SUBSCRIPTION_GATE) return;
    return subscribeProUpgradeModal((payload) => {
      setProModal(payload);
    });
  }, []);

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

  const isHomeFullCanvas = !publicResultSlug && !isApuracao && activeTab === 'inicial';

  if (!publicResultSlug && !isApuracao && deviceLicense.status === 'blocked' && !adminSession) {
    return (
      <DeviceLicenseGateScreen
        license={deviceLicense}
        checking={checkingDeviceLicense}
        onRetry={() => {
          void runDeviceLicenseCheck();
        }}
        onAdminUnlocked={() => {
          void runDeviceLicenseCheck();
        }}
      />
    );
  }

  return (
    <div
      className={`${
        isHomeFullCanvas
          ? 'h-[100dvh] overflow-hidden'
          : 'min-h-[100dvh] overflow-x-hidden'
      } w-full bg-rally-asphalt text-[var(--ps-text)] flex flex-col`}
    >
      {/* PitStop-Sports Top Header (respeita Safe-Area em Android/iOS para nunca cobrir relógio/notificações) */}
      <header className="sticky top-0 z-30 border-b border-[var(--ps-border)] bg-[var(--ps-header)] pt-safe text-[var(--ps-text)] backdrop-blur-md">
        <div className="relative overflow-hidden">
          <div className="relative mx-auto flex min-h-[54px] max-w-7xl items-center justify-between gap-2 px-2.5 py-1.5 sm:min-h-[58px] sm:gap-3 sm:px-4 lg:px-8">
            {/* 4 Ordered Tabs filtered by active rallyMode (Início, Regul. OR Veloc., Calc., Config.) */}
            {!isApuracao && !publicResultSlug ? (
              <nav
                aria-label="Menu principal"
                className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]/90 p-1 lg:flex-none lg:gap-1.5"
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('inicial')}
                  aria-label="Início"
                  title="Início"
                  className={`relative overflow-hidden min-w-0 flex-1 lg:flex-none inline-flex min-h-[48px] flex-col lg:min-h-[42px] lg:flex-row items-center justify-center gap-1 lg:gap-2 rounded-xl border px-1.5 py-1 sm:px-3.5 lg:px-4 text-[11px] sm:text-xs font-bold tracking-wide transition-all active:scale-[0.98] whitespace-nowrap ${
                    activeTab === 'inicial'
                      ? 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                      : 'border-transparent text-[var(--ps-muted)] hover:border-[var(--ps-border)] hover:bg-[var(--ps-surface)]/70 hover:text-[var(--ps-text)]'
                  }`}
                >
                  <TopNavIcon kind="home" active={activeTab === 'inicial'} />
                  <span className="truncate leading-none">Início</span>
                  {activeTab === 'inicial' && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#E10600]"
                    />
                  )}
                </button>

                {rallyMode === 'regularidade' ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!isPro) {
                        openProUpgradeModal(
                          'Navegação de Regularidade Completa',
                          'Importação de planilhas .NBP/.TXT, TNAV/PMM em tempo real, alertas de voz e pareamento Droid Piloto.'
                        );
                        return;
                      }
                      updateRallyMode('regularidade');
                      setActiveTab('navegacao');
                    }}
                    aria-label="Regularidade"
                    title="Regularidade"
                    className={`relative overflow-hidden min-w-0 flex-1 lg:flex-none inline-flex min-h-[48px] flex-col lg:min-h-[42px] lg:flex-row items-center justify-center gap-1 lg:gap-2 rounded-xl border px-1.5 py-1 sm:px-3.5 lg:px-4 text-[11px] sm:text-xs font-bold tracking-wide transition-colors duration-75 active:scale-[0.98] whitespace-nowrap ${
                      activeTab === 'navegacao'
                        ? 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                        : 'border-transparent text-[var(--ps-muted)] hover:border-[var(--ps-border)] hover:bg-[var(--ps-surface)]/70 hover:text-[var(--ps-text)]'
                    }`}
                  >
                    <TopNavIcon kind="regularity" active={activeTab === 'navegacao'} />
                    <span className="inline-flex items-center gap-1 truncate leading-none">
                      <span className="lg:hidden">Regul.</span>
                      <span className="hidden lg:inline">Regularidade</span>
                      {!isPro && (
                        <span className="rounded bg-amber-500/20 px-1 py-0.5 font-mono text-[8px] font-black text-[var(--ps-amber)]">
                          PRO
                        </span>
                      )}
                    </span>
                    {activeTab === 'navegacao' && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#E10600]"
                      />
                    )}
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
                    className={`relative overflow-hidden min-w-0 flex-1 lg:flex-none inline-flex min-h-[48px] flex-col lg:min-h-[42px] lg:flex-row items-center justify-center gap-1 lg:gap-2 rounded-xl border px-1.5 py-1 sm:px-3.5 lg:px-4 text-[11px] sm:text-xs font-bold tracking-wide transition-colors duration-75 active:scale-[0.98] whitespace-nowrap ${
                      activeTab === 'velocidade'
                        ? 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                        : 'border-transparent text-[var(--ps-muted)] hover:border-[var(--ps-border)] hover:bg-[var(--ps-surface)]/70 hover:text-[var(--ps-text)]'
                    }`}
                  >
                    <TopNavIcon kind="velocity" active={activeTab === 'velocidade'} />
                    <span className="truncate leading-none lg:hidden">Veloc.</span>
                    <span className="hidden lg:inline">Velocidade</span>
                    {activeTab === 'velocidade' && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#E10600]"
                      />
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setActiveTab('calculadora')}
                  aria-label="Calculadora"
                  title="Calculadora"
                  className={`relative overflow-hidden min-w-0 flex-1 lg:flex-none inline-flex min-h-[48px] flex-col lg:min-h-[42px] lg:flex-row items-center justify-center gap-1 lg:gap-2 rounded-xl border px-1.5 py-1 sm:px-3.5 lg:px-4 text-[11px] sm:text-xs font-bold tracking-wide transition-colors duration-75 active:scale-[0.98] whitespace-nowrap ${
                    activeTab === 'calculadora'
                      ? 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                      : 'border-transparent text-[var(--ps-muted)] hover:border-[var(--ps-border)] hover:bg-[var(--ps-surface)]/70 hover:text-[var(--ps-text)]'
                  }`}
                >
                  <TopNavIcon kind="calc" active={activeTab === 'calculadora'} />
                  <span className="truncate leading-none lg:hidden">Calc.</span>
                  <span className="hidden lg:inline">Calculadora</span>
                  {activeTab === 'calculadora' && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#E10600]"
                    />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => openSettingsSection('hub')}
                  aria-label="Configurações"
                  title="Configurações"
                  className={`relative overflow-hidden min-w-0 flex-1 lg:flex-none inline-flex min-h-[48px] flex-col lg:min-h-[42px] lg:flex-row items-center justify-center gap-1 lg:gap-2 rounded-xl border px-1.5 py-1 sm:px-3.5 lg:px-4 text-[11px] sm:text-xs font-bold tracking-wide transition-colors duration-75 active:scale-[0.98] whitespace-nowrap ${
                    activeTab === 'configuracoes'
                      ? 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                      : 'border-transparent text-[var(--ps-muted)] hover:border-[var(--ps-border)] hover:bg-[var(--ps-surface)]/70 hover:text-[var(--ps-text)]'
                  }`}
                >
                  <TopNavIcon kind="settings" active={activeTab === 'configuracoes'} />
                  <span className="truncate leading-none lg:hidden">Config.</span>
                  <span className="hidden lg:inline">Configurações</span>
                  {activeTab === 'configuracoes' && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-[#E10600]"
                    />
                  )}
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
            <OfflineIndicator />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main
        className={
          isHomeFullCanvas
            ? 'flex w-full flex-1 min-h-0 flex-col overflow-hidden p-0'
            : 'mx-auto w-full max-w-7xl flex-1 px-2.5 pt-2.5 pb-4 sm:px-6 sm:pt-5 lg:px-8'
        }
      >
        {publicResultSlug ? (
          <Suspense
            fallback={
              <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-6 text-center text-xs text-[var(--ps-muted)]">
                Carregando resultado...
              </div>
            }
          >
            <PublicStandingsView slug={publicResultSlug} />
          </Suspense>
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
            <div
              className={
                activeTab === 'inicial'
                  ? 'flex flex-1 min-h-0 flex-col overflow-hidden'
                  : 'hidden'
              }
            >
              <InitialStatusTab />
            </div>
            <Suspense
              fallback={
                <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-6 text-center text-xs text-[var(--ps-muted)]">
                  Carregando módulo...
                </div>
              }
            >
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
                    rallyMode={rallyMode}
                    onSelectRallyMode={updateRallyMode}
                    onOpenNavigation={() => {
                      if (!isPro) {
                        openProUpgradeModal(
                          'Navegação de Regularidade Completa',
                          'Disponível para contas com Plano PRO ativo.'
                        );
                        return;
                      }
                      updateRallyMode('regularidade');
                      setActiveTab('navegacao');
                    }}
                    onOpenApuracao={!isCompetitorEnv ? openApuracaoPortal : undefined}
                    deviceLicense={deviceLicense}
                    checkingDeviceLicense={checkingDeviceLicense}
                    onRecheckDeviceLicense={() => {
                      void runDeviceLicenseCheck();
                    }}
                  />
                </div>
              )}
            </Suspense>
          </>
        )}
      </main>

      {!isHomeFullCanvas && (
        <footer className="mx-auto w-full max-w-7xl px-4 pb-safe pt-2 text-center">
          <p
            onClick={handleFooterSecretTap}
            className="inline-block cursor-default select-none text-[11px] tracking-wide text-[var(--ps-muted)]"
          >
            Desenvolvido por Márlon Zill · PitStop-Sports
          </p>
        </footer>
      )}

      <AdminSecretLoginModal
        open={adminModalOpen}
        onClose={() => setAdminModalOpen(false)}
        onSuccess={() => {
          setAdminModalOpen(false);
          void runDeviceLicenseCheck();
          openSettingsSection('system');
        }}
      />

      {/* Modal de Solicitação / Upgrade para Plano PRO */}
      {ENABLE_SUBSCRIPTION_GATE && proModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pro-modal-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-5 text-[var(--ps-text)] shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/15 text-amber-400">
                  <Crown className="h-5 w-5" />
                </div>
                <div>
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] font-black tracking-widest text-amber-400 uppercase">
                    <Lock className="h-3 w-3" />
                    <span>Recurso Exclusivo PRO</span>
                  </span>
                  <h2
                    id="pro-modal-title"
                    className="font-['Barlow_Condensed'] text-xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase leading-tight"
                  >
                    {proModal.featureName}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProModal(null)}
                aria-label="Fechar aviso PRO"
                className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1.5 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {proModal.description && (
              <p className="text-xs leading-relaxed text-[var(--ps-muted)]">
                {proModal.description}
              </p>
            )}

            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-xs space-y-1.5">
              <p className="font-bold text-[var(--ps-text)]">
                {user
                  ? `Conta atual: ${user.email} (Plano FREE)`
                  : 'Você está usando o modo visitante (Plano FREE).'}
              </p>
              <p className="text-[11px] text-[var(--ps-muted)]">
                No Plano FREE você tem Calculadora, Odômetro/Velocímetro básico, Levantamento básico e 2 Temas. Faça login ou solicite a liberação PRO na sua conta.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  setProModal(null);
                  openSettingsSection('system');
                }}
                className="pitstop-btn-red flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold tracking-wider uppercase"
              >
                <Crown className="h-4 w-4" />
                <span>{user ? 'Gerenciar Assinatura PRO' : 'Entrar / Ativar PRO'}</span>
              </button>
              <button
                type="button"
                onClick={() => setProModal(null)}
                className="pitstop-btn-metal min-h-[44px] rounded-xl px-4 text-xs font-bold"
              >
                Continuar no FREE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
