// Open GoPro BLE GATT API (0xFEA6) Controller & Bench Simulator for up to 7 cameras

export const GOPRO_SERVICE_UUID = '0000fea6-0000-1000-8000-00805f9b34fb';
export const GOPRO_CMD_REQ_UUID = 'b5f90072-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_CMD_RSP_UUID = 'b5f90073-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_REQ_UUID = 'b5f90074-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_SET_RSP_UUID = 'b5f90075-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_REQ_UUID = 'b5f90076-aa8d-11e3-9046-0002a5d5c51b';
export const GOPRO_QRY_RSP_UUID = 'b5f90077-aa8d-11e3-9046-0002a5d5c51b';

export type GoProResolution = '4K' | '2.7K' | '1080p';
export type GoProFps = 30 | 60 | 120;
export type GoProHyperSmooth = 'off' | 'on' | 'boost' | 'autoboost';
export type GoProLens = 'wide' | 'linear' | 'superview' | 'horizon_lock';

export interface GoProCameraState {
  id: string;
  name: string;
  model: string;
  connected: boolean;
  reconnecting: boolean;
  sleeping: boolean;
  recording: boolean;
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

interface BleCharacteristicLike extends EventTarget {
  writeValueWithResponse?: (val: BufferSource) => Promise<void>;
  writeValue?: (val: BufferSource) => Promise<void>;
  startNotifications?: () => Promise<BleCharacteristicLike>;
  value?: DataView;
}

interface BleGattServerLike {
  connected: boolean;
  connect: () => Promise<BleGattServerLike>;
  disconnect: () => void;
  getPrimaryService: (uuid: string) => Promise<{
    getCharacteristic: (uuid: string) => Promise<BleCharacteristicLike>;
  }>;
}

interface BleDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: BleGattServerLike;
}

interface NavigatorBluetoothExt extends Navigator {
  bluetooth?: {
    requestDevice: (opts: {
      filters?: { services?: string[]; namePrefix?: string }[];
      optionalServices?: string[];
      acceptAllDevices?: boolean;
    }) => Promise<BleDeviceLike>;
  };
}

interface LiveBleSession {
  device: BleDeviceLike;
  cmdReq: BleCharacteristicLike;
  setReq: BleCharacteristicLike;
  qryReq: BleCharacteristicLike;
}

const liveSessions = new Map<string, LiveBleSession>();

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

function encodeShutterPacket(start: boolean): Uint8Array {
  return new Uint8Array([0x03, 0x01, 0x01, start ? 0x01 : 0x00]);
}

function encodeSleepPacket(): Uint8Array {
  return new Uint8Array([0x01, 0x05]);
}

function encodeKeepAlivePacket(): Uint8Array {
  return new Uint8Array([0x03, 0x5b, 0x01, 0x42]);
}

function encodeSettingPacket(settingId: number, value: number): Uint8Array {
  return new Uint8Array([0x03, settingId, 0x01, value]);
}

function encodeStatusQueryPacket(): Uint8Array {
  // Query ID 10 (encoding), ID 13 (duration sec), ID 70 (battery %), ID 35 (SD rem), ID 6 (overheating)
  return new Uint8Array([0x06, 0x13, 10, 13, 70, 35, 6]);
}

async function writeBleCharacteristic(
  chr: BleCharacteristicLike,
  bytes: Uint8Array
): Promise<void> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (typeof chr.writeValueWithResponse === 'function') {
    await chr.writeValueWithResponse(buf);
  } else if (typeof chr.writeValue === 'function') {
    await chr.writeValue(buf);
  }
}

export function isWebBluetoothSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as NavigatorBluetoothExt;
  return Boolean(nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function');
}

export async function scanAndConnectGoProBle(
  onTelemetryUpdate: (camId: string, patch: Partial<GoProCameraState>) => void
): Promise<GoProCameraState> {
  const nav = navigator as NavigatorBluetoothExt;
  if (!nav.bluetooth?.requestDevice) {
    throw new Error(
      'Web Bluetooth BLE indisponível neste navegador/WebView. Use Chrome no Android ou ative o Simulador de Bancada.'
    );
  }

  const device = await nav.bluetooth.requestDevice({
    filters: [{ services: [GOPRO_SERVICE_UUID] }, { namePrefix: 'GoPro' }],
    optionalServices: [GOPRO_SERVICE_UUID],
  });

  if (!device.gatt) {
    throw new Error('Dispositivo selecionado não expôs servidor GATT BLE.');
  }

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(GOPRO_SERVICE_UUID);
  const cmdReq = await service.getCharacteristic(GOPRO_CMD_REQ_UUID);
  const cmdRsp = await service.getCharacteristic(GOPRO_CMD_RSP_UUID);
  const setReq = await service.getCharacteristic(GOPRO_SET_REQ_UUID);
  const qryReq = await service.getCharacteristic(GOPRO_QRY_REQ_UUID);
  const qryRsp = await service.getCharacteristic(GOPRO_QRY_RSP_UUID);

  const camId = device.id || `gopro_${Date.now()}`;

  const parseQueryResponse = (ev: Event) => {
    const target = ev.target as BleCharacteristicLike | null;
    const view = target?.value;
    if (!view || view.byteLength < 4) return;
    // Open GoPro Query response: [len, cmdId, err, statusId, valLen, val...]
    let idx = 3;
    const patch: Partial<GoProCameraState> = { lastSeenMs: Date.now(), connected: true, sleeping: false };
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
  };

  try {
    await cmdRsp.startNotifications?.();
    await qryRsp.startNotifications?.();
    qryRsp.addEventListener('characteristicvaluechanged', parseQueryResponse);
  } catch {
    // Ignore optional notify limitations on some devices
  }

  device.addEventListener('gattserverdisconnected', () => {
    onTelemetryUpdate(camId, { connected: false, reconnecting: true });
  });

  liveSessions.set(camId, { device, cmdReq, setReq, qryReq });

  // Initial status poll & keepalive
  writeBleCharacteristic(qryReq, encodeStatusQueryPacket()).catch(() => {});
  writeBleCharacteristic(cmdReq, encodeKeepAlivePacket()).catch(() => {});

  return {
    id: camId,
    name: device.name || 'GoPro HERO',
    model: device.name || 'HERO Open GoPro',
    connected: true,
    reconnecting: false,
    sleeping: false,
    recording: false,
    encodingDurationSec: 0,
    batteryPct: 92,
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

export async function sendGoProShutter(camId: string, start: boolean): Promise<void> {
  const sess = liveSessions.get(camId);
  if (!sess || !sess.device.gatt?.connected) return;
  await writeBleCharacteristic(sess.cmdReq, encodeShutterPacket(start));
}

export async function sendGoProSleep(camId: string): Promise<void> {
  const sess = liveSessions.get(camId);
  if (!sess || !sess.device.gatt?.connected) return;
  await writeBleCharacteristic(sess.cmdReq, encodeSleepPacket());
}

export async function sendGoProWakeOrReconnect(
  camId: string,
  onTelemetryUpdate: (id: string, patch: Partial<GoProCameraState>) => void
): Promise<void> {
  const sess = liveSessions.get(camId);
  if (!sess?.device.gatt) return;
  if (!sess.device.gatt.connected) {
    await sess.device.gatt.connect();
  }
  await writeBleCharacteristic(sess.cmdReq, encodeKeepAlivePacket());
  await writeBleCharacteristic(sess.qryReq, encodeStatusQueryPacket());
  onTelemetryUpdate(camId, { connected: true, reconnecting: false, sleeping: false, lastSeenMs: Date.now() });
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
  const sess = liveSessions.get(camId);
  if (!sess || !sess.device.gatt?.connected) return;
  if (opts.resolution) {
    await writeBleCharacteristic(sess.setReq, encodeSettingPacket(2, RESOLUTION_VALUE_MAP[opts.resolution]));
  }
  if (opts.fps) {
    await writeBleCharacteristic(sess.setReq, encodeSettingPacket(3, FPS_VALUE_MAP[opts.fps]));
  }
  if (opts.hypersmooth) {
    await writeBleCharacteristic(sess.setReq, encodeSettingPacket(135, HYPERSMOOTH_VALUE_MAP[opts.hypersmooth]));
  }
  if (opts.lens) {
    await writeBleCharacteristic(sess.setReq, encodeSettingPacket(121, LENS_VALUE_MAP[opts.lens]));
  }
}

export function pollAllGoProStatus(): void {
  for (const [, sess] of liveSessions) {
    if (sess.device.gatt?.connected) {
      writeBleCharacteristic(sess.qryReq, encodeStatusQueryPacket()).catch(() => {});
      writeBleCharacteristic(sess.cmdReq, encodeKeepAlivePacket()).catch(() => {});
    }
  }
}

export function disconnectGoProBle(camId: string): void {
  const sess = liveSessions.get(camId);
  if (sess?.device.gatt?.connected) {
    sess.device.gatt.disconnect();
  }
  liveSessions.delete(camId);
}

export function createSimulatedCameraFleet(count = 5): GoProCameraState[] {
  const positions = ['Capô Frontal', 'Para-Brisa Interno', 'Santo Antônio', 'Para-Choque Diant.', 'Traseira', 'Suspensão Esq.', 'Capacete Navegador'];
  const clamped = Math.min(7, Math.max(1, count));
  return Array.from({ length: clamped }).map((_, i) => ({
    id: `sim_gp_${i + 1}`,
    name: `HERO12 #${i + 1} (${positions[i]})`,
    model: i % 2 === 0 ? 'HERO12 Black' : 'HERO11 Black',
    connected: true,
    reconnecting: false,
    sleeping: false,
    recording: false,
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
