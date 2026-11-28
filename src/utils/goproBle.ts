// Open GoPro BLE GATT API (0xFEA6) Controller via @capacitor-community/bluetooth-le
// Native Android/iOS APK + Web Bluetooth fallback + Bench Simulator (up to 7 cameras)
// Shared reactive fleet store + persistent custom camera aliases
import { useEffect, useState } from 'react';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';

export const GOPRO_SERVICE_UUID = '0000fea6-0000-1000-8000-00805f9b34fb';
export const GOPRO_CMD_REQ_UUID = 'b5f90072-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_CMD_RSP_UUID = 'b5f90073-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_REQ_UUID = 'b5f90074-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_RSP_UUID = 'b5f90075-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_REQ_UUID = 'b5f90076-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_RSP_UUID = 'b5f90077-aa8d-11e3-9046-0002a5d5c51b';

const SAVED_GOPRO_KEY = 'pitstop_saved_gopro_devices_v1';
const GOPRO_ALIASES_KEY = 'pitstop_gopro_aliases_v1';

export type GoProResolution = '4K' | '2.7K' | '1080p';
export type GoProFps = 30 | 60 | 120;
export type GoProHyperSmooth = 'off' | 'on' | 'boost' | 'autoboost';
export type GoProLens = 'wide' | 'linear' | 'superview' | 'horizon_lock';
export type GoProCaptureMode = 'video' | 'photo';

export interface SavedGoProDevice {
  deviceId: string;
  name: string;
  alias?: string;
}

export interface GoProCameraState {
  id: string;
  name: string;
  alias?: string;
  model: string;
  connected: boolean;
  reconnecting: boolean;
  sleeping: boolean;
  recording: boolean;
  captureMode: GoProCaptureMode;
  encodingDurationSec: number;
  batteryPct: number;
  sdRemainingMin: number;
  overheating: boolean;
  sdFull: boolean;
  resolution: GoProResolution;
  fps: GoProFps;
  hypersmooth: GoProHyperSmooth;
  lens: GoProLens;
  isSimulated: boolean;
  lastSeenMs: number;
}

export function getGoProDisplayName(cam: { name: string; alias?: string }): string {
  const custom = cam.alias?.trim();
  return custom && custom.length > 0 ? custom : cam.name;
}

const connectedDeviceIds = new Set<string>();
const telemetryCallbacks = new Map<
  string,
  (camId: string, patch: Partial<GoProCameraState>) => void
>();
const webDisconnectCleanups = new Map<string, () => void>();
const qryRxBuffers = new Map<string, { expectedLen: number; bytes: number[] }>();
const consecutivePollFailures = new Map<string, number>();
let bleInitPromise: Promise<void> | null = null;
let heartbeatInFlight = false;

// Open GoPro Setting ID mappings
const RESOLUTION_VALUE_MAP: Record<GoProResolution, number> = {
  '4K': 1,
  '2.7K': 4,
  '1080p': 9,
};

const FPS_VALUE_MAP: Record<GoProFps, number> = {
  30: 8,
  60: 5,
  120: 1,
};

const HYPERSMOOTH_VALUE_MAP: Record<GoProHyperSmooth, number> = {
  off: 0,
  on: 1,
  boost: 3,
  autoboost: 4,
};

const LENS_VALUE_MAP: Record<GoProLens, number> = {
  wide: 0,
  linear: 4,
  superview: 3,
  horizon_lock: 8,
};

// Exact Open GoPro BLE Command Payloads
const CMD_SHUTTER_START = [0x03, 0x01, 0x01, 0x01];
const CMD_SHUTTER_STOP = [0x03, 0x01, 0x01, 0x00];
const CMD_MODE_VIDEO = [0x04, 0x3e, 0x02, 0x03, 0xe8];
const CMD_MODE_PHOTO = [0x04, 0x3e, 0x02, 0x03, 0xe9];
const CMD_SLEEP = [0x01, 0x05];
const CMD_KEEP_ALIVE = [0x03, 0x5b, 0x01, 0x42];
const CMD_AP_CONTROL_ENABLE = [0x03, 0x17, 0x01, 0x01];
const CMD_AP_CONTROL_DISABLE = [0x03, 0x17, 0x01, 0x00];
const CMD_ADD_HILIGHT_TAG = [0x01, 0x18];

// Essential Open GoPro Status IDs:
// 8  = System Busy (recording / encoding active or camera busy)
// 10 = Encoding Active (video/time-lapse encoding active)
// 13 = Current Video Encoding Duration (seconds)
// 2  = Internal Battery Level Bars (0..4)
// 70 = Internal Battery Percentage (0..100)
// 35 = Remaining Video Time / SD Free Space (seconds)
// 6  = System Hot / Overheating
const ESSENTIAL_STATUS_IDS = [8, 10, 13, 2, 70, 35, 6];
const QRY_REGISTER_STATUS = [
  1 + ESSENTIAL_STATUS_IDS.length,
  0x53,
  ...ESSENTIAL_STATUS_IDS,
];
const QRY_STATUS_POLL = [
  1 + ESSENTIAL_STATUS_IDS.length,
  0x13,
  ...ESSENTIAL_STATUS_IDS,
];
const QRY_HEARTBEAT_STATUS_8 = [0x03, 0x13, 8, 10];

interface WebBluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: {
    connected: boolean;
  };
}

interface NavigatorWithWebBluetooth extends Navigator {
  bluetooth?: {
    requestDevice?: unknown;
    getDevices?: () => Promise<WebBluetoothDeviceLike[]>;
  };
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

let bleOperationQueue: Promise<unknown> = Promise.resolve();

function enqueueBleOperation<T>(fn: () => Promise<T>): Promise<T> {
  const next = bleOperationQueue.then(fn, fn);
  bleOperationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function isGatt133Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('133') ||
    msg.includes('gatt_error') ||
    msg.includes('gatt error') ||
    msg.includes('connection failed')
  );
}

function withBleTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Timeout BLE (${label})`));
    }, timeoutMs);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isDefinitiveDisconnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('disconnected') ||
    msg.includes('not connected') ||
    msg.includes('gatt server') ||
    msg.includes('device not found') ||
    msg.includes('connection lost') ||
    msg.includes('status 133') ||
    msg.includes('status 8') ||
    msg.includes('no longer connected')
  );
}

function markCameraDisconnected(
  camId: string,
  onTelemetryUpdate?: (id: string, patch: Partial<GoProCameraState>) => void
): void {
  connectedDeviceIds.delete(camId);
  consecutivePollFailures.delete(camId);
  qryRxBuffers.delete(camId);

  const webCleanup = webDisconnectCleanups.get(camId);
  if (webCleanup) {
    webCleanup();
    webDisconnectCleanups.delete(camId);
  }

  const cb = onTelemetryUpdate ?? telemetryCallbacks.get(camId);
  if (cb) {
    cb(camId, {
      connected: false,
      reconnecting: false,
      recording: false,
    });
  }
}

function loadGoProAliases(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(GOPRO_ALIASES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function saveGoProAliasToStorage(deviceId: string, alias: string): void {
  if (typeof window === 'undefined') return;
  try {
    const aliases = loadGoProAliases();
    const clean = alias.trim();
    if (clean) {
      aliases[deviceId] = clean;
    } else {
      delete aliases[deviceId];
    }
    window.localStorage.setItem(GOPRO_ALIASES_KEY, JSON.stringify(aliases));
  } catch {
    // Ignore storage error
  }
}

export function loadSavedGoProDevices(): SavedGoProDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_GOPRO_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const aliases = loadGoProAliases();
    return parsed
      .filter(
        (x): x is SavedGoProDevice =>
          Boolean(x && typeof x.deviceId === 'string' && x.deviceId.length > 0)
      )
      .map((d) => ({
        ...d,
        alias: aliases[d.deviceId] ?? d.alias,
      }));
  } catch {
    return [];
  }
}

export function saveGoProDeviceToStorage(deviceId: string, name: string): void {
  if (typeof window === 'undefined') return;
  try {
    const aliases = loadGoProAliases();
    const list = loadSavedGoProDevices();
    const existing = list.find((d) => d.deviceId === deviceId);
    const filtered = list.filter((d) => d.deviceId !== deviceId);
    filtered.unshift({
      deviceId,
      name: name || 'GoPro HERO',
      alias: aliases[deviceId] ?? existing?.alias,
    });
    window.localStorage.setItem(SAVED_GOPRO_KEY, JSON.stringify(filtered.slice(0, 12)));
  } catch {
    // Ignore quota errors
  }
}

export function removeSavedGoProDevice(deviceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const filtered = loadSavedGoProDevices().filter((d) => d.deviceId !== deviceId);
    window.localStorage.setItem(SAVED_GOPRO_KEY, JSON.stringify(filtered));
  } catch {
    // Ignore storage errors
  }
}

export function isGoProBleSupported(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorWithWebBluetooth;
  return Boolean(nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function');
}

export async function ensureGoProBleInitialized(): Promise<void> {
  if (!isGoProBleSupported()) {
    throw new Error(
      'Bluetooth BLE indisponível neste navegador. Use o App Android (.apk), Chrome no Android ou o Simulador.'
    );
  }
  if (!bleInitPromise) {
    bleInitPromise = BleClient.initialize({ androidNeverForLocation: true }).catch((err) => {
      bleInitPromise = null;
      throw err;
    });
  }
  await bleInitPromise;

  if (Capacitor.isNativePlatform()) {
    try {
      const enabled = await BleClient.isEnabled();
      if (!enabled) {
        await BleClient.requestEnable();
      }
    } catch {
      // User may enable Bluetooth manually or OS already handles it
    }
  }
}

function mapBatteryBarsToPct(bars: number): number {
  if (bars > 4) return Math.min(100, Math.max(0, bars));
  switch (bars) {
    case 0:
      return 5;
    case 1:
      return 25;
    case 2:
      return 50;
    case 3:
      return 75;
    default:
      return 100;
  }
}

function parseReassembledQueryPayload(
  camId: string,
  payload: number[],
  onTelemetryUpdate: (id: string, patch: Partial<GoProCameraState>) => void
): void {
  if (payload.length < 2) return;
  const queryId = payload[0];
  const respStatus = payload[1];

  // Accept Get Status (0x13), Register Status Updates (0x53), and Async Status Notification (0x93)
  if (queryId !== 0x13 && queryId !== 0x53 && queryId !== 0x93) {
    onTelemetryUpdate(camId, { lastSeenMs: Date.now(), connected: true, sleeping: false });
    return;
  }

  // Non-zero Open GoPro error status
  if (respStatus !== 0) {
    onTelemetryUpdate(camId, { lastSeenMs: Date.now(), connected: true, sleeping: false });
    return;
  }

  const patch: Partial<GoProCameraState> = {
    lastSeenMs: Date.now(),
    connected: true,
    sleeping: false,
  };

  let status8Val: number | null = null;
  let status10Val: number | null = null;
  let status2Val: number | null = null;
  let status70Val: number | null = null;

  const u8 = new Uint8Array(payload);
  const dv = new DataView(u8.buffer);
  let idx = 2;

  while (idx + 2 <= payload.length) {
    const statusId = payload[idx];
    const valLen = payload[idx + 1];
    idx += 2;
    if (idx + valLen > payload.length) break;

    if (statusId === 8 && valLen >= 1) {
      status8Val = payload[idx];
    } else if (statusId === 10 && valLen >= 1) {
      status10Val = payload[idx];
    } else if (statusId === 2 && valLen >= 1) {
      status2Val = payload[idx];
    } else if (statusId === 70 && valLen >= 1) {
      status70Val = Math.min(100, payload[idx]);
    } else if (statusId === 6 && valLen >= 1) {
      patch.overheating = payload[idx] === 1;
    } else if (statusId === 13 && valLen >= 4) {
      patch.encodingDurationSec = dv.getUint32(idx, false);
    } else if (statusId === 35 && valLen >= 4) {
      const remSec = dv.getUint32(idx, false);
      patch.sdRemainingMin = Math.round(remSec / 60);
      patch.sdFull = remSec <= 60;
    }

    idx += valLen;
  }

  // Encoding Active (ID 10) is authoritative; System Busy (ID 8) updates recording
  // when ID 10 is absent or clears recording immediately if System Busy drops to 0.
  if (status10Val !== null) {
    patch.recording = status10Val === 1;
  } else if (status8Val !== null) {
    patch.recording = status8Val === 1;
  }

  if (patch.recording === false && status13ValMissing(payload)) {
    patch.encodingDurationSec = 0;
  }

  // Battery percentage (ID 70) preferred; fallback to Battery Bars (ID 2)
  if (status70Val !== null) {
    patch.batteryPct = status70Val;
  } else if (status2Val !== null) {
    patch.batteryPct = mapBatteryBarsToPct(status2Val);
  }

  consecutivePollFailures.set(camId, 0);
  onTelemetryUpdate(camId, patch);
}

function status13ValMissing(payload: number[]): boolean {
  let idx = 2;
  while (idx + 2 <= payload.length) {
    const id = payload[idx];
    const len = payload[idx + 1];
    if (id === 13) return false;
    idx += 2 + len;
  }
  return true;
}

function parseQueryNotification(
  camId: string,
  view: DataView,
  onTelemetryUpdate: (id: string, patch: Partial<GoProCameraState>) => void
): void {
  if (!view || view.byteLength < 2) return;
  const raw: number[] = [];
  for (let i = 0; i < view.byteLength; i += 1) {
    raw.push(view.getUint8(i));
  }

  const first = raw[0];
  const isContinuation = (first & 0x80) !== 0;

  if (!isContinuation) {
    const headerType = (first >> 5) & 0x03;
    let headerBytes = 1;
    let expectedLen = first & 0x1f;
    if (headerType === 1 && raw.length >= 2) {
      headerBytes = 2;
      expectedLen = ((first & 0x1f) << 8) | raw[1];
    } else if (headerType === 2 && raw.length >= 3) {
      headerBytes = 3;
      expectedLen = (raw[1] << 8) | raw[2];
    }
    const body = raw.slice(headerBytes);
    if (body.length >= expectedLen) {
      qryRxBuffers.delete(camId);
      parseReassembledQueryPayload(camId, body.slice(0, expectedLen), onTelemetryUpdate);
    } else {
      qryRxBuffers.set(camId, { expectedLen, bytes: body });
    }
    return;
  }

  const existing = qryRxBuffers.get(camId);
  if (!existing) return;
  existing.bytes.push(...raw.slice(1));
  if (existing.bytes.length >= existing.expectedLen) {
    const complete = existing.bytes.slice(0, existing.expectedLen);
    qryRxBuffers.delete(camId);
    parseReassembledQueryPayload(camId, complete, onTelemetryUpdate);
  }
}

async function attachWebBluetoothDisconnectListener(
  deviceId: string,
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<void> {
  if (Capacitor.isNativePlatform() || typeof navigator === 'undefined') return;
  const nav = navigator as NavigatorWithWebBluetooth;
  if (typeof nav.bluetooth?.getDevices !== 'function') return;

  try {
    const devices = await nav.bluetooth.getDevices();
    const target = devices.find((d) => d.id === deviceId);
    if (!target) return;

    const existingCleanup = webDisconnectCleanups.get(deviceId);
    if (existingCleanup) existingCleanup();

    const onGattServerDisconnected = () => {
      markCameraDisconnected(deviceId, onTelemetryUpdate);
    };

    target.addEventListener('gattserverdisconnected', onGattServerDisconnected);
    webDisconnectCleanups.set(deviceId, () => {
      target.removeEventListener('gattserverdisconnected', onGattServerDisconnected);
    });
  } catch {
    // Browser may restrict getDevices(); BleClient's gattserverdisconnected still handles it
  }
}

async function isWebDeviceGattConnected(deviceId: string): Promise<boolean | null> {
  if (Capacitor.isNativePlatform() || typeof navigator === 'undefined') return null;
  const nav = navigator as NavigatorWithWebBluetooth;
  if (typeof nav.bluetooth?.getDevices !== 'function') return null;
  try {
    const devices = await nav.bluetooth.getDevices();
    const target = devices.find((d) => d.id === deviceId);
    if (!target) return null;
    return Boolean(target.gatt?.connected);
  } catch {
    return null;
  }
}

async function connectGattOnce(
  deviceId: string,
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<void> {
  try {
    await BleClient.connect(
      deviceId,
      (disconnectedId) => {
        markCameraDisconnected(disconnectedId, onTelemetryUpdate);
      },
      { timeout: 10000 }
    );
  } catch (err) {
    if (!isGatt133Error(err)) {
      throw err;
    }
    // Retry 1x on Android status 133 (GATT_ERROR) after clean disconnect & 500ms cooldown
    await BleClient.disconnect(deviceId).catch(() => {});
    await delayMs(500);
    await BleClient.connect(
      deviceId,
      (disconnectedId) => {
        markCameraDisconnected(disconnectedId, onTelemetryUpdate);
      },
      { timeout: 10000 }
    );
  }
}

async function connectGattAndSubscribe(
  deviceId: string,
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<void> {
  return enqueueBleOperation(async () => {
    telemetryCallbacks.set(deviceId, onTelemetryUpdate);

    // On Web Bluetooth, populate Capacitor BLE plugin map for saved deviceIds if already authorized
    if (!Capacitor.isNativePlatform()) {
      await BleClient.getDevices([deviceId]).catch(() => {});
    }

    await connectGattOnce(deviceId, onTelemetryUpdate);

    connectedDeviceIds.add(deviceId);
    consecutivePollFailures.set(deviceId, 0);
    qryRxBuffers.delete(deviceId);

    await attachWebBluetoothDisconnectListener(deviceId, onTelemetryUpdate);

    if (Capacitor.isNativePlatform()) {
      await BleClient.discoverServices(deviceId).catch(() => {});
    }

    await BleClient.startNotifications(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_CMD_RSP_UUID,
      () => {
        onTelemetryUpdate(deviceId, { lastSeenMs: Date.now(), connected: true, sleeping: false });
      }
    ).catch(() => {});

    // Subscribe to Open GoPro Query Response Characteristic (GP-0077 / 0x0077)
    await BleClient.startNotifications(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_QRY_RSP_UUID,
      (value) => parseQueryNotification(deviceId, value, onTelemetryUpdate)
    ).catch(() => {});

    await BleClient.write(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_CMD_REQ_UUID,
      numbersToDataView(CMD_KEEP_ALIVE)
    ).catch(() => {});

    // Ensure camera is placed in Video mode automatically upon BLE connection
    await BleClient.write(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_CMD_REQ_UUID,
      numbersToDataView(CMD_MODE_VIDEO)
    ).catch(() => {});

    // Register for Status Value Updates (0x53) via GP-0076 for IDs [8, 10, 13, 2, 70, 35, 6]
    await BleClient.write(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_QRY_REQ_UUID,
      numbersToDataView(QRY_REGISTER_STATUS)
    ).catch(() => {});

    // Initial Get Status Poll (0x13) to populate live state immediately
    await BleClient.write(
      deviceId,
      GOPRO_SERVICE_UUID,
      GOPRO_QRY_REQ_UUID,
      numbersToDataView(QRY_STATUS_POLL)
    ).catch(() => {});

    // Maintain 400ms spacing before any queued next camera GATT connection
    await delayMs(400);
  });
}

export async function scanAndConnectGoProBle(
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<GoProCameraState> {
  await ensureGoProBleInitialized();

  const device = await BleClient.requestDevice({
    services: [GOPRO_SERVICE_UUID],
    optionalServices: [GOPRO_SERVICE_UUID],
  });

  const camId = device.deviceId;
  const camName = device.name || 'GoPro HERO';
  const aliases = loadGoProAliases();

  await connectGattAndSubscribe(camId, onTelemetryUpdate);
  saveGoProDeviceToStorage(camId, camName);

  return {
    id: camId,
    name: camName,
    alias: aliases[camId],
    model: camName,
    connected: true,
    reconnecting: false,
    sleeping: false,
    recording: false,
    captureMode: 'video',
    encodingDurationSec: 0,
    batteryPct: 95,
    sdRemainingMin: 120,
    overheating: false,
    sdFull: false,
    resolution: '4K',
    fps: 60,
    hypersmooth: 'boost',
    lens: 'wide',
    isSimulated: false,
    lastSeenMs: Date.now(),
  };
}

export async function wakeOrReconnectGoProById(
  deviceId: string,
  name: string,
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<GoProCameraState> {
  await ensureGoProBleInitialized();
  const aliases = loadGoProAliases();

  onTelemetryUpdate(deviceId, { reconnecting: true });
  try {
    await connectGattAndSubscribe(deviceId, onTelemetryUpdate);
    onTelemetryUpdate(deviceId, {
      connected: true,
      reconnecting: false,
      sleeping: false,
      lastSeenMs: Date.now(),
    });
    return {
      id: deviceId,
      name: name || 'GoPro HERO',
      alias: aliases[deviceId],
      model: name || 'GoPro HERO',
      connected: true,
      reconnecting: false,
      sleeping: false,
      recording: false,
      captureMode: 'video',
      encodingDurationSec: 0,
      batteryPct: 95,
      sdRemainingMin: 120,
      overheating: false,
      sdFull: false,
      resolution: '4K',
      fps: 60,
      hypersmooth: 'boost',
      lens: 'wide',
      isSimulated: false,
      lastSeenMs: Date.now(),
    };
  } catch (err) {
    markCameraDisconnected(deviceId, onTelemetryUpdate);
    throw err;
  }
}

export async function sendGoProShutter(camId: string, start: boolean): Promise<void> {
  if (!connectedDeviceIds.has(camId)) {
    throw new Error('GoPro desconectada.');
  }
  try {
    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_CMD_REQ_UUID,
        numbersToDataView(start ? CMD_SHUTTER_START : CMD_SHUTTER_STOP)
      ),
      3500,
      'shutter'
    );
  } catch (err) {
    if (isDefinitiveDisconnectError(err)) {
      markCameraDisconnected(camId);
    }
    throw err;
  }
}

export async function sendGoProCaptureMode(camId: string, mode: GoProCaptureMode): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  try {
    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_CMD_REQ_UUID,
        numbersToDataView(mode === 'video' ? CMD_MODE_VIDEO : CMD_MODE_PHOTO)
      ),
      3500,
      'mode'
    );
  } catch (err) {
    if (isDefinitiveDisconnectError(err)) {
      markCameraDisconnected(camId);
    }
    throw err;
  }
}

export async function sendGoProSleep(camId: string): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(CMD_SLEEP)
  ).catch(() => {});
  connectedDeviceIds.delete(camId);
  consecutivePollFailures.delete(camId);
  qryRxBuffers.delete(camId);
}

export async function sendGoProApControl(camId: string, enable = true): Promise<void> {
  if (!connectedDeviceIds.has(camId)) {
    throw new Error('GoPro desconectada.');
  }
  try {
    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_CMD_REQ_UUID,
        numbersToDataView(enable ? CMD_AP_CONTROL_ENABLE : CMD_AP_CONTROL_DISABLE)
      ),
      4000,
      'wifi-ap-control'
    );
  } catch (err) {
    if (isDefinitiveDisconnectError(err)) {
      markCameraDisconnected(camId);
    }
    throw err;
  }
}

export async function sendGoProHiLightTag(camId: string): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  try {
    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_CMD_REQ_UUID,
        numbersToDataView(CMD_ADD_HILIGHT_TAG)
      ),
      3000,
      'hilight-tag'
    );
  } catch (err) {
    if (isDefinitiveDisconnectError(err)) {
      markCameraDisconnected(camId);
    }
    throw err;
  }
}

export async function sendGoProKeepAliveAndPoll(
  camId: string,
  connectedSetOverride?: Set<string>
): Promise<boolean> {
  if (!connectedDeviceIds.has(camId)) return false;

  // 1. Direct GATT link check (Web Bluetooth device.gatt.connected + Capacitor getConnectedDevices)
  const webConnected = await isWebDeviceGattConnected(camId);
  if (webConnected === false) {
    markCameraDisconnected(camId);
    return false;
  }
  if (connectedSetOverride && !connectedSetOverride.has(camId)) {
    markCameraDisconnected(camId);
    return false;
  }

  // 2. Lightweight KeepAlive + Get Status (IDs 8, 10, ...) with strict timeout
  try {
    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_QRY_REQ_UUID,
        numbersToDataView(QRY_HEARTBEAT_STATUS_8)
      ),
      2800,
      'heartbeat-status-8'
    );

    await withBleTimeout(
      BleClient.write(
        camId,
        GOPRO_SERVICE_UUID,
        GOPRO_CMD_REQ_UUID,
        numbersToDataView(CMD_KEEP_ALIVE)
      ),
      2500,
      'keepalive'
    ).catch(() => {});

    consecutivePollFailures.set(camId, 0);
    return true;
  } catch (err) {
    const prevFails = consecutivePollFailures.get(camId) ?? 0;
    const nextFails = prevFails + 1;
    consecutivePollFailures.set(camId, nextFails);

    // Definitive GATT disconnect error OR 2 consecutive heartbeat failures -> mark disconnected immediately
    if (isDefinitiveDisconnectError(err) || nextFails >= 2) {
      markCameraDisconnected(camId);
      return false;
    }
    return false;
  }
}

export async function pollAllGoProKeepAlive(): Promise<void> {
  if (heartbeatInFlight || connectedDeviceIds.size === 0) return;
  heartbeatInFlight = true;
  try {
    let connectedSet: Set<string> | undefined;
    try {
      const res = await withBleTimeout(
        BleClient.getConnectedDevices([GOPRO_SERVICE_UUID]),
        2000,
        'connected-devices'
      );
      if (Array.isArray(res)) {
        connectedSet = new Set(res.map((d) => d.deviceId));
      }
    } catch {
      connectedSet = undefined;
    }

    const camIds = Array.from(connectedDeviceIds);
    for (let i = 0; i < camIds.length; i += 1) {
      await sendGoProKeepAliveAndPoll(camIds[i], connectedSet);
      if (i < camIds.length - 1) {
        await delayMs(200);
      }
    }
  } finally {
    heartbeatInFlight = false;
  }
}

export async function applyGoProRemoteSettings(
  camId: string,
  opts: {
    resolution?: GoProResolution;
    fps?: GoProFps;
    hypersmooth?: GoProHyperSmooth;
    lens?: GoProLens;
  }
): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  if (opts.resolution) {
    await BleClient.write(
      camId,
      GOPRO_SERVICE_UUID,
      GOPRO_SET_REQ_UUID,
      numbersToDataView([0x03, 2, 0x01, RESOLUTION_VALUE_MAP[opts.resolution]])
    );
  }
  if (opts.fps) {
    await BleClient.write(
      camId,
      GOPRO_SERVICE_UUID,
      GOPRO_SET_REQ_UUID,
      numbersToDataView([0x03, 3, 0x01, FPS_VALUE_MAP[opts.fps]])
    );
  }
  if (opts.hypersmooth) {
    await BleClient.write(
      camId,
      GOPRO_SERVICE_UUID,
      GOPRO_SET_REQ_UUID,
      numbersToDataView([0x03, 135, 0x01, HYPERSMOOTH_VALUE_MAP[opts.hypersmooth]])
    );
  }
  if (opts.lens) {
    await BleClient.write(
      camId,
      GOPRO_SERVICE_UUID,
      GOPRO_SET_REQ_UUID,
      numbersToDataView([0x03, 121, 0x01, LENS_VALUE_MAP[opts.lens]])
    );
  }
}

export async function disconnectGoProBle(camId: string): Promise<void> {
  markCameraDisconnected(camId);
  await BleClient.stopNotifications(camId, GOPRO_SERVICE_UUID, GOPRO_CMD_RSP_UUID).catch(() => {});
  await BleClient.stopNotifications(camId, GOPRO_SERVICE_UUID, GOPRO_QRY_RSP_UUID).catch(() => {});
  await BleClient.disconnect(camId).catch(() => {});
}

export function createSimulatedCameraFleet(count = 5): GoProCameraState[] {
  const aliases = loadGoProAliases();
  const positions = [
    'Capô Frontal',
    'Para-Brisa Interno',
    'Santo Antônio',
    'Para-Choque Diant.',
    'Traseira',
    'Suspensão Esq.',
    'Capacete Navegador',
  ];
  const clamped = Math.min(7, Math.max(1, count));
  return Array.from({ length: clamped }).map((_, i) => {
    const id = `sim_gp_${i + 1}`;
    return {
      id,
      name: `HERO12 #${i + 1} (${positions[i]})`,
      alias: aliases[id] ?? positions[i],
      model: i % 2 === 0 ? 'HERO12 Black' : 'HERO11 Black',
      connected: true,
      reconnecting: false,
      sleeping: false,
      recording: false,
      captureMode: 'video',
      encodingDurationSec: 0,
      batteryPct: Math.max(24, 96 - i * 11),
      sdRemainingMin: 185 - i * 18,
      overheating: false,
      sdFull: false,
      resolution: '4K',
      fps: 60,
      hypersmooth: 'boost',
      lens: i === 0 || i === 4 ? 'superview' : 'wide',
      isSimulated: true,
      lastSeenMs: Date.now(),
    };
  });
}

// ============================================================================
// Shared Reactive GoPro Fleet Store (Syncs Settings <-> Velocidade Cockpit)
// ============================================================================

export interface GoProFleetSnapshot {
  cameras: GoProCameraState[];
  savedDevices: SavedGoProDevice[];
  scanning: boolean;
  wakingId: string | null;
  errorMsg: string | null;
}

const fleetState: GoProFleetSnapshot = {
  cameras: [],
  savedDevices: loadSavedGoProDevices(),
  scanning: false,
  wakingId: null,
  errorMsg: null,
};

const fleetListeners = new Set<() => void>();
let globalLoopsStarted = false;

function notifyFleet() {
  fleetListeners.forEach((cb) => cb());
}

function updateCameraInFleet(camId: string, patch: Partial<GoProCameraState>) {
  fleetState.cameras = fleetState.cameras.map((c) =>
    c.id === camId ? { ...c, ...patch } : c
  );
  notifyFleet();
}

function upsertCameraInFleet(cam: GoProCameraState) {
  const idx = fleetState.cameras.findIndex((x) => x.id === cam.id);
  if (idx >= 0) {
    fleetState.cameras = fleetState.cameras.map((c, i) => (i === idx ? cam : c));
  } else {
    fleetState.cameras = [...fleetState.cameras, cam];
  }
  notifyFleet();
}

function ensureGlobalFleetLoops() {
  if (globalLoopsStarted || typeof window === 'undefined') return;
  globalLoopsStarted = true;

  // 1s Recording duration & battery/SD simulator tick + stale connection guard
  window.setInterval(() => {
    if (fleetState.cameras.length === 0) return;
    let changed = false;
    const now = Date.now();
    const next = fleetState.cameras.map((c) => {
      // Stale BLE safety guard: if real camera hasn't responded in > 12s, mark disconnected
      if (!c.isSimulated && c.connected && !c.sleeping && now - c.lastSeenMs > 12000) {
        if (!connectedDeviceIds.has(c.id)) {
          changed = true;
          return { ...c, connected: false, reconnecting: false, recording: false };
        }
      }
      if (!c.connected || c.sleeping || !c.recording) return c;
      changed = true;
      const nextSec = c.encodingDurationSec + 1;
      const nextBatt =
        c.isSimulated && nextSec % 25 === 0 ? Math.max(5, c.batteryPct - 1) : c.batteryPct;
      const nextSd =
        c.isSimulated && nextSec % 60 === 0
          ? Math.max(0, c.sdRemainingMin - 1)
          : c.sdRemainingMin;
      return {
        ...c,
        encodingDurationSec: nextSec,
        batteryPct: nextBatt,
        sdRemainingMin: nextSd,
        sdFull: nextSd <= 1,
      };
    });
    if (changed) {
      fleetState.cameras = next;
      notifyFleet();
    }
  }, 1000);

  // 3.5s Heartbeat / Watchdog (Keep-Alive + Get Status ID 8/10 + GATT Check)
  window.setInterval(() => {
    const activeBleCams = fleetState.cameras.filter(
      (c) => !c.isSimulated && c.connected && !c.sleeping
    );
    if (activeBleCams.length === 0) return;
    for (const c of activeBleCams) {
      telemetryCallbacks.set(c.id, updateCameraInFleet);
      if (!connectedDeviceIds.has(c.id)) {
        updateCameraInFleet(c.id, { connected: false, reconnecting: false, recording: false });
      }
    }
    void pollAllGoProKeepAlive();
  }, 3500);
}

export async function scanAndAddGoProToFleet(): Promise<void> {
  fleetState.errorMsg = null;
  if (fleetState.cameras.length >= 7) {
    fleetState.errorMsg = 'Limite recomendado de 7 conexões BLE simultâneas atingido.';
    notifyFleet();
    return;
  }
  fleetState.scanning = true;
  notifyFleet();
  try {
    const cam = await scanAndConnectGoProBle(updateCameraInFleet);
    fleetState.savedDevices = loadSavedGoProDevices();
    upsertCameraInFleet(cam);
  } catch (err) {
    fleetState.errorMsg =
      err instanceof Error
        ? err.message
        : 'Não foi possível parear com a GoPro via Bluetooth BLE.';
  } finally {
    fleetState.scanning = false;
    notifyFleet();
  }
}

export function activateSimulatedGoProFleet(count = 5): void {
  fleetState.errorMsg = null;
  fleetState.cameras = createSimulatedCameraFleet(count);
  notifyFleet();
}

export async function wakeSavedGoProInFleet(saved: SavedGoProDevice): Promise<void> {
  fleetState.errorMsg = null;
  fleetState.wakingId = saved.deviceId;
  notifyFleet();
  try {
    const cam = await wakeOrReconnectGoProById(saved.deviceId, saved.name, updateCameraInFleet);
    upsertCameraInFleet(cam);
  } catch (err) {
    fleetState.errorMsg =
      err instanceof Error
        ? err.message
        : `Não foi possível acordar/reconectar "${saved.alias || saved.name}". Verifique se a câmera está ao alcance.`;
  } finally {
    fleetState.wakingId = null;
    notifyFleet();
  }
}

export function renameGoProInFleet(deviceId: string, newAlias: string): void {
  saveGoProAliasToStorage(deviceId, newAlias);
  const clean = newAlias.trim() || undefined;
  fleetState.cameras = fleetState.cameras.map((c) =>
    c.id === deviceId ? { ...c, alias: clean } : c
  );
  fleetState.savedDevices = loadSavedGoProDevices();
  notifyFleet();
}

export async function shutterSingleGoPro(cam: GoProCameraState, start: boolean): Promise<void> {
  if (!cam.connected || cam.sleeping) return;
  if (!cam.isSimulated) {
    try {
      await sendGoProShutter(cam.id, start);
    } catch (err) {
      fleetState.errorMsg =
        err instanceof Error ? err.message : 'Erro ao enviar comando de gravação.';
      notifyFleet();
      return;
    }
  }
  updateCameraInFleet(cam.id, {
    recording: start,
    encodingDurationSec: start ? 0 : cam.encodingDurationSec,
  });
}

export async function modeSingleGoPro(
  cam: GoProCameraState,
  mode: GoProCaptureMode
): Promise<void> {
  if (!cam.connected || cam.sleeping) return;
  if (!cam.isSimulated) {
    await sendGoProCaptureMode(cam.id, mode).catch(() => {});
  }
  updateCameraInFleet(cam.id, { captureMode: mode });
}

export async function shutterAllGoPro(start: boolean): Promise<void> {
  return enqueueBleOperation(async () => {
    const targets = fleetState.cameras.filter((cam) => {
      if (!cam.connected || cam.sleeping) return false;
      if (start && cam.recording) return false;
      if (!start && !cam.recording) return false;
      return true;
    });

    for (let i = 0; i < targets.length; i += 1) {
      const cam = targets[i];
      if (!cam.isSimulated) {
        try {
          await sendGoProShutter(cam.id, start);
        } catch (err) {
          fleetState.errorMsg =
            err instanceof Error ? err.message : 'Erro ao enviar comando em lote para GoPro.';
          notifyFleet();
          if (i < targets.length - 1) await delayMs(400);
          continue;
        }
      }
      updateCameraInFleet(cam.id, {
        recording: start,
        encodingDurationSec: start ? 0 : cam.encodingDurationSec,
      });
      if (!cam.isSimulated && i < targets.length - 1) {
        await delayMs(400);
      }
    }
  });
}

export async function modeAllGoPro(mode: GoProCaptureMode): Promise<void> {
  return enqueueBleOperation(async () => {
    const targets = fleetState.cameras.filter((c) => c.connected && !c.sleeping);
    for (let i = 0; i < targets.length; i += 1) {
      const cam = targets[i];
      if (!cam.isSimulated) {
        await sendGoProCaptureMode(cam.id, mode).catch(() => {});
      }
      updateCameraInFleet(cam.id, { captureMode: mode });
      if (!cam.isSimulated && i < targets.length - 1) {
        await delayMs(400);
      }
    }
  });
}

export async function wakeSingleGoPro(cam: GoProCameraState): Promise<void> {
  if (!cam.sleeping && cam.connected) return;
  if (!cam.isSimulated) {
    await wakeOrReconnectGoProById(cam.id, cam.name, updateCameraInFleet).catch((err) => {
      fleetState.errorMsg =
        err instanceof Error ? err.message : 'Falha ao acordar GoPro.';
      notifyFleet();
    });
  } else {
    updateCameraInFleet(cam.id, { sleeping: false, connected: true, reconnecting: false });
  }
}

export async function sleepSingleGoPro(cam: GoProCameraState): Promise<void> {
  if (cam.sleeping && !cam.connected) return;
  if (!cam.isSimulated) {
    await enqueueBleOperation(() => sendGoProSleep(cam.id).catch(() => {}));
  }
  updateCameraInFleet(cam.id, { sleeping: true, connected: false, recording: false });
}

export async function toggleSingleGoProPower(cam: GoProCameraState): Promise<void> {
  const disconnectedOrSleeping = cam.sleeping || !cam.connected;
  if (disconnectedOrSleeping) {
    await wakeSingleGoPro(cam);
  } else {
    await sleepSingleGoPro(cam);
  }
}

export async function sleepAllGoPro(): Promise<void> {
  return enqueueBleOperation(async () => {
    const targets = [...fleetState.cameras];
    for (let i = 0; i < targets.length; i += 1) {
      const cam = targets[i];
      if (!cam.isSimulated) {
        await sendGoProSleep(cam.id).catch(() => {});
      }
      updateCameraInFleet(cam.id, { sleeping: true, connected: false, recording: false });
      if (!cam.isSimulated && i < targets.length - 1) {
        await delayMs(400);
      }
    }
  });
}

export async function wakeAllGoPro(): Promise<void> {
  // Wake connected sleeping cameras sequentially (connectGattAndSubscribe enforces 400ms spacing)
  const sleepingCams = fleetState.cameras.filter((c) => c.sleeping || !c.connected);
  for (const cam of sleepingCams) {
    if (!cam.isSimulated) {
      await wakeOrReconnectGoProById(cam.id, cam.name, updateCameraInFleet).catch((err) => {
        fleetState.errorMsg =
          err instanceof Error ? err.message : 'Falha ao acordar GoPro.';
        notifyFleet();
      });
    } else {
      updateCameraInFleet(cam.id, { sleeping: false, connected: true, reconnecting: false });
    }
  }
  // Also wake saved devices not currently in active cameras list, one by one
  const savedMissing = fleetState.savedDevices.filter(
    (sd) => !fleetState.cameras.some((c) => c.id === sd.deviceId)
  );
  for (const sd of savedMissing) {
    await wakeSavedGoProInFleet(sd);
  }
}

export async function applyBatchSettingsToFleet(opts: {
  resolution: GoProResolution;
  fps: GoProFps;
  hypersmooth: GoProHyperSmooth;
  lens: GoProLens;
}): Promise<void> {
  return enqueueBleOperation(async () => {
    const targets = [...fleetState.cameras];
    for (let i = 0; i < targets.length; i += 1) {
      const cam = targets[i];
      if (!cam.isSimulated && cam.connected && !cam.sleeping) {
        await applyGoProRemoteSettings(cam.id, opts).catch(() => {});
      }
      updateCameraInFleet(cam.id, opts);
      if (!cam.isSimulated && cam.connected && !cam.sleeping && i < targets.length - 1) {
        await delayMs(400);
      }
    }
  });
}

export function disconnectGoProFromFleet(cam: GoProCameraState): void {
  if (!cam.isSimulated) disconnectGoProBle(cam.id).catch(() => {});
  fleetState.cameras = fleetState.cameras.filter((c) => c.id !== cam.id);
  notifyFleet();
}

export function forgetSavedGoProFromFleet(deviceId: string): void {
  removeSavedGoProDevice(deviceId);
  fleetState.savedDevices = loadSavedGoProDevices();
  notifyFleet();
}

export function clearGoProFleetError(): void {
  fleetState.errorMsg = null;
  notifyFleet();
}

export function useGoProFleet(): GoProFleetSnapshot {
  const [snap, setSnap] = useState<GoProFleetSnapshot>(() => ({
    ...fleetState,
    cameras: [...fleetState.cameras],
    savedDevices: [...fleetState.savedDevices],
  }));

  useEffect(() => {
    ensureGlobalFleetLoops();
    const sync = () => {
      setSnap({
        ...fleetState,
        cameras: [...fleetState.cameras],
        savedDevices: [...fleetState.savedDevices],
      });
    };
    fleetListeners.add(sync);
    sync();
    return () => {
      fleetListeners.delete(sync);
    };
  }, []);

  return snap;
}

// ============================================================================
// Open GoPro Wi-Fi AP (0x17), HiLight Tags (0x18) & HTTP Media List (10.5.5.9)
// ============================================================================

export const GOPRO_WIFI_HOST = 'http://10.5.5.9:8080';

export interface GoProWifiApResult {
  ok: boolean;
  simulated: boolean;
  cameraName: string | null;
  error?: string;
}

/**
 * Envia comando BLE Open GoPro Command ID 0x17 (Set AP Control = 1)
 * para ligar o Ponto de Acesso Wi-Fi da câmera pareada.
 */
export async function enableGoProWifiAP(camId?: string): Promise<GoProWifiApResult> {
  let target = camId
    ? fleetState.cameras.find((c) => c.id === camId)
    : fleetState.cameras.find((c) => c.connected && !c.sleeping) ?? fleetState.cameras[0];

  if (!target && fleetState.savedDevices.length > 0) {
    const saved = camId
      ? fleetState.savedDevices.find((d) => d.deviceId === camId)
      : fleetState.savedDevices[0];
    if (saved) {
      await wakeSavedGoProInFleet(saved).catch(() => {});
      target = fleetState.cameras.find((c) => c.id === saved.deviceId);
    }
  }

  if (!target) {
    return {
      ok: false,
      simulated: false,
      cameraName: null,
      error: 'Nenhuma GoPro pareada via BLE no momento.',
    };
  }

  if (target.sleeping || !target.connected) {
    await wakeSingleGoPro(target).catch(() => {});
    target = fleetState.cameras.find((c) => c.id === target?.id) ?? target;
  }

  const displayName = getGoProDisplayName(target);
  if (target.isSimulated) {
    return { ok: true, simulated: true, cameraName: displayName };
  }

  if (!target.connected || !connectedDeviceIds.has(target.id)) {
    return {
      ok: false,
      simulated: false,
      cameraName: displayName,
      error: `GoPro "${displayName}" está desconectada via BLE.`,
    };
  }

  try {
    await sendGoProApControl(target.id, true);
    return { ok: true, simulated: false, cameraName: displayName };
  } catch (err) {
    return {
      ok: false,
      simulated: false,
      cameraName: displayName,
      error:
        err instanceof Error
          ? err.message
          : 'Falha ao ativar Wi-Fi AP da GoPro via BLE.',
    };
  }
}

/**
 * Envia comando BLE Open GoPro 0x18 (Add HiLight Tag) para todas as câmeras
 * conectadas que já estejam gravando (ex.: ao cruzar Largada L ou Chegada C).
 */
export async function addGoProHiLightTag(camId?: string): Promise<number> {
  const candidates = camId
    ? fleetState.cameras.filter((c) => c.id === camId)
    : fleetState.cameras;

  let taggedCount = 0;
  const activeRecording = candidates.filter(
    (c) => c.connected && !c.sleeping && c.recording
  );
  for (let i = 0; i < activeRecording.length; i += 1) {
    const cam = activeRecording[i];
    if (cam.isSimulated) {
      taggedCount += 1;
      continue;
    }
    try {
      await sendGoProHiLightTag(cam.id);
      taggedCount += 1;
    } catch {
      // Nunca interrompe fluxo de cronometragem se comando BLE falhar
    }
    if (i < activeRecording.length - 1) {
      await delayMs(400);
    }
  }
  return taggedCount;
}

export interface GoProMediaItem {
  id: string;
  dir: string;
  filename: string;
  sizeBytes: number;
  createdAtMs: number;
  videoUrl: string;
  thumbUrl: string;
}

interface RawGoProMediaFile {
  n?: string;
  cre?: string | number;
  mod?: string | number;
  s?: string | number;
}

interface RawGoProMediaDir {
  d?: string;
  fs?: RawGoProMediaFile[];
}

function parseEpochToMs(raw: string | number | undefined): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 1e12 ? Math.round(num) : Math.round(num * 1000);
}

function base64ToBlob(base64Data: string, mimeType: string): Blob {
  const cleanB64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const binStr = atob(cleanB64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Consulta http://10.5.5.9:8080/gp/gpMediaList usando CapacitorHttp no Android
 * (evitando bloqueios de mixed-content/CORS) com fallback para fetch na Web.
 */
export async function fetchGoProMediaList(): Promise<GoProMediaItem[]> {
  const endpoints = [
    `${GOPRO_WIFI_HOST}/gp/gpMediaList`,
    `${GOPRO_WIFI_HOST}/gopro/media/list`,
  ];
  let jsonPayload: { media?: RawGoProMediaDir[] } | null = null;
  let lastErr: Error | null = null;

  for (const url of endpoints) {
    try {
      if (Capacitor.isNativePlatform()) {
        const res = await CapacitorHttp.get({
          url,
          connectTimeout: 6500,
          readTimeout: 8000,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`GoPro respondeu HTTP ${res.status}`);
        }
        jsonPayload =
          typeof res.data === 'string'
            ? (JSON.parse(res.data) as { media?: RawGoProMediaDir[] })
            : (res.data as { media?: RawGoProMediaDir[] });
        break;
      } else {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6500);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            throw new Error(`GoPro respondeu HTTP ${res.status}`);
          }
          jsonPayload = (await res.json()) as { media?: RawGoProMediaDir[] };
          break;
        } finally {
          window.clearTimeout(timer);
        }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!jsonPayload && lastErr) {
    throw lastErr;
  }

  const dirs = Array.isArray(jsonPayload?.media) ? jsonPayload.media : [];
  const videos: GoProMediaItem[] = [];

  for (const dirEntry of dirs) {
    const dir = String(dirEntry?.d || '').trim();
    const files = Array.isArray(dirEntry?.fs) ? dirEntry.fs : [];
    if (!dir) continue;

    for (const file of files) {
      const filename = String(file?.n || '').trim();
      if (!filename || !/\.mp4$/i.test(filename)) continue;
      const createdAtMs = parseEpochToMs(file.cre) || parseEpochToMs(file.mod);
      const sizeBytes = Number(file.s) || 0;
      const encodedPath = encodeURIComponent(`${dir}/${filename}`);

      videos.push({
        id: `${dir}/${filename}`,
        dir,
        filename,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        createdAtMs,
        videoUrl: `${GOPRO_WIFI_HOST}/videos/DCIM/${encodeURIComponent(dir)}/${encodeURIComponent(filename)}`,
        thumbUrl: `${GOPRO_WIFI_HOST}/gp/gpMediaMetadata?p=${encodedPath}&t=thm`,
      });
    }
  }

  videos.sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return b.filename.localeCompare(a.filename);
  });

  return videos.slice(0, 24);
}

/**
 * Baixa miniatura (.thm) via CapacitorHttp no Android ou fetch na Web.
 */
export async function fetchGoProMediaThumbnail(thumbUrl: string): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const res = await CapacitorHttp.get({
        url: thumbUrl,
        responseType: 'blob',
        connectTimeout: 4000,
        readTimeout: 5000,
      });
      if (res.status < 200 || res.status >= 300 || !res.data) return null;
      if (typeof res.data === 'string') {
        return res.data.startsWith('data:')
          ? res.data
          : `data:image/jpeg;base64,${res.data}`;
      }
      if (res.data instanceof Blob) {
        return URL.createObjectURL(res.data);
      }
      return null;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(thumbUrl, { signal: controller.signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } finally {
      window.clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Baixa o arquivo MP4 da GoPro para Blob local (URL.createObjectURL) via CapacitorHttp no Android
 * ou fetch na Web, evitando CORS/mixed-content no player e na exportação com HUD.
 */
export async function downloadGoProMediaVideoUrl(
  item: GoProMediaItem
): Promise<{ url: string; isBlob: boolean }> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url: item.videoUrl,
      responseType: 'blob',
      connectTimeout: 10000,
      readTimeout: 120000,
    });
    if (res.status < 200 || res.status >= 300 || !res.data) {
      throw new Error(`Falha ao baixar vídeo da GoPro (HTTP ${res.status}).`);
    }
    const blob =
      typeof res.data === 'string'
        ? base64ToBlob(res.data, 'video/mp4')
        : res.data instanceof Blob
        ? res.data
        : null;
    if (!blob) {
      throw new Error('Formato de resposta inválido ao baixar vídeo da GoPro.');
    }
    return { url: URL.createObjectURL(blob), isBlob: true };
  }

  const res = await fetch(item.videoUrl);
  if (!res.ok) {
    throw new Error(`Falha ao baixar vídeo da GoPro (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), isBlob: true };
}

