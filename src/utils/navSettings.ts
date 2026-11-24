import { useCallback, useEffect, useState } from 'react';
import {
  generatePairingRoomCode,
  generatePairingRoomPin,
  normalizeRoomCode,
  normalizeRoomPin,
  type BondedBluetoothDevice,
  type PairingRole,
  type PairingTransportMode,
} from './pairingClient';

/**
 * Chave mestra do sistema de Conta & Assinatura PRO.
 * - false: libera 100% das funções PRO sem exigir login ou chamadas /api/auth/*.
 * - true: reativa login, verificação de assinatura e bloqueios FREE/PRO.
 */
export const ENABLE_SUBSCRIPTION_GATE = false;

export type HighlightTheme = 'yellow' | 'blue' | 'green';
export type SensorMode = 'gps' | 'blue';
export type VoiceUnit = 'meters' | 'seconds';
export type AlertStyle = 'voice' | 'beep_short' | 'beep_long' | 'vibration';
export type ScreenOrientationLock = 'auto' | 'portrait' | 'landscape';
export type AppThemeId =
  | 'pitstop'
  | 'gt'
  | 'fueltech'
  | 'subaru'
  | 'gulf'
  | 'martini'
  | 'cyberpunk'
  | 'castrol'
  | 'night'
  | 'solar';

export interface PilotDisplayOptions {
  showDistance: boolean;
  showOdometer: boolean;
  showSpeed: boolean;
  showTargetSpeed: boolean;
  showTnav: boolean;
  showColorBar: boolean;
  showDeltaMeters: boolean;
  showClock: boolean;
  showDesenho: boolean;
  showCap: boolean;
  showObs: boolean;
}

export interface ShortcutBindings {
  syncHere: string;
  odoPlus: string;
  odoMinus: string;
  nextTulipa: string;
  prevTulipa: string;
  toggleRun: string;
}

export interface PairingSettings {
  enabled: boolean;
  role: PairingRole;
  roomCode: string;
  roomPin: string;
  transportMode: PairingTransportMode;
  bluetoothDevices: BondedBluetoothDevice[];
  bluetoothDeviceName?: string;
}

export interface CalibrationPassRecord {
  id: string;
  officialM: number;
  measuredM: number;
  suggestedW: number;
}

export interface PitStopNavSettings {
  raceDate: string;
  startTimeStr: string;
  clockOffsetMs: number;
  calibrationPct: number;
  sensorMode: SensorMode;
  wBaseValue: number;
  transitionAdvanceM: number;
  activeRowLine: 1 | 2;
  reducePassedRow: boolean;
  showPassedTick: boolean;
  highlightTheme: HighlightTheme;
  voiceEnabled: boolean;
  voiceUnit: VoiceUnit;
  voiceThresholds: number[];
  alertStyle: AlertStyle;
  pilotDisplay: PilotDisplayOptions;
  shortcuts: ShortcutBindings;
  pairing: PairingSettings;
  wPasses: CalibrationPassRecord[];
  baseServerUrl: string;
  screenOrientation: ScreenOrientationLock;
  goproAutoRecOnStart: boolean;
  appTheme: AppThemeId;
}

const STORAGE_KEY = 'pitstop_nav_settings_v1';
const SETTINGS_EVENT = 'pitstop:nav-settings-updated';

function getTodayDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDefaultTime(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
}

export function getDefaultPilotDisplay(): PilotDisplayOptions {
  return {
    showDistance: true,
    showOdometer: true,
    showSpeed: true,
    showTargetSpeed: true,
    showTnav: true,
    showColorBar: true,
    showDeltaMeters: false,
    showClock: false,
    showDesenho: true,
    showCap: true,
    showObs: true,
  };
}

export function getDefaultShortcuts(): ShortcutBindings {
  return {
    syncHere: 'Enter',
    odoPlus: 'ArrowUp',
    odoMinus: 'ArrowDown',
    nextTulipa: 'ArrowRight',
    prevTulipa: 'ArrowLeft',
    toggleRun: ' ',
  };
}

export function getDefaultNavSettings(): PitStopNavSettings {
  return {
    raceDate: getTodayDate(),
    startTimeStr: getDefaultTime(),
    clockOffsetMs: 0,
    calibrationPct: 100.0,
    sensorMode: 'gps',
    wBaseValue: 4000,
    transitionAdvanceM: 5,
    activeRowLine: 2,
    reducePassedRow: true,
    showPassedTick: true,
    highlightTheme: 'yellow',
    voiceEnabled: true,
    voiceUnit: 'meters',
    voiceThresholds: [100, 50, 20],
    alertStyle: 'voice',
    pilotDisplay: getDefaultPilotDisplay(),
    shortcuts: getDefaultShortcuts(),
    pairing: {
      enabled: false,
      role: 'navigator',
      roomCode: generatePairingRoomCode(),
      roomPin: generatePairingRoomPin(),
      transportMode: 'auto',
      bluetoothDevices: [],
    },
    wPasses: [],
    baseServerUrl: '',
    screenOrientation: 'auto',
    goproAutoRecOnStart: false,
    appTheme: 'pitstop',
  };
}

export function getNavSettings(): PitStopNavSettings {
  const defaults = getDefaultNavSettings();
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PitStopNavSettings>;
    const alertStyle: AlertStyle =
      parsed.alertStyle === 'beep_short' ||
      parsed.alertStyle === 'beep_long' ||
      parsed.alertStyle === 'vibration'
        ? parsed.alertStyle
        : 'voice';
    const transportMode: PairingTransportMode =
      parsed.pairing?.transportMode === 'bluetooth_spp' ||
      parsed.pairing?.transportMode === 'wifi_ws'
        ? parsed.pairing.transportMode
        : 'auto';
    const rawDevices = Array.isArray(parsed.pairing?.bluetoothDevices)
      ? parsed.pairing!.bluetoothDevices.filter(
          (d): d is BondedBluetoothDevice =>
            Boolean(d && typeof d.address === 'string' && d.address.trim())
        )
      : [];
    return {
      ...defaults,
      ...parsed,
      activeRowLine: parsed.activeRowLine === 1 ? 1 : 2,
      highlightTheme:
        parsed.highlightTheme === 'blue' || parsed.highlightTheme === 'green'
          ? parsed.highlightTheme
          : 'yellow',
      sensorMode: parsed.sensorMode === 'blue' ? 'blue' : 'gps',
      voiceUnit: parsed.voiceUnit === 'seconds' ? 'seconds' : 'meters',
      alertStyle,
      pilotDisplay: {
        ...defaults.pilotDisplay,
        ...(parsed.pilotDisplay || {}),
      },
      shortcuts: {
        ...defaults.shortcuts,
        ...(parsed.shortcuts || {}),
      },
      pairing: {
        enabled: Boolean(parsed.pairing?.enabled),
        role: parsed.pairing?.role === 'pilot' ? 'pilot' : 'navigator',
        roomCode:
          normalizeRoomCode(parsed.pairing?.roomCode || '') || defaults.pairing.roomCode,
        roomPin:
          normalizeRoomPin(parsed.pairing?.roomPin || '') || defaults.pairing.roomPin,
        transportMode,
        bluetoothDevices: rawDevices.slice(0, 3),
        bluetoothDeviceName: parsed.pairing?.bluetoothDeviceName || '',
      },
      wPasses: Array.isArray(parsed.wPasses) ? parsed.wPasses.slice(0, 6) : [],
      screenOrientation:
        parsed.screenOrientation === 'portrait' || parsed.screenOrientation === 'landscape'
          ? parsed.screenOrientation
          : 'auto',
      goproAutoRecOnStart: Boolean(parsed.goproAutoRecOnStart),
      appTheme:
        parsed.appTheme === 'gt' ||
        parsed.appTheme === 'fueltech' ||
        parsed.appTheme === 'subaru' ||
        parsed.appTheme === 'gulf' ||
        parsed.appTheme === 'martini' ||
        parsed.appTheme === 'cyberpunk' ||
        parsed.appTheme === 'castrol' ||
        parsed.appTheme === 'night' ||
        parsed.appTheme === 'solar'
          ? parsed.appTheme
          : 'pitstop',
      voiceThresholds:
        Array.isArray(parsed.voiceThresholds) && parsed.voiceThresholds.length > 0
          ? parsed.voiceThresholds
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n > 0)
              .sort((a, b) => b - a)
          : defaults.voiceThresholds,
    };
  } catch {
    return defaults;
  }
}

export function applyAppThemeToDocument(themeId: AppThemeId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', themeId);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    const colorMap: Record<AppThemeId, string> = {
      pitstop: '#090A0D',
      gt: '#0F172A',
      fueltech: '#000000',
      subaru: '#071430',
      gulf: '#081929',
      martini: '#0A1324',
      cyberpunk: '#0B0514',
      castrol: '#051610',
      night: '#050506',
      solar: '#F1F5F9',
    };
    metaTheme.setAttribute('content', colorMap[themeId]);
  }
}

if (typeof window !== 'undefined') {
  applyAppThemeToDocument(getNavSettings().appTheme);
}

export function updateNavSettings(
  patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)
): PitStopNavSettings {
  const current = getNavSettings();
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  applyAppThemeToDocument(next.appTheme);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
  } catch {
    // Ignore quota errors
  }
  return next;
}

export function useNavSettings(): [
  PitStopNavSettings,
  (patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)) => void
] {
  const [settings, setSettings] = useState<PitStopNavSettings>(() => getNavSettings());

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<PitStopNavSettings>).detail;
      if (detail) {
        setSettings(detail);
      } else {
        setSettings(getNavSettings());
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setSettings(getNavSettings());
      }
    };
    window.addEventListener(SETTINGS_EVENT, onUpdate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onUpdate);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const update = useCallback(
    (patch: Partial<PitStopNavSettings> | ((prev: PitStopNavSettings) => PitStopNavSettings)) => {
      const saved = updateNavSettings(patch);
      setSettings(saved);
    },
    []
  );

  return [settings, update];
}

export function wValueFromCalibrationPct(
  calibrationPct: number,
  wBaseValue = 4000
): number {
  const safeBase = wBaseValue > 0 ? wBaseValue : 4000;
  return Math.round(safeBase * (calibrationPct / 100));
}

export function calibrationPctFromWValue(
  wValue: number,
  wBaseValue = 4000
): number {
  const safeBase = wBaseValue > 0 ? wBaseValue : 4000;
  if (!Number.isFinite(wValue) || wValue <= 0) return 100;
  return Number(Math.min(130, Math.max(70, (wValue / safeBase) * 100)).toFixed(2));
}
