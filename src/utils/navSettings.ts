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
  | 'neo'
  | 'pitstop'
  | 'daylight_pro'
  | 'daylight_xl'
  | 'neo_xl'
  | 'rally_paper'
  | 'solar_yellow_xl'
  | 'toxic_volt_xl'
  | 'hyper_orange_xl'
  | 'electric_magenta_xl'
  | 'gulf_racing_xl'
  | 'gt'
  | 'fueltech'
  | 'subaru'
  | 'gulf'
  | 'martini'
  | 'cyberpunk'
  | 'castrol'
  | 'night'
  | 'solar'
  | 'neon_cyan'
  | 'neon_amber'
  | 'neon_lime'
  | 'neon_red'
  | 'old_vdo'
  | 'old_terratrip'
  | 'futuristic_hud'
  | 'cyber_plasma';

export interface AppThemeOption {
  id: AppThemeId;
  name: string;
  tag: string;
  scalePct: number;
  description: string;
  bg: string;
  surface: string;
  card: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  border: string;
  fontClass: string;
  darkAccentText?: boolean;
}

export const APP_THEME_OPTIONS: AppThemeOption[] = [
  {
    id: 'neo',
    name: 'Neo',
    tag: 'Original · Neon',
    scalePct: 100,
    description: 'Fundo preto carbono (#090A0D), cartões #12141A e verde-lima neon (#84CC16).',
    bg: '#090A0D',
    surface: '#0E1015',
    card: '#12141A',
    accent: '#84CC16',
    accent2: '#A3E635',
    text: '#F8FAFC',
    muted: '#94A3B8',
    border: 'rgba(132,204,22,0.34)',
    fontClass: "font-['Outfit']",
    darkAccentText: true,
  },
  {
    id: 'neo_xl',
    name: 'Neo XL',
    tag: 'XL · 120%',
    scalePct: 120,
    description: 'Paleta do Neo (#090A0D / #12141A / #84CC16) com fontes, menus e números ampliados (120%).',
    bg: '#090A0D',
    surface: '#0E1015',
    card: '#12141A',
    accent: '#84CC16',
    accent2: '#A3E635',
    text: '#F8FAFC',
    muted: '#CBD5E1',
    border: 'rgba(132,204,22,0.48)',
    fontClass: "font-['Outfit']",
    darkAccentText: true,
  },
  {
    id: 'daylight_pro',
    name: 'Daylight Pro',
    tag: 'Claro · Sol Forte',
    scalePct: 100,
    description: 'Fundo claro (#F4F6F8), cartões brancos (#FFFFFF), textos escuros (#0F172A) e Vermelho Racing (#E10600).',
    bg: '#F4F6F8',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    accent: '#E10600',
    accent2: '#B91C1C',
    text: '#0F172A',
    muted: '#475569',
    border: 'rgba(15,23,42,0.18)',
    fontClass: 'font-mono',
  },
  {
    id: 'daylight_xl',
    name: 'Daylight XL',
    tag: 'Claro · XL 120%',
    scalePct: 120,
    description: 'Paleta clara de alto contraste (#F4F6F8 / #FFFFFF / #E10600) com fontes e números grandes (120%).',
    bg: '#F4F6F8',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    accent: '#E10600',
    accent2: '#B91C1C',
    text: '#0F172A',
    muted: '#334155',
    border: 'rgba(15,23,42,0.24)',
    fontClass: 'font-mono',
  },
  {
    id: 'rally_paper',
    name: 'Rally Paper',
    tag: 'Planilha · 112%',
    scalePct: 112,
    description: 'Fundo creme anti-reflexo (#F7F4EC), cartões brancos, textos pretos e azul-cobalto (112%).',
    bg: '#F7F4EC',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    accent: '#1D4ED8',
    accent2: '#2563EB',
    text: '#18181B',
    muted: '#52525B',
    border: 'rgba(24,24,27,0.2)',
    fontClass: 'font-mono',
  },
  {
    id: 'solar_yellow_xl',
    name: 'Solar Yellow XL',
    tag: 'WRC · XL 122%',
    scalePct: 122,
    description: 'Fundo amarelo-solar (#FEF08A), cartões #FFFFFF com bordas pretas fortes e textos pretos (122%).',
    bg: '#FEF08A',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    accent: '#09090B',
    accent2: '#27272A',
    text: '#09090B',
    muted: '#27272A',
    border: 'rgba(9,9,11,0.72)',
    fontClass: 'font-mono',
  },
  {
    id: 'toxic_volt_xl',
    name: 'Toxic Volt XL',
    tag: 'Volt · XL 125%',
    scalePct: 125,
    description: 'Fundo preto puro (#050705), cartões #111711 e verde-volt marca-texto (#B8FF00) em 125%.',
    bg: '#050705',
    surface: '#0B0F0B',
    card: '#111711',
    accent: '#B8FF00',
    accent2: '#D4FF4D',
    text: '#F7FEE7',
    muted: '#BEF264',
    border: 'rgba(184,255,0,0.44)',
    fontClass: 'font-mono',
    darkAccentText: true,
  },
  {
    id: 'hyper_orange_xl',
    name: 'Hyper Orange XL',
    tag: 'Dakar · XL 122%',
    scalePct: 122,
    description: 'Carbono (#0C0A09), cartões #1C1917 e laranja-néon (#FF5500) com escala 122%.',
    bg: '#0C0A09',
    surface: '#141210',
    card: '#1C1917',
    accent: '#FF5500',
    accent2: '#FF7A33',
    text: '#FFF7ED',
    muted: '#FDBA74',
    border: 'rgba(255,85,0,0.44)',
    fontClass: 'font-mono',
  },
  {
    id: 'electric_magenta_xl',
    name: 'Electric Magenta XL',
    tag: 'Neon · XL 120%',
    scalePct: 120,
    description: 'Preto profundo (#09050F), cartões #160D24 e rosa-choque neon (#FF007F) em 120%.',
    bg: '#09050F',
    surface: '#10091A',
    card: '#160D24',
    accent: '#FF007F',
    accent2: '#FF4DA6',
    text: '#FDF2F8',
    muted: '#F9A8D4',
    border: 'rgba(255,0,127,0.44)',
    fontClass: "font-['Outfit']",
  },
  {
    id: 'gulf_racing_xl',
    name: 'Gulf Racing XL',
    tag: 'Claro · XL 118%',
    scalePct: 118,
    description: 'Azul-gelo claro (#E0F2FE), cartões brancos, azul-marinho (#0C4A6E) e laranja (#F97316) em 118%.',
    bg: '#E0F2FE',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    accent: '#F97316',
    accent2: '#EA580C',
    text: '#0C4A6E',
    muted: '#0369A1',
    border: 'rgba(12,74,110,0.26)',
    fontClass: 'font-mono',
  },
  {
    id: 'pitstop',
    name: 'PitStop Original',
    tag: 'FREE · Original',
    scalePct: 100,
    description: 'Preto carbono (#090A0D), superfícies foscas e Vermelho Racing (#E10600).',
    bg: '#090A0D',
    surface: '#111318',
    card: '#181B22',
    accent: '#E10600',
    accent2: '#FF2A2A',
    text: '#F4F4F5',
    muted: '#A1A1AA',
    border: 'rgba(255,255,255,0.12)',
    fontClass: 'font-mono',
  },
  {
    id: 'solar',
    name: 'Solar Dia',
    tag: 'FREE · Alto Contraste',
    scalePct: 100,
    description: 'Fundo claro (#F1F5F9), cards brancos (#FFFFFF) e texto preto para sol forte.',
    bg: '#F1F5F9',
    surface: '#FFFFFF',
    card: '#F8FAFC',
    accent: '#E10600',
    accent2: '#B91C1C',
    text: '#090D16',
    muted: '#475569',
    border: 'rgba(15,23,42,0.16)',
    fontClass: 'font-mono',
  },
  {
    id: 'fueltech',
    name: 'FuelTech Pro (OLED)',
    tag: 'PRO · OLED',
    scalePct: 100,
    description: 'Preto puro #000000 OLED com Azul Elétrico (#0EA5E9) e Laranja Âmbar (#F59E0B).',
    bg: '#000000',
    surface: '#070B12',
    card: '#0F1724',
    accent: '#0EA5E9',
    accent2: '#F59E0B',
    text: '#F8FAFC',
    muted: '#94A3B8',
    border: 'rgba(14,165,233,0.32)',
    fontClass: "font-['Barlow_Condensed']",
  },
  {
    id: 'subaru',
    name: 'Subaru WRX Rally',
    tag: 'PRO · WRC',
    scalePct: 100,
    description: 'World Rally Blue (#1D4ED8) combinado com Amarelo Ouro (#FACC15) de especial.',
    bg: '#071430',
    surface: '#0C214D',
    card: '#132F68',
    accent: '#1D4ED8',
    accent2: '#FACC15',
    text: '#F8FAFC',
    muted: '#93C5FD',
    border: 'rgba(250,204,21,0.32)',
    fontClass: 'font-mono',
  },
  {
    id: 'gulf',
    name: 'Gulf Racing',
    tag: 'PRO · Heritage',
    scalePct: 100,
    description: 'Azul Claro (#38BDF8) combinado com Laranja Gulf (#F97316) clássico de pista.',
    bg: '#081929',
    surface: '#0E2942',
    card: '#163959',
    accent: '#38BDF8',
    accent2: '#F97316',
    text: '#F0F9FF',
    muted: '#7DD3FC',
    border: 'rgba(56,189,248,0.3)',
    fontClass: 'font-mono',
    darkAccentText: true,
  },
  {
    id: 'martini',
    name: 'Martini Racing',
    tag: 'PRO · Group B',
    scalePct: 100,
    description: 'Azul Marinho grafite com listras em Vermelho (#E11D48) e Azul Claro (#38BDF8).',
    bg: '#0A1324',
    surface: '#111F38',
    card: '#192C4D',
    accent: '#E11D48',
    accent2: '#38BDF8',
    text: '#F8FAFC',
    muted: '#93C5FD',
    border: 'rgba(56,189,248,0.3)',
    fontClass: 'font-mono',
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk Magenta',
    tag: 'PRO · Synth',
    scalePct: 100,
    description: 'Roxo-preto noturno (#0B0514) com Rosa Neon (#EC4899) e Ciano (#06B6D4).',
    bg: '#0B0514',
    surface: '#150A24',
    card: '#211038',
    accent: '#EC4899',
    accent2: '#06B6D4',
    text: '#FDF4FF',
    muted: '#C4B5FD',
    border: 'rgba(236,72,153,0.32)',
    fontClass: "font-['Outfit']",
  },
  {
    id: 'castrol',
    name: "Castrol Tom's",
    tag: 'PRO · Endurance',
    scalePct: 100,
    description: 'Verde Esmeralda escuro (#051610) com acentos Verde (#10B981) e Vermelho (#EF4444).',
    bg: '#051610',
    surface: '#09241B',
    card: '#0F3527',
    accent: '#10B981',
    accent2: '#EF4444',
    text: '#ECFDF5',
    muted: '#6EE7B7',
    border: 'rgba(16,185,129,0.32)',
    fontClass: 'font-mono',
    darkAccentText: true,
  },
  {
    id: 'night',
    name: 'Rally Noturno (Night Vision)',
    tag: 'PRO · Noturno',
    scalePct: 100,
    description: 'Preto fosco (#050506) com vermelho rubi e âmbar suaves anti-ofuscamento.',
    bg: '#050506',
    surface: '#0B0B0E',
    card: '#121216',
    accent: '#DC2626',
    accent2: '#D97706',
    text: '#E5D4CE',
    muted: '#9C7E76',
    border: 'rgba(220,38,38,0.3)',
    fontClass: 'font-mono',
  },
  {
    id: 'neon_cyan',
    name: 'Neon Cyan (Tron)',
    tag: 'PRO · Neon',
    scalePct: 100,
    description: 'Fundo #06090F, cartões #0D131F e azul ciano elétrico #00F5FF com fonte Orbitron.',
    bg: '#06090F',
    surface: '#090E18',
    card: '#0D131F',
    accent: '#00F5FF',
    accent2: '#38BDF8',
    text: '#ECFEFF',
    muted: '#67E8F9',
    border: 'rgba(0,245,255,0.32)',
    fontClass: "font-['Orbitron']",
    darkAccentText: true,
  },
  {
    id: 'neon_amber',
    name: 'Neon Âmbar (Rally Night)',
    tag: 'PRO · Neon',
    scalePct: 100,
    description: 'Fundo #0A0806, cartões #16120E e laranja âmbar noturno #FF9E00 com fonte Orbitron.',
    bg: '#0A0806',
    surface: '#110E0A',
    card: '#16120E',
    accent: '#FF9E00',
    accent2: '#FFB703',
    text: '#FFFBEB',
    muted: '#FBBF24',
    border: 'rgba(255,158,0,0.34)',
    fontClass: "font-['Orbitron']",
    darkAccentText: true,
  },
  {
    id: 'neon_lime',
    name: 'Neon Acid Lime (WRC)',
    tag: 'PRO · Neon',
    scalePct: 100,
    description: 'Fundo #080A06, cartões #11160D e verde-limão ácido #CCFF00 com fonte Orbitron.',
    bg: '#080A06',
    surface: '#0D1109',
    card: '#11160D',
    accent: '#CCFF00',
    accent2: '#D9FF33',
    text: '#F7FEE7',
    muted: '#BEF264',
    border: 'rgba(204,255,0,0.34)',
    fontClass: "font-['Orbitron']",
    darkAccentText: true,
  },
  {
    id: 'neon_red',
    name: 'Neon Laser Red',
    tag: 'PRO · Neon',
    scalePct: 100,
    description: 'Fundo #0B0607, cartões #160C0E e vermelho laser #FF1744 com fonte Orbitron.',
    bg: '#0B0607',
    surface: '#11090B',
    card: '#160C0E',
    accent: '#FF1744',
    accent2: '#FF4569',
    text: '#FFF1F2',
    muted: '#FDA4AF',
    border: 'rgba(255,23,68,0.36)',
    fontClass: "font-['Orbitron']",
  },
  {
    id: 'old_vdo',
    name: 'Old VDO Green (80s/90s)',
    tag: 'PRO · Old School',
    scalePct: 100,
    description: 'Painéis VDO Gol GTI / Kadett GSi: preto fosco #0B0D0B e verde clássico #38E57D.',
    bg: '#0B0D0B',
    surface: '#0F120F',
    card: '#131713',
    accent: '#38E57D',
    accent2: '#6EE7B7',
    text: '#ECFDF5',
    muted: '#86EFAC',
    border: 'rgba(56,229,125,0.32)',
    fontClass: "font-['Share_Tech_Mono']",
    darkAccentText: true,
  },
  {
    id: 'old_terratrip',
    name: 'Old Terratrip (Rally)',
    tag: 'PRO · Old School',
    scalePct: 100,
    description: 'Computadores de rally antigos: grafite quente #161310 e dígitos laranja #FF6A00.',
    bg: '#161310',
    surface: '#1B1713',
    card: '#211C17',
    accent: '#FF6A00',
    accent2: '#FF8C33',
    text: '#FFF7ED',
    muted: '#FDBA74',
    border: 'rgba(255,106,0,0.36)',
    fontClass: "font-['Share_Tech_Mono']",
  },
  {
    id: 'futuristic_hud',
    name: 'Futuristic HUD (Caça/F1)',
    tag: 'PRO · Futurista',
    scalePct: 100,
    description: 'Fundo azul-aço #050B14, cartões #0B1626 e azul holográfico #38BDF8.',
    bg: '#050B14',
    surface: '#08111D',
    card: '#0B1626',
    accent: '#38BDF8',
    accent2: '#7DD3FC',
    text: '#F0F9FF',
    muted: '#7DD3FC',
    border: 'rgba(56,189,248,0.34)',
    fontClass: "font-['Orbitron']",
    darkAccentText: true,
  },
  {
    id: 'cyber_plasma',
    name: 'Cyber Plasma',
    tag: 'PRO · Futurista',
    scalePct: 100,
    description: 'Fundo abissal #070510, cartões #120D24 e magenta/plasma #E879F9.',
    bg: '#070510',
    surface: '#0C091A',
    card: '#120D24',
    accent: '#E879F9',
    accent2: '#F0ABFC',
    text: '#FAF5FF',
    muted: '#F0ABFC',
    border: 'rgba(232,121,249,0.34)',
    fontClass: "font-['Orbitron']",
    darkAccentText: true,
  },
];

const VALID_APP_THEME_IDS = new Set<AppThemeId>([
  'gt',
  ...APP_THEME_OPTIONS.map((t) => t.id),
]);

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
        parsed.appTheme && VALID_APP_THEME_IDS.has(parsed.appTheme as AppThemeId)
          ? (parsed.appTheme === 'gt' ? 'neo' : (parsed.appTheme as AppThemeId))
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
      neo: '#090A0D',
      pitstop: '#090A0D',
      daylight_pro: '#F4F6F8',
      daylight_xl: '#F4F6F8',
      neo_xl: '#090A0D',
      rally_paper: '#F7F4EC',
      solar_yellow_xl: '#FEF08A',
      toxic_volt_xl: '#050705',
      hyper_orange_xl: '#0C0A09',
      electric_magenta_xl: '#09050F',
      gulf_racing_xl: '#E0F2FE',
      gt: '#090A0D',
      fueltech: '#000000',
      subaru: '#071430',
      gulf: '#081929',
      martini: '#0A1324',
      cyberpunk: '#0B0514',
      castrol: '#051610',
      night: '#050506',
      solar: '#F1F5F9',
      neon_cyan: '#06090F',
      neon_amber: '#0A0806',
      neon_lime: '#080A06',
      neon_red: '#0B0607',
      old_vdo: '#0B0D0B',
      old_terratrip: '#161310',
      futuristic_hud: '#050B14',
      cyber_plasma: '#070510',
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
