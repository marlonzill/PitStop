// High-Frequency External Bluetooth BLE GPS Receiver Driver (10 Hz / 25 Hz)
// Supports:
// - RaceBox Mini / Mini S (25 Hz binary UBX 0xB5 0x62 0xFF 0x01 over Nordic UART Service)
// - NMEA-0183 ($GPRMC / $GNRMC / $GPGGA / $GNGGA) over BLE UART (Garmin GLO / Qstarz / Dual XGPS / ESP32)
// - Standard Bluetooth Location & Navigation Service (0x1819 / 0x2A67)
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export const LNS_SERVICE_UUID = '00001819-0000-1000-8000-00805f9b34fb';
export const LNS_LOC_SPEED_CHAR_UUID = '00002a67-0000-1000-8000-00805f9b34fb';

export const HM10_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const HM10_CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

export const ISSC_SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
export const ISSC_TX_CHAR_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';

export const GENERIC_UART_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const GENERIC_UART_CHAR_1 = '0000fff1-0000-1000-8000-00805f9b34fb';
export const GENERIC_UART_CHAR_4 = '0000fff4-0000-1000-8000-00805f9b34fb';

const SAVED_EXT_GPS_KEY = 'pitstop_saved_external_gps_v1';

export type ExternalGpsProtocol = 'RaceBox 25Hz' | 'NMEA-0183' | 'BLE LNS' | 'BLE GPS';

export interface SavedExternalGpsDevice {
  deviceId: string;
  name: string;
  protocolHint?: ExternalGpsProtocol;
}

export interface ExternalGpsFix {
  lat: number;
  lon: number;
  speedKmh: number;
  rawDopplerSpeedMs: number | null;
  accuracyM: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  satellites: number | null;
  timestampMs: number;
  protocol: ExternalGpsProtocol;
  imuAccel?: { longG: number; latG: number } | null;
}

export interface ExternalGpsSnapshot {
  connected: boolean;
  scanning: boolean;
  connecting: boolean;
  deviceId: string | null;
  deviceName: string | null;
  protocol: ExternalGpsProtocol | null;
  measuredHz: number;
  satellites: number | null;
  accuracyM: number | null;
  lastFixMs: number | null;
  errorMsg: string | null;
  savedDevice: SavedExternalGpsDevice | null;
}

function loadSavedDevice(): SavedExternalGpsDevice | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SAVED_EXT_GPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedExternalGpsDevice>;
    if (parsed.deviceId && parsed.name) {
      return {
        deviceId: parsed.deviceId,
        name: parsed.name,
        protocolHint: parsed.protocolHint,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function saveDevice(dev: SavedExternalGpsDevice | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!dev) {
      window.localStorage.removeItem(SAVED_EXT_GPS_KEY);
    } else {
      window.localStorage.setItem(SAVED_EXT_GPS_KEY, JSON.stringify(dev));
    }
  } catch {
    // Ignore quota errors
  }
}

export function isExternalGpsBleSupported(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { bluetooth?: { requestDevice?: unknown } };
  return Boolean(nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function');
}

// ============================================================================
// Pure Parsers: RaceBox UBX Binary & NMEA-0183
// ============================================================================

function validateUbxChecksum(packet: Uint8Array): boolean {
  if (packet.length < 8) return false;
  let ckA = 0;
  let ckB = 0;
  for (let i = 2; i < packet.length - 2; i += 1) {
    ckA = (ckA + packet[i]) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  return ckA === packet[packet.length - 2] && ckB === packet[packet.length - 1];
}

/**
 * Parses an 88-byte RaceBox Data Message (0xB5 0x62 0xFF 0x01, payloadLen = 80).
 */
export function parseRaceBoxPacket(packet: Uint8Array, nowMs = Date.now()): ExternalGpsFix | null {
  if (packet.length < 88) return null;
  if (packet[0] !== 0xb5 || packet[1] !== 0x62 || packet[2] !== 0xff || packet[3] !== 0x01) {
    return null;
  }
  const payloadLen = packet[4] | (packet[5] << 8);
  if (payloadLen !== 80 || packet.length < payloadLen + 8) return null;
  if (!validateUbxChecksum(packet.subarray(0, 88))) return null;

  const dv = new DataView(packet.buffer, packet.byteOffset + 6, 80);
  const fixStatus = dv.getUint8(20); // 0=no fix, 2=2D, 3=3D
  if (fixStatus < 2) return null;

  const numSVs = dv.getUint8(23);
  const lon = dv.getInt32(24, true) * 1e-7;
  const lat = dv.getInt32(28, true) * 1e-7;
  const mslAltM = dv.getInt32(36, true) / 1000;
  const hAccM = dv.getUint32(40, true) / 1000;
  const speedMs = Math.max(0, dv.getInt32(48, true) / 1000);
  const headingDegRaw = dv.getInt32(52, true) * 1e-5;
  const gForceX = dv.getInt16(68, true) / 1000;
  const gForceY = dv.getInt16(70, true) / 1000;

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }

  const headingDeg = Number.isFinite(headingDegRaw)
    ? Math.round(((headingDegRaw % 360) + 360) % 360)
    : null;

  return {
    lat,
    lon,
    speedKmh: speedMs * 3.6,
    rawDopplerSpeedMs: speedMs,
    accuracyM: Number.isFinite(hAccM) ? Math.max(1, Math.round(hAccM)) : 1,
    headingDeg,
    altitudeM: Number.isFinite(mslAltM) ? Math.round(mslAltM) : null,
    satellites: Number.isFinite(numSVs) ? numSVs : null,
    timestampMs: nowMs,
    protocol: 'RaceBox 25Hz',
    imuAccel:
      Number.isFinite(gForceX) && Number.isFinite(gForceY)
        ? {
            longG: Number(Math.max(-3, Math.min(3, gForceX)).toFixed(2)),
            latG: Number(Math.max(-3, Math.min(3, gForceY)).toFixed(2)),
          }
        : null,
  };
}

function validateNmeaChecksum(sentence: string): boolean {
  const starIdx = sentence.indexOf('*');
  if (starIdx === -1) return true;
  if (!sentence.startsWith('$') || starIdx + 3 > sentence.length) return false;
  const body = sentence.slice(1, starIdx);
  const expected = parseInt(sentence.slice(starIdx + 1, starIdx + 3), 16);
  if (!Number.isFinite(expected)) return false;
  let xor = 0;
  for (let i = 0; i < body.length; i += 1) {
    xor ^= body.charCodeAt(i);
  }
  return xor === expected;
}

function parseNmeaCoord(val: string, hemi: string): number | null {
  if (!val || !hemi) return null;
  const dotIdx = val.indexOf('.');
  if (dotIdx < 3) return null;
  const degLen = dotIdx - 2;
  const deg = parseInt(val.slice(0, degLen), 10);
  const min = parseFloat(val.slice(degLen));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  let decimal = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') decimal = -decimal;
  return decimal;
}

interface NmeaMetaState {
  satellites: number | null;
  accuracyM: number | null;
  altitudeM: number | null;
  lastRmcMs: number;
}

export function parseNmeaSentence(
  rawLine: string,
  meta: NmeaMetaState,
  nowMs = Date.now()
): ExternalGpsFix | null {
  const line = rawLine.trim();
  if (!line.startsWith('$') || !validateNmeaChecksum(line)) return null;
  const body = line.includes('*') ? line.slice(1, line.indexOf('*')) : line.slice(1);
  const parts = body.split(',');
  const type = (parts[0] || '').toUpperCase();

  // $GPGGA / $GNGGA: satellites, HDOP, altitude
  if (type.endsWith('GGA')) {
    const fixQuality = parseInt(parts[6] || '0', 10);
    const sats = parseInt(parts[7] || '', 10);
    const hdop = parseFloat(parts[8] || '');
    const alt = parseFloat(parts[9] || '');
    if (Number.isFinite(sats)) meta.satellites = sats;
    if (Number.isFinite(hdop) && hdop > 0) {
      meta.accuracyM = Math.max(1, Math.round(hdop * 4.5));
    }
    if (Number.isFinite(alt)) meta.altitudeM = Math.round(alt);

    // Fallback emit if receiver sends GGA without RMC
    if (fixQuality >= 1 && nowMs - meta.lastRmcMs > 500) {
      const lat = parseNmeaCoord(parts[2], parts[3]);
      const lon = parseNmeaCoord(parts[4], parts[5]);
      if (lat !== null && lon !== null) {
        return {
          lat,
          lon,
          speedKmh: 0,
          rawDopplerSpeedMs: null,
          accuracyM: meta.accuracyM,
          headingDeg: null,
          altitudeM: meta.altitudeM,
          satellites: meta.satellites,
          timestampMs: nowMs,
          protocol: 'NMEA-0183',
        };
      }
    }
    return null;
  }

  // $GPRMC / $GNRMC: position, speed (knots), true course
  if (type.endsWith('RMC')) {
    const status = (parts[2] || '').toUpperCase();
    if (status !== 'A') return null;
    const lat = parseNmeaCoord(parts[3], parts[4]);
    const lon = parseNmeaCoord(parts[5], parts[6]);
    if (lat === null || lon === null) return null;

    const knots = parseFloat(parts[7] || '0');
    const speedKmh = Number.isFinite(knots) && knots >= 0 ? knots * 1.852 : 0;
    const speedMs = Number.isFinite(knots) && knots >= 0 ? knots * 0.514444 : 0;
    const course = parseFloat(parts[8] || '');
    const headingDeg =
      Number.isFinite(course) ? Math.round(((course % 360) + 360) % 360) : null;

    meta.lastRmcMs = nowMs;
    return {
      lat,
      lon,
      speedKmh,
      rawDopplerSpeedMs: speedMs,
      accuracyM: meta.accuracyM ?? 2,
      headingDeg,
      altitudeM: meta.altitudeM,
      satellites: meta.satellites,
      timestampMs: nowMs,
      protocol: 'NMEA-0183',
    };
  }

  return null;
}

function parseBleLnsCharacteristic(view: DataView, nowMs = Date.now()): ExternalGpsFix | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint16(0, true);
  let offset = 2;

  const speedPresent = (flags & 0x01) !== 0;
  const totalDistPresent = (flags & 0x02) !== 0;
  const locPresent = (flags & 0x04) !== 0;
  const elevPresent = (flags & 0x08) !== 0;
  const headingPresent = (flags & 0x10) !== 0;

  let speedMs = 0;
  if (speedPresent && offset + 2 <= view.byteLength) {
    speedMs = view.getUint16(offset, true) / 100; // units of 1/100 m/s
    offset += 2;
  }
  if (totalDistPresent && offset + 3 <= view.byteLength) {
    offset += 3;
  }
  if (!locPresent || offset + 8 > view.byteLength) return null;

  const lat = view.getInt32(offset, true) * 1e-7;
  const lon = view.getInt32(offset + 4, true) * 1e-7;
  offset += 8;

  let altM: number | null = null;
  if (elevPresent && offset + 3 <= view.byteLength) {
    const rawElev =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getInt8(offset + 2) << 16);
    altM = Math.round(rawElev / 100);
    offset += 3;
  }

  let headingDeg: number | null = null;
  if (headingPresent && offset + 2 <= view.byteLength) {
    headingDeg = Math.round((view.getUint16(offset, true) / 100) % 360);
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }

  return {
    lat,
    lon,
    speedKmh: speedMs * 3.6,
    rawDopplerSpeedMs: speedMs,
    accuracyM: 2,
    headingDeg,
    altitudeM: altM,
    satellites: null,
    timestampMs: nowMs,
    protocol: 'BLE LNS',
  };
}

// ============================================================================
// Reactive Singleton BLE GPS Receiver Store
// ============================================================================

const extState: ExternalGpsSnapshot = {
  connected: false,
  scanning: false,
  connecting: false,
  deviceId: null,
  deviceName: null,
  protocol: null,
  measuredHz: 0,
  satellites: null,
  accuracyM: null,
  lastFixMs: null,
  errorMsg: null,
  savedDevice: loadSavedDevice(),
};

const stateListeners = new Set<() => void>();
const fixListeners = new Set<(fix: ExternalGpsFix) => void>();
let bleInitPromise: Promise<void> | null = null;
let rxByteBuffer = new Uint8Array(0);
let rxTextBuffer = '';
const nmeaMeta: NmeaMetaState = {
  satellites: null,
  accuracyM: null,
  altitudeM: null,
  lastRmcMs: 0,
};
let fixTimestamps: number[] = [];
let hzWatcherStarted = false;
let subscribedPairs: Array<{ service: string; char: string }> = [];

function notifyState() {
  stateListeners.forEach((cb) => cb());
}

function ensureHzWatcher() {
  if (hzWatcherStarted || typeof window === 'undefined') return;
  hzWatcherStarted = true;
  window.setInterval(() => {
    if (!extState.connected) return;
    const cutoff = Date.now() - 2000;
    fixTimestamps = fixTimestamps.filter((t) => t >= cutoff);
    const hz = Number((fixTimestamps.length / 2).toFixed(1));
    const roundedHz = hz >= 2 ? Math.round(hz) : hz;
    if (extState.measuredHz !== roundedHz) {
      extState.measuredHz = roundedHz;
      notifyState();
    }
  }, 500);
}

function emitFix(fix: ExternalGpsFix) {
  const now = Date.now();
  fixTimestamps.push(now);
  const cutoff = now - 2000;
  fixTimestamps = fixTimestamps.filter((t) => t >= cutoff);
  const hzRaw = fixTimestamps.length / 2;
  extState.measuredHz = hzRaw >= 2 ? Math.round(hzRaw) : Number(hzRaw.toFixed(1));
  extState.protocol = fix.protocol;
  if (fix.satellites !== null) extState.satellites = fix.satellites;
  if (fix.accuracyM !== null) extState.accuracyM = fix.accuracyM;
  extState.lastFixMs = now;
  notifyState();

  fixListeners.forEach((cb) => cb(fix));
}

function handleIncomingUartChunk(view: DataView) {
  if (!view || view.byteLength === 0) return;
  const incoming = new Uint8Array(view.byteLength);
  for (let i = 0; i < view.byteLength; i += 1) {
    incoming[i] = view.getUint8(i);
  }

  // Append to binary ring buffer for RaceBox UBX packet scanning
  const merged = new Uint8Array(rxByteBuffer.length + incoming.length);
  merged.set(rxByteBuffer, 0);
  merged.set(incoming, rxByteBuffer.length);
  rxByteBuffer = merged;

  // 1. Scan for RaceBox UBX packets (0xB5 0x62 0xFF 0x01)
  let consumedRaceBox = false;
  let searchIdx = 0;
  while (searchIdx + 88 <= rxByteBuffer.length) {
    if (
      rxByteBuffer[searchIdx] === 0xb5 &&
      rxByteBuffer[searchIdx + 1] === 0x62 &&
      rxByteBuffer[searchIdx + 2] === 0xff &&
      rxByteBuffer[searchIdx + 3] === 0x01
    ) {
      const slice = rxByteBuffer.subarray(searchIdx, searchIdx + 88);
      const fix = parseRaceBoxPacket(slice);
      if (fix) {
        emitFix(fix);
        consumedRaceBox = true;
        searchIdx += 88;
        continue;
      }
    }
    searchIdx += 1;
  }

  if (consumedRaceBox) {
    rxByteBuffer = rxByteBuffer.slice(searchIdx);
    rxTextBuffer = '';
    return;
  }
  if (rxByteBuffer.length > 512) {
    rxByteBuffer = rxByteBuffer.slice(rxByteBuffer.length - 128);
  }

  // 2. Decode ASCII NMEA-0183 lines ($GPRMC / $GNRMC / $GPGGA / $GNGGA)
  let textChunk = '';
  for (let i = 0; i < incoming.length; i += 1) {
    const ch = incoming[i];
    if (ch === 10 || ch === 13 || (ch >= 32 && ch <= 126)) {
      textChunk += String.fromCharCode(ch);
    }
  }
  if (textChunk.length > 0) {
    rxTextBuffer += textChunk;
    const lines = rxTextBuffer.split(/\r?\n/);
    rxTextBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('$')) {
        const dollarPos = line.indexOf('$');
        const fix = parseNmeaSentence(line.slice(dollarPos), nmeaMeta);
        if (fix) emitFix(fix);
      }
    }
    if (rxTextBuffer.length > 512) {
      rxTextBuffer = '';
    }
  }
}

async function ensureBleReady(): Promise<void> {
  if (!isExternalGpsBleSupported()) {
    throw new Error(
      'Bluetooth BLE indisponível neste navegador. Use o App Android (.apk) ou Chrome Android.'
    );
  }
  if (!bleInitPromise) {
    bleInitPromise = BleClient.initialize({ androidNeverForLocation: false }).catch((err) => {
      bleInitPromise = null;
      throw err;
    });
  }
  await bleInitPromise;

  if (Capacitor.isNativePlatform()) {
    try {
      const enabled = await BleClient.isEnabled();
      if (!enabled) await BleClient.requestEnable();
    } catch {
      // User or OS handles Bluetooth enable
    }
  }
}

async function connectAndSubscribeDevice(deviceId: string, deviceName: string): Promise<void> {
  rxByteBuffer = new Uint8Array(0);
  rxTextBuffer = '';
  fixTimestamps = [];
  subscribedPairs = [];

  if (!Capacitor.isNativePlatform()) {
    await BleClient.getDevices([deviceId]).catch(() => {});
  }

  await BleClient.connect(
    deviceId,
    (disconnectedId) => {
      if (extState.deviceId === disconnectedId) {
        extState.connected = false;
        extState.connecting = false;
        extState.measuredHz = 0;
        subscribedPairs = [];
        notifyState();
      }
    },
    { timeout: 10000 }
  );

  if (Capacitor.isNativePlatform()) {
    await BleClient.discoverServices(deviceId).catch(() => {});
  }

  const candidateChannels: Array<{ service: string; char: string; isLns?: boolean }> = [
    { service: NUS_SERVICE_UUID, char: NUS_TX_CHAR_UUID },
    { service: LNS_SERVICE_UUID, char: LNS_LOC_SPEED_CHAR_UUID, isLns: true },
    { service: HM10_SERVICE_UUID, char: HM10_CHAR_UUID },
    { service: ISSC_SERVICE_UUID, char: ISSC_TX_CHAR_UUID },
    { service: GENERIC_UART_SERVICE_UUID, char: GENERIC_UART_CHAR_1 },
    { service: GENERIC_UART_SERVICE_UUID, char: GENERIC_UART_CHAR_4 },
  ];

  // Filter candidates by discovered services if supported
  let availableServices: Set<string> | null = null;
  try {
    const services = await BleClient.getServices(deviceId);
    if (Array.isArray(services) && services.length > 0) {
      availableServices = new Set(services.map((s) => s.uuid.toLowerCase()));
    }
  } catch {
    availableServices = null;
  }

  for (const ch of candidateChannels) {
    if (availableServices && !availableServices.has(ch.service.toLowerCase())) {
      continue;
    }
    try {
      await BleClient.startNotifications(deviceId, ch.service, ch.char, (view) => {
        if (ch.isLns) {
          const fix = parseBleLnsCharacteristic(view);
          if (fix) emitFix(fix);
        } else {
          handleIncomingUartChunk(view);
        }
      });
      subscribedPairs.push({ service: ch.service, char: ch.char });
    } catch {
      // Try remaining UART profiles
    }
  }

  if (subscribedPairs.length === 0) {
    await BleClient.disconnect(deviceId).catch(() => {});
    throw new Error(
      'Dispositivo BLE sem perfil RaceBox UART, NMEA-0183 ou Location Service (0x1819) compatível.'
    );
  }

  const guessProtocol: ExternalGpsProtocol = deviceName.toLowerCase().includes('racebox')
    ? 'RaceBox 25Hz'
    : subscribedPairs.some((p) => p.service === LNS_SERVICE_UUID)
    ? 'BLE LNS'
    : 'NMEA-0183';

  const saved: SavedExternalGpsDevice = {
    deviceId,
    name: deviceName,
    protocolHint: guessProtocol,
  };
  saveDevice(saved);

  extState.connected = true;
  extState.connecting = false;
  extState.deviceId = deviceId;
  extState.deviceName = deviceName;
  extState.protocol = guessProtocol;
  extState.errorMsg = null;
  extState.savedDevice = saved;
  notifyState();
}

export async function scanAndConnectExternalGps(): Promise<void> {
  extState.errorMsg = null;
  extState.scanning = true;
  notifyState();
  try {
    await ensureBleReady();
    const device = await BleClient.requestDevice({
      optionalServices: [
        NUS_SERVICE_UUID,
        LNS_SERVICE_UUID,
        HM10_SERVICE_UUID,
        ISSC_SERVICE_UUID,
        GENERIC_UART_SERVICE_UUID,
      ],
    });
    extState.scanning = false;
    extState.connecting = true;
    notifyState();
    await connectAndSubscribeDevice(device.deviceId, device.name || 'GPS BLE Externo');
  } catch (err) {
    extState.errorMsg =
      err instanceof Error
        ? err.message
        : 'Não foi possível parear o receptor GPS Bluetooth.';
  } finally {
    extState.scanning = false;
    extState.connecting = false;
    notifyState();
  }
}

export async function reconnectSavedExternalGps(): Promise<void> {
  const saved = extState.savedDevice ?? loadSavedDevice();
  if (!saved) return;
  extState.errorMsg = null;
  extState.connecting = true;
  notifyState();
  try {
    await ensureBleReady();
    await connectAndSubscribeDevice(saved.deviceId, saved.name);
  } catch (err) {
    extState.errorMsg =
      err instanceof Error
        ? err.message
        : `Não foi possível reconectar "${saved.name}".`;
  } finally {
    extState.connecting = false;
    notifyState();
  }
}

export async function disconnectExternalGps(): Promise<void> {
  const id = extState.deviceId;
  if (id) {
    for (const pair of subscribedPairs) {
      await BleClient.stopNotifications(id, pair.service, pair.char).catch(() => {});
    }
    await BleClient.disconnect(id).catch(() => {});
  }
  subscribedPairs = [];
  extState.connected = false;
  extState.connecting = false;
  extState.measuredHz = 0;
  extState.deviceId = null;
  notifyState();
}

export function forgetSavedExternalGps(): void {
  void disconnectExternalGps();
  saveDevice(null);
  extState.savedDevice = null;
  extState.deviceName = null;
  extState.protocol = null;
  extState.satellites = null;
  extState.accuracyM = null;
  notifyState();
}

export function subscribeExternalGpsFixes(
  listener: (fix: ExternalGpsFix) => void
): () => void {
  fixListeners.add(listener);
  return () => {
    fixListeners.delete(listener);
  };
}

export function useExternalGpsBle(): ExternalGpsSnapshot {
  const [snap, setSnap] = useState<ExternalGpsSnapshot>(() => ({ ...extState }));
  useEffect(() => {
    ensureHzWatcher();
    const sync = () => setSnap({ ...extState });
    stateListeners.add(sync);
    sync();
    return () => {
      stateListeners.delete(sync);
    };
  }, []);
  return snap;
}
