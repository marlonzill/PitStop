import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION as ROOT_APP_VERSION } from '../version';

declare const __APP_BUILD_ISO__: string | undefined;

export const SUPABASE_URL = 'https://xoicjwgoovpqouxmliru.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_7My7wzmW62pPHSq27G7rpQ_YULvsrGk';
export const APP_VERSION = ROOT_APP_VERSION;
export const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/marlonzill/PitStop/releases/latest';
export const GITHUB_APK_DOWNLOAD_URL =
  'https://github.com/marlonzill/PitStop/releases/download/latest/PitStop-Sports.apk';

const DEVICE_IDENTITY_KEY = 'pitstop_device_identity_v1';
const DEVICE_LICENSE_CACHE_KEY = 'pitstop_device_license_cache_v1';
const ADMIN_SESSION_KEY = 'pitstop_supabase_admin_session_v1';
const ADMIN_SESSION_EVENT = 'pitstop:admin-license-session-updated';
const APP_VERSION_RESERVED_ID = '__APP_VERSION__';
const INSTALLED_RELEASE_AT_KEY = 'pitstop_installed_release_published_at_v1';

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

export interface OfficialAppVersionInfo {
  version: string;
  download_url?: string | null;
  source: 'app_version' | 'fallback';
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

export function isValidNumericDeviceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^\d{5}$/.test(id.trim());
}

function formatNumericDeviceCodeFromSeed(seed: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
  }
  const code = 10000 + (h1 % 90000);
  return String(code);
}

function generateRandomNumericDeviceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(10000 + (buf[0] % 90000));
  }
  return String(10000 + Math.floor(Math.random() * 90000));
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
    if (typeof parsed?.deviceId === 'string' && parsed.deviceId.trim().length > 0) {
      const trimmed = parsed.deviceId.trim();
      const numericId = isValidNumericDeviceId(trimmed)
        ? trimmed
        : formatNumericDeviceCodeFromSeed(trimmed);
      const migrated: DeviceIdentity = {
        deviceId: numericId,
        deviceModel:
          typeof parsed.deviceModel === 'string' && parsed.deviceModel.trim()
            ? parsed.deviceModel.trim()
            : detectWebDeviceModel(),
        appVersion: APP_VERSION,
      };
      if (numericId !== trimmed) {
        window.localStorage.setItem(DEVICE_IDENTITY_KEY, JSON.stringify(migrated));
      }
      return migrated;
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
    deviceId: generateRandomNumericDeviceId(),
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
      existing && isValidNumericDeviceId(existing.deviceId)
        ? existing.deviceId
        : nativeSeedId
          ? formatNumericDeviceCodeFromSeed(nativeSeedId)
          : generateRandomNumericDeviceId(),
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
      cache: 'no-store',
      headers: getSupabaseHeaders(),
    });

    if (!getRes.ok) {
      throw new Error(`HTTP ${getRes.status}`);
    }

    const rows = (await getRes.json()) as DispositivoRecord[];

    if (!Array.isArray(rows) || rows.length === 0) {
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
      cache: 'no-store',
      headers: getSupabaseHeaders(),
    }
  );
  if (!res.ok) {
    throw new Error(`Erro ao listar dispositivos (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as DispositivoRecord[];
  return Array.isArray(rows)
    ? rows.filter((r) => r.device_id !== APP_VERSION_RESERVED_ID)
    : [];
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

export function normalizeAppVersionString(raw: string): string {
  const clean = raw.trim().replace(/^v+/i, '');
  return clean ? `v${clean}` : APP_VERSION;
}

export function compareAppVersions(remoteVer: string, localVer: string): number {
  const parseParts = (v: string) =>
    v
      .trim()
      .replace(/^v+/i, '')
      .split('.')
      .map((n) => {
        const parsed = parseInt(n.replace(/[^0-9].*$/, ''), 10);
        return Number.isFinite(parsed) ? parsed : 0;
      });
  const a = parseParts(remoteVer);
  const b = parseParts(localVer);
  const maxLen = Math.max(a.length, b.length, 3);
  for (let i = 0; i < maxLen; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function sanitizeSafeDownloadUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export async function fetchOfficialAppVersion(): Promise<OfficialAppVersionInfo | null> {
  const cacheBust = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/app_version?select=*&limit=1&_t=${cacheBust}`,
      {
        method: 'GET',
        cache: 'no-store',
        headers: getSupabaseHeaders(),
      }
    );
    if (res.ok) {
      const rows = (await res.json()) as Array<{
        version?: string | null;
        download_url?: string | null;
      }>;
      if (Array.isArray(rows) && rows[0]?.version) {
        return {
          version: normalizeAppVersionString(rows[0].version),
          download_url: sanitizeSafeDownloadUrl(rows[0].download_url),
          source: 'app_version',
        };
      }
    }
  } catch {
    // Fallback to dispositivos metadata row
  }

  const encodedReserved = encodeURIComponent(APP_VERSION_RESERVED_ID);
  const fallbackRes = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedReserved}&select=*&_t=${cacheBust}`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: getSupabaseHeaders(),
    }
  );
  if (!fallbackRes.ok) {
    throw new Error(`Falha ao consultar versão oficial (HTTP ${fallbackRes.status}).`);
  }
  const fbRows = (await fallbackRes.json()) as DispositivoRecord[];
  const row = Array.isArray(fbRows) ? fbRows[0] : undefined;
  if (!row || !row.app_version) return null;
  return {
    version: normalizeAppVersionString(row.app_version),
    download_url: sanitizeSafeDownloadUrl(row.pilot_name),
    source: 'fallback',
  };
}

export async function publishOfficialAppVersion(
  versionInput: string,
  downloadUrlInput?: string | null
): Promise<OfficialAppVersionInfo> {
  const cleanVersion = normalizeAppVersionString(versionInput);
  const safeUrl = sanitizeSafeDownloadUrl(downloadUrlInput);

  try {
    const checkRes = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/app_version?select=*&limit=1&_t=${Date.now()}`,
      {
        method: 'GET',
        cache: 'no-store',
        headers: getSupabaseHeaders(),
      }
    );
    if (checkRes.ok) {
      const rows = (await checkRes.json()) as Array<{ id?: string | number }>;
      if (Array.isArray(rows) && rows.length > 0 && rows[0]?.id !== undefined) {
        const patchRes = await fetchWithTimeout(
          `${SUPABASE_URL}/rest/v1/app_version?id=eq.${encodeURIComponent(String(rows[0].id))}`,
          {
            method: 'PATCH',
            headers: {
              ...getSupabaseHeaders(),
              Prefer: 'return=representation',
            },
            body: JSON.stringify({
              version: cleanVersion.replace(/^v/i, ''),
              download_url: safeUrl,
            }),
          }
        );
        if (patchRes.ok) {
          return { version: cleanVersion, download_url: safeUrl, source: 'app_version' };
        }
      } else {
        const postRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/app_version`, {
          method: 'POST',
          headers: {
            ...getSupabaseHeaders(),
            Prefer: 'return=representation',
          },
          body: JSON.stringify({
            version: cleanVersion.replace(/^v/i, ''),
            download_url: safeUrl,
          }),
        });
        if (postRes.ok) {
          return { version: cleanVersion, download_url: safeUrl, source: 'app_version' };
        }
      }
    }
  } catch {
    // Fallback to reserved row in dispositivos
  }

  const encodedReserved = encodeURIComponent(APP_VERSION_RESERVED_ID);
  const fbGet = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedReserved}&select=device_id`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: getSupabaseHeaders(),
    }
  );
  const existing = fbGet.ok ? ((await fbGet.json()) as DispositivoRecord[]) : [];
  if (Array.isArray(existing) && existing.length > 0) {
    const patchRes = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/dispositivos?device_id=eq.${encodedReserved}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          app_version: cleanVersion,
          pilot_name: safeUrl ?? '',
          last_seen_at: new Date().toISOString(),
        }),
      }
    );
    if (!patchRes.ok) {
      throw new Error(`Não foi possível salvar a versão oficial (HTTP ${patchRes.status}).`);
    }
  } else {
    const postRes = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/dispositivos`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        device_id: APP_VERSION_RESERVED_ID,
        pilot_name: safeUrl ?? '',
        device_model: 'Official Release Metadata',
        app_version: cleanVersion,
        allowed: false,
        expires_at: null,
        last_seen_at: new Date().toISOString(),
      }),
    });
    if (!postRes.ok) {
      throw new Error(`Não foi possível registrar a versão oficial (HTTP ${postRes.status}).`);
    }
  }

  return { version: cleanVersion, download_url: safeUrl, source: 'fallback' };
}

const PERSISTENT_OFFLINE_TILE_CACHE = 'rally-offline-tiles-v1';

export async function clearCodeCachesPreservingOfflineMaps(): Promise<number> {
  let deletedCount = 0;
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys();
      const codeCaches = keys.filter((k) => k !== PERSISTENT_OFFLINE_TILE_CACHE);
      await Promise.all(codeCaches.map((k) => window.caches.delete(k)));
      deletedCount = codeCaches.length;
    }
  } catch {
    // Ignore cache clear failure
  }
  return deletedCount;
}

export async function triggerServiceWorkerUpdates(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map(async (r) => {
          try {
            await r.update();
          } catch {
            // ignore update fetch error
          }
          if (r.waiting) {
            r.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        })
      );
    }
  } catch {
    // Ignore service worker failure
  }
}

export async function forceAppUpdateReload(downloadUrl?: string | null): Promise<void> {
  const safeUrl = sanitizeSafeDownloadUrl(downloadUrl);
  if (safeUrl) {
    window.location.assign(safeUrl);
    return;
  }

  await triggerServiceWorkerUpdates();
  await clearCodeCachesPreservingOfflineMaps();

  try {
    const url = new URL(window.location.href);
    url.searchParams.set('_upd', String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

export async function performOtaPwaUpdateAndReload(): Promise<{ ok: boolean; error?: string }> {
  await triggerServiceWorkerUpdates();
  await clearCodeCachesPreservingOfflineMaps();

  const base =
    typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const checkUrl = `${normalizedBase}index.html?t=${Date.now()}`;

  try {
    const res = await fetchWithTimeout(checkUrl, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, error: `Servidor respondeu HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Sem conexão com o servidor.',
    };
  }
}

export interface GithubReleaseCheckResult {
  hasUpdate: boolean;
  publishedAt: string | null;
  tagName: string | null;
  apkDownloadUrl: string;
}

function getLocalReleaseReferenceMs(): number {
  let storedMs = 0;
  try {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem(INSTALLED_RELEASE_AT_KEY);
      if (saved) {
        const parsed = Date.parse(saved);
        if (Number.isFinite(parsed)) storedMs = parsed;
      }
    }
  } catch {
    // Ignore storage error
  }

  let buildMs = 0;
  try {
    if (typeof __APP_BUILD_ISO__ === 'string' && __APP_BUILD_ISO__) {
      const parsed = Date.parse(__APP_BUILD_ISO__);
      // Allow 3 min grace for CI build -> release publish timing offset on the same release
      if (Number.isFinite(parsed)) buildMs = parsed + 3 * 60 * 1000;
    }
  } catch {
    // Ignore missing compile constant
  }

  return Math.max(storedMs, buildMs);
}

export async function checkGithubReleaseUpdate(): Promise<GithubReleaseCheckResult> {
  const res = await fetchWithTimeout(GITHUB_LATEST_RELEASE_API, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
    },
  });

  if (res.status === 404) {
    return {
      hasUpdate: false,
      publishedAt: null,
      tagName: null,
      apkDownloadUrl: GITHUB_APK_DOWNLOAD_URL,
    };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    published_at?: string | null;
    tag_name?: string | null;
  };

  const publishedAt = typeof data?.published_at === 'string' ? data.published_at : null;
  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
  const localRefMs = getLocalReleaseReferenceMs();

  const hasUpdate =
    Number.isFinite(publishedMs) && (localRefMs <= 0 || publishedMs > localRefMs);

  return {
    hasUpdate,
    publishedAt,
    tagName: typeof data?.tag_name === 'string' ? data.tag_name : null,
    apkDownloadUrl: GITHUB_APK_DOWNLOAD_URL,
  };
}

export async function applyGithubReleaseUpdate(publishedAt?: string | null): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    window.location.assign(GITHUB_APK_DOWNLOAD_URL);
    return;
  }

  try {
    if (publishedAt && typeof window !== 'undefined') {
      window.localStorage.setItem(INSTALLED_RELEASE_AT_KEY, publishedAt);
    }
  } catch {
    // Ignore storage error
  }

  await forceAppUpdateReload(null);
}
