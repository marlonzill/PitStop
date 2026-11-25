import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

export const SUPABASE_URL = 'https://xoicjwgoovpqouxmliru.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_7My7wzmW62pPHSq27G7rpQ_YULvsrGk';
export const APP_VERSION = 'v2.0.5';

const DEVICE_IDENTITY_KEY = 'pitstop_device_identity_v1';
const DEVICE_LICENSE_CACHE_KEY = 'pitstop_device_license_cache_v1';
const ADMIN_SESSION_KEY = 'pitstop_supabase_admin_session_v1';
const ADMIN_SESSION_EVENT = 'pitstop:admin-license-session-updated';

const TRIAL_24H_MS = 24 * 60 * 60 * 1000; // 24 horas grátis na primeira instalação
const OFFLINE_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_TRIAL_PILOT_NAME = 'Novo Piloto (Teste 24h)';

export interface DeviceIdentity {
  deviceId: string;
  deviceModel: string;
  appVersion: string;
}

export interface DispositivoRecord {
  device_id: string;
  pilot_name?: string | null;
  device_model?: string | null;
  app_version?: string | null;
  allowed?: boolean | null;
  expires_at?: string | null;
  last_seen_at?: string | null;
}

export interface DeviceLicenseCache {
  deviceId: string;
  allowed: boolean;
  expiresAt: string | null;
  pilotName: string | null;
  verifiedAtMs: number;
}

export type DeviceBlockReason = 'disabled' | 'expired' | 'offline_expired';

export interface DeviceLicenseStatus {
  status: 'allowed' | 'blocked';
  reason?: DeviceBlockReason;
  offlineGrace: boolean;
  isAdminBypass?: boolean;
  identity: DeviceIdentity;
  pilotName: string | null;
  expiresAt: string | null;
  lastVerifiedAtMs: number | null;
  syncError?: string;
}

export interface AdminLicenseSession {
  username: string;
  role: 'admin';
  loggedInAtIso: string;
}

interface CapacitorDevicePluginLike {
  getId?: () => Promise<{ identifier?: string }>;
  getInfo?: () => Promise<{
    model?: string;
    manufacturer?: string;
    platform?: string;
    operatingSystem?: string;
    osVersion?: string;
  }>;
}

function getCapacitorDevicePlugin(): CapacitorDevicePluginLike | null {
  try {
    const cap = Capacitor as unknown as {
      Plugins?: { Device?: CapacitorDevicePluginLike };
    };
    if (cap?.Plugins?.Device) return cap.Plugins.Device;
    if (typeof window !== 'undefined') {
      const winCap = (
        window as unknown as {
          Capacitor?: { Plugins?: { Device?: CapacitorDevicePluginLike } };
        }
      ).Capacitor;
      if (winCap?.Plugins?.Device) return winCap.Plugins.Device;
    }
  } catch {
    // Ignore reflection issues
  }
  return null;
}

const READABLE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function formatReadableDeviceCodeFromSeed(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b) >>> 0;
  }
  let part1 = '';
  let part2 = '';
  for (let i = 0; i < 4; i += 1) {
    part1 += READABLE_CHARS[(h1 >>> (i * 5)) % READABLE_CHARS.length];
    part2 += READABLE_CHARS[(h2 >>> (i * 5)) % READABLE_CHARS.length];
  }
  return `PS-${part1}-${part2}`;
}

function generateRandomReadableDeviceId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let p1 = '';
  let p2 = '';
  for (let i = 0; i < 4; i += 1) {
    p1 += READABLE_CHARS[bytes[i] % READABLE_CHARS.length];
    p2 += READABLE_CHARS[bytes[i + 4] % READABLE_CHARS.length];
  }
  return `PS-${p1}-${p2}`;
}

function detectWebDeviceModel(): string {
  if (typeof navigator === 'undefined') return 'Web Browser';
  const nav = navigator as Navigator & {
    userAgentData?: { model?: string; platform?: string };
  };
  const ua = navigator.userAgent || '';

  const androidMatch = ua.match(/Android\s*([0-9.]+)?;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
  if (androidMatch) {
    const ver = androidMatch[1] ? `Android ${androidMatch[1]}` : 'Android';
    const model = androidMatch[2]?.trim();
    if (model && model.toLowerCase() !== 'k') {
      return `${model} (${ver})`.slice(0, 80);
    }
    return ver;
  }

  if (/iPhone/i.test(ua)) return 'Apple iPhone (iOS)';
  if (/iPad/i.test(ua)) return 'Apple iPad (iPadOS)';

  const uaPlatform = nav.userAgentData?.platform || '';
  if (nav.userAgentData?.model) {
    return `${nav.userAgentData.model}${uaPlatform ? ` (${uaPlatform})` : ''}`.slice(0, 80);
  }
  if (/Windows/i.test(ua)) return 'Windows Web';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS Web';
  if (/Linux/i.test(ua)) return 'Linux Web';
  return uaPlatform || 'Web Browser';
}

export function getStoredAdminSession(): AdminLicenseSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AdminLicenseSession>;
    if (parsed?.role === 'admin' && typeof parsed.username === 'string' && parsed.username.trim()) {
      return {
        username: parsed.username.trim(),
        role: 'admin',
        loggedInAtIso: String(parsed.loggedInAtIso || new Date().toISOString()),
      };
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

export function isDeviceAdminLoggedIn(): boolean {
  return getStoredAdminSession() !== null;
}

export function authenticateUnifiedAdmin(
  usernameOrEmail: string,
  password: string
): AdminLicenseSession | null {
  const normalizedUser = usernameOrEmail.trim().toLowerCase();
  const normalizedPass = password.trim();
  if (normalizedUser !== 'marlonzill' || normalizedPass !== '147258') {
    return null;
  }
  const session: AdminLicenseSession = {
    username: 'marlonzill',
    role: 'admin',
    loggedInAtIso: new Date().toISOString(),
  };
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
      window.dispatchEvent(new CustomEvent(ADMIN_SESSION_EVENT, { detail: session }));
    }
  } catch {
    // Ignore storage error
  }
  return session;
}

export function logoutAdminSession(): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ADMIN_SESSION_KEY);
      window.dispatchEvent(new CustomEvent(ADMIN_SESSION_EVENT, { detail: null }));
    }
  } catch {
    // Ignore storage error
  }
}

export function useAdminLicenseSession(): AdminLicenseSession | null {
  const [adminSession, setAdminSession] = useState<AdminLicenseSession | null>(() =>
    getStoredAdminSession()
  );

  useEffect(() => {
    const sync = () => setAdminSession(getStoredAdminSession());
    const onStorage = (e: StorageEvent) => {
      if (e.key === ADMIN_SESSION_KEY) sync();
    };
    window.addEventListener(ADMIN_SESSION_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(ADMIN_SESSION_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return adminSession;
}

export function readStoredDeviceIdentitySync(): DeviceIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (typeof parsed?.deviceId === 'string' && parsed.deviceId.trim().length >= 5) {
      return {
        deviceId: parsed.deviceId.trim(),
        deviceModel:
          typeof parsed.deviceModel === 'string' && parsed.deviceModel.trim()
            ? parsed.deviceModel.trim()
            : detectWebDeviceModel(),
        appVersion: APP_VERSION,
      };
    }
  } catch {
    // Ignore storage parse error
  }
  return null;
}

export function getOrCreateDeviceIdentitySync(): DeviceIdentity {
  const existing = readStoredDeviceIdentitySync();
  if (existing) return existing;
  const identity: DeviceIdentity = {
    deviceId: generateRandomReadableDeviceId(),
    deviceModel: detectWebDeviceModel(),
    appVersion: APP_VERSION,
  };
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
    }
  } catch {
    // Ignore storage error
  }
  return identity;
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const existing = readStoredDeviceIdentitySync();
  const devicePlugin = getCapacitorDevicePlugin();

  let nativeModel: string | null = null;
  let nativeSeedId: string | null = null;

  if (devicePlugin) {
    try {
      const info = await devicePlugin.getInfo?.();
      if (info) {
        const mfg = info.manufacturer?.trim() || '';
        const mdl = info.model?.trim() || '';
        const os = info.operatingSystem?.trim() || info.platform?.trim() || '';
        const osVer = info.osVersion?.trim() || '';
        const namePart = [mfg, mdl]
          .filter((v, idx, arr) => Boolean(v) && (idx === 0 || v.toLowerCase() !== arr[0].toLowerCase()))
          .join(' ');
        const osPart = [os, osVer].filter(Boolean).join(' ');
        const combined = [namePart, osPart ? `(${osPart})` : ''].filter(Boolean).join(' ');
        if (combined) nativeModel = combined.slice(0, 80);
      }
    } catch {
      // Ignore native info errors
    }
    if (!existing) {
      try {
        const idRes = await devicePlugin.getId?.();
        if (idRes?.identifier && idRes.identifier.trim().length > 0) {
          nativeSeedId = idRes.identifier.trim();
        }
      } catch {
        // Ignore native ID errors
      }
    }
  }

  const identity: DeviceIdentity = {
    deviceId:
      existing?.deviceId ??
      (nativeSeedId
        ? formatReadableDeviceCodeFromSeed(nativeSeedId)
        : generateRandomReadableDeviceId()),
    deviceModel: nativeModel || existing?.deviceModel || detectWebDeviceModel(),
    appVersion: APP_VERSION,
  };

  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
    }
  } catch {
    // Ignore storage write error
  }

  return identity;
}

export function readLicenseCache(): DeviceLicenseCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_LICENSE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceLicenseCache>;
    if (
      typeof parsed?.deviceId === 'string' &&
      typeof parsed?.allowed === 'boolean' &&
      typeof parsed?.verifiedAtMs === 'number' &&
      Number.isFinite(parsed.verifiedAtMs)
    ) {
      return {
        deviceId: parsed.deviceId,
        allowed: parsed.allowed,
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
        pilotName: typeof parsed.pilotName === 'string' ? parsed.pilotName : null,
        verifiedAtMs: parsed.verifiedAtMs,
      };
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

function saveLicenseCache(cache: DeviceLicenseCache): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEVICE_LICENSE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage error
  }
}

export function isLicenseExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts < Date.now();
}

export function getCachedLicenseStatusSync(): DeviceLicenseStatus {
  const identity = getOrCreateDeviceIdentitySync();
  const cache = readLicenseCache();
  const adminLogged = isDeviceAdminLoggedIn();

  if (adminLogged) {
    return {
      status: 'allowed',
      offlineGrace: false,
      isAdminBypass: true,
      identity,
      pilotName: cache?.pilotName ?? 'Administrador (marlonzill)',
      expiresAt: null,
      lastVerifiedAtMs: cache?.verifiedAtMs ?? Date.now(),
    };
  }

  if (cache && cache.deviceId === identity.deviceId) {
    const expired = isLicenseExpired(cache.expiresAt);
    if (!cache.allowed || expired) {
      return {
        status: 'blocked',
        reason: !cache.allowed ? 'disabled' : 'expired',
        offlineGrace: false,
        identity,
        pilotName: cache.pilotName,
        expiresAt: cache.expiresAt,
        lastVerifiedAtMs: cache.verifiedAtMs,
      };
    }
    return {
      status: 'allowed',
      offlineGrace: true,
      identity,
      pilotName: cache.pilotName,
      expiresAt: cache.expiresAt,
      lastVerifiedAtMs: cache.verifiedAtMs,
    };
  }

  return {
    status: 'allowed',
    offlineGrace: true,
    identity,
    pilotName: null,
    expiresAt: null,
    lastVerifiedAtMs: null,
  };
}

function getSupabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function verifyDeviceLicense(): Promise<DeviceLicenseStatus> {
  const identity = await getOrCreateDeviceIdentity();
  const cache = readLicenseCache();
  const adminLogged = isDeviceAdminLoggedIn();
  const nowIso = new Date().toISOString();
  const encodedId = encodeURIComponent(identity.deviceId);
  const queryUrl = `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedId}&select=*`;

  try {
    const getRes = await fetchWithTimeout(queryUrl, {
      method: 'GET',
      headers: getSupabaseHeaders(),
    });

    if (!getRes.ok) {
      throw new Error(`HTTP ${getRes.status}`);
    }

    const rows = (await getRes.json()) as DispositivoRecord[];

    if (!Array.isArray(rows) || rows.length === 0) {
      // Primeira instalação: registra automaticamente com 1 dia grátis (24h)
      const trialExpiresAt = new Date(Date.now() + TRIAL_24H_MS).toISOString();
      const postRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/dispositivos`, {
        method: 'POST',
        headers: {
          ...getSupabaseHeaders(),
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          device_id: identity.deviceId,
          pilot_name: DEFAULT_TRIAL_PILOT_NAME,
          device_model: identity.deviceModel,
          app_version: identity.appVersion,
          allowed: true,
          expires_at: trialExpiresAt,
          last_seen_at: nowIso,
        }),
      });

      if (!postRes.ok) {
        throw new Error(`HTTP POST ${postRes.status}`);
      }

      let created: DispositivoRecord | null = null;
      try {
        const createdRows = (await postRes.json()) as DispositivoRecord[];
        created = Array.isArray(createdRows) ? createdRows[0] ?? null : null;
      } catch {
        created = null;
      }

      const allowed = created?.allowed !== false;
      const expiresAt =
        created && 'expires_at' in created ? (created.expires_at ?? null) : trialExpiresAt;
      const pilotName = created?.pilot_name ?? DEFAULT_TRIAL_PILOT_NAME;
      const verifiedAtMs = Date.now();

      saveLicenseCache({
        deviceId: identity.deviceId,
        allowed,
        expiresAt,
        pilotName,
        verifiedAtMs,
      });

      if (adminLogged) {
        return {
          status: 'allowed',
          offlineGrace: false,
          isAdminBypass: true,
          identity,
          pilotName,
          expiresAt,
          lastVerifiedAtMs: verifiedAtMs,
        };
      }

      if (!allowed || isLicenseExpired(expiresAt)) {
        return {
          status: 'blocked',
          reason: !allowed ? 'disabled' : 'expired',
          offlineGrace: false,
          identity,
          pilotName,
          expiresAt,
          lastVerifiedAtMs: verifiedAtMs,
        };
      }

      return {
        status: 'allowed',
        offlineGrace: false,
        identity,
        pilotName,
        expiresAt,
        lastVerifiedAtMs: verifiedAtMs,
      };
    }

    // Dispositivo já existe -> atualiza last_seen_at e lê allowed / expires_at
    const record = rows[0];
    const allowed = record.allowed !== false;
    const expiresAt = record.expires_at ?? null;
    const pilotName = record.pilot_name ?? null;
    const verifiedAtMs = Date.now();

    fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedId}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          last_seen_at: nowIso,
          device_model: identity.deviceModel,
          app_version: identity.appVersion,
        }),
      }
    ).catch(() => {});

    saveLicenseCache({
      deviceId: identity.deviceId,
      allowed,
      expiresAt,
      pilotName,
      verifiedAtMs,
    });

    if (adminLogged) {
      return {
        status: 'allowed',
        offlineGrace: false,
        isAdminBypass: true,
        identity,
        pilotName,
        expiresAt,
        lastVerifiedAtMs: verifiedAtMs,
      };
    }

    if (!allowed || isLicenseExpired(expiresAt)) {
      return {
        status: 'blocked',
        reason: !allowed ? 'disabled' : 'expired',
        offlineGrace: false,
        identity,
        pilotName,
        expiresAt,
        lastVerifiedAtMs: verifiedAtMs,
      };
    }

    return {
      status: 'allowed',
      offlineGrace: false,
      identity,
      pilotName,
      expiresAt,
      lastVerifiedAtMs: verifiedAtMs,
    };
  } catch (err) {
    const syncError = err instanceof Error ? err.message : 'Sem conexão com o servidor.';

    if (adminLogged) {
      return {
        status: 'allowed',
        offlineGrace: true,
        isAdminBypass: true,
        identity,
        pilotName: cache?.pilotName ?? 'Administrador (marlonzill)',
        expiresAt: null,
        lastVerifiedAtMs: cache?.verifiedAtMs ?? Date.now(),
        syncError,
      };
    }

    if (cache && cache.deviceId === identity.deviceId) {
      const expired = isLicenseExpired(cache.expiresAt);
      if (!cache.allowed || expired) {
        return {
          status: 'blocked',
          reason: !cache.allowed ? 'disabled' : 'expired',
          offlineGrace: false,
          identity,
          pilotName: cache.pilotName,
          expiresAt: cache.expiresAt,
          lastVerifiedAtMs: cache.verifiedAtMs,
          syncError,
        };
      }

      const ageMs = Date.now() - cache.verifiedAtMs;
      if (ageMs <= OFFLINE_TOLERANCE_MS) {
        return {
          status: 'allowed',
          offlineGrace: true,
          identity,
          pilotName: cache.pilotName,
          expiresAt: cache.expiresAt,
          lastVerifiedAtMs: cache.verifiedAtMs,
          syncError,
        };
      }

      return {
        status: 'blocked',
        reason: 'offline_expired',
        offlineGrace: false,
        identity,
        pilotName: cache.pilotName,
        expiresAt: cache.expiresAt,
        lastVerifiedAtMs: cache.verifiedAtMs,
        syncError,
      };
    }

    // Primeira execução sem internet: libera temporariamente para não travar em trilha sem sinal
    return {
      status: 'allowed',
      offlineGrace: true,
      identity,
      pilotName: null,
      expiresAt: null,
      lastVerifiedAtMs: null,
      syncError,
    };
  }
}

export async function fetchAllDispositivos(): Promise<DispositivoRecord[]> {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dispositivos?select=*&order=last_seen_at.desc.nullslast`,
    {
      method: 'GET',
      headers: getSupabaseHeaders(),
    }
  );
  if (!res.ok) {
    throw new Error(`Erro ao listar dispositivos (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as DispositivoRecord[];
  return Array.isArray(rows) ? rows : [];
}

export async function updateDispositivoRecord(
  deviceId: string,
  patch: Partial<Pick<DispositivoRecord, 'pilot_name' | 'allowed' | 'expires_at'>>
): Promise<DispositivoRecord> {
  const encodedId = encodeURIComponent(deviceId);
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedId}`,
    {
      method: 'PATCH',
      headers: {
        ...getSupabaseHeaders(),
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) {
    throw new Error(`Erro ao atualizar dispositivo (HTTP ${res.status}).`);
  }
  const rows = (await res.json().catch(() => [])) as DispositivoRecord[];
  const updated: DispositivoRecord =
    Array.isArray(rows) && rows[0] ? rows[0] : { device_id: deviceId, ...patch };

  const currentIdentity = getOrCreateDeviceIdentitySync();
  if (deviceId === currentIdentity.deviceId) {
    const existingCache = readLicenseCache();
    saveLicenseCache({
      deviceId,
      allowed: updated.allowed !== false,
      expiresAt:
        'expires_at' in updated ? (updated.expires_at ?? null) : (existingCache?.expiresAt ?? null),
      pilotName:
        'pilot_name' in updated ? (updated.pilot_name ?? null) : (existingCache?.pilotName ?? null),
      verifiedAtMs: Date.now(),
    });
  }

  return updated;
}

export async function deleteDispositivoRecord(deviceId: string): Promise<void> {
  const encodedId = encodeURIComponent(deviceId);
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedId}`,
    {
      method: 'DELETE',
      headers: getSupabaseHeaders(),
    }
  );
  if (!res.ok) {
    throw new Error(`Erro ao excluir dispositivo (HTTP ${res.status}).`);
  }
}
