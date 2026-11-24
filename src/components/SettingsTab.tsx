import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Share } from '@capacitor/share';
import {
  ArrowLeft,
  Battery,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Bell,
  Bluetooth,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Compass,
  Copy,
  Crown,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileSearch,
  FileText,
  Flag,
  HardDrive,
  Keyboard,
  Link2,
  Lock,
  Navigation,
  Radio,
  RefreshCw,
  RotateCcw,
  Route,
  Ruler,
  Satellite,
  Server,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  UploadCloud,
  Volume2,
  Wifi,
} from 'lucide-react';
import { VelocityCockpitLayoutEditor } from './VelocityCockpitLayoutEditor';
import type { SettingsSubMenu } from '../App';
import type { ParsedRoadbook, RallyMode } from '../types/rally';
import {
  checkBaseServerHealth,
  getPendingSubmissions,
  submitCollectorResultToBase,
  type PendingSubmissionPayload,
} from '../utils/baseApi';
import {
  type AlertStyle,
  APP_THEME_OPTIONS,
  calibrationPctFromWValue,
  getDefaultNavSettings,
  getDefaultPilotDisplay,
  getDefaultShortcuts,
  type HighlightTheme,
  type PitStopNavSettings,
  type ScreenOrientationLock,
  type ShortcutBindings,
  useNavSettings,
  wValueFromCalibrationPct,
} from '../utils/navSettings';
import {
  type BondedBluetoothDevice,
  connectPairingRoom,
  generatePairingRoomCode,
  generatePairingRoomPin,
  isNativeBluetoothSppAvailable,
  listBondedBluetoothDevices,
  normalizeRoomCode,
  normalizeRoomPin,
  type PairingPresenceState,
  type PairingTransportMode,
  playPairingBell,
} from '../utils/pairingClient';
import {
  checkAllPermissionsStatus,
  requestMissingPermissions,
  type AppPermissionsSnapshot,
} from '../utils/permissionsBootstrap';
import {
  extractRoadbookDiagnosticDataTxt,
  inspectRoadbookFileStructure,
  parseNavigationBuffer,
  type ImportFormatHint,
} from '../utils/roadbookFormats';
import {
  deleteSavedRoadbook,
  getLastActiveRoadbookId,
  listSavedRoadbooks,
  saveConvertedRoadbook,
  setLastActiveRoadbookId,
} from '../utils/roadbookStorage';
import {
  loadVelocityDatabase,
  persistVelocityRuns,
  persistVelocityTracks,
} from '../utils/velocityStorage';
import type { VelocityTrack } from '../utils/velocityEngine';
import {
  ENABLE_SUBSCRIPTION_GATE,
  isThemeUnlockedForPlan,
  openProUpgradeModal,
  useAuthSession,
} from '../utils/authSubscription';
import { AccountSubscriptionPanel } from './AccountSubscriptionPanel';
import { CompetitorCollector } from './CompetitorCollector';
import { GoProBlePanel } from './GoProBlePanel';
import { SettingsWireframeArt } from './SettingsWireframeArt';

interface SettingsTabProps {
  initialMenu?: SettingsSubMenu;
  onMenuChange?: (menu: SettingsSubMenu) => void;
  rallyMode?: RallyMode;
  onSelectRallyMode?: (mode: RallyMode) => void;
  onOpenNavigation?: () => void;
  onOpenApuracao?: () => void;
}

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
  bluetooth?: {
    requestDevice: (opts: { acceptAllDevices?: boolean; optionalServices?: string[] }) => Promise<{
      name?: string;
      id?: string;
    }>;
  };
}


const IMPORT_FORMAT_OPTIONS: {
  id: ImportFormatHint;
  label: string;
  ext: string;
  hint: string;
}[] = [
  {
    id: 'nbp',
    label: 'Digitais NBP (T15)',
    ext: '.NBP',
    hint: 'Formato padrão T15 Planilha / T15Nav (ZIP, XML, SQLite ou delimitado).',
  },
  {
    id: 'txt',
    label: 'Planilha Aberta',
    ext: '.TXT / .CSV / .XML',
    hint: 'Compatibilidade aberta para planilhas exportadas em texto.',
  },
];

function getGpsQuality(accuracyM: number | null): {
  bars: number;
  label: string;
  toneClass: string;
  barClass: string;
} {
  if (accuracyM === null) {
    return { bars: 0, label: 'Aguardando', toneClass: 'text-[#B5B5B5]', barClass: 'bg-zinc-700' };
  }
  if (accuracyM <= 5) {
    return { bars: 5, label: 'Excelente', toneClass: 'text-emerald-400', barClass: 'bg-emerald-400' };
  }
  if (accuracyM <= 10) {
    return { bars: 4, label: 'Ótimo', toneClass: 'text-emerald-400', barClass: 'bg-emerald-400' };
  }
  if (accuracyM <= 20) {
    return { bars: 3, label: 'Bom', toneClass: 'text-amber-400', barClass: 'bg-amber-400' };
  }
  if (accuracyM <= 40) {
    return { bars: 2, label: 'Fraco', toneClass: 'text-[#C0C4C9]', barClass: 'bg-[#C0C4C9]' };
  }
  return { bars: 1, label: 'Instável', toneClass: 'text-[#FF2A2A]', barClass: 'bg-[#E10600]' };
}

function formatClockOnly(tsMs: number): string {
  const d = new Date(tsMs);
  return [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function formatKeyLabel(key: string): string {
  if (!key) return 'Não definido';
  if (key === ' ') return 'Espaço';
  if (key === 'ArrowUp') return 'Seta ↑ / Vol+';
  if (key === 'ArrowDown') return 'Seta ↓ / Vol-';
  if (key === 'ArrowRight') return 'Seta →';
  if (key === 'ArrowLeft') return 'Seta ←';
  return key.length === 1 ? key.toUpperCase() : key;
}

function testAlertSound(style: AlertStyle) {
  if (style === 'vibration') {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([140, 60, 140]);
    }
    return;
  }
  if (style === 'voice') {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance('Cinquenta metros, referência a seguir.');
        u.lang = 'pt-BR';
        u.rate = 1.12;
        window.speechSynthesis.speak(u);
      } catch {
        // Ignore TTS blocks
      }
    }
    return;
  }
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = style === 'beep_long' ? 880 : 1040;
    gain.gain.value = 0.16;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const durSec = style === 'beep_long' ? 0.34 : 0.09;
    osc.start();
    osc.stop(ctx.currentTime + durSec);
    window.setTimeout(() => ctx.close().catch(() => {}), 500);
  } catch {
    // Ignore audio context restriction
  }
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  initialMenu = 'hub',
  onMenuChange,
  rallyMode = 'regularidade',
  onSelectRallyMode,
  onOpenNavigation,
  onOpenApuracao,
}) => {
  const [settings, updateSettings] = useNavSettings();
  const { user, isPro, isAdmin } = useAuthSession();
  const [activeMenu, setActiveMenu] = useState<SettingsSubMenu>(initialMenu);

  useEffect(() => {
    setActiveMenu(initialMenu);
  }, [initialMenu]);

  const navigateMenu = (menu: SettingsSubMenu) => {
    setActiveMenu(menu);
    onMenuChange?.(menu);
  };

  // Roadbooks management state
  const [savedRoadbooks, setSavedRoadbooks] = useState<ParsedRoadbook[]>([]);
  const [activeRoadbookId, setActiveRoadbookId] = useState<string | null>(() =>
    getLastActiveRoadbookId()
  );
  const [importFormat, setImportFormat] = useState<ImportFormatHint>('nbp');
  const [rbError, setRbError] = useState<string | null>(null);
  const [rbSuccess, setRbSuccess] = useState<string | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [fileStructureReport, setFileStructureReport] = useState<string | null>(null);
  const [diagnosticTxtData, setDiagnosticTxtData] = useState<{
    fileName: string;
    content: string;
  } | null>(null);
  const [showStructureReport, setShowStructureReport] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  // Backup & Offline storage summary state
  const [velocityStats, setVelocityStats] = useState<{ tracksCount: number; runsCount: number }>({
    tracksCount: 0,
    runsCount: 0,
  });
  const [backupFeedback, setBackupFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmResetDefaults, setConfirmResetDefaults] = useState(false);

  const refreshSavedRoadbooks = useCallback(async () => {
    const [list, velDb] = await Promise.all([
      listSavedRoadbooks(),
      loadVelocityDatabase().catch(() => ({ tracks: [], runs: [] })),
    ]);
    setSavedRoadbooks(list);
    setActiveRoadbookId(getLastActiveRoadbookId());
    setVelocityStats({
      tracksCount: velDb.tracks.length,
      runsCount: velDb.runs.length,
    });
  }, []);

  useEffect(() => {
    refreshSavedRoadbooks();
  }, [refreshSavedRoadbooks]);

  const handleActivateRoadbook = (rb: ParsedRoadbook, goNav = false) => {
    if (rb.id) {
      setLastActiveRoadbookId(rb.id);
      setActiveRoadbookId(rb.id);
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: rb.id }));
      setRbSuccess(`Planilha "${rb.eventName}" ativada para regularidade.`);
      if (goNav) {
        onOpenNavigation?.();
      }
    }
  };

  const handleRoadbookFile = async (file: File) => {
    setRbError(null);
    setRbSuccess(null);
    setCopiedReport(false);
    try {
      const buffer = await file.arrayBuffer();
      const [report, txtSample, parsed] = await Promise.all([
        inspectRoadbookFileStructure(buffer, file.name).catch(() => null),
        extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
        parseNavigationBuffer(buffer, file.name, importFormat),
      ]);
      if (report) setFileStructureReport(report);
      if (txtSample) {
        const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
        setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
      }
      const stored = await saveConvertedRoadbook(parsed);
      await refreshSavedRoadbooks();
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: stored.id }));
      setRbSuccess(
        `"${stored.eventName}" importada (${stored.tulipas.length} refs · ${stored.totalKm.toFixed(2)} km) e definida como ativa.`
      );
      if ((stored.raceParameters?.notesCount ?? 0) === 0 || stored.totalKm < 0.5) {
        setShowStructureReport(true);
      }
    } catch (err) {
      try {
        const buffer = await file.arrayBuffer();
        const [report, txtSample] = await Promise.all([
          inspectRoadbookFileStructure(buffer, file.name),
          extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
        ]);
        setFileStructureReport(report);
        if (txtSample) {
          const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
          setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
        }
        setShowStructureReport(true);
      } catch {
        // Ignore diagnostic fallback error
      }
      setRbError(
        err instanceof Error
          ? err.message
          : 'Não foi possível ler o arquivo da planilha.'
      );
    }
  };

  const handleInspectFileOnly = async (file: File) => {
    setCopiedReport(false);
    try {
      const buffer = await file.arrayBuffer();
      const [report, txtSample] = await Promise.all([
        inspectRoadbookFileStructure(buffer, file.name),
        extractRoadbookDiagnosticDataTxt(buffer, file.name).catch(() => null),
      ]);
      setFileStructureReport(report);
      if (txtSample) {
        const cleanStem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
        setDiagnosticTxtData({ fileName: `dados_${cleanStem}.txt`, content: txtSample });
      }
      setShowStructureReport(true);
    } catch {
      setFileStructureReport(`Não foi possível inspecionar "${file.name}".`);
      setDiagnosticTxtData(null);
      setShowStructureReport(true);
    }
  };

  const handleLoadSample = async () => {
    setRbError(null);
    setRbSuccess(null);
    setLoadingSample(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}assets/aistudio/rally_escoteiros_merged_66a34567.txt`);
      if (!res.ok) throw new Error('Planilha modelo não encontrada.');
      const buffer = await res.arrayBuffer();
      const parsed = await parseNavigationBuffer(buffer, 'rally_escoteiros_merged.txt');
      const stored = await saveConvertedRoadbook(parsed);
      await refreshSavedRoadbooks();
      window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: stored.id }));
      setRbSuccess(`Planilha modelo "${stored.eventName}" carregada e ativada.`);
    } catch (err) {
      setRbError(err instanceof Error ? err.message : 'Erro ao carregar modelo.');
    } finally {
      setLoadingSample(false);
    }
  };

  const handleDeleteSaved = async (id: string) => {
    await deleteSavedRoadbook(id);
    await refreshSavedRoadbooks();
    window.dispatchEvent(new CustomEvent('pitstop:roadbook-activated', { detail: getLastActiveRoadbookId() }));
  };

  const handleCopyStructureReport = async () => {
    if (!fileStructureReport) return;
    try {
      await navigator.clipboard.writeText(fileStructureReport);
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleDownloadDiagnosticTxt = async () => {
    const content = diagnosticTxtData?.content || fileStructureReport;
    if (!content) return;
    const outName = diagnosticTxtData?.fileName || 'diagnostico_nbp.txt';
    if (Capacitor.isNativePlatform()) {
      try {
        const written = await Filesystem.writeFile({
          path: outName,
          data: content,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: outName,
          text: 'Diagnóstico da planilha .NBP/.ZIP para mapeamento',
          url: written.uri,
        });
        return;
      } catch {
        // Fallback to web download
      }
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // GPS & Battery state
  const [gps, setGps] = useState<{
    status: 'searching' | 'active' | 'denied' | 'error';
    accuracyM: number | null;
    lat: number | null;
    lon: number | null;
    updatedAtMs: number | null;
    message?: string;
  }>({
    status: 'searching',
    accuracyM: null,
    lat: null,
    lon: null,
    updatedAtMs: null,
  });
  const [refreshingGps, setRefreshingGps] = useState(false);

  const [battery, setBattery] = useState<{
    supported: boolean;
    levelPct: number | null;
    charging: boolean;
  }>({
    supported: true,
    levelPct: null,
    charging: false,
  });

  // W Fino direct edit & pass calculator state
  const [editingW, setEditingW] = useState(false);
  const [wInputText, setWInputText] = useState('');
  const [passOfficialM, setPassOfficialM] = useState('1000');
  const [passMeasuredM, setPassMeasuredM] = useState('');

  // Cantada thresholds
  const [thresholdsInput, setThresholdsInput] = useState(() =>
    settings.voiceThresholds.join(', ')
  );

  // Hotkey capture state
  const [capturingShortcut, setCapturingShortcut] = useState<keyof ShortcutBindings | null>(null);

  // Real-time pairing + Bluetooth + Wake Lock state
  const [pairingPresence, setPairingPresence] = useState<PairingPresenceState>({
    status: 'disconnected',
    navigators: 0,
    pilots: 0,
    transport: 'none',
  });
  const [btStatusMsg, setBtStatusMsg] = useState<string | null>(null);
  const [bondedBtList, setBondedBtList] = useState<BondedBluetoothDevice[]>([]);
  const [loadingBtList, setLoadingBtList] = useState(false);
  const [copiedPilotLink, setCopiedPilotLink] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockSentinelRef = useRef<{ release: () => Promise<void> } | null>(null);

  // Clock & Base server state
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [clockSyncFeedback, setClockSyncFeedback] = useState<string | null>(null);
  const [clockMode, setClockMode] = useState<'auto' | 'manual'>(() =>
    settings.clockOffsetMs !== 0 ? 'manual' : 'auto'
  );
  const [manualTimeInput, setManualTimeInput] = useState(() =>
    formatClockOnly(Date.now() + settings.clockOffsetMs)
  );
  const [permSnapshot, setPermSnapshot] = useState<AppPermissionsSnapshot | null>(null);
  const [requestingPerms, setRequestingPerms] = useState(false);

  const [healthState, setHealthState] = useState<{
    checking: boolean;
    ok?: boolean;
    message?: string;
  }>({ checking: false });
  const [pendingQueue, setPendingQueue] = useState<PendingSubmissionPayload[]>(() =>
    getPendingSubmissions()
  );
  const [retryingQueue, setRetryingQueue] = useState(false);

  useEffect(() => {
    setThresholdsInput(settings.voiceThresholds.join(', '));
  }, [settings.voiceThresholds]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    checkAllPermissionsStatus()
      .then(setPermSnapshot)
      .catch(() => {});
  }, []);

  // Battery Monitor
  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') {
      setBattery({ supported: false, levelPct: null, charging: false });
      return;
    }
    let mounted = true;
    let manager: BatteryManagerLike | null = null;
    const syncBattery = () => {
      if (!mounted || !manager) return;
      setBattery({
        supported: true,
        levelPct: Math.round(manager.level * 100),
        charging: manager.charging,
      });
    };
    nav
      .getBattery()
      .then((bm) => {
        if (!mounted) return;
        manager = bm;
        syncBattery();
        bm.addEventListener('levelchange', syncBattery);
        bm.addEventListener('chargingchange', syncBattery);
      })
      .catch(() => {
        if (mounted) setBattery({ supported: false, levelPct: null, charging: false });
      });
    return () => {
      mounted = false;
      if (manager) {
        manager.removeEventListener('levelchange', syncBattery);
        manager.removeEventListener('chargingchange', syncBattery);
      }
    };
  }, []);

  // Live GPS Telemetry Monitor
  const readSingleGpsFix = useCallback(async () => {
    setRefreshingGps(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
          setGps((prev) => ({
            ...prev,
            status: 'denied',
            message: 'Permissão de localização negada no Android.',
          }));
          return;
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10000,
        });
        setGps({
          status: 'active',
          accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          updatedAtMs: pos.timestamp || Date.now(),
        });
      } else if ('geolocation' in navigator) {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              setGps({
                status: 'active',
                accuracyM: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                updatedAtMs: pos.timestamp || Date.now(),
              });
              resolve();
            },
            (err) => {
              setGps((prev) => ({
                ...prev,
                status: err.code === 1 ? 'denied' : 'error',
                message:
                  err.code === 1
                    ? 'Permissão de localização bloqueada no navegador.'
                    : 'Sinal GPS indisponível em ambiente fechado.',
              }));
              resolve();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 1500 }
          );
        });
      }
    } finally {
      setRefreshingGps(false);
    }
  }, []);

  useEffect(() => {
    readSingleGpsFix();
  }, [readSingleGpsFix]);

  // Live Pairing Connection Monitor when pairing enabled
  useEffect(() => {
    if (!settings.pairing.enabled || !settings.pairing.roomCode) {
      setPairingPresence({
        status: 'disconnected',
        navigators: 0,
        pilots: 0,
        transport: 'none',
      });
      return;
    }
    const conn = connectPairingRoom({
      roomCode: settings.pairing.roomCode,
      roomPin: settings.pairing.roomPin,
      role: settings.pairing.role,
      transportMode: settings.pairing.transportMode,
      bluetoothDevices: settings.pairing.bluetoothDevices,
      onTelemetry: () => {},
      onPresence: (p) => setPairingPresence(p),
    });
    return () => conn.close();
  }, [
    settings.pairing.enabled,
    settings.pairing.role,
    settings.pairing.roomCode,
    settings.pairing.roomPin,
    settings.pairing.transportMode,
    settings.pairing.bluetoothDevices,
  ]);

  // Global key listener when capturing a shortcut binding
  useEffect(() => {
    if (!capturingShortcut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturingShortcut(null);
        return;
      }
      updateSettings((prev) => ({
        ...prev,
        shortcuts: {
          ...prev.shortcuts,
          [capturingShortcut]: e.key,
        },
      }));
      setCapturingShortcut(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingShortcut, updateSettings]);

  const handleSelectBluetoothDevice = async () => {
    setBtStatusMsg(null);
    if (isNativeBluetoothSppAvailable()) {
      setLoadingBtList(true);
      try {
        const devices = await listBondedBluetoothDevices();
        setBondedBtList(devices);
        if (devices.length === 0) {
          setBtStatusMsg('Nenhum celular pareado. Pareie o Piloto nos Ajustes > Bluetooth do Android.');
        } else {
          setBtStatusMsg(`${devices.length} aparelho(s) encontrado(s). Toque para selecionar até 3 Pilotos.`);
        }
      } catch (err) {
        setBtStatusMsg(
          err instanceof Error ? err.message : 'Erro ao listar dispositivos Bluetooth.'
        );
      } finally {
        setLoadingBtList(false);
      }
      return;
    }

    const nav = navigator as NavigatorWithBattery;
    if (nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function') {
      try {
        const device = await nav.bluetooth.requestDevice({ acceptAllDevices: true });
        const devName = device.name || device.id || 'Dispositivo Bluetooth';
        updateSettings({
          pairing: { ...settings.pairing, bluetoothDeviceName: devName },
        });
        setBtStatusMsg(`Dispositivo selecionado: ${devName}.`);
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFoundError') {
          setBtStatusMsg('Seleção cancelada.');
          return;
        }
      }
    }
    setBtStatusMsg('Na Web, use Hotspot Wi-Fi ou o link ?piloto=SALA para conectar.');
  };

  const handleToggleBondedBtDevice = (dev: BondedBluetoothDevice) => {
    const current = settings.pairing.bluetoothDevices || [];
    const exists = current.some((d) => d.address === dev.address);
    const next = exists
      ? current.filter((d) => d.address !== dev.address)
      : [...current, dev].slice(-3);
    updateSettings({
      pairing: {
        ...settings.pairing,
        bluetoothDevices: next,
        bluetoothDeviceName: next.map((d) => d.name).join(', '),
      },
    });
  };

  const handleCopyPilotLink = async () => {
    if (typeof window === 'undefined') return;
    const room = normalizeRoomCode(settings.pairing.roomCode) || 'PS-4821';
    const pin = normalizeRoomPin(settings.pairing.roomPin || '');
    const pinSuffix = pin ? `&pin=${encodeURIComponent(pin)}` : '';
    const url = `${window.location.origin}/?piloto=${encodeURIComponent(room)}${pinSuffix}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPilotLink(true);
      window.setTimeout(() => setCopiedPilotLink(false), 2000);
    } catch {
      setBtStatusMsg(`Link do Piloto: ${url}`);
    }
  };

  const handleOpenPilotDisplay = () => {
    updateSettings({
      pairing: {
        ...settings.pairing,
        enabled: true,
        role: 'pilot',
      },
    });
    playPairingBell();
    onOpenNavigation?.();
  };

  const handleToggleWakeLock = async () => {
    const nav = navigator as NavigatorWithBattery;
    if (wakeLockActive && wakeLockSentinelRef.current) {
      await wakeLockSentinelRef.current.release().catch(() => {});
      wakeLockSentinelRef.current = null;
      setWakeLockActive(false);
      return;
    }
    if (nav.wakeLock && typeof nav.wakeLock.request === 'function') {
      try {
        const sentinel = await nav.wakeLock.request('screen');
        wakeLockSentinelRef.current = sentinel;
        setWakeLockActive(true);
        sentinel.addEventListener('release', () => setWakeLockActive(false));
        return;
      } catch {
        // Ignore unsupported wake lock
      }
    }
    setWakeLockActive((v) => !v);
  };

  const activeW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
  const gpsQuality = getGpsQuality(gps.accuracyM);

  const handleOpenWEditor = () => {
    setWInputText(
      settings.sensorMode === 'blue' ? String(activeW) : settings.calibrationPct.toFixed(2)
    );
    setEditingW(true);
  };

  const handleCommitWEditor = () => {
    const cleaned = Number(wInputText.replace(',', '.').trim());
    if (Number.isFinite(cleaned) && cleaned > 0) {
      if (settings.sensorMode === 'blue') {
        updateSettings({
          calibrationPct: calibrationPctFromWValue(cleaned, settings.wBaseValue),
        });
      } else {
        updateSettings({
          calibrationPct: Number(Math.min(130, Math.max(70, cleaned)).toFixed(2)),
        });
      }
    }
    setEditingW(false);
  };

  const handleAdjustCalPct = (delta: number) => {
    const next = Math.min(130, Math.max(70, Number((settings.calibrationPct + delta).toFixed(2))));
    updateSettings({ calibrationPct: next });
  };

  const handleAddCalibrationPass = () => {
    const offM = Number(passOfficialM.replace(',', '.'));
    const measM = Number(passMeasuredM.replace(',', '.'));
    if (!Number.isFinite(offM) || offM <= 0 || !Number.isFinite(measM) || measM <= 0) return;

    const currentW = wValueFromCalibrationPct(settings.calibrationPct, settings.wBaseValue);
    const suggestedW = Math.round(currentW * (offM / measM));
    const entry = {
      id: `p_${Date.now()}`,
      officialM: offM,
      measuredM: measM,
      suggestedW,
    };
    updateSettings((prev) => ({
      ...prev,
      wPasses: [...prev.wPasses, entry].slice(-3),
    }));
    setPassMeasuredM('');
  };

  const averageCalibrationSuggestion = useMemo(() => {
    if (settings.wPasses.length === 0) return null;
    const totalOff = settings.wPasses.reduce((acc, p) => acc + p.officialM, 0);
    const totalMeas = settings.wPasses.reduce((acc, p) => acc + p.measuredM, 0);
    const avgW = Math.round(
      settings.wPasses.reduce((acc, p) => acc + p.suggestedW, 0) / settings.wPasses.length
    );
    const avgPct = calibrationPctFromWValue(avgW, settings.wBaseValue);
    const errorMPerKm = totalOff > 0 ? ((totalMeas - totalOff) / totalOff) * 1000 : 0;
    return { avgW, avgPct, errorMPerKm };
  }, [settings.wPasses, settings.wBaseValue]);

  const handleApplyAverageW = () => {
    if (!averageCalibrationSuggestion) return;
    updateSettings({ calibrationPct: averageCalibrationSuggestion.avgPct });
  };

  const handleSyncGpsClock = () => {
    setClockMode('auto');
    setClockSyncFeedback('Buscando pulso de relógio GPS...');
    if (!('geolocation' in navigator)) {
      updateSettings({ clockOffsetMs: 0 });
      setClockSyncFeedback('Hora automática do sistema aplicada.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const gpsTs = pos.timestamp || Date.now();
        const offset = gpsTs - Date.now();
        updateSettings({ clockOffsetMs: offset });
        setManualTimeInput(formatClockOnly(Date.now() + offset));
        setClockSyncFeedback(
          `Relógio sincronizado automaticamente (${offset >= 0 ? '+' : ''}${Math.round(offset)} ms)`
        );
      },
      () => {
        updateSettings({ clockOffsetMs: 0 });
        setManualTimeInput(formatClockOnly(Date.now()));
        setClockSyncFeedback('Sincronizado com hora automática do aparelho.');
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
    );
  };

  const handleApplyManualClock = (hhmmss: string) => {
    const parts = hhmmss.split(':').map((n) => parseInt(n, 10));
    if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) {
      setClockSyncFeedback('Informe a hora no formato HH:MM:SS.');
      return;
    }
    const [h, m, s = 0] = parts;
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) {
      setClockSyncFeedback('Hora inválida. Use entre 00:00:00 e 23:59:59.');
      return;
    }
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, 0);
    const offset = target.getTime() - now.getTime();
    setClockMode('manual');
    updateSettings({ clockOffsetMs: offset });
    setClockSyncFeedback(`Hora manual ajustada para ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.`);
  };

  const handleAdjustClockDeltaMs = (deltaMs: number) => {
    const nextOffset = settings.clockOffsetMs + deltaMs;
    setClockMode('manual');
    updateSettings({ clockOffsetMs: nextOffset });
    setManualTimeInput(formatClockOnly(Date.now() + nextOffset));
    setClockSyncFeedback(
      `Ajuste manual: ${nextOffset >= 0 ? '+' : ''}${(nextOffset / 1000).toFixed(1)}s em relação ao aparelho.`
    );
  };

  const handleRequestDevicePermissions = async () => {
    setRequestingPerms(true);
    try {
      const snap = await requestMissingPermissions({ includeMicrophonePrompt: true });
      setPermSnapshot(snap);
    } finally {
      setRequestingPerms(false);
    }
  };

  const handleCommitThresholds = (rawText: string) => {
    const parsed = rawText
      .split(/[,;\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b - a);
    if (parsed.length > 0) {
      updateSettings({ voiceThresholds: parsed });
    }
  };

  const handleTestBaseConnection = async () => {
    setHealthState({ checking: true });
    const res = await checkBaseServerHealth();
    if (res.ok) {
      setHealthState({
        checking: false,
        ok: true,
        message: `Base conectada (${res.submissionsCount ?? 0} coletas recebidas).`,
      });
    } else {
      setHealthState({
        checking: false,
        ok: false,
        message: res.error || 'Base inacessível no momento.',
      });
    }
  };

  const handleRetryQueue = async () => {
    if (pendingQueue.length === 0) return;
    setRetryingQueue(true);
    try {
      for (const item of pendingQueue) {
        await submitCollectorResultToBase(item);
      }
      setPendingQueue(getPendingSubmissions());
    } finally {
      setRetryingQueue(false);
    }
  };

  const renderBatteryIcon = () => {
    if (battery.charging) return <BatteryCharging className="h-4 w-4 text-emerald-400" />;
    if (battery.levelPct === null) return <Battery className="h-4 w-4 text-[#C0C4C9]" />;
    if (battery.levelPct <= 15) return <BatteryWarning className="h-4 w-4 text-[#FF2A2A]" />;
    if (battery.levelPct <= 30) return <BatteryLow className="h-4 w-4 text-amber-400" />;
    if (battery.levelPct <= 70) return <BatteryMedium className="h-4 w-4 text-[#C0C4C9]" />;
    return <BatteryFull className="h-4 w-4 text-emerald-400" />;
  };

  const handleExportBackup = async () => {
    setBackupFeedback(null);
    try {
      const velDb = await loadVelocityDatabase();
      const payload = {
        app: 'PitStop-Sports',
        exportedAt: new Date().toISOString(),
        settings,
        velocityTracks: velDb.tracks,
        roadbookIds: savedRoadbooks.map((r) => ({ id: r.id, eventName: r.eventName, fileName: r.fileName })),
      };
      const json = JSON.stringify(payload, null, 2);
      const fileName = `pitstop_backup_${new Date().toISOString().slice(0, 10)}.json`;

      if (Capacitor.isNativePlatform()) {
        try {
          await Filesystem.writeFile({
            path: fileName,
            data: json,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
          });
          setBackupFeedback({
            ok: true,
            message: `Backup salvo na pasta Documentos como ${fileName}.`,
          });
          return;
        } catch {
          // Fall through to browser download
        }
      }

      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupFeedback({
        ok: true,
        message: `Backup exportado (${velDb.tracks.length} pista(s) e ajustes de navegação).`,
      });
    } catch {
      setBackupFeedback({ ok: false, message: 'Não foi possível gerar o backup.' });
    }
  };

  const handleImportBackup = async (file: File) => {
    setBackupFeedback(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        settings?: Partial<PitStopNavSettings>;
        velocityTracks?: VelocityTrack[];
      };
      let restoredParts = 0;
      if (parsed.settings && typeof parsed.settings === 'object') {
        updateSettings(parsed.settings);
        restoredParts += 1;
      }
      if (Array.isArray(parsed.velocityTracks)) {
        const existing = await loadVelocityDatabase();
        const existingIds = new Set(existing.tracks.map((t) => t.id));
        const merged = [
          ...existing.tracks,
          ...parsed.velocityTracks.filter((t) => t && t.id && !existingIds.has(t.id)),
        ];
        await persistVelocityTracks(merged);
        window.dispatchEvent(new CustomEvent('pitstop:velocity-db-updated'));
        restoredParts += 1;
      }
      await refreshSavedRoadbooks();
      if (restoredParts === 0) {
        throw new Error('Arquivo JSON sem ajustes ou pistas válidas.');
      }
      setBackupFeedback({
        ok: true,
        message: 'Backup restaurado com sucesso!',
      });
    } catch (err) {
      setBackupFeedback({
        ok: false,
        message: err instanceof Error ? err.message : 'Arquivo de backup inválido.',
      });
    }
  };

  const handleClearVelocityRuns = async () => {
    await persistVelocityRuns([]);
    window.dispatchEvent(new CustomEvent('pitstop:velocity-db-updated'));
    await refreshSavedRoadbooks();
    setBackupFeedback({
      ok: true,
      message: 'Histórico de passagens de velocidade limpo (pistas e marcos preservados).',
    });
  };

  const handleResetDefaultSettings = () => {
    const defaults = getDefaultNavSettings();
    updateSettings(defaults);
    setConfirmResetDefaults(false);
    setBackupFeedback({
      ok: true,
      message: 'Ajustes de navegação e aferição restaurados para o padrão.',
    });
  };

  const activeRoadbookItem = savedRoadbooks.find((r) => r.id === activeRoadbookId) ?? null;
  const pilotActiveCount = Object.values(settings.pilotDisplay).filter(Boolean).length;

  const activeThemeMeta =
    APP_THEME_OPTIONS.find((t) => t.id === settings.appTheme) ?? APP_THEME_OPTIONS[0];

  const menuTitleMap: Record<Exclude<SettingsSubMenu, 'hub'>, string> = {
    modality: 'Modalidade do Rally',
    account: 'Conta & Assinatura (FREE / PRO)',
    theme: 'Temas & Visual do Painel',
    collector: 'Coletor & Envio para Admin',
    roadbooks: 'Planilhas & Livros de Bordo',
    clock: 'Ajuste de Hora (Manual / Automática)',
    pairing: 'Pareamento Navegador ↔ Piloto',
    pilot: 'Tela do Piloto (Personalização)',
    calibration: 'Aferição do Hodômetro & W Fino',
    alerts: 'Alertas, Road Book & Atalhos',
    gopro: 'Câmeras GoPro (Bluetooth BLE)',
    backup: 'Backup & Dados Offline',
    system: 'Sistema, Tela, GPS & Permissões',
  };

  return (
    <div className="mx-auto max-w-4xl space-y-3 text-[var(--ps-text)]">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ps-border)] pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {activeMenu !== 'hub' && (
            <button
              type="button"
              onClick={() => navigateMenu('hub')}
              className="inline-flex min-h-[38px] shrink-0 items-center gap-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
            >
              <ArrowLeft className="h-4 w-4 text-[var(--ps-accent)]" />
              <span>Menus</span>
            </button>
          )}
          <div className="min-w-0">
            <p className="font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--ps-accent)] uppercase">
              Configurações
            </p>
            <h1 className="text-base font-extrabold tracking-widest text-[var(--ps-text)] uppercase">
              {activeMenu === 'hub' ? 'CENTRAL DE AJUSTES' : menuTitleMap[activeMenu]}
            </h1>
          </div>
        </div>
        <span className="shrink-0 font-mono text-xs font-semibold text-[var(--ps-muted)] tabular-nums">
          {formatClockOnly(nowMs + settings.clockOffsetMs)}
        </span>
      </div>

      {/* MENU HUB (Estilo FuelTech FT700: 2 colunas compactas, wireframe vibrante à esquerda, título à direita + LED inferior) */}
      {activeMenu === 'hub' && (
        <div className="grid grid-cols-2 gap-2">
          {[
            {
              id: 'modality' as const,
              accentColor: '#FF2A2A',
              title: 'MODALIDADE DO RALLY',
              subtitle:
                rallyMode === 'velocidade' ? 'Rally Velocidade' : 'Rally Regularidade',
            },
            {
              id: 'account' as const,
              accentColor: '#38BDF8',
              title: !ENABLE_SUBSCRIPTION_GATE ? 'CONTA & ASSINATURA' : 'CONTA & PRO',
              subtitle: !ENABLE_SUBSCRIPTION_GATE
                ? 'Recursos PRO liberados'
                : isAdmin
                  ? 'Admin / PRO'
                  : isPro
                    ? 'PRO Ativo'
                    : user
                      ? 'Plano FREE'
                      : 'Entrar / Plano',
              badge: !ENABLE_SUBSCRIPTION_GATE
                ? 'DESATIVADO / MODO DEV'
                : isAdmin
                  ? 'ADMIN'
                  : isPro
                    ? 'PRO'
                    : 'FREE',
            },
            {
              id: 'theme' as const,
              accentColor: '#00E5FF',
              title: 'TEMAS VISUAIS',
              subtitle: `${APP_THEME_OPTIONS.length} Visuais`,
              swatches: [
                activeThemeMeta.bg,
                activeThemeMeta.surface,
                activeThemeMeta.accent,
                activeThemeMeta.accent2,
              ],
            },
            {
              id: 'roadbooks' as const,
              accentColor: '#10B981',
              title: 'PLANILHAS',
              subtitle:
                savedRoadbooks.length > 0
                  ? `${savedRoadbooks.length} Livros de Bordo`
                  : 'Livros de Bordo',
            },
            {
              id: 'collector' as const,
              accentColor: '#F97316',
              title: 'COLETOR GPS',
              subtitle:
                pendingQueue.length > 0
                  ? `${pendingQueue.length} na fila`
                  : 'Envio Admin',
            },
            {
              id: 'clock' as const,
              accentColor: '#FBBF24',
              title: 'HORA & GPS',
              subtitle: 'Sinc. Oficial',
            },
            {
              id: 'pairing' as const,
              accentColor: '#0EA5E9',
              title: 'PAREAMENTO',
              subtitle: settings.pairing.enabled
                ? `Sala ${settings.pairing.roomCode}`
                : 'Piloto / Nav',
            },
            {
              id: 'pilot' as const,
              accentColor: '#A3E635',
              title: 'TELA PILOTO',
              subtitle: 'HUD & Layout',
            },
            {
              id: 'calibration' as const,
              accentColor: '#E10600',
              title: 'CALIBRAÇÃO',
              subtitle: 'Odômetro / Sensores',
            },
            {
              id: 'alerts' as const,
              accentColor: '#F59E0B',
              title: 'ALERTAS',
              subtitle: 'Bips & Limites',
            },
            {
              id: 'gopro' as const,
              accentColor: '#FF2A2A',
              title: 'GOPRO BLE',
              subtitle: 'Câmeras',
            },
            {
              id: 'backup' as const,
              accentColor: '#22C55E',
              title: 'BACKUP',
              subtitle: 'Exportar Dados',
            },
            {
              id: 'system' as const,
              accentColor: '#A855F7',
              title: 'SISTEMA',
              subtitle: 'Versão & Reset',
            },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateMenu(item.id)}
              className="group relative flex h-[76px] items-center justify-end overflow-hidden rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 py-2 text-right transition-all hover:border-[var(--ps-accent)] active:scale-[0.98]"
            >
              <SettingsWireframeArt menuId={item.id} color={item.accentColor} />

              <div className="relative z-10 flex min-w-0 max-w-[82%] flex-col items-end justify-center text-right">
                {'badge' in item && item.badge && (
                  <span
                    className={`mb-0.5 rounded px-1.5 py-0.5 font-mono text-[8px] font-black leading-none uppercase ${
                      item.badge === 'ADMIN'
                        ? 'bg-cyan-500/20 text-[var(--ps-accent)]'
                        : item.badge === 'PRO'
                          ? 'bg-emerald-500/20 text-[var(--ps-emerald)]'
                          : item.badge.includes('DEV')
                            ? 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-amber)]'
                            : 'bg-amber-500/20 text-[var(--ps-amber)]'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
                <span className="max-w-full truncate text-[11px] font-black tracking-wider text-[var(--ps-text)] uppercase leading-tight sm:text-xs">
                  {item.title}
                </span>

                <div className="mt-0.5 max-w-full truncate text-[10px] font-medium text-[var(--ps-muted)] leading-tight">
                  {item.subtitle}
                </div>

                {'swatches' in item && item.swatches && (
                  <div className="mt-1 flex items-center justify-end gap-1">
                    {item.swatches.map((hex, i) => (
                      <span
                        key={i}
                        className="h-2 w-2 rounded-full border border-[var(--ps-border-strong)]"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Barra de LED fina iluminada na base inferior */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
                style={{
                  backgroundColor: item.accentColor,
                  boxShadow: `0 0 8px ${item.accentColor}`,
                }}
              />
            </button>
          ))}
        </div>
      )}

      {/* SUBMENU: MODALIDADE DO RALLY */}
      {activeMenu === 'modality' && (
        <div className="space-y-3">
          <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Modalidade do Rally
                </h2>
                <p className="text-xs text-[var(--ps-muted)]">
                  Escolha a disciplina ativa. A aba correspondente na barra superior será atualizada imediatamente.
                </p>
              </div>
              <span className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-1.5 font-mono text-[11px] font-bold text-[var(--ps-accent)]">
                Ativa: {rallyMode === 'velocidade' ? 'Rally Velocidade' : 'Rally Regularidade'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                {
                  id: 'regularidade' as const,
                  title: 'Rally Regularidade',
                  tabLabel: 'Regul.',
                  description:
                    'Navegação por planilha (.NBP/.TXT), cálculos de TNAV/PMM, alertas de voz, hodômetro aferido e pareamento Droid Piloto.',
                  icon: Route,
                },
                {
                  id: 'velocidade' as const,
                  title: 'Rally Velocidade',
                  tabLabel: 'Veloc.',
                  description:
                    'Cronômetro de Especiais (SS), parciais ao vivo com Delta Time, Satcron, Datalogger de 3 voltas, mapa e GoPro BLE.',
                  icon: Flag,
                },
              ].map((option) => {
                const isSelected = rallyMode === option.id;
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onSelectRallyMode?.(option.id)}
                    className={`group relative flex flex-col justify-between gap-3 overflow-hidden rounded-2xl border p-4 text-left transition-all active:scale-[0.99] ${
                      isSelected
                        ? 'border-[var(--ps-accent)] ring-1 ring-[var(--ps-accent)]/50 bg-[var(--ps-card)]'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-[var(--ps-border-strong)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
                            isSelected
                              ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-accent)]'
                              : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)]'
                          }`}
                        >
                          <Icon className="h-5 w-5" />
                        </span>
                        <div>
                          <p className="font-['Barlow_Condensed'] text-lg font-black tracking-wide text-[var(--ps-text)] uppercase leading-tight">
                            {option.title}
                          </p>
                          <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                            Aba no topo: {option.tabLabel}
                          </p>
                        </div>
                      </div>
                      {isSelected && (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ps-accent)] text-[var(--ps-accent-text)]">
                          <Check className="h-3.5 w-3.5 stroke-[3]" />
                        </span>
                      )}
                    </div>

                    <p className="text-xs leading-relaxed text-[var(--ps-muted)]">
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* SUBMENU 00: CONTA & ASSINATURA + ADMIN */}
      {activeMenu === 'account' && <AccountSubscriptionPanel />}

      {/* SUBMENU 0: TEMAS & VISUAL DO PAINEL */}
      {activeMenu === 'theme' && (
        <div className="space-y-3">
          <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Escolha o Tema do Cockpit ({APP_THEME_OPTIONS.length} Modelos)
                </h2>
                <p className="text-xs text-[var(--ps-muted)]">
                  {!ENABLE_SUBSCRIPTION_GATE
                    ? `Modo Dev ativo: todos os ${APP_THEME_OPTIONS.length} temas visuais estão 100% liberados (inclui escala de fonte integrada nos temas XL).`
                    : isPro
                      ? `Plano PRO ativo: todos os ${APP_THEME_OPTIONS.length} temas visuais desbloqueados offline e online.`
                      : `Plano FREE: temas iniciais liberados. Ative o Plano PRO para liberar todos os ${APP_THEME_OPTIONS.length} temas visuais.`}
                </p>
              </div>
              <span className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] px-3 py-1.5 font-mono text-[11px] font-bold text-[var(--ps-accent)]">
                Ativo: {activeThemeMeta.name}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {APP_THEME_OPTIONS.map((themeOpt) => {
                const isActive =
                  settings.appTheme === themeOpt.id ||
                  (themeOpt.id === 'neo' && settings.appTheme === 'gt');
                const unlocked = isThemeUnlockedForPlan(themeOpt.id, isPro);
                return (
                  <button
                    key={themeOpt.id}
                    type="button"
                    onClick={() => {
                      if (!unlocked) {
                        openProUpgradeModal(
                          `Tema ${themeOpt.name}`,
                          'Ative o Plano PRO para usar todos os temas visuais disponíveis.'
                        );
                        return;
                      }
                      updateSettings({ appTheme: themeOpt.id });
                    }}
                    title={themeOpt.description}
                    className={`group relative flex flex-col justify-between gap-2 overflow-hidden rounded-xl border p-2.5 text-left transition-all active:scale-[0.98] ${
                      isActive
                        ? 'border-[var(--ps-accent)] ring-1 ring-[var(--ps-accent)]/50 bg-[var(--ps-card)]'
                        : unlocked
                          ? 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-[var(--ps-border-strong)]'
                          : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] opacity-80 hover:border-amber-500/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-['Barlow_Condensed'] text-sm font-black tracking-wide text-[var(--ps-text)] uppercase leading-tight sm:text-base">
                          {themeOpt.name}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <span
                            className="rounded px-1.5 py-0.5 font-mono text-[8px] font-extrabold leading-none uppercase"
                            style={{
                              backgroundColor: themeOpt.accent,
                              color: themeOpt.darkAccentText ? '#090D16' : '#FFFFFF',
                            }}
                          >
                            {themeOpt.tag}
                          </span>
                        </div>
                      </div>
                      {isActive ? (
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ps-accent)] text-[var(--ps-accent-text)]">
                          <Check className="h-3 w-3 stroke-[3]" />
                        </span>
                      ) : !unlocked ? (
                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/45 bg-amber-500/15 px-1 py-0.5 font-mono text-[8px] font-black text-[var(--ps-amber)] uppercase">
                          <Crown className="h-2.5 w-2.5" />
                          <span>PRO</span>
                        </span>
                      ) : null}
                    </div>

                    {/* Mini Preview Compacto + Amostras */}
                    <div
                      className="w-full rounded-lg border p-1.5"
                      style={{
                        backgroundColor: themeOpt.bg,
                        borderColor: themeOpt.border,
                        color: themeOpt.text,
                      }}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div
                          className="rounded border px-1.5 py-1"
                          style={{
                            backgroundColor: themeOpt.surface,
                            borderColor: themeOpt.border,
                          }}
                        >
                          <div className={`${themeOpt.fontClass} text-xs font-black leading-none tabular-nums sm:text-sm`}>
                            124 <span className="text-[8px] font-bold" style={{ color: themeOpt.muted }}>km/h</span>
                          </div>
                        </div>

                        <div
                          className="rounded border px-1.5 py-1 text-right"
                          style={{
                            backgroundColor: themeOpt.card,
                            borderColor: themeOpt.accent,
                          }}
                        >
                          <div
                            className={`${themeOpt.fontClass} text-xs font-black leading-none tabular-nums sm:text-sm`}
                            style={{ color: themeOpt.accent2 }}
                          >
                            -0.42s
                          </div>
                        </div>
                      </div>

                      <div className="mt-1.5 flex items-center justify-between gap-1 pt-1" style={{ borderTop: `1px solid ${themeOpt.border}` }}>
                        <span className="truncate font-mono text-[8px] font-semibold uppercase" style={{ color: themeOpt.muted }}>
                          Paleta
                        </span>
                        <div className="flex items-center gap-1">
                          {[themeOpt.bg, themeOpt.surface, themeOpt.card, themeOpt.accent, themeOpt.accent2].map((hex, idx) => (
                            <span
                              key={idx}
                              className="h-2.5 w-2.5 rounded-full border border-black/25 ring-1 ring-white/20"
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Barra LED inferior estilo FT */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
                      style={{
                        backgroundColor: themeOpt.accent,
                        opacity: isActive ? 1 : 0.45,
                      }}
                    />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* SUBMENU 1: PLANILHAS & LIVROS DE BORDO */}
      {activeMenu === 'roadbooks' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold text-[var(--ps-text)] uppercase">
                  Importar Planilha (.NBP / .NBP.ZIP / .TXT)
                </h2>
                <p className="mt-0.5 text-xs text-[var(--ps-muted)]">
                  Importe ou troque seus livros de bordo em um só lugar para navegar offline.
                </p>
              </div>
              <button
                type="button"
                onClick={handleLoadSample}
                disabled={loadingSample}
                className="pitstop-btn-metal inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-bold whitespace-nowrap shrink-0"
              >
                <FileText className="h-4 w-4 text-[var(--ps-accent)]" />
                <span>{loadingSample ? 'Carregando...' : 'Testar com Modelo'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {IMPORT_FORMAT_OPTIONS.map((opt) => {
                const selected = importFormat === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setImportFormat(opt.id);
                      setRbError(null);
                    }}
                    className={`flex items-center justify-between rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
                      selected
                        ? 'border-[var(--ps-accent)] bg-[#E10600]/15 text-[var(--ps-text)]'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:border-[var(--ps-border-strong)]'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-bold">{opt.label}</div>
                      <div className="mt-0.5 text-[11px] text-[var(--ps-muted)]">{opt.hint}</div>
                    </div>
                    <span className="ml-3 font-mono text-[11px] font-bold text-[var(--ps-accent)] shrink-0">
                      {opt.ext}
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-5 py-6 text-center transition-colors hover:border-[var(--ps-accent)] hover:bg-[#E10600]/5">
              <Upload className="h-7 w-7 text-[var(--ps-accent)]" />
              <span className="mt-2 text-sm font-bold text-[var(--ps-text)]">
                {importFormat === 'nbp'
                  ? 'Selecionar Planilha Digital .NBP / .NBP.ZIP (T15)'
                  : 'Selecionar Planilha (.NBP, .ZIP, .TXT, .CSV, .XML)'}
              </span>
              <span className="mt-1 text-xs text-[var(--ps-muted)]">
                Converte tulipas (desde 0,00), distâncias, médias, tempos ideais e observações.
              </span>
              <input
                type="file"
                accept=".nbp,.zip,.txt,.csv,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleRoadbookFile(f);
                  e.currentTarget.value = '';
                }}
              />
            </label>

            {rbError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-800/70 bg-red-950/50 p-3 text-xs text-red-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF2A2A]" />
                <span>{rbError}</span>
              </div>
            )}

            {rbSuccess && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-xs text-emerald-200">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>{rbSuccess}</span>
                </div>
                {onOpenNavigation && (
                  <button
                    type="button"
                    onClick={onOpenNavigation}
                    className="pitstop-btn-red inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold uppercase"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <span>Ir para Regularidade</span>
                  </button>
                )}
              </div>
            )}

            {/* Diagnostic .NBP structure inspector */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-2.5">
              <div className="flex items-center gap-2 text-xs text-[var(--ps-muted)]">
                <FileSearch className="h-4 w-4 text-[var(--ps-muted)] shrink-0" />
                <span>Inspeção técnica do arquivo .NBP / .NBP.ZIP</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="pitstop-btn-metal inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold">
                  <FileSearch className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                  <span>Inspecionar .NBP</span>
                  <input
                    type="file"
                    accept=".nbp,.zip,.txt,.csv,.xml,.gpx,.json,.db,.sqlite,.sqlite3,application/zip"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleInspectFileOnly(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                {fileStructureReport && (
                  <button
                    type="button"
                    onClick={() => setShowStructureReport((v) => !v)}
                    className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ps-text)]"
                  >
                    {showStructureReport ? 'Ocultar' : 'Ver Estrutura'}
                  </button>
                )}
              </div>
            </div>

            {showStructureReport && fileStructureReport && (
              <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3.5">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-bold text-[var(--ps-accent)] uppercase">
                    Estrutura Detectada
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleDownloadDiagnosticTxt}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ps-muted)]"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Baixar .TXT</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCopyStructureReport}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ps-muted)]"
                    >
                      {copiedReport ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-[var(--ps-accent)]" />}
                      <span>{copiedReport ? 'Copiado' : 'Copiar'}</span>
                    </button>
                  </div>
                </div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--ps-muted)]">
                  {fileStructureReport}
                </pre>
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)]">
            <div className="flex items-center justify-between border-b border-[var(--ps-border)] px-4 py-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[var(--ps-accent)]" />
                <h3 className="font-['Barlow_Condensed'] text-lg font-bold text-[var(--ps-text)] uppercase">
                  Livros de Bordo Salvos ({savedRoadbooks.length})
                </h3>
              </div>
              <span className="text-[11px] text-[var(--ps-muted)]">Base offline</span>
            </div>

            {savedRoadbooks.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--ps-muted)]">
                Nenhuma planilha importada ainda. Envie um arquivo .NBP ou carregue o modelo acima.
              </div>
            ) : (
              <div className="divide-y divide-[var(--ps-border)]">
                {savedRoadbooks.map((item) => {
                  const isActive = item.id === activeRoadbookId;
                  return (
                    <div
                      key={item.id ?? item.fileName}
                      className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between ${
                        isActive ? 'bg-[#E10600]/10' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-['Barlow_Condensed'] text-lg font-bold text-[var(--ps-text)] truncate">
                            {item.eventName}
                          </span>
                          <span className="font-mono text-[10px] font-bold uppercase text-[var(--ps-accent)]">
                            {item.sourceFormat || 'TXT'}
                          </span>
                          {isActive && (
                            <span className="font-mono text-[10px] font-extrabold text-emerald-400 uppercase">
                              · Ativa
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                          <span>{item.tulipas.length} refs</span>
                          <span>{item.totalKm.toFixed(2)} km</span>
                          <span>
                            V:{item.countV} · D:{item.countD} · N:{item.countN}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleActivateRoadbook(item, true)}
                          className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold tracking-wide uppercase"
                        >
                          <Navigation className="h-3.5 w-3.5" />
                          <span>{isActive ? 'Navegar' : 'Trocar e Navegar'}</span>
                        </button>
                        {item.id && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSaved(item.id!)}
                            title="Remover da base interna"
                            className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[#FF2A2A]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* SUBMENU 2: PAREAMENTO NAVEGADOR <-> PILOTO (MESTRE -> ESCRAVO) */}
      {activeMenu === 'pairing' && (
        <div className="space-y-3">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 sm:p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase sm:text-xl">
                  Droid Piloto · Mestre → Escravo
                </h2>
                <p className="text-[11px] text-[var(--ps-muted)]">
                  Navegador (Mestre) envia hodômetro, PMM, TNAV e alertas para 1 ou 2+ celulares Piloto.
                </p>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-1.5 text-xs font-bold text-[var(--ps-text)]">
                <input
                  type="checkbox"
                  checked={settings.pairing.enabled}
                  onChange={(e) =>
                    updateSettings({
                      pairing: { ...settings.pairing, enabled: e.target.checked },
                    })
                  }
                  className="h-4 w-4 accent-[var(--ps-accent)]"
                />
                <span>{settings.pairing.enabled ? 'Ativo' : 'Desligado'}</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div>
                <span className="block text-[10px] font-semibold text-[var(--ps-muted)] uppercase">
                  Papel do Aparelho
                </span>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1">
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({ pairing: { ...settings.pairing, role: 'navigator' } })
                    }
                    className={`min-h-[36px] rounded-md text-xs font-bold whitespace-nowrap ${
                      settings.pairing.role === 'navigator'
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    Navegador
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({ pairing: { ...settings.pairing, role: 'pilot' } })
                    }
                    className={`min-h-[36px] rounded-md text-xs font-bold whitespace-nowrap ${
                      settings.pairing.role === 'pilot'
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    Piloto
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="pairing-room-code"
                  className="block text-[10px] font-semibold text-[var(--ps-muted)] uppercase"
                >
                  Código da Sala &amp; PIN
                </label>
                <div className="mt-1 flex gap-1.5">
                  <input
                    id="pairing-room-code"
                    type="text"
                    value={settings.pairing.roomCode}
                    onChange={(e) =>
                      updateSettings({
                        pairing: {
                          ...settings.pairing,
                          roomCode: normalizeRoomCode(e.target.value),
                        },
                      })
                    }
                    placeholder="PS-4821"
                    className="w-24 sm:w-28 min-h-[38px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 font-mono text-sm font-black tracking-wider text-[var(--ps-text)] uppercase focus:border-[var(--ps-accent)] focus:outline-none"
                  />
                  <input
                    id="pairing-room-pin"
                    type="text"
                    aria-label="PIN de segurança da sala"
                    value={settings.pairing.roomPin || ''}
                    onChange={(e) =>
                      updateSettings({
                        pairing: {
                          ...settings.pairing,
                          roomPin: normalizeRoomPin(e.target.value),
                        },
                      })
                    }
                    placeholder="PIN"
                    className="flex-1 min-w-[74px] min-h-[38px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 font-mono text-sm font-black tracking-wider text-emerald-300 uppercase focus:border-[var(--ps-accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({
                        pairing: {
                          ...settings.pairing,
                          roomCode: generatePairingRoomCode(),
                          roomPin: generatePairingRoomPin(),
                        },
                      })
                    }
                    className="pitstop-btn-metal min-h-[38px] rounded-lg px-2.5 text-xs font-bold whitespace-nowrap shrink-0"
                  >
                    Gerar
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[var(--ps-muted)]">Status</span>
                  <span
                    className={`font-mono font-bold ${
                      !settings.pairing.enabled
                        ? 'text-zinc-500'
                        : pairingPresence.status === 'connected'
                          ? 'text-emerald-400'
                          : pairingPresence.status === 'connecting'
                            ? 'text-amber-400'
                            : 'text-[#FF2A2A]'
                    }`}
                  >
                    {!settings.pairing.enabled
                      ? 'Off'
                      : pairingPresence.status === 'connected'
                        ? pairingPresence.transport === 'bt_spp'
                          ? 'BT SPP'
                          : pairingPresence.transport === 'local'
                            ? 'Local'
                            : 'Wi-Fi WS'
                        : pairingPresence.status === 'connecting'
                          ? 'Conectando...'
                          : 'Aguardando'}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                  Mestre: {pairingPresence.navigators} · Pilotos: {pairingPresence.pilots}
                </div>
              </div>
            </div>

            {/* Transport Selector + Quick Pilot Launcher */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ps-border)] pt-3">
              <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1 text-[11px] font-bold">
                {(
                  [
                    { id: 'auto', label: 'Auto' },
                    { id: 'bluetooth_spp', label: 'BT Clássico' },
                    { id: 'wifi_ws', label: 'Wi-Fi / Web' },
                  ] as { id: PairingTransportMode; label: string }[]
                ).map((modeOpt) => (
                  <button
                    key={modeOpt.id}
                    type="button"
                    onClick={() =>
                      updateSettings({
                        pairing: { ...settings.pairing, transportMode: modeOpt.id },
                      })
                    }
                    className={`min-h-[32px] rounded-md px-2.5 transition-colors whitespace-nowrap ${
                      settings.pairing.transportMode === modeOpt.id
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    {modeOpt.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => playPairingBell()}
                  className="pitstop-btn-metal inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold whitespace-nowrap"
                >
                  <Bell className="h-3.5 w-3.5 text-amber-300" />
                  <span>Testar Sinetinha</span>
                </button>
                <button
                  type="button"
                  onClick={handleCopyPilotLink}
                  className="pitstop-btn-metal inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold whitespace-nowrap"
                >
                  {copiedPilotLink ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Share2 className="h-3.5 w-3.5 text-sky-400" />
                  )}
                  <span>{copiedPilotLink ? 'Copiado!' : 'Copiar Link Piloto'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleOpenPilotDisplay}
                  className="pitstop-btn-red inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold whitespace-nowrap"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Abrir Visor Droid Piloto</span>
                </button>
              </div>
            </div>

            {/* Bluetooth Pairing Picker (Native SPP Multi-Pilot + Wake Lock) */}
            <div className="grid grid-cols-1 gap-2.5 border-t border-[var(--ps-border)] pt-3 sm:grid-cols-2">
              <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Bluetooth className="h-4 w-4 text-[var(--ps-accent)]" />
                    <span className="text-xs font-bold text-[var(--ps-text)] uppercase">
                      {isNativeBluetoothSppAvailable()
                        ? 'Pilotos Bluetooth (SPP)'
                        : 'Bluetooth / Wi-Fi'}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={loadingBtList}
                    onClick={handleSelectBluetoothDevice}
                    className="pitstop-btn-metal rounded-lg px-2.5 py-1 text-xs font-bold whitespace-nowrap"
                  >
                    {loadingBtList ? 'Buscando...' : 'Listar Pareados'}
                  </button>
                </div>

                {bondedBtList.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {bondedBtList.map((dev) => {
                      const selected = (settings.pairing.bluetoothDevices || []).some(
                        (d) => d.address === dev.address
                      );
                      return (
                        <button
                          key={dev.address}
                          type="button"
                          onClick={() => handleToggleBondedBtDevice(dev)}
                          className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-bold transition-colors ${
                            selected
                              ? 'border-emerald-400 bg-emerald-950/50 text-emerald-300'
                              : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-muted)]'
                          }`}
                        >
                          {selected ? '✓ ' : '+ '}
                          {dev.name}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="font-mono text-[11px] text-[var(--ps-muted)]">
                    {(settings.pairing.bluetoothDevices || []).length > 0
                      ? `Alvos: ${settings.pairing.bluetoothDevices.map((d) => d.name).join(', ')}`
                      : settings.pairing.bluetoothDeviceName
                        ? `Selecionado: ${settings.pairing.bluetoothDeviceName}`
                        : 'Nenhum aparelho Bluetooth selecionado'}
                  </p>
                )}

                {btStatusMsg && <p className="text-[11px] text-amber-300">{btStatusMsg}</p>}
              </div>

              <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 flex flex-col justify-between gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Smartphone className="h-4 w-4 text-[var(--ps-accent)]" />
                    <span className="text-xs font-bold text-[var(--ps-text)] uppercase">
                      Tela Sempre Ativa
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleWakeLock}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                      wakeLockActive ? 'bg-emerald-600 text-[#FFFFFF]' : 'pitstop-btn-metal'
                    }`}
                  >
                    {wakeLockActive ? 'Ativa' : 'Manter Acesa'}
                  </button>
                </div>
                <p className="text-[11px] text-[var(--ps-muted)]">
                  Impede que o painel do Piloto ou Navegador apague durante a prova.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 text-[11px] text-[var(--ps-muted)]">
              <Wifi className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
              <span>
                No APK Android, <strong className="text-[var(--ps-text)]">Bluetooth Clássico SPP</strong> conecta direto 1 ou 2 Pilotos sem internet; no navegador use Hotspot Wi-Fi + mesma Sala.
              </span>
            </div>
          </section>
        </div>
      )}

      {/* SUBMENU 3: TELA DO PILOTO (PERSONALIZAÇÃO REGULARIDADE + COCKPIT VELOCIDADE) */}
      {activeMenu === 'pilot' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Cockpit Ao Vivo · Aba Velocidade (13 Modelos + Customizado)
                </h2>
                <p className="text-xs text-[var(--ps-muted)]">
                  Escolha um dos 13 layouts prontos ou monte o seu painel com ordem, tamanho P/M/G e widgets ativos.
                </p>
              </div>
            </div>
            <VelocityCockpitLayoutEditor />
          </section>

          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Campos Visíveis na Tela do Piloto (Regularidade)
                </h2>
                <p className="text-xs text-[var(--ps-muted)]">
                  Escolha exatamente o que aparece para o piloto na aba Regularidade &gt; Piloto.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => updateSettings({ pilotDisplay: getDefaultPilotDisplay() })}
                  className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-1.5 text-xs font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                >
                  Completo
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({
                      pilotDisplay: {
                        showDistance: true,
                        showOdometer: false,
                        showSpeed: true,
                        showTargetSpeed: true,
                        showTnav: true,
                        showColorBar: true,
                        showDeltaMeters: false,
                        showClock: false,
                        showDesenho: true,
                        showCap: false,
                        showObs: true,
                      },
                    })
                  }
                  className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-1.5 text-xs font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                >
                  Essencial Piloto
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({
                      pilotDisplay: {
                        showDistance: false,
                        showOdometer: false,
                        showSpeed: true,
                        showTargetSpeed: true,
                        showTnav: true,
                        showColorBar: true,
                        showDeltaMeters: false,
                        showClock: false,
                        showDesenho: false,
                        showCap: false,
                        showObs: false,
                      },
                    })
                  }
                  className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-1.5 text-xs font-bold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                >
                  Minimalista (Vel/Média/TNAV)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
              {([
                { key: 'showSpeed', label: 'Velocidade Atual (km/h)' },
                { key: 'showTargetSpeed', label: 'Média Ideal (PMM)' },
                { key: 'showTnav', label: 'TNAV (Adiantado / Atrasado)' },
                { key: 'showColorBar', label: 'Barra de Cores (Verde/Cinza/Verm.)' },
                { key: 'showDistance', label: 'Distância Regressiva (m/km)' },
                { key: 'showOdometer', label: 'Hodômetro Total' },
                { key: 'showDeltaMeters', label: 'Diferença em Metros (+/- m)' },
                { key: 'showClock', label: 'Hora Oficial' },
                { key: 'showDesenho', label: 'Desenho da Tulipa (Quadrado)' },
                { key: 'showCap', label: 'CAP° / Número do Trecho' },
                { key: 'showObs', label: 'Observação (Retângulo + Texto)' },
              ] as const).map((item) => (
                <label
                  key={item.key}
                  className="flex min-h-[46px] cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-[var(--ps-border-strong)]"
                >
                  <input
                    type="checkbox"
                    checked={settings.pilotDisplay[item.key]}
                    onChange={(e) =>
                      updateSettings({
                        pilotDisplay: {
                          ...settings.pilotDisplay,
                          [item.key]: e.target.checked,
                        },
                      })
                    }
                    className="h-4 w-4 accent-[var(--ps-accent)]"
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* SUBMENU 4: AFERIÇÃO DO HODÔMETRO & W FINO */}
      {activeMenu === 'calibration' && (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                Aferição do Hodômetro, W Fino &amp; Pista de Calibração
              </h2>
              <p className="mt-1 text-xs text-[var(--ps-muted)]">
                <strong className="text-[var(--ps-text)]">W maior</strong> → odômetro marca mais distância ·{' '}
                <strong className="text-[var(--ps-text)]">W menor</strong> → odômetro marca menos distância.
              </p>
            </div>

            <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => updateSettings({ sensorMode: 'gps' })}
                className={`rounded-md px-3 py-1.5 font-semibold whitespace-nowrap shrink-0 ${
                  settings.sensorMode === 'gps'
                    ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                GPS (CAL%)
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ sensorMode: 'blue' })}
                className={`rounded-md px-3 py-1.5 font-semibold whitespace-nowrap shrink-0 ${
                  settings.sensorMode === 'blue'
                    ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                Sensor Blue (W)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-7 grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2">
              <button
                type="button"
                onClick={() => handleAdjustCalPct(-1)}
                className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                -1%
              </button>
              <button
                type="button"
                onClick={() => handleAdjustCalPct(-0.1)}
                className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3.5 font-mono text-base font-black text-[var(--ps-text)]"
              >
                −
              </button>

              {editingW ? (
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  value={wInputText}
                  onChange={(e) => setWInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitWEditor();
                    if (e.key === 'Escape') setEditingW(false);
                  }}
                  onBlur={handleCommitWEditor}
                  className="w-full min-h-[44px] rounded-lg border border-[var(--ps-accent)] bg-[var(--ps-card-deep)] px-2 text-center font-mono text-base font-black text-[var(--ps-text)] focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={handleOpenWEditor}
                  className="flex min-h-[44px] flex-col items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2 hover:border-[var(--ps-accent)]"
                >
                  <span className="font-mono text-lg font-black text-[var(--ps-text)] tabular-nums">
                    {settings.sensorMode === 'blue'
                      ? `W ${activeW}`
                      : `${settings.calibrationPct.toFixed(2)}%`}
                  </span>
                  <span className="text-[9px] font-semibold tracking-wider text-[var(--ps-muted)] uppercase">
                    Toque para digitar
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => handleAdjustCalPct(0.1)}
                className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3.5 font-mono text-base font-black text-[var(--ps-text)]"
              >
                +
              </button>
              <button
                type="button"
                onClick={() => handleAdjustCalPct(1)}
                className="min-h-[44px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 font-mono text-xs font-extrabold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                +1%
              </button>
            </div>

            <div className="lg:col-span-5 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3">
              <label htmlFor="w-base-cfg" className="text-xs font-semibold text-[var(--ps-muted)] whitespace-nowrap">
                W Base (100%):
              </label>
              <input
                id="w-base-cfg"
                type="number"
                min={500}
                max={99999}
                value={settings.wBaseValue}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 500) updateSettings({ wBaseValue: v });
                }}
                className="w-24 min-h-[38px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2.5 font-mono text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => updateSettings({ calibrationPct: 100 })}
                className="ml-auto inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-semibold text-[var(--ps-muted)] hover:text-[var(--ps-text)] whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Zerar 100%</span>
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                Passagens em Pista de Aferição (Passagem 1 / 2 / 3)
              </span>
              {settings.wPasses.length > 0 && (
                <button
                  type="button"
                  onClick={() => updateSettings({ wPasses: [] })}
                  className="text-[11px] font-semibold text-[#FF2A2A] hover:underline"
                >
                  Limpar passagens
                </button>
              )}
            </div>

            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <input
                type="number"
                inputMode="decimal"
                placeholder="Distância oficial (m) ex: 1000"
                value={passOfficialM}
                onChange={(e) => setPassOfficialM(e.target.value)}
                className="min-h-[42px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 font-mono text-xs text-[var(--ps-text)] placeholder:text-zinc-500 focus:border-[var(--ps-accent)] focus:outline-none"
              />
              <input
                type="number"
                inputMode="decimal"
                placeholder="Medida no hodômetro (m) ex: 992"
                value={passMeasuredM}
                onChange={(e) => setPassMeasuredM(e.target.value)}
                className="min-h-[42px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 font-mono text-xs text-[var(--ps-text)] placeholder:text-zinc-500 focus:border-[var(--ps-accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCalibrationPass}
                className="pitstop-btn-metal min-h-[42px] rounded-lg px-3 text-xs font-bold whitespace-nowrap"
              >
                + Registrar Passagem ({Math.min(3, settings.wPasses.length + 1)}/3)
              </button>
            </div>

            {settings.wPasses.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ps-border)] pt-3">
                <div className="flex flex-wrap gap-2">
                  {settings.wPasses.map((p, idx) => (
                    <span
                      key={p.id}
                      className="rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2.5 py-1 font-mono text-[11px] text-[var(--ps-muted)]"
                    >
                      P{idx + 1}: {p.measuredM}m / {p.officialM}m →{' '}
                      <strong className="text-[var(--ps-text)]">W {p.suggestedW}</strong>
                    </span>
                  ))}
                </div>
                {averageCalibrationSuggestion && (
                  <button
                    type="button"
                    onClick={handleApplyAverageW}
                    className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold whitespace-nowrap shrink-0"
                  >
                    <span>
                      Aplicar Média W {averageCalibrationSuggestion.avgW} ({averageCalibrationSuggestion.avgPct.toFixed(2)}% · Erro{' '}
                      {averageCalibrationSuggestion.errorMPerKm >= 0 ? '+' : ''}
                      {averageCalibrationSuggestion.errorMPerKm.toFixed(1)} m/km)
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* SUBMENU 5: ALERTAS, ROAD BOOK & ATALHOS */}
      {activeMenu === 'alerts' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-[var(--ps-accent)]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Alertas Sonoros &amp; Cantada
                </h2>
              </div>
              <button
                type="button"
                onClick={() => testAlertSound(settings.alertStyle)}
                className="pitstop-btn-metal rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              >
                Testar Alerta
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                { id: 'voice', label: 'Voz pt-BR' },
                { id: 'beep_short', label: 'Bipe Curto' },
                { id: 'beep_long', label: 'Bipe Longo' },
                { id: 'vibration', label: 'Vibração' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => updateSettings({ alertStyle: opt.id, voiceEnabled: true })}
                  className={`min-h-[38px] rounded-lg text-xs font-bold whitespace-nowrap ${
                    settings.alertStyle === opt.id
                      ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                      : 'border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="cfg-cantada-dist"
                  className="block text-[11px] font-semibold text-[var(--ps-muted)]"
                >
                  Distâncias / Gatilhos
                </label>
                <input
                  id="cfg-cantada-dist"
                  type="text"
                  value={thresholdsInput}
                  onChange={(e) => setThresholdsInput(e.target.value)}
                  onBlur={() => handleCommitThresholds(thresholdsInput)}
                  placeholder="100, 50, 20"
                  className="mt-1 w-full min-h-[40px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 font-mono text-xs text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                />
              </div>

              <div>
                <span className="block text-[11px] font-semibold text-[var(--ps-muted)]">Unidade</span>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1">
                  <button
                    type="button"
                    onClick={() => updateSettings({ voiceUnit: 'meters' })}
                    className={`min-h-[32px] rounded-md text-xs font-bold ${
                      settings.voiceUnit === 'meters' ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]' : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    Metros
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSettings({ voiceUnit: 'seconds' })}
                    className={`min-h-[32px] rounded-md text-xs font-bold ${
                      settings.voiceUnit === 'seconds' ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]' : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    Segundos
                  </button>
                </div>
              </div>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--ps-muted)]">
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={(e) => updateSettings({ voiceEnabled: e.target.checked })}
                className="h-4 w-4 accent-[var(--ps-accent)]"
              />
              <span>Ativar alertas automáticos antes das referências</span>
            </label>
          </div>

          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-[var(--ps-accent)]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Teclas de Atalho / Controle Bluetooth
                </h2>
              </div>
              <button
                type="button"
                onClick={() => updateSettings({ shortcuts: getDefaultShortcuts() })}
                className="text-[11px] font-semibold text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              >
                Padrão
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'syncHere', label: 'Zerar / OK Lap' },
                { key: 'toggleRun', label: 'Iniciar / Pausar' },
                { key: 'odoPlus', label: 'Hodômetro +Passo' },
                { key: 'odoMinus', label: 'Hodômetro -Passo' },
                { key: 'nextTulipa', label: 'Próxima Tulipa' },
                { key: 'prevTulipa', label: 'Tulipa Anterior' },
              ] as const).map((item) => {
                const isCap = capturingShortcut === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setCapturingShortcut(isCap ? null : item.key)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isCap
                        ? 'border-[var(--ps-accent)] bg-[#E10600]/15'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-zinc-600'
                    }`}
                  >
                    <span className="text-[10px] font-semibold text-[var(--ps-muted)] uppercase">
                      {item.label}
                    </span>
                    <span className="mt-0.5 font-mono text-xs font-bold text-[var(--ps-text)]">
                      {isCap ? 'Pressione uma tecla...' : formatKeyLabel(settings.shortcuts[item.key])}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3 lg:col-span-2">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-[var(--ps-accent)]" />
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                Exibição do Road Book Digital
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateSettings({ activeRowLine: 1 })}
                className={`min-h-[38px] rounded-lg text-xs font-bold ${
                  settings.activeRowLine === 1
                    ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                }`}
              >
                Ref. da Vez: Linha 1 (Topo)
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ activeRowLine: 2 })}
                className={`min-h-[38px] rounded-lg text-xs font-bold ${
                  settings.activeRowLine === 2
                    ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                    : 'border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                }`}
              >
                Ref. da Vez: Linha 2
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--ps-muted)]">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.reducePassedRow}
                  onChange={(e) => updateSettings({ reducePassedRow: e.target.checked })}
                  className="h-4 w-4 accent-[var(--ps-accent)]"
                />
                <span>Reduzir passada</span>
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.showPassedTick}
                  onChange={(e) => updateSettings({ showPassedTick: e.target.checked })}
                  className="h-4 w-4 accent-[var(--ps-accent)]"
                />
                <span>✓ Verde na passada</span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-xs font-semibold text-[var(--ps-muted)]">Tema da Referência:</span>
              <div className="flex gap-1.5">
                {([
                  { id: 'yellow', label: 'Amarelo' },
                  { id: 'blue', label: 'Azul' },
                  { id: 'green', label: 'Verde' },
                ] as { id: HighlightTheme; label: string }[]).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => updateSettings({ highlightTheme: t.id })}
                    className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                      settings.highlightTheme === t.id
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-[var(--ps-muted)]">
                <span>Troca Antecipada</span>
                <span className="font-mono text-[var(--ps-text)]">{settings.transitionAdvanceM} m</span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {[0, 5, 10, 20].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateSettings({ transitionAdvanceM: m })}
                    className={`min-h-[34px] rounded-lg font-mono text-xs font-bold ${
                      settings.transitionAdvanceM === m
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
                    }`}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUBMENU: AJUSTE DE HORA (MANUAL OU AUTOMÁTICA) */}
      {activeMenu === 'clock' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Hora Oficial da Prova
                </h2>
                <p className="text-xs text-[var(--ps-muted)]">
                  Escolha entre sincronização automática (GPS / Rede) ou ajuste manual até o segundo para alinhar com a cronometragem.
                </p>
              </div>
              <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1 text-xs">
                <button
                  type="button"
                  onClick={handleSyncGpsClock}
                  className={`min-h-[36px] rounded-md px-3 font-bold ${
                    clockMode === 'auto' ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]' : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  Automática (GPS)
                </button>
                <button
                  type="button"
                  onClick={() => setClockMode('manual')}
                  className={`min-h-[36px] rounded-md px-3 font-bold ${
                    clockMode === 'manual' ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]' : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                  }`}
                >
                  Manual
                </button>
              </div>
            </div>

            {/* Live Big Clock Preview */}
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-5 text-center">
              <p className="font-mono text-[11px] font-bold tracking-widest text-[var(--ps-accent)] uppercase">
                {clockMode === 'auto' && settings.clockOffsetMs === 0
                  ? 'RELÓGIO AUTOMÁTICO ATIVO'
                  : `MODO ${clockMode === 'auto' ? 'GPS' : 'MANUAL'} · DESVIO ${settings.clockOffsetMs >= 0 ? '+' : ''}${(settings.clockOffsetMs / 1000).toFixed(1)}s`}
              </p>
              <div className="mt-1 font-mono text-4xl font-black tracking-tight text-[var(--ps-text)] tabular-nums sm:text-5xl">
                {formatClockOnly(nowMs + settings.clockOffsetMs)}
              </div>
            </div>

            {clockMode === 'auto' ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-4">
                <div className="text-xs text-[var(--ps-muted)]">
                  <strong className="text-[var(--ps-text)] block">Sincronização Automática</strong>
                  Usa o timestamp preciso do satélite GPS ou do relógio oficial do aparelho.
                </div>
                <button
                  type="button"
                  onClick={handleSyncGpsClock}
                  className="pitstop-btn-red min-h-[40px] rounded-lg px-4 text-xs font-extrabold uppercase"
                >
                  Sincronizar Agora
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[160px]">
                    <label
                      htmlFor="manual-clock-input"
                      className="block text-[11px] font-bold text-[var(--ps-muted)] uppercase"
                    >
                      Digitar Hora Manual (HH:MM:SS)
                    </label>
                    <input
                      id="manual-clock-input"
                      type="text"
                      value={manualTimeInput}
                      onChange={(e) => setManualTimeInput(e.target.value)}
                      placeholder="14:30:00"
                      className="mt-1 w-full min-h-[42px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 font-mono text-base font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => handleApplyManualClock(manualTimeInput)}
                    className="pitstop-btn-red min-h-[42px] rounded-lg px-4 text-xs font-extrabold uppercase"
                  >
                    Aplicar Hora
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setClockMode('auto');
                      updateSettings({ clockOffsetMs: 0 });
                      setManualTimeInput(formatClockOnly(Date.now()));
                      setClockSyncFeedback('Ajuste zerado para hora do aparelho.');
                    }}
                    className="pitstop-btn-metal min-h-[42px] rounded-lg px-3 text-xs font-bold uppercase"
                  >
                    Zerar
                  </button>
                </div>

                <div>
                  <span className="block text-[11px] font-semibold text-[var(--ps-muted)] mb-1.5">
                    Ajuste Fino Rápido:
                  </span>
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 font-mono text-xs font-bold">
                    {[
                      { label: '-1h', ms: -3600000 },
                      { label: '-1m', ms: -60000 },
                      { label: '-1s', ms: -1000 },
                      { label: '+1s', ms: 1000 },
                      { label: '+1m', ms: 60000 },
                      { label: '+1h', ms: 3600000 },
                    ].map((btn) => (
                      <button
                        key={btn.label}
                        type="button"
                        onClick={() => handleAdjustClockDeltaMs(btn.ms)}
                        className="min-h-[38px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {clockSyncFeedback && (
              <p className="text-xs font-semibold text-emerald-400">{clockSyncFeedback}</p>
            )}
          </section>
        </div>
      )}

      {/* SUBMENU: CÂMERAS GOPRO (OPEN GOPRO BLE) */}
      {activeMenu === 'gopro' && <GoProBlePanel />}

      {/* SUBMENU: SISTEMA, TELA, GPS, PERMISSÕES & APURAÇÃO */}
      {activeMenu === 'system' && (
        <div className="space-y-4">
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Satellite className="h-4 w-4 text-[var(--ps-accent)]" />
                  <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase">
                    Sinal do GPS
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={readSingleGpsFix}
                  disabled={refreshingGps}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-[#C0C4C9]/50 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`h-3.5 w-3.5 text-[var(--ps-muted)] ${refreshingGps ? 'animate-spin' : ''}`} />
                  <span>Atualizar</span>
                </button>
              </div>

              <div className="mt-3 flex items-baseline justify-between gap-2">
                <div>
                  <span className={`font-['Barlow_Condensed'] text-2xl font-extrabold italic ${gpsQuality.toneClass}`}>
                    {gps.status === 'active' ? gpsQuality.label : gps.status === 'denied' ? 'Bloqueado' : 'Buscando...'}
                  </span>
                  <span className="ml-2 font-mono text-xs text-[var(--ps-muted)] tabular-nums">
                    {gps.accuracyM !== null ? `±${gps.accuracyM} m` : '--'}
                  </span>
                </div>
                <div className="flex items-end gap-1" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((b) => (
                    <span
                      key={b}
                      className={`w-1.5 rounded-xs ${b <= gpsQuality.bars ? gpsQuality.barClass : 'bg-[var(--ps-border)]'}`}
                      style={{ height: `${b * 4 + 4}px` }}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--ps-border)] pt-2.5 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                <span className="truncate">Lat: {gps.lat !== null ? gps.lat.toFixed(6) : '--'}</span>
                <span className="truncate text-right">Lon: {gps.lon !== null ? gps.lon.toFixed(6) : '--'}</span>
              </div>
              {gps.message && <p className="mt-2 text-xs text-amber-300">{gps.message}</p>}
            </div>

            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {renderBatteryIcon()}
                  <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase">
                    Bateria do Aparelho
                  </h2>
                </div>
                <span className="font-mono text-[11px] font-semibold text-[var(--ps-muted)]">
                  {battery.charging ? 'Carregando' : battery.supported ? 'Em bateria' : 'N/D'}
                </span>
              </div>

              <div className="mt-3 flex items-baseline justify-between">
                <span className="font-mono text-3xl font-extrabold text-[var(--ps-text)] tabular-nums">
                  {battery.supported && battery.levelPct !== null ? `${battery.levelPct}%` : '--'}
                </span>
                <span className="text-xs text-[var(--ps-muted)]">
                  {battery.levelPct !== null && battery.levelPct <= 25
                    ? 'Recomendado ligar carregador veicular'
                    : 'Carga estável para etapa'}
                </span>
              </div>

              <div className="mt-3 h-2 w-full overflow-hidden rounded-sm border border-[var(--ps-border)] bg-[var(--ps-card-deep)]">
                <div
                  className={`h-full transition-all ${
                    (battery.levelPct ?? 0) <= 20
                      ? 'bg-[#E10600]'
                      : (battery.levelPct ?? 0) <= 50
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${battery.levelPct ?? 0}%` }}
                />
              </div>
            </div>
          </section>

          {/* Screen Orientation Lock + Device Permissions */}
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-[var(--ps-accent)]" />
                <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Orientação &amp; Trava de Tela
                </h2>
              </div>
              <p className="text-xs text-[var(--ps-muted)]">
                Trave a rotação no painel do carro (Retrato / Paisagem) ou deixe automática conforme o sensor do aparelho.
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ['auto', 'Automática'],
                    ['portrait', 'Retrato'],
                    ['landscape', 'Paisagem'],
                  ] as [ScreenOrientationLock, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => updateSettings({ screenOrientation: id })}
                    className={`min-h-[40px] rounded-lg text-xs font-bold ${
                      settings.screenOrientation === id
                        ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                        : 'border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[var(--ps-accent)]" />
                  <h2 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase">
                    Permissões do Aparelho
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={handleRequestDevicePermissions}
                  disabled={requestingPerms}
                  className="pitstop-btn-red rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
                >
                  {requestingPerms ? 'Solicitando...' : 'Solicitar Acessos'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
                {(
                  [
                    ['Localização GPS', permSnapshot?.location],
                    ['Microfone (Voz)', permSnapshot?.microphone],
                    ['Pastas / Arquivos', permSnapshot?.storage],
                    ['Bluetooth BLE', permSnapshot?.bluetooth],
                  ] as const
                ).map(([label, status]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5"
                  >
                    <span className="truncate text-[var(--ps-muted)]">{label}</span>
                    <span
                      className={`font-bold uppercase ${
                        status === 'granted'
                          ? 'text-emerald-400'
                          : status === 'denied'
                            ? 'text-[#FF2A2A]'
                            : 'text-amber-300'
                      }`}
                    >
                      {status === 'granted'
                        ? 'OK'
                        : status === 'denied'
                          ? 'Negado'
                          : status === 'unsupported'
                            ? 'N/A'
                            : 'Pedir'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[var(--ps-accent)]" />
                <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                  Base PitStop-Sports &amp; Portal Web de Apuração
                </h2>
              </div>
              <button
                type="button"
                onClick={handleTestBaseConnection}
                disabled={healthState.checking}
                className="pitstop-btn-red inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
              >
                <Server className="h-3.5 w-3.5" />
                <span>{healthState.checking ? 'Verificando...' : 'Testar Base'}</span>
              </button>
            </div>

            <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-xs text-[var(--ps-muted)] space-y-2.5">
              <p className="font-bold text-[var(--ps-text)] uppercase text-[11px]">
                Como acessar o Portal Web de Apuração (Separado do APK do Competidor):
              </p>
              <p>
                No navegador web do organizador, adicione{' '}
                <code className="rounded border border-[var(--ps-border)] bg-[var(--ps-card)] px-1.5 py-0.5 font-mono text-[var(--ps-accent)]">?apuracao=1</code>{' '}
                ao final do endereço (ex.:{' '}
                <code className="font-mono text-[var(--ps-text)]">https://seusite/?apuracao=1</code>) ou clique no botão abaixo.
                O APK compilado para competidores oculta essa tela automaticamente para segurança da prova.
              </p>
              {onOpenApuracao && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={onOpenApuracao}
                    className="pitstop-btn-red inline-flex min-h-[40px] items-center gap-2 rounded-lg px-4 text-xs font-extrabold uppercase tracking-wide"
                  >
                    <Server className="h-4 w-4" />
                    <span>Abrir Portal Web de Apuração</span>
                  </button>
                </div>
              )}
            </div>

            {healthState.message && (
              <p
                className={`flex items-center gap-1.5 text-xs ${
                  healthState.ok ? 'text-emerald-400' : 'text-amber-300'
                }`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{healthState.message}</span>
              </p>
            )}

            {pendingQueue.length > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <span>{pendingQueue.length} coleta(s) na fila offline aguardando envio</span>
                <button
                  type="button"
                  disabled={retryingQueue}
                  onClick={handleRetryQueue}
                  className="inline-flex min-h-[32px] items-center gap-1 rounded-md bg-amber-400 px-2.5 text-xs font-extrabold text-black"
                >
                  <UploadCloud className="h-3.5 w-3.5" />
                  <span>{retryingQueue ? 'Enviando...' : 'Reenviar Agora'}</span>
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {/* SUBMENU 9: COLETOR & ENVIO PARA ADMIN */}
      {activeMenu === 'collector' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 sm:p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Server className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
                <div className="min-w-0">
                  <p className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase leading-tight">
                    Envio Direto para Base / Admin
                  </p>
                  <p className="text-[11px] text-[var(--ps-muted)] truncate">
                    Colete a passagem dos PCs por GPS e envie direto ao organizador.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleTestBaseConnection}
                  disabled={healthState.checking}
                  className="pitstop-btn-metal inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold whitespace-nowrap"
                >
                  <Server className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                  <span>{healthState.checking ? 'Verificando...' : 'Testar Base'}</span>
                </button>
                {onOpenApuracao && (
                  <button
                    type="button"
                    onClick={onOpenApuracao}
                    className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold uppercase whitespace-nowrap"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Portal Admin</span>
                  </button>
                )}
              </div>
            </div>

            {healthState.message && (
              <p
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                  healthState.ok
                    ? 'border-emerald-500/35 bg-emerald-500/12 text-[var(--ps-emerald)]'
                    : 'border-amber-500/35 bg-amber-500/12 text-[var(--ps-amber)]'
                }`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>{healthState.message}</span>
              </p>
            )}
          </section>

          <CompetitorCollector />
        </div>
      )}

      {/* SUBMENU 10: BACKUP & DADOS OFFLINE */}
      {activeMenu === 'backup' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-4">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-[var(--ps-accent)]" />
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                Resumo de Armazenamento Offline
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 font-mono tabular-nums">
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-center">
                <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Planilhas</p>
                <p className="mt-1 text-2xl font-black text-[var(--ps-text)]">{savedRoadbooks.length}</p>
              </div>
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-center">
                <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Pistas / SS</p>
                <p className="mt-1 text-2xl font-black text-[var(--ps-text)]">{velocityStats.tracksCount}</p>
              </div>
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-center">
                <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Passagens</p>
                <p className="mt-1 text-2xl font-black text-[var(--ps-amber)]">{velocityStats.runsCount}</p>
              </div>
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 text-center">
                <p className="text-[10px] font-bold text-[var(--ps-muted)] uppercase">Fila Admin</p>
                <p className="mt-1 text-2xl font-black text-[var(--ps-accent)]">{pendingQueue.length}</p>
              </div>
            </div>

            {backupFeedback && (
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-semibold ${
                  backupFeedback.ok
                    ? 'border-emerald-500/40 bg-emerald-500/12 text-[var(--ps-emerald)]'
                    : 'border-red-500/40 bg-red-500/12 text-red-500'
                }`}
              >
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{backupFeedback.message}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleExportBackup}
                className="pitstop-btn-red inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold uppercase tracking-wide"
              >
                <Download className="h-4 w-4" />
                <span>Exportar Backup (.JSON)</span>
              </button>

              <label className="pitstop-btn-metal inline-flex min-h-[46px] cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-xs font-bold uppercase tracking-wide">
                <Upload className="h-4 w-4 text-[var(--ps-accent)]" />
                <span>Restaurar Backup (.JSON)</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleImportBackup(f);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
            <h3 className="font-['Barlow_Condensed'] text-lg font-bold tracking-wide text-[var(--ps-text)] uppercase">
              Limpeza &amp; Manutenção
            </h3>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={handleClearVelocityRuns}
                disabled={velocityStats.runsCount === 0}
                className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-4 text-xs font-bold text-[var(--ps-muted)] hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
                <span>Limpar Passagens de Velocidade</span>
              </button>

              {!confirmResetDefaults ? (
                <button
                  type="button"
                  onClick={() => setConfirmResetDefaults(true)}
                  className="inline-flex min-h-[42px] items-center justify-center gap-2 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-4 text-xs font-bold text-[var(--ps-muted)] hover:border-red-500/60 hover:text-red-300"
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>Restaurar Ajustes Padrão</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-950/25 px-3 py-1.5">
                  <span className="flex-1 text-xs font-semibold text-red-200">
                    Confirmar reset?
                  </span>
                  <button
                    type="button"
                    onClick={handleResetDefaultSettings}
                    className="rounded-lg bg-[var(--ps-accent)] px-3 py-1.5 text-xs font-extrabold text-[var(--ps-accent-text)]"
                  >
                    Sim
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmResetDefaults(false)}
                    className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 py-1.5 text-xs text-[var(--ps-muted)]"
                  >
                    Não
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
