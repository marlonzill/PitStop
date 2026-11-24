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
import { CockpitSelect } from './CockpitSelect';
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
  const recordingCount = cameras.filter((c) => c.connected && !c.sleeping && c.recording).length;
  const savedNotShown = savedDevices.filter((s) => !cameras.some((c) => c.id === s.deviceId));

  return (
    <div className="space-y-3">
      {/* Top Action & BLE Pairing Bar */}
      <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-[var(--ps-accent)]" />
              <h2 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-[var(--ps-text)] uppercase">
                GoPro BLE (HERO9 – HERO13)
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-[var(--ps-muted)]">
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
              className="pitstop-btn-red inline-flex min-h-[48px] items-center gap-1.5 rounded-xl px-4 text-xs font-extrabold uppercase whitespace-nowrap"
            >
              <Bluetooth className={`h-4 w-4 ${scanning ? 'animate-pulse' : ''}`} />
              <span>{scanning ? 'Buscando BLE...' : '+ Buscar Câmera BLE'}</span>
            </button>

            <button
              type="button"
              onClick={() => activateSimulatedGoProFleet(5)}
              className="pitstop-btn-metal inline-flex min-h-[48px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-bold whitespace-nowrap"
            >
              <Video className="h-4 w-4 text-[var(--ps-emerald)]" />
              <span>Simular 5</span>
            </button>
          </div>
        </div>

        {!bleReady && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-[var(--ps-amber)]">
            Bluetooth BLE web indisponível neste navegador (use o App Android APK, Chrome no Android ou teste com{' '}
            <strong>Simular 5</strong>).
          </div>
        )}

        {errorMsg && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-2 text-xs font-semibold text-[var(--ps-danger)]">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={clearGoProFleetError}
              className="shrink-0 p-1 text-[var(--ps-danger)] hover:text-[var(--ps-text)]"
              aria-label="Fechar aviso"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Saved Devices Quick Reconnect / Wake + Inline Naming */}
        {savedNotShown.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5">
            <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
              Câmeras Salvas (Reconexão Rápida / Nomear)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {savedNotShown.map((sd) => {
                const displayName = getGoProDisplayName(sd);
                const isEditing = editingId === sd.deviceId;
                return (
                  <div
                    key={sd.deviceId}
                    className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] pl-2.5 pr-1 py-1"
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
                          className="h-7 w-32 rounded border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
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
                        <span className="text-xs font-bold text-[var(--ps-text)]">{displayName}</span>
                        <button
                          type="button"
                          onClick={() => beginRename(sd.deviceId, sd.alias || sd.name)}
                          className="p-1 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
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
                      className="p-1 text-[var(--ps-muted)] hover:text-red-400"
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
          <div className="space-y-2 border-t border-[var(--ps-border)] pt-3">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => {
                  void shutterAllGoPro(true);
                }}
                className="pitstop-btn-red inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-extrabold uppercase"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Gravar ({cameras.length})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void shutterAllGoPro(false);
                }}
                className="pitstop-btn-metal inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-extrabold uppercase"
              >
                <Square className="h-4 w-4 fill-current text-[var(--ps-muted)]" />
                <span>Parar ({recordingCount})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void wakeAllGoPro();
                }}
                className="inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border border-emerald-500/45 bg-emerald-500/15 px-3 text-xs font-bold text-[var(--ps-emerald)] uppercase hover:bg-emerald-500/25"
              >
                <Power className="h-4 w-4" />
                <span>Ligar / Acordar</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  void sleepAllGoPro();
                }}
                className="inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-muted)] uppercase hover:text-[var(--ps-text)]"
              >
                <Power className="h-4 w-4 opacity-70" />
                <span>Sleep</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  void modeAllGoPro('video');
                }}
                className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-xs font-bold text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
              >
                <Video className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
                <span>Modo Vídeo (Todas)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void modeAllGoPro('photo');
                }}
                className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-xs font-bold text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
              >
                <Image className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
                <span>Modo Foto (Todas)</span>
              </button>
            </div>
          </div>
        )}

        <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-2.5 text-xs">
          <span className="font-semibold text-[var(--ps-text)]">
            Auto-REC na Largada (disparar todas ao iniciar cronômetro da prova)
          </span>
          <input
            type="checkbox"
            checked={settings.goproAutoRecOnStart}
            onChange={(e) => updateSettings({ goproAutoRecOnStart: e.target.checked })}
            className="h-4 w-4 accent-[var(--ps-accent)]"
          />
        </label>
      </section>

      {/* Batch Remote Config */}
      {cameras.length > 0 && (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs font-bold text-[var(--ps-muted)] uppercase">
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

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <CockpitSelect
              compact
              ariaLabel="Resolução GoPro"
              value={batchRes}
              options={[
                { value: '4K', label: 'Res: 4K UHD' },
                { value: '2.7K', label: 'Res: 2.7K' },
                { value: '1080p', label: 'Res: 1080p HD' },
              ]}
              onChange={(val) => setBatchRes(val as GoProResolution)}
            />

            <CockpitSelect
              compact
              ariaLabel="FPS GoPro"
              value={String(batchFps)}
              options={[
                { value: '30', label: '30 FPS' },
                { value: '60', label: '60 FPS' },
                { value: '120', label: '120 FPS' },
              ]}
              onChange={(val) => setBatchFps(Number(val) as GoProFps)}
            />

            <CockpitSelect
              compact
              ariaLabel="HyperSmooth"
              value={batchHs}
              options={[
                { value: 'boost', label: 'HyperSmooth Boost' },
                { value: 'autoboost', label: 'AutoBoost' },
                { value: 'on', label: 'HyperSmooth On' },
                { value: 'off', label: 'Estabilização Off' },
              ]}
              onChange={(val) => setBatchHs(val as GoProHyperSmooth)}
            />

            <CockpitSelect
              compact
              ariaLabel="Lente Digital"
              value={batchLens}
              options={[
                { value: 'wide', label: 'Lente Wide' },
                { value: 'superview', label: 'SuperView' },
                { value: 'linear', label: 'Linear' },
                { value: 'horizon_lock', label: 'Trava Horizonte' },
              ]}
              onChange={(val) => setBatchLens(val as GoProLens)}
            />
          </div>
        </section>
      )}

      {/* Multi-Camera Status Grid */}
      {cameras.length === 0 ? (
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-6 text-center space-y-2.5">
          <Camera className="mx-auto h-7 w-7 text-[var(--ps-accent)]" />
          <p className="text-sm font-bold text-[var(--ps-text)]">
            Nenhuma GoPro pareada
          </p>
          <p className="text-xs text-[var(--ps-muted)]">
            Ligue o Bluetooth da câmera e toque em <strong className="text-[var(--ps-text)]">+ Buscar Câmera BLE</strong> para controlar gravações direto do cockpit.
          </p>
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
                    ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)]'
                    : hasAlert
                      ? 'border-amber-500/60 bg-amber-500/10'
                      : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
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
                          className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
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
                        <span className="truncate font-['Barlow_Condensed'] text-lg font-bold text-[var(--ps-text)] uppercase">
                          {displayName}
                        </span>
                        <button
                          type="button"
                          onClick={() => beginRename(cam.id, cam.alias || cam.name)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--ps-muted)] hover:bg-[var(--ps-card)] hover:text-[var(--ps-text)]"
                          aria-label={`Renomear ${displayName}`}
                          title="Renomear câmera"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                    <p className="font-mono text-[11px] text-[var(--ps-muted)] truncate">
                      {cam.alias ? `${cam.name} · ` : ''}
                      {cam.captureMode === 'video' ? 'VÍDEO' : 'FOTO'} · {cam.resolution} · {cam.fps}fps ·{' '}
                      {cam.lens.toUpperCase()}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => disconnectGoProFromFleet(cam)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-red-400"
                    aria-label={`Desconectar ${displayName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Live Telemetry Pills */}
                <div className="grid grid-cols-3 gap-1.5 font-mono text-xs tabular-nums">
                  <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5">
                    <span className="text-[10px] text-[var(--ps-muted)] block">BATERIA</span>
                    <span
                      className={`inline-flex items-center gap-1 font-bold ${
                        cam.batteryPct <= 15
                          ? 'text-[var(--ps-danger)]'
                          : cam.batteryPct <= 30
                            ? 'text-[var(--ps-amber)]'
                            : 'text-[var(--ps-emerald)]'
                      }`}
                    >
                      <Battery className="h-3 w-3" />
                      {cam.batteryPct}%
                    </span>
                  </div>

                  <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5">
                    <span className="text-[10px] text-[var(--ps-muted)] block">CARTÃO SD</span>
                    <span className="inline-flex items-center gap-1 font-bold text-[var(--ps-text)]">
                      <HardDrive className="h-3 w-3 text-[var(--ps-muted)]" />
                      {cam.sdRemainingMin}m
                    </span>
                  </div>

                  <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2.5 py-1.5">
                    <span className="text-[10px] text-[var(--ps-muted)] block">STATUS</span>
                    <span
                      className={`font-bold ${
                        disconnectedOrSleeping
                          ? 'text-[var(--ps-muted)]'
                          : cam.recording
                            ? 'text-[var(--ps-danger)]'
                            : 'text-[var(--ps-emerald)]'
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
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-[var(--ps-amber)]">
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
                    className={`min-h-[38px] inline-flex items-center justify-center gap-1 rounded-lg border text-[11px] font-bold ${
                      cam.captureMode === 'video'
                        ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
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
                    className={`min-h-[38px] inline-flex items-center justify-center gap-1 rounded-lg border text-[11px] font-bold ${
                      cam.captureMode === 'photo'
                        ? 'border-amber-400 bg-amber-500/20 text-[var(--ps-amber)]'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
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
                    className={`col-span-2 min-h-[48px] rounded-xl text-xs font-extrabold uppercase ${
                      cam.recording
                        ? 'pitstop-btn-metal'
                        : 'pitstop-btn-red'
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
                        ? 'border-emerald-500/50 bg-emerald-500/15 text-[var(--ps-emerald)]'
                        : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
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
