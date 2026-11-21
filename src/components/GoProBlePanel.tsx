import React, { useState } from 'react';
import {
  AlertTriangle,
  Battery,
  Bluetooth,
  Camera,
  Check,
  HardDrive,
  Image,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Square,
  Thermometer,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import {
  activateSimulatedGoProFleet,
  applyBatchSettingsToFleet,
  clearGoProFleetError,
  disconnectGoProFromFleet,
  forgetSavedGoProFromFleet,
  getGoProDisplayName,
  isGoProBleSupported,
  modeAllGoPro,
  modeSingleGoPro,
  renameGoProInFleet,
  scanAndAddGoProToFleet,
  shutterAllGoPro,
  shutterSingleGoPro,
  sleepAllGoPro,
  toggleSingleGoProPower,
  useGoProFleet,
  wakeAllGoPro,
  wakeSavedGoProInFleet,
  type GoProFps,
  type GoProHyperSmooth,
  type GoProLens,
  type GoProResolution,
} from '../utils/goproBle';
import { useNavSettings } from '../utils/navSettings';

function formatRecTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const GoProBlePanel: React.FC = () => {
  const [settings, updateSettings] = useNavSettings();
  const { cameras, savedDevices, scanning, wakingId, errorMsg } = useGoProFleet();

  const [batchRes, setBatchRes] = useState<GoProResolution>('4K');
  const [batchFps, setBatchFps] = useState<GoProFps>(60);
  const [batchHs, setBatchHs] = useState<GoProHyperSmooth>('boost');
  const [batchLens, setBatchLens] = useState<GoProLens>('wide');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const beginRename = (deviceId: string, currentName: string) => {
    setEditingId(deviceId);
    setEditingName(currentName);
  };

  const commitRename = (deviceId: string) => {
    renameGoProInFleet(deviceId, editingName);
    setEditingId(null);
    setEditingName('');
  };

  const bleReady = isGoProBleSupported();
  const recordingCount = cameras.filter((c) => c.recording).length;
  const savedNotShown = savedDevices.filter((s) => !cameras.some((c) => c.id === s.deviceId));

  return (
    <div className="space-y-3">
      {/* Top Action & BLE Pairing Bar */}
      <section className="rounded-xl border border-zinc-800 bg-[#111214] p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-[#E10600]" />
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white uppercase">
                GoPro BLE (HERO9 – HERO13)
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-[#B5B5B5]">
              Controle até 7 câmeras via Open GoPro BLE e nomeie cada câmera para uso rápido em Velocidade.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void scanAndAddGoProToFleet();
              }}
              disabled={scanning}
              className="pitstop-btn-red inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3.5 text-xs font-extrabold text-white uppercase whitespace-nowrap"
            >
              <Bluetooth className={`h-4 w-4 ${scanning ? 'animate-pulse' : ''}`} />
              <span>{scanning ? 'Buscando BLE...' : '+ Buscar Câmera BLE'}</span>
            </button>

            <button
              type="button"
              onClick={() => activateSimulatedGoProFleet(5)}
              className="pitstop-btn-metal inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold whitespace-nowrap"
            >
              <Video className="h-3.5 w-3.5 text-emerald-400" />
              <span>Simular 5</span>
            </button>
          </div>
        </div>

        {!bleReady && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-200">
            Bluetooth BLE web indisponível neste navegador (use o App Android APK, Chrome no Android ou teste com{' '}
            <strong>Simular 5</strong>).
          </div>
        )}

        {errorMsg && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-700/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={clearGoProFleetError}
              className="shrink-0 p-0.5 text-red-300 hover:text-white"
              aria-label="Fechar aviso"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Saved Devices Quick Reconnect / Wake + Inline Naming */}
        {savedNotShown.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-[#080B0D] p-2.5">
            <p className="font-mono text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
              Câmeras Salvas (Reconexão Rápida / Nomear)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {savedNotShown.map((sd) => {
                const displayName = getGoProDisplayName(sd);
                const isEditing = editingId === sd.deviceId;
                return (
                  <div
                    key={sd.deviceId}
                    className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-zinc-700 bg-[#111214] pl-2.5 pr-1 py-1"
                  >
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(sd.deviceId);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          placeholder="Ex: Capô, Para-brisa"
                          autoFocus
                          className="h-7 w-32 rounded border border-zinc-600 bg-[#080B0D] px-2 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(sd.deviceId)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded bg-emerald-600 text-white"
                          aria-label="Salvar nome da câmera"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-xs font-bold text-white">{displayName}</span>
                        <button
                          type="button"
                          onClick={() => beginRename(sd.deviceId, sd.alias || sd.name)}
                          className="p-1 text-zinc-400 hover:text-white"
                          aria-label={`Renomear ${displayName}`}
                          title="Dar nome para esta GoPro"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      disabled={wakingId === sd.deviceId}
                      onClick={() => {
                        void wakeSavedGoProInFleet(sd);
                      }}
                      className="rounded bg-emerald-600/90 px-2 py-1 text-[10px] font-extrabold text-white uppercase hover:bg-emerald-500"
                    >
                      {wakingId === sd.deviceId ? 'Conectando...' : 'Ligar / Acordar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => forgetSavedGoProFromFleet(sd.deviceId)}
                      className="p-1 text-zinc-500 hover:text-red-400"
                      aria-label={`Esquecer ${displayName}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Master Triggers Bar */}
        {cameras.length > 0 && (
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => {
                  void shutterAllGoPro(true);
                }}
                className="pitstop-btn-red inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-extrabold text-white uppercase"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Gravar ({cameras.length})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void shutterAllGoPro(false);
                }}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 text-xs font-extrabold text-white uppercase hover:bg-zinc-800"
              >
                <Square className="h-4 w-4 fill-current text-zinc-300" />
                <span>Parar ({recordingCount})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void wakeAllGoPro();
                }}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/35 px-3 text-xs font-bold text-emerald-300 uppercase hover:bg-emerald-950/60"
              >
                <Power className="h-4 w-4" />
                <span>Ligar / Acordar</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void sleepAllGoPro();
                }}
                className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-bold text-[#C0C4C9] uppercase hover:text-white"
              >
                <Power className="h-4 w-4 text-zinc-500" />
                <span>Sleep</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  void modeAllGoPro('video');
                }}
                className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-[#080B0D] text-xs font-bold text-[#C0C4C9] hover:border-[#E10600] hover:text-white"
              >
                <Video className="h-3.5 w-3.5 text-[#E10600]" />
                <span>Modo Vídeo (Todas)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void modeAllGoPro('photo');
                }}
                className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-[#080B0D] text-xs font-bold text-[#C0C4C9] hover:border-[#E10600] hover:text-white"
              >
                <Image className="h-3.5 w-3.5 text-amber-400" />
                <span>Modo Foto (Todas)</span>
              </button>
            </div>
          </div>
        )}

        <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-[#080B0D] px-3.5 py-2.5 text-xs">
          <span className="font-semibold text-[#F4F4F4]">
            Auto-REC na Largada (disparar todas ao iniciar cronômetro da prova)
          </span>
          <input
            type="checkbox"
            checked={settings.goproAutoRecOnStart}
            onChange={(e) => updateSettings({ goproAutoRecOnStart: e.target.checked })}
            className="h-4 w-4 accent-[#E10600]"
          />
        </label>
      </section>

      {/* Batch Remote Config */}
      {cameras.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-[#111214] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs font-bold text-[#C0C4C9] uppercase">
              Ajuste em Lote (Todas Conectadas)
            </span>
            <button
              type="button"
              onClick={() => {
                void applyBatchSettingsToFleet({
                  resolution: batchRes,
                  fps: batchFps,
                  hypersmooth: batchHs,
                  lens: batchLens,
                });
              }}
              className="pitstop-btn-metal rounded-lg px-3 py-1.5 text-xs font-bold"
            >
              Aplicar em Todas
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <select
              aria-label="Resolução GoPro"
              value={batchRes}
              onChange={(e) => setBatchRes(e.target.value as GoProResolution)}
              className="min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 font-mono text-xs font-bold text-white"
            >
              <option value="4K">Res: 4K UHD</option>
              <option value="2.7K">Res: 2.7K</option>
              <option value="1080p">Res: 1080p HD</option>
            </select>

            <select
              aria-label="FPS GoPro"
              value={batchFps}
              onChange={(e) => setBatchFps(Number(e.target.value) as GoProFps)}
              className="min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 font-mono text-xs font-bold text-white"
            >
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
              <option value={120}>120 FPS</option>
            </select>

            <select
              aria-label="HyperSmooth"
              value={batchHs}
              onChange={(e) => setBatchHs(e.target.value as GoProHyperSmooth)}
              className="min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 font-mono text-xs font-bold text-white"
            >
              <option value="boost">HyperSmooth Boost</option>
              <option value="autoboost">AutoBoost</option>
              <option value="on">HyperSmooth On</option>
              <option value="off">Estabilização Off</option>
            </select>

            <select
              aria-label="Lente Digital"
              value={batchLens}
              onChange={(e) => setBatchLens(e.target.value as GoProLens)}
              className="min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 font-mono text-xs font-bold text-white"
            >
              <option value="wide">Lente Wide</option>
              <option value="superview">SuperView</option>
              <option value="linear">Linear</option>
              <option value="horizon_lock">Trava Horizonte</option>
            </select>
          </div>
        </section>
      )}

      {/* Multi-Camera Status Grid */}
      {cameras.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-6 text-center text-xs text-[#B5B5B5]">
          Ligue o Bluetooth da GoPro e toque em <strong className="text-white">+ Buscar Câmera BLE</strong>.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cameras.map((cam) => {
            const hasAlert = cam.overheating || cam.sdFull || cam.batteryPct <= 15;
            const disconnectedOrSleeping = cam.sleeping || !cam.connected;
            const displayName = getGoProDisplayName(cam);
            const isEditing = editingId === cam.id;

            return (
              <div
                key={cam.id}
                className={`rounded-xl border p-3.5 space-y-2.5 ${
                  cam.recording
                    ? 'border-[#E10600]/80 bg-[#1B0D0F]'
                    : hasAlert
                      ? 'border-amber-500/60 bg-[#17120B]'
                      : 'border-zinc-800 bg-[#111214]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(cam.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          placeholder="Nome (ex: Capô, Para-brisa)"
                          autoFocus
                          className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-600 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(cam.id)}
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"
                          aria-label="Confirmar nome"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                            disconnectedOrSleeping
                              ? 'bg-zinc-500'
                              : cam.recording
                                ? 'bg-[#E10600] animate-pulse'
                                : 'bg-emerald-400'
                          }`}
                        />
                        <span className="truncate font-['Barlow_Condensed'] text-lg font-bold text-white uppercase">
                          {displayName}
                        </span>
                        <button
                          type="button"
                          onClick={() => beginRename(cam.id, cam.alias || cam.name)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-white"
                          aria-label={`Renomear ${displayName}`}
                          title="Renomear câmera"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    <p className="font-mono text-[11px] text-[#B5B5B5] truncate">
                      {cam.alias ? `${cam.name} · ` : ''}
                      {cam.captureMode === 'video' ? 'VÍDEO' : 'FOTO'} · {cam.resolution} · {cam.fps}fps ·{' '}
                      {cam.lens.toUpperCase()}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => disconnectGoProFromFleet(cam)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-[#080B0D] text-zinc-400 hover:text-red-400"
                    aria-label={`Desconectar ${displayName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Live Telemetry Pills */}
                <div className="grid grid-cols-3 gap-1.5 font-mono text-xs tabular-nums">
                  <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-1.5">
                    <span className="text-[10px] text-[#B5B5B5] block">BATERIA</span>
                    <span
                      className={`inline-flex items-center gap-1 font-bold ${
                        cam.batteryPct <= 15
                          ? 'text-[#FF2A2A]'
                          : cam.batteryPct <= 30
                            ? 'text-amber-300'
                            : 'text-emerald-400'
                      }`}
                    >
                      <Battery className="h-3 w-3" />
                      {cam.batteryPct}%
                    </span>
                  </div>

                  <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-1.5">
                    <span className="text-[10px] text-[#B5B5B5] block">CARTÃO SD</span>
                    <span className="inline-flex items-center gap-1 font-bold text-white">
                      <HardDrive className="h-3 w-3 text-[#C0C4C9]" />
                      {cam.sdRemainingMin}m
                    </span>
                  </div>

                  <div className="rounded-lg border border-zinc-800 bg-[#080B0D] px-2.5 py-1.5">
                    <span className="text-[10px] text-[#B5B5B5] block">STATUS</span>
                    <span
                      className={`font-bold ${
                        disconnectedOrSleeping
                          ? 'text-zinc-400'
                          : cam.recording
                            ? 'text-[#FF2A2A]'
                            : 'text-emerald-400'
                      }`}
                    >
                      {cam.sleeping
                        ? 'SLEEP'
                        : !cam.connected
                          ? 'OFFLINE'
                          : cam.recording
                            ? `REC ${formatRecTimer(cam.encodingDurationSec)}`
                            : 'ATIVA'}
                    </span>
                  </div>
                </div>

                {hasAlert && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/30 px-2.5 py-1.5 text-[11px] font-semibold text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {cam.overheating && (
                      <span className="inline-flex items-center gap-1">
                        <Thermometer className="h-3 w-3" /> Superaquecimento
                      </span>
                    )}
                    {cam.sdFull && <span>Cartão SD quase cheio</span>}
                    {cam.batteryPct <= 15 && <span>Bateria crítica ({cam.batteryPct}%)</span>}
                  </div>
                )}

                {/* Per-Camera Mode Switch: Vídeo / Foto */}
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={disconnectedOrSleeping}
                    onClick={() => {
                      void modeSingleGoPro(cam, 'video');
                    }}
                    className={`min-h-[34px] inline-flex items-center justify-center gap-1 rounded-lg border text-[11px] font-bold ${
                      cam.captureMode === 'video'
                        ? 'border-[#E10600] bg-[#E10600]/20 text-white'
                        : 'border-zinc-800 bg-[#080B0D] text-[#B5B5B5]'
                    } disabled:opacity-40`}
                  >
                    <Video className="h-3 w-3" />
                    <span>Modo Vídeo</span>
                  </button>
                  <button
                    type="button"
                    disabled={disconnectedOrSleeping}
                    onClick={() => {
                      void modeSingleGoPro(cam, 'photo');
                    }}
                    className={`min-h-[34px] inline-flex items-center justify-center gap-1 rounded-lg border text-[11px] font-bold ${
                      cam.captureMode === 'photo'
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                        : 'border-zinc-800 bg-[#080B0D] text-[#B5B5B5]'
                    } disabled:opacity-40`}
                  >
                    <Image className="h-3 w-3" />
                    <span>Modo Foto</span>
                  </button>
                </div>

                {/* Shutter + Ligar/Acordar / Sleep */}
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    disabled={disconnectedOrSleeping}
                    onClick={() => {
                      void shutterSingleGoPro(cam, !cam.recording);
                    }}
                    className={`col-span-2 min-h-[40px] rounded-lg text-xs font-extrabold uppercase ${
                      cam.recording
                        ? 'bg-zinc-800 text-white border border-zinc-600'
                        : 'pitstop-btn-red text-white'
                    } disabled:opacity-40`}
                  >
                    {cam.recording ? 'Parar Gravação' : 'Iniciar Gravação'}
                  </button>
                  <button
                    type="button"
                    disabled={cam.reconnecting}
                    onClick={() => {
                      void toggleSingleGoProPower(cam);
                    }}
                    className={`min-h-[40px] inline-flex items-center justify-center gap-1 rounded-lg border px-1.5 text-[11px] font-bold ${
                      disconnectedOrSleeping
                        ? 'border-emerald-500/50 bg-emerald-950/40 text-emerald-300'
                        : 'border-zinc-700 bg-[#080B0D] text-[#C0C4C9] hover:text-white'
                    }`}
                  >
                    {cam.reconnecting ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                    <span>{disconnectedOrSleeping ? 'Ligar / Acordar' : 'Desligar'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
