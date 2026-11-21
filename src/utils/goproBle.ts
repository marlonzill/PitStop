// Open GoPro BLE GATT API (0xFEA6) Controller via @capacitor-community/bluetooth-le
// Native Android/iOS APK + Web Bluetooth fallback + Bench Simulator (up to 7 cameras)
import { Capacitor } from '@capacitor/core';
import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';

export const GOPRO_SERVICE_UUID = '0000fea6-0000-1000-8000-00805f9b34fb';
export const GOPRO_CMD_REQ_UUID = 'b5f90072-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_CMD_RSP_UUID = 'b5f90073-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_REQ_UUID = 'b5f90074-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_RSP_UUID = 'b5f90075-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_REQ_UUID = 'b5f90076-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_RSP_UUID = 'b5f90077-aa8d-11e3-9046-0002a5d5c51b';

const SAVED_GOPRO_KEY = 'pitstop_saved_gopro_devices_v1';

export type GoProResolution = '4K' | '2.7K' | '1080p';
export type GoProFps = 30 | 60 | 120;
export type GoProHyperSmooth = 'off' | 'on' | 'boost' | 'autoboost';
export type GoProLens = 'wide' | 'linear' | 'superview' | 'horizon_lock';
export type GoProCaptureMode = 'video' | 'photo';

export interface SavedGoProDevice {
  deviceId: string;
  name: string;
}

export interface GoProCameraState {
  id: string;
  name: string;
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

const connectedDeviceIds = new Set<string>();
let bleInitPromise: Promise<void> | null = null;

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
const QRY_STATUS_POLL = [0x06, 0x13, 10, 13, 70, 35, 6];

export function loadSavedGoProDevices(): SavedGoProDevice[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_GOPRO_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SavedGoProDevice =>
        Boolean(x && typeof x.deviceId === 'string' && x.deviceId.length > 0)
    );
  } catch {
    return [];
  }
}

export function saveGoProDeviceToStorage(deviceId: string, name: string): void {
  if (typeof window === 'undefined') return;
  try {
    const list = loadSavedGoProDevices();
    const filtered = list.filter((d) => d.deviceId !== deviceId);
    filtered.unshift({ deviceId, name: name || 'GoPro HERO' });
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
  const nav = navigator as Navigator & {
    bluetooth?: { requestDevice?: unknown };
  };
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

function parseQueryNotification(
  camId: string,
  view: DataView,
  onTelemetryUpdate: (id: string, patch: Partial<GoProCameraState>) => void
): void {
  if (!view || view.byteLength < 4) return;
  let idx = 3;
  const patch: Partial<GoProCameraState> = {
    lastSeenMs: Date.now(),
    connected: true,
    sleeping: false,
  };
  while (idx + 2 <= view.byteLength) {
    const statusId = view.getUint8(idx);
    const valLen = view.getUint8(idx + 1);
    idx += 2;
    if (idx + valLen > view.byteLength) break;
    if (statusId === 10 && valLen >= 1) {
      patch.recording = view.getUint8(idx) === 1;
    } else if (statusId === 70 && valLen >= 1) {
      patch.batteryPct = Math.min(100, view.getUint8(idx));
    } else if (statusId === 6 && valLen >= 1) {
      patch.overheating = view.getUint8(idx) === 1;
    } else if (statusId === 13 && valLen >= 4) {
      patch.encodingDurationSec = view.getUint32(idx, false);
    } else if (statusId === 35 && valLen >= 4) {
      const remSec = view.getUint32(idx, false);
      patch.sdRemainingMin = Math.round(remSec / 60);
      patch.sdFull = remSec <= 60;
    }
    idx += valLen;
  }
  onTelemetryUpdate(camId, patch);
}

async function connectGattAndSubscribe(
  deviceId: string,
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<void> {
  await BleClient.connect(deviceId, (disconnectedId) => {
    connectedDeviceIds.delete(disconnectedId);
    onTelemetryUpdate(disconnectedId, {
      connected: false,
      reconnecting: false,
      recording: false,
    });
  });

  connectedDeviceIds.add(deviceId);

  if (Capacitor.isNativePlatform()) {
    await BleClient.discoverServices(deviceId).catch(() => {});
  }

  // Subscribe to Command Response & Query Status notifications
  await BleClient.startNotifications(
    deviceId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_RSP_UUID,
    () => {
      onTelemetryUpdate(deviceId, { lastSeenMs: Date.now(), connected: true, sleeping: false });
    }
  ).catch(() => {});

  await BleClient.startNotifications(
    deviceId,
    GOPRO_SERVICE_UUID,
    GOPRO_QRY_RSP_UUID,
    (value) => parseQueryNotification(deviceId, value, onTelemetryUpdate)
  ).catch(() => {});

  // Read Query Characteristic if exposed + send Keep-Alive & initial poll
  await BleClient.read(deviceId, GOPRO_SERVICE_UUID, GOPRO_QRY_REQ_UUID)
    .then((val) => parseQueryNotification(deviceId, val, onTelemetryUpdate))
    .catch(() => {});

  await BleClient.write(
    deviceId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(CMD_KEEP_ALIVE)
  ).catch(() => {});

  await BleClient.write(
    deviceId,
    GOPRO_SERVICE_UUID,
    GOPRO_QRY_REQ_UUID,
    numbersToDataView(QRY_STATUS_POLL)
  ).catch(() => {});
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

  await connectGattAndSubscribe(camId, onTelemetryUpdate);
  saveGoProDeviceToStorage(camId, camName);

  return {
    id: camId,
    name: camName,
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
    onTelemetryUpdate(deviceId, { connected: false, reconnecting: false });
    throw err;
  }
}

export async function sendGoProShutter(camId: string, start: boolean): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(start ? CMD_SHUTTER_START : CMD_SHUTTER_STOP)
  );
}

export async function sendGoProCaptureMode(camId: string, mode: GoProCaptureMode): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(mode === 'video' ? CMD_MODE_VIDEO : CMD_MODE_PHOTO)
  );
}

export async function sendGoProSleep(camId: string): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(CMD_SLEEP)
  );
  connectedDeviceIds.delete(camId);
}

export async function sendGoProKeepAliveAndPoll(camId: string): Promise<void> {
  if (!connectedDeviceIds.has(camId)) return;
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_CMD_REQ_UUID,
    numbersToDataView(CMD_KEEP_ALIVE)
  ).catch(() => {});
  await BleClient.write(
    camId,
    GOPRO_SERVICE_UUID,
    GOPRO_QRY_REQ_UUID,
    numbersToDataView(QRY_STATUS_POLL)
  ).catch(() => {});
}

export function pollAllGoProKeepAlive(): void {
  for (const camId of connectedDeviceIds) {
    sendGoProKeepAliveAndPoll(camId).catch(() => {});
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
  connectedDeviceIds.delete(camId);
  await BleClient.stopNotifications(camId, GOPRO_SERVICE_UUID, GOPRO_CMD_RSP_UUID).catch(() => {});
  await BleClient.stopNotifications(camId, GOPRO_SERVICE_UUID, GOPRO_QRY_RSP_UUID).catch(() => {});
  await BleClient.disconnect(camId).catch(() => {});
}

export function createSimulatedCameraFleet(count = 5): GoProCameraState[] {
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
  return Array.from({ length: clamped }).map((_, i) => ({
    id: `sim_gp_${i + 1}`,
    name: `HERO12 #${i + 1} (${positions[i]})`,
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
  }));
}
