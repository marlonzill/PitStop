import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { resolveApiBaseUrl } from './baseApi';

export type PairingRole = 'navigator' | 'pilot';
export type PairingTransportMode = 'auto' | 'bluetooth_spp' | 'wifi_ws';

export interface BondedBluetoothDevice {
  name: string;
  address: string;
}

export interface PairingAlertCue {
  kind: 'bell' | 'pmm_change' | 'countdown' | 'sync' | 'reset';
  seq: number;
}

export interface PairingTelemetryPayload {
  roomCode: string;
  odometerKm: number;
  partialKm: number;
  speedKmh: number;
  targetSpeedKmh: number | null;
  nextTargetSpeedKmh?: number | null;
  nextBlockType?: 'D' | 'V' | 'N' | '';
  deltaSec: number | null;
  deltaMeters?: number | null;
  clockTimeStr?: string;
  elapsedMs?: number;
  activeTulipaIdx: number;
  tulipaNum: number;
  distToNextKm: number;
  cap: number | null;
  type: 'D' | 'V' | 'N' | '';
  section: number | null;
  tdnMs: number | null;
  sectionRemainingMs: number | null;
  notes?: string;
  imageDataUrl?: string;
  notesImageDataUrl?: string;
  imageIsComposite?: boolean;
  isRunning: boolean;
  eventName?: string;
  alertCue?: PairingAlertCue;
  updatedAtMs: number;
}

export interface PairingPresenceState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  navigators: number;
  pilots: number;
  transport: 'ws' | 'bt_spp' | 'local' | 'none';
  peerName?: string;
  errorMessage?: string;
}

interface BluetoothSppPluginInterface {
  ensurePermissions(): Promise<{ granted: boolean }>;
  listBondedDevices(): Promise<{ devices: BondedBluetoothDevice[] }>;
  startPilotServer(): Promise<{ started: boolean }>;
  connectNavigator(options: { addresses: string[] }): Promise<{ connecting: boolean }>;
  sendTelemetry(options: { json: string }): Promise<void>;
  stopAll(): Promise<void>;
  addListener(
    eventName: 'telemetryData',
    listenerFunc: (data: { json: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'connectionState',
    listenerFunc: (data: {
      role: string;
      status: string;
      navigators: number;
      pilots: number;
      peerName?: string;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'btError',
    listenerFunc: (data: { message: string }) => void
  ): Promise<PluginListenerHandle>;
}

const BluetoothSpp = registerPlugin<BluetoothSppPluginInterface>('BluetoothSpp');

export function isNativeBluetoothSppAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function listBondedBluetoothDevices(): Promise<BondedBluetoothDevice[]> {
  if (!isNativeBluetoothSppAvailable()) {
    throw new Error('Bluetooth Clássico SPP disponível apenas no APK Android nativo.');
  }
  const perm = await BluetoothSpp.ensurePermissions();
  if (!perm?.granted) {
    throw new Error('Permissão de Dispositivos Próximos (Bluetooth) negada.');
  }
  const res = await BluetoothSpp.listBondedDevices();
  return Array.isArray(res?.devices) ? res.devices : [];
}

/**
 * Emits a crisp 2-note connection bell ("sinetinha") + subtle tactile buzz
 * when Navegador and Droid Piloto establish pairing or sync.
 */
export function playPairingBell(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const playTone = (freq: number, startOffset: number, dur: number, gainPeak: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + startOffset);
        gain.gain.setValueAtTime(0.001, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(gainPeak, now + startOffset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + dur + 0.02);
      };
      playTone(1318.5, 0, 0.14, 0.22); // E6
      playTone(1760.0, 0.11, 0.24, 0.24); // A6
      window.setTimeout(() => {
        ctx.close().catch(() => {});
      }, 600);
    }
  } catch {
    // Ignore blocked audio context prior to user gesture
  }
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([70, 50, 90]);
    }
  } catch {
    // Ignore vibration errors
  }
}

export function normalizeRoomCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 12);
}

export function normalizeRoomPin(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export function generatePairingRoomCode(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `PS-${num}`;
}

export function generatePairingRoomPin(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 6; i += 1) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buf)
    .map((b) => chars[b % chars.length])
    .join('');
}

function buildWebSocketUrl(roomCode: string, role: PairingRole, roomPin?: string): string | null {
  if (typeof window === 'undefined') return null;

  const customBase = resolveApiBaseUrl();
  let wsOrigin = '';

  if (customBase) {
    try {
      const parsed = new URL(customBase);
      const wsProto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      wsOrigin = `${wsProto}//${parsed.host}`;
    } catch {
      wsOrigin = '';
    }
  }

  if (!wsOrigin) {
    const loc = window.location;
    if (loc.protocol === 'http:' || loc.protocol === 'https:') {
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      wsOrigin = `${wsProto}//${loc.host}`;
    }
  }

  if (!wsOrigin) return null;
  const pinQuery = roomPin ? `&pin=${encodeURIComponent(roomPin)}` : '';
  return `${wsOrigin}/ws/pair?room=${encodeURIComponent(roomCode)}&role=${encodeURIComponent(role)}${pinQuery}`;
}

export interface PairingConnection {
  sendTelemetry: (payload: PairingTelemetryPayload) => void;
  close: () => void;
}

export function connectPairingRoom(opts: {
  roomCode: string;
  roomPin?: string;
  role: PairingRole;
  transportMode?: PairingTransportMode;
  bluetoothDevices?: BondedBluetoothDevice[];
  onTelemetry: (payload: PairingTelemetryPayload) => void;
  onPresence: (state: PairingPresenceState) => void;
}): PairingConnection {
  const cleanRoom = normalizeRoomCode(opts.roomCode);
  const cleanPin = normalizeRoomPin(opts.roomPin || '');
  const mode: PairingTransportMode = opts.transportMode ?? 'auto';
  const btTargets = Array.isArray(opts.bluetoothDevices) ? opts.bluetoothDevices : [];

  if (!cleanRoom && mode === 'wifi_ws') {
    opts.onPresence({
      status: 'error',
      navigators: 0,
      pilots: 0,
      transport: 'none',
      errorMessage: 'Informe um código de dupla válido.',
    });
    return {
      sendTelemetry: () => {},
      close: () => {},
    };
  }

  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let channel: BroadcastChannel | null = null;
  let wsOpen = false;
  let btConnected = false;
  const btListeners: PluginListenerHandle[] = [];

  let btState: PairingPresenceState | null = null;
  let wsState: PairingPresenceState | null = null;

  const publishMergedPresence = () => {
    if (closed) return;
    if (btState && btState.status === 'connected') {
      opts.onPresence(btState);
      return;
    }
    if (wsState && wsState.status === 'connected') {
      opts.onPresence(wsState);
      return;
    }
    if (btState && (btState.status === 'connecting' || btState.status === 'error')) {
      if (wsState && wsState.status === 'connecting') {
        opts.onPresence(wsState);
      } else {
        opts.onPresence(btState);
      }
      return;
    }
    if (wsState) {
      opts.onPresence(wsState);
      return;
    }
    if (channel) {
      opts.onPresence({
        status: 'connected',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: 'local',
      });
    }
  };

  // 1. Native Android Bluetooth Classic SPP Transport (Auto or Bluetooth SPP mode)
  const useBtSpp =
    mode !== 'wifi_ws' &&
    isNativeBluetoothSppAvailable() &&
    (opts.role === 'pilot' || btTargets.length > 0);

  if (useBtSpp) {
    (async () => {
      try {
        const perm = await BluetoothSpp.ensurePermissions();
        if (closed) return;
        if (!perm?.granted) {
          btState = {
            status: 'error',
            navigators: 0,
            pilots: 0,
            transport: 'bt_spp',
            errorMessage: 'Permissão Bluetooth negada no Android.',
          };
          publishMergedPresence();
          return;
        }

        const l1 = await BluetoothSpp.addListener('telemetryData', (ev) => {
          if (closed || opts.role !== 'pilot' || !ev?.json) return;
          try {
            const parsed = JSON.parse(ev.json) as
              | { type?: string; payload?: PairingTelemetryPayload }
              | PairingTelemetryPayload;
            const payload =
              'payload' in parsed && parsed.payload
                ? parsed.payload
                : 'odometerKm' in parsed
                  ? (parsed as PairingTelemetryPayload)
                  : null;
            if (payload) {
              opts.onTelemetry(payload);
            }
          } catch {
            // Ignore malformed SPP line
          }
        });

        const l2 = await BluetoothSpp.addListener('connectionState', (ev) => {
          if (closed) return;
          const isConn = ev.status === 'connected';
          btConnected = isConn;
          btState = {
            status: isConn
              ? 'connected'
              : ev.status === 'listening' || ev.status === 'connecting'
                ? 'connecting'
                : 'disconnected',
            navigators: Number(ev.navigators) || 0,
            pilots: Number(ev.pilots) || 0,
            transport: 'bt_spp',
            peerName: ev.peerName,
          };
          publishMergedPresence();
        });

        const l3 = await BluetoothSpp.addListener('btError', (ev) => {
          if (closed) return;
          btConnected = false;
          btState = {
            status: 'error',
            navigators: 0,
            pilots: 0,
            transport: 'bt_spp',
            errorMessage: ev?.message || 'Erro na conexão Bluetooth SPP.',
          };
          publishMergedPresence();
        });

        if (closed) {
          l1.remove().catch(() => {});
          l2.remove().catch(() => {});
          l3.remove().catch(() => {});
          return;
        }
        btListeners.push(l1, l2, l3);

        if (opts.role === 'pilot') {
          btState = {
            status: 'connecting',
            navigators: 0,
            pilots: 1,
            transport: 'bt_spp',
          };
          publishMergedPresence();
          await BluetoothSpp.startPilotServer();
        } else if (btTargets.length > 0) {
          btState = {
            status: 'connecting',
            navigators: 1,
            pilots: 0,
            transport: 'bt_spp',
          };
          publishMergedPresence();
          await BluetoothSpp.connectNavigator({
            addresses: btTargets.map((d) => d.address),
          });
        }
      } catch (err) {
        if (!closed) {
          btConnected = false;
          btState = {
            status: 'error',
            navigators: 0,
            pilots: 0,
            transport: 'bt_spp',
            errorMessage:
              err instanceof Error ? err.message : 'Falha ao iniciar Bluetooth SPP.',
          };
          publishMergedPresence();
        }
      }
    })();
  } else if (mode === 'bluetooth_spp' && !isNativeBluetoothSppAvailable()) {
    btState = {
      status: 'error',
      navigators: 0,
      pilots: 0,
      transport: 'none',
      errorMessage: 'Modo Bluetooth SPP nativo requer o app Android (.APK).',
    };
    publishMergedPresence();
  }

  // 2. Local tab BroadcastChannel fallback (same device preview / WebView)
  if (mode !== 'bluetooth_spp' && typeof BroadcastChannel !== 'undefined' && cleanRoom) {
    try {
      channel = new BroadcastChannel(`pitstop_pair_${cleanRoom}`);
      channel.onmessage = (ev) => {
        if (closed || opts.role !== 'pilot') return;
        const msg = ev.data as { type?: string; payload?: PairingTelemetryPayload };
        if (msg?.type === 'nav:telemetry' && msg.payload) {
          opts.onTelemetry(msg.payload);
        }
      };
    } catch {
      channel = null;
    }
  }

  // 3. Wi-Fi / Hotspot / WebSocket Transport (Auto or wifi_ws mode)
  const connectWs = () => {
    if (closed || mode === 'bluetooth_spp' || !cleanRoom) return;
    const url = buildWebSocketUrl(cleanRoom, opts.role, cleanPin);
    if (!url) {
      wsState = {
        status: channel ? 'connected' : 'error',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: channel ? 'local' : 'none',
        errorMessage: channel
          ? undefined
          : 'Configure o IP/Servidor Base em Configurações para parear por Wi-Fi.',
      };
      publishMergedPresence();
      return;
    }

    wsState = {
      status: 'connecting',
      navigators: opts.role === 'navigator' ? 1 : 0,
      pilots: opts.role === 'pilot' ? 1 : 0,
      transport: 'ws',
    };
    publishMergedPresence();

    try {
      ws = new WebSocket(url);
    } catch {
      wsState = {
        status: 'error',
        navigators: 0,
        pilots: 0,
        transport: 'none',
        errorMessage: 'Não foi possível abrir WebSocket.',
      };
      publishMergedPresence();
      return;
    }

    ws.onopen = () => {
      if (closed) return;
      wsOpen = true;
      wsState = {
        status: 'connected',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: 'ws',
      };
      publishMergedPresence();
      try {
        ws?.send(
          JSON.stringify({
            type: opts.role === 'pilot' ? 'pilot:hello' : 'nav:ping',
            roomCode: cleanRoom,
          })
        );
      } catch {
        // Ignore initial hello send error
      }
    };

    ws.onmessage = (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          payload?: PairingTelemetryPayload;
          navigators?: number;
          pilots?: number;
        };
        if (msg.type === 'pair:presence') {
          wsState = {
            status: 'connected',
            navigators: Number(msg.navigators) || 0,
            pilots: Number(msg.pilots) || 0,
            transport: 'ws',
          };
          publishMergedPresence();
        } else if (msg.type === 'nav:telemetry' && msg.payload && opts.role === 'pilot') {
          opts.onTelemetry(msg.payload);
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.onclose = () => {
      wsOpen = false;
      if (closed) return;
      wsState = {
        status: 'disconnected',
        navigators: 0,
        pilots: 0,
        transport: channel ? 'local' : 'none',
      };
      publishMergedPresence();
      reconnectTimer = window.setTimeout(connectWs, 2500);
    };

    ws.onerror = () => {
      wsOpen = false;
      if (closed) return;
      wsState = {
        status: channel ? 'connected' : 'error',
        navigators: opts.role === 'navigator' ? 1 : 0,
        pilots: opts.role === 'pilot' ? 1 : 0,
        transport: channel ? 'local' : 'none',
        errorMessage: 'Sem acesso ao servidor WebSocket.',
      };
      publishMergedPresence();
    };
  };

  if (mode !== 'bluetooth_spp') {
    connectWs();
  }

  return {
    sendTelemetry: (payload: PairingTelemetryPayload) => {
      if (closed || opts.role !== 'navigator') return;
      const envelope = { type: 'nav:telemetry', payload };
      const jsonStr = JSON.stringify(envelope);

      if (useBtSpp && btConnected) {
        BluetoothSpp.sendTelemetry({ json: jsonStr }).catch(() => {});
      }

      if (ws && wsOpen && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(jsonStr);
        } catch {
          // Ignore send errors while reconnecting
        }
      }

      if (channel) {
        try {
          channel.postMessage(envelope);
        } catch {
          // Ignore local broadcast errors
        }
      }
    },
    close: () => {
      closed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
        ws = null;
      }
      if (channel) {
        try {
          channel.close();
        } catch {
          // Ignore close error
        }
        channel = null;
      }
      for (const h of btListeners) {
        h.remove().catch(() => {});
      }
      if (useBtSpp) {
        BluetoothSpp.stopAll().catch(() => {});
      }
    },
  };
}
