import React, { useState } from 'react';
import {
  AlertTriangle,
  Bluetooth,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Square,
  Thermometer,
  Trash2,
  X,
} from 'lucide-react';
import { CockpitSelect } from './CockpitSelect';
import {
  applyBatchSettingsToFleet,
  clearGoProFleetError,
  disconnectGoProFromFleet,
  forgetSavedGoProFromFleet,
  getGoProDisplayName,
  isGoProBleSupported,
  renameGoProInFleet,
  scanAndAddGoProToFleet,
  shutterAllGoPro,
  shutterSingleGoPro,
  toggleSingleGoProPower,
  useGoProFleet,
  wakeAllGoPro,
  wakeSavedGoProInFleet,
  type GoProFps,
  type GoProHyperSmooth,
  type GoProLens,
  type GoProResolution,
} from '../utils/goproBle';

function formatRecTimer(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatLensLabel(lens: GoProLens): string {
  switch (lens) {
    case 'wide':
      return 'Wide';
    case 'superview':
      return 'SuperView';
    case 'linear':
      return 'Linear';
    case 'horizon_lock':
      return 'Horizon';
  }
}

export const GoProBlePanel: React.FC = () => {
  const { cameras, savedDevices, scanning, wakingId, errorMsg } = useGoProFleet();

  const [batchOpen, setBatchOpen] = useState(false);
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
  const savedNotShown = savedDevices.filter((s) => !cameras.some((c) => c.id === s.deviceId));
  const hasAnyCamera = cameras.length > 0 || savedNotShown.length > 0;
  const readyCamerasCount = cameras.filter((c) => c.connected && !c.sleeping).length;
  const recordingCount = cameras.filter((c) => c.connected && !c.sleeping && c.recording).length;

  const handleMasterRecordAll = async () => {
    if (readyCamerasCount === 0) {
      await wakeAllGoPro();
    }
    await shutterAllGoPro(true);
  };

  return (
    <div className="space-y-3">
      {errorMsg && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-red-500/50 bg-red-500/15 px-3 py-2 text-xs font-semibold text-[var(--ps-danger)]">
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

      {/* 1. Controle Mestre Manual (no topo quando houver câmeras pareadas/salvas) */}
      {hasAnyCamera && (
        <section className="rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-black tracking-wider text-[var(--ps-muted)] uppercase">
              Controle Mestre GoPro
            </span>
            <span className="font-mono text-[11px] font-bold text-[var(--ps-muted)] tabular-nums">
              {readyCamerasCount}/{cameras.length + savedNotShown.length} pronta(s)
              {recordingCount > 0 && (
                <span className="ml-1.5 font-black text-[#FF2A2A]">· {recordingCount} REC</span>
              )}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                void handleMasterRecordAll();
              }}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-[#EF233C] bg-[#EF233C] px-3 text-xs font-black tracking-wide text-white uppercase shadow-[0_0_20px_rgba(239,35,60,0.35)] transition-all hover:brightness-110 active:scale-[0.98]"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-white" />
              <span>GRAVAR TODAS</span>
            </button>

            <button
              type="button"
              onClick={() => {
                void shutterAllGoPro(false);
              }}
              disabled={recordingCount === 0}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-[var(--ps-border-strong)] bg-[#1B1E24] px-3 text-xs font-black tracking-wide text-[var(--ps-text)] uppercase transition-all hover:border-white/30 active:scale-[0.98] disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5 fill-current text-[var(--ps-text)]" />
              <span>PARAR TODAS</span>
            </button>
          </div>
        </section>
      )}

      {/* 2. Cards Compactos das Câmeras */}
      {!hasAnyCamera ? (
        <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-6 text-center space-y-2">
          <Camera className="mx-auto h-7 w-7 text-[var(--ps-accent)]" />
          <p className="text-sm font-bold text-[var(--ps-text)]">
            Nenhuma GoPro pareada
          </p>
          <p className="text-xs text-[var(--ps-muted)]">
            Ligue o Bluetooth da câmera e toque em <strong className="text-[var(--ps-text)]">+ Buscar Nova Câmera BLE</strong> abaixo para parear e gravar direto do cockpit.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {cameras.map((cam) => {
            const disconnectedOrSleeping = cam.sleeping || !cam.connected;
            const hasAlert =
              cam.overheating ||
              cam.sdFull ||
              (!disconnectedOrSleeping && cam.batteryPct <= 15);
            const displayName = getGoProDisplayName(cam);
            const isEditing = editingId === cam.id;

            const statusText = cam.recording
              ? `● REC ${formatRecTimer(cam.encodingDurationSec)}`
              : disconnectedOrSleeping
                ? '● OFFLINE'
                : '● PRONTA';

            const statusCls = cam.recording
              ? 'text-[#FF2A2A] animate-pulse'
              : disconnectedOrSleeping
                ? 'text-[var(--ps-muted)]'
                : 'text-[var(--ps-emerald)]';

            return (
              <div
                key={cam.id}
                className={`rounded-xl border p-3.5 space-y-3 ${
                  cam.recording
                    ? 'border-[#EF233C]/85 bg-red-950/25 shadow-[0_0_20px_rgba(239,35,60,0.16)]'
                    : hasAlert
                      ? 'border-amber-500/60 bg-amber-500/10'
                      : 'border-[var(--ps-border)] bg-[var(--ps-surface)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {cam.recording ? (
                        <span className="inline-flex items-center gap-2 rounded-lg border border-[#EF233C]/70 bg-[#EF233C]/20 px-2.5 py-1 font-mono text-base font-black tracking-wider text-[#FF2A2A] tabular-nums">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#FF2A2A] animate-pulse" />
                          <span>REC {formatRecTimer(cam.encodingDurationSec)}</span>
                        </span>
                      ) : (
                        <span className={`font-mono text-[11px] font-black uppercase tabular-nums shrink-0 ${statusCls}`}>
                          {statusText}
                        </span>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="flex items-center gap-1.5 pt-0.5">
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
                        <span className="truncate font-['Barlow_Condensed'] text-xl font-black leading-tight text-[var(--ps-text)] uppercase">
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

                    <p className="truncate font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                      Bateria{' '}
                      <strong
                        className={
                          cam.batteryPct <= 15
                            ? 'text-[var(--ps-danger)]'
                            : cam.batteryPct <= 30
                              ? 'text-[var(--ps-amber)]'
                              : 'text-[var(--ps-emerald)]'
                        }
                      >
                        {cam.batteryPct}%
                      </strong>{' '}
                      · SD {cam.sdRemainingMin}m · {cam.resolution} · {cam.fps}fps ·{' '}
                      {formatLensLabel(cam.lens)}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      disconnectGoProFromFleet(cam);
                      forgetSavedGoProFromFleet(cam.id);
                    }}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:border-red-500/50 hover:text-red-400"
                    aria-label={`Remover ${displayName}`}
                    title="Remover câmera"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {hasAlert && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-[var(--ps-amber)]">
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

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={disconnectedOrSleeping}
                    onClick={() => {
                      void shutterSingleGoPro(cam, !cam.recording);
                    }}
                    className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2 text-[11px] font-black uppercase transition-all active:scale-[0.98] disabled:opacity-35 ${
                      cam.recording
                        ? 'border border-[var(--ps-border-strong)] bg-[#1B1E24] text-[var(--ps-text)] hover:border-white/30'
                        : 'border border-[#EF233C] bg-[#EF233C] text-white'
                    }`}
                  >
                    {cam.recording ? (
                      <>
                        <Square className="h-3 w-3 fill-current" />
                        <span>PARAR GRAVAÇÃO</span>
                      </>
                    ) : (
                      <>
                        <span className="h-2.5 w-2.5 rounded-full bg-white" />
                        <span>GRAVAR</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={cam.reconnecting}
                    onClick={() => {
                      void toggleSingleGoProPower(cam);
                    }}
                    className={`min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border px-2 text-[11px] font-extrabold uppercase transition-all active:scale-[0.98] ${
                      disconnectedOrSleeping
                        ? 'border-emerald-500/60 bg-emerald-500/15 text-[var(--ps-emerald)] hover:bg-emerald-500/25'
                        : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                    }`}
                  >
                    {cam.reconnecting ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                    <span>{disconnectedOrSleeping ? 'ACORDAR' : 'DESLIGAR'}</span>
                  </button>
                </div>
              </div>
            );
          })}

          {savedNotShown.map((sd) => {
            const displayName = getGoProDisplayName(sd);
            const isEditing = editingId === sd.deviceId;
            const isWaking = wakingId === sd.deviceId;

            return (
              <div
                key={sd.deviceId}
                className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <span className="block font-mono text-[10px] font-black text-[var(--ps-muted)] uppercase">
                      ● OFFLINE
                    </span>

                    {isEditing ? (
                      <div className="flex items-center gap-1.5 pt-0.5">
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
                          className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => commitRename(sd.deviceId)}
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"
                          aria-label="Salvar nome da câmera"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="truncate font-['Barlow_Condensed'] text-lg font-bold leading-tight text-[var(--ps-text)] uppercase">
                          {displayName}
                        </span>
                        <button
                          type="button"
                          onClick={() => beginRename(sd.deviceId, sd.alias || sd.name)}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--ps-muted)] hover:bg-[var(--ps-card)] hover:text-[var(--ps-text)]"
                          aria-label={`Renomear ${displayName}`}
                          title="Renomear câmera"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </div>
                    )}

                    <p className="truncate font-mono text-[11px] text-[var(--ps-muted)]">
                      Câmera salva · Toque em Acordar para reconectar via BLE
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => forgetSavedGoProFromFleet(sd.deviceId)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:border-red-500/50 hover:text-red-400"
                    aria-label={`Remover ${displayName}`}
                    title="Remover câmera"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled
                    className="min-h-[42px] rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 text-[11px] font-black text-[var(--ps-muted)] uppercase opacity-35"
                  >
                    INICIAR GRAVAÇÃO
                  </button>

                  <button
                    type="button"
                    disabled={isWaking}
                    onClick={() => {
                      void wakeSavedGoProInFleet(sd);
                    }}
                    className="min-h-[42px] inline-flex items-center justify-center gap-1 rounded-xl border border-emerald-500/60 bg-emerald-500/15 px-2 text-[11px] font-extrabold text-[var(--ps-emerald)] uppercase hover:bg-emerald-500/25"
                  >
                    {isWaking ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                    <span>{isWaking ? 'CONECTANDO...' : 'ACORDAR'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 3. Ajuste em Lote recolhível em Accordion discreto abaixo das câmeras */}
      {cameras.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)]">
          <button
            type="button"
            onClick={() => setBatchOpen((v) => !v)}
            aria-expanded={batchOpen}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-[var(--ps-card)]/60"
          >
            <span className="font-mono text-[11px] font-bold text-[var(--ps-muted)] uppercase">
              Ajuste em Lote (Resolução / FPS / Lente)
            </span>
            {batchOpen ? (
              <ChevronUp className="h-4 w-4 shrink-0 text-[var(--ps-muted)]" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ps-muted)]" />
            )}
          </button>

          {batchOpen && (
            <div className="space-y-2.5 border-t border-[var(--ps-border)] p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
                className="pitstop-btn-metal w-full rounded-lg px-3 py-2 text-xs font-extrabold uppercase"
              >
                Aplicar em Todas Conectadas
              </button>
            </div>
          )}
        </section>
      )}

      {/* 4. Rodapé compacto para pareamento de novas câmeras */}
      {!bleReady && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-[var(--ps-amber)]">
          Bluetooth BLE web indisponível neste navegador (use o App Android APK ou Chrome no Android).
        </div>
      )}

      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => {
            void scanAndAddGoProToFleet();
          }}
          disabled={scanning}
          className="pitstop-btn-metal inline-flex min-h-[42px] w-full items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-extrabold uppercase"
        >
          <Bluetooth className={`h-4 w-4 text-[var(--ps-accent)] ${scanning ? 'animate-pulse' : ''}`} />
          <span>{scanning ? 'Buscando Câmera BLE...' : '+ Buscar Nova Câmera BLE'}</span>
        </button>
      </div>
    </div>
  );
};
