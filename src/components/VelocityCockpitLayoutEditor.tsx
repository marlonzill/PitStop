import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  LayoutGrid,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  VELOCITY_COCKPIT_PRESETS,
  type CustomWidgetId,
  type CustomWidgetSize,
  type VelocityCockpitLayoutId,
  useVelocityCockpitLayout,
} from '../utils/velocityCockpitLayout';

const LayoutMiniSchematic: React.FC<{ id: VelocityCockpitLayoutId; accent: string }> = ({
  id,
  accent,
}) => {
  switch (id) {
    case 'classic':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="10" rx="2" fill={accent} fillOpacity="0.35" stroke={accent} />
          <rect x="6" y="17" width="11.5" height="6" rx="1.5" fill="#1E2432" />
          <rect x="19.5" y="17" width="11.5" height="6" rx="1.5" fill="#1E2432" />
          <rect x="33" y="17" width="11.5" height="6" rx="1.5" fill="#1E2432" />
          <rect x="46.5" y="17" width="11.5" height="6" rx="1.5" fill="#1E2432" />
          <rect x="6" y="25" width="25" height="8" rx="1.5" fill="#181D29" />
          <rect x="33" y="25" width="25" height="8" rx="1.5" fill="#181D29" />
          <rect x="6" y="35" width="52" height="4" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'thumb_zone':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="4" rx="1.5" fill="#1E2432" />
          <rect x="6" y="11" width="52" height="14" rx="2" fill="#151B26" stroke={accent} strokeOpacity="0.5" />
          <rect x="6" y="27" width="52" height="5" rx="1.5" fill={accent} fillOpacity="0.45" />
          <rect x="6" y="34" width="11.5" height="5" rx="1.5" fill={accent} />
          <rect x="19.5" y="34" width="11.5" height="5" rx="1.5" fill="#252C3D" />
          <rect x="33" y="34" width="11.5" height="5" rx="1.5" fill="#252C3D" />
          <rect x="46.5" y="34" width="11.5" height="5" rx="1.5" fill="#252C3D" />
        </svg>
      );
    case 'coralba':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="34" height="15" rx="2" fill={accent} fillOpacity="0.25" stroke={accent} />
          <rect x="42" y="5" width="16" height="15" rx="2" fill="#E10600" fillOpacity="0.7" />
          <rect x="6" y="22" width="16" height="10" rx="1.5" fill="#181D29" />
          <rect x="24" y="22" width="16" height="10" rx="1.5" fill="#181D29" />
          <rect x="42" y="22" width="16" height="10" rx="1.5" fill="#181D29" />
          <rect x="6" y="34" width="52" height="5" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'split_map':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="18" rx="2" fill="#091B29" stroke={accent} />
          <path d="M12 18 Q26 8 36 14 T52 10" fill="none" stroke={accent} strokeWidth="2" />
          <rect x="6" y="25" width="16" height="9" rx="1.5" fill="#181D29" />
          <rect x="24" y="25" width="16" height="9" rx="1.5" fill="#181D29" />
          <rect x="42" y="25" width="16" height="9" rx="1.5" fill="#181D29" />
          <rect x="6" y="36" width="52" height="3.5" rx="1" fill="#1E2432" />
        </svg>
      );
    case 'aim_minimal':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="10" rx="2" fill={accent} fillOpacity="0.3" stroke={accent} />
          <rect x="6" y="17" width="52" height="10" rx="2" fill="#181D29" />
          <rect x="6" y="29" width="52" height="10" rx="2" fill="#181D29" />
        </svg>
      );
    case 'ft700_cluster':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="4" rx="1.5" fill={accent} />
          <rect x="6" y="11" width="29" height="14" rx="2" fill="#141A26" stroke={accent} strokeOpacity="0.6" />
          <rect x="37" y="11" width="21" height="14" rx="2" fill="#10B981" fillOpacity="0.25" />
          <rect x="6" y="27" width="32" height="6" rx="1.5" fill="#181D29" />
          <rect x="40" y="27" width="18" height="6" rx="1.5" fill="#181D29" />
          <rect x="6" y="35" width="52" height="4" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'harrys_delta':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="18" rx="2" fill={accent} fillOpacity="0.85" />
          <rect x="6" y="25" width="16" height="8" rx="1.5" fill="#181D29" />
          <rect x="24" y="25" width="16" height="8" rx="1.5" fill="#181D29" />
          <rect x="42" y="25" width="16" height="8" rx="1.5" fill="#181D29" />
          <rect x="6" y="35" width="52" height="4" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'wrc_pacenote':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="5" width="52" height="18" rx="2" fill={accent} fillOpacity="0.28" stroke={accent} />
          <rect x="6" y="25" width="25" height="8" rx="1.5" fill="#181D29" />
          <rect x="33" y="25" width="25" height="8" rx="1.5" fill="#181D29" />
          <rect x="6" y="35" width="52" height="4" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'night_stage':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#000000" stroke="#22252F" />
          <rect x="6" y="6" width="52" height="10" rx="2" fill="#07080B" stroke="#334155" />
          <rect x="6" y="18" width="25" height="11" rx="2" fill="#07080B" stroke="#334155" />
          <rect x="33" y="18" width="25" height="11" rx="2" fill="#07080B" stroke="#334155" />
          <rect x="6" y="32" width="52" height="6" rx="1.5" fill="#0A0C10" stroke="#334155" />
        </svg>
      );
    case 'landscape_3col':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke="#2D3342" />
          <rect x="6" y="6" width="16" height="25" rx="2" fill={accent} fillOpacity="0.25" stroke={accent} />
          <rect x="24" y="6" width="16" height="25" rx="2" fill="#181D29" />
          <rect x="42" y="6" width="16" height="25" rx="2" fill="#181D29" />
          <rect x="6" y="33" width="52" height="5" rx="1.5" fill="#1E2432" />
        </svg>
      );
    case 'custom':
      return (
        <svg viewBox="0 0 64 44" className="h-9 w-12 shrink-0" aria-hidden="true">
          <rect x="2" y="2" width="60" height="40" rx="4" fill="#0B0D12" stroke={accent} strokeDasharray="3 2" />
          <rect x="6" y="6" width="52" height="7" rx="1.5" fill={accent} fillOpacity="0.35" />
          <rect x="6" y="15" width="32" height="9" rx="1.5" fill="#1E2432" />
          <rect x="40" y="15" width="18" height="9" rx="1.5" fill="#1E2432" />
          <rect x="6" y="26" width="52" height="11" rx="1.5" fill="#181D29" />
        </svg>
      );
  }
};

interface VelocityCockpitLayoutEditorProps {
  onSelectClose?: () => void;
}

export const VelocityCockpitLayoutEditor: React.FC<VelocityCockpitLayoutEditorProps> = ({
  onSelectClose,
}) => {
  const { config, preset, setLayoutId, updateCustomWidgets, resetCustomWidgets } =
    useVelocityCockpitLayout();
  const [showBuilder, setShowBuilder] = useState(config.layoutId === 'custom');

  const moveWidget = (index: number, direction: -1 | 1) => {
    updateCustomWidgets((prev) => {
      const targetIdx = index + direction;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(targetIdx, 0, moved);
      return copy;
    });
  };

  const toggleWidget = (id: CustomWidgetId) => {
    updateCustomWidgets((prev) =>
      prev.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w))
    );
  };

  const setWidgetSize = (id: CustomWidgetId, size: CustomWidgetSize) => {
    updateCustomWidgets((prev) =>
      prev.map((w) => (w.id === id ? { ...w, size } : w))
    );
  };

  const enabledCount = config.customWidgets.filter((w) => w.enabled).length;

  return (
    <div className="space-y-4">
      {/* Header status summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
            Layout Ativo na Tela Ao Vivo
          </p>
          <p className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase truncate">
            {preset.code} · {preset.name}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setLayoutId('custom');
            setShowBuilder(true);
          }}
          className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 text-xs font-extrabold uppercase transition-colors ${
            config.layoutId === 'custom'
              ? 'border-purple-500/70 bg-purple-600/20 text-purple-300'
              : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] hover:border-purple-500/60'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-purple-400" />
          <span>Monte o Seu Painel</span>
        </button>
      </div>

      {/* Grid of 10 Ready-Made Presets + #11 Custom */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {VELOCITY_COCKPIT_PRESETS.map((item) => {
          const active = config.layoutId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setLayoutId(item.id);
                if (item.id === 'custom') {
                  setShowBuilder(true);
                } else if (onSelectClose) {
                  onSelectClose();
                }
              }}
              className={`group relative flex min-h-[76px] items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-all active:scale-[0.99] ${
                active
                  ? 'border-white/40 bg-[#171C28] shadow-md'
                  : 'border-[var(--ps-border)] bg-[#11141C] hover:border-white/25'
              }`}
            >
              <LayoutMiniSchematic id={item.id} accent={item.accentColor} />

              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-['Barlow_Condensed'] text-sm font-black tracking-wide text-white uppercase sm:text-base">
                    {item.code} · {item.name}
                  </span>
                  {active && (
                    <span
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-black"
                      style={{ backgroundColor: item.accentColor }}
                    >
                      <Check className="h-3.5 w-3.5 stroke-[3]" />
                    </span>
                  )}
                </div>

                <p className="line-clamp-2 text-[11px] leading-snug text-slate-300/85">
                  {item.description}
                </p>

                <p
                  className="font-mono text-[10px] font-bold uppercase"
                  style={{ color: item.accentColor }}
                >
                  {item.tag}
                </p>
              </div>

              {/* Technical bottom LED bar */}
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] transition-opacity"
                style={{
                  backgroundColor: item.accentColor,
                  opacity: active ? 1 : 0.35,
                }}
              />
            </button>
          );
        })}
      </div>

      {/* Custom Mode Builder (#11) */}
      {(config.layoutId === 'custom' || showBuilder) && (
        <div className="space-y-3 rounded-xl border border-purple-500/40 bg-[#12151E] p-3.5 text-[var(--ps-text)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5">
            <div>
              <h4 className="font-['Barlow_Condensed'] text-base font-black tracking-wide text-purple-300 uppercase sm:text-lg">
                11 · Editor Visual ("Monte o Seu Cockpit")
              </h4>
              <p className="text-[11px] text-slate-400">
                {enabledCount} de {config.customWidgets.length} widgets ativos · Salvo automaticamente.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {config.layoutId !== 'custom' && (
                <button
                  type="button"
                  onClick={() => setLayoutId('custom')}
                  className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-extrabold text-white uppercase"
                >
                  Ativar Customizado
                </button>
              )}
              <button
                type="button"
                onClick={resetCustomWidgets}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/15 bg-[#191D28] px-2.5 text-xs font-bold text-slate-200 hover:border-white/30"
              >
                <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
                <span>Restaurar Padrão</span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {config.customWidgets.map((widget, idx) => (
              <div
                key={widget.id}
                className={`flex flex-col gap-2 rounded-xl border p-2.5 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                  widget.enabled
                    ? 'border-purple-500/35 bg-[#181C28]'
                    : 'border-white/10 bg-[#0E1118] opacity-65'
                }`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => toggleWidget(widget.id)}
                    aria-pressed={widget.enabled}
                    className={`inline-flex h-10 min-w-[66px] shrink-0 items-center justify-center rounded-lg border px-2 font-mono text-[11px] font-black uppercase transition-colors ${
                      widget.enabled
                        ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-300'
                        : 'border-white/15 bg-[#131722] text-slate-400'
                    }`}
                  >
                    {widget.enabled ? 'ATIVO' : 'OCULTO'}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-extrabold text-white uppercase sm:text-sm">
                      {idx + 1}. {widget.label}
                    </p>
                    <p className="truncate text-[11px] text-slate-400">{widget.description}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  {/* Size selector P / M / G */}
                  <div
                    className="inline-flex items-center rounded-lg border border-white/15 bg-[#0C0F16] p-0.5"
                    role="group"
                    aria-label={`Tamanho do widget ${widget.label}`}
                  >
                    {(['P', 'M', 'G'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => setWidgetSize(widget.id, sz)}
                        className={`min-h-[32px] min-w-[32px] rounded-md font-mono text-xs font-black transition-colors ${
                          widget.size === sz
                            ? 'bg-purple-600 text-white'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {sz}
                      </button>
                    ))}
                  </div>

                  {/* Reorder Up / Down */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveWidget(idx, -1)}
                      aria-label={`Subir ${widget.label}`}
                      title="Subir posição"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-[#131722] text-slate-200 hover:border-white/35 disabled:opacity-30"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === config.customWidgets.length - 1}
                      onClick={() => moveWidget(idx, 1)}
                      aria-label={`Descer ${widget.label}`}
                      title="Descer posição"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-[#131722] text-slate-200 hover:border-white/35 disabled:opacity-30"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {onSelectClose && (
            <button
              type="button"
              onClick={onSelectClose}
              className="pitstop-btn-red flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl text-xs font-extrabold uppercase"
            >
              <Check className="h-4 w-4" />
              <span>Aplicar Painel Customizado Ao Vivo</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface VelocityCockpitLayoutModalProps {
  open: boolean;
  onClose: () => void;
}

export const VelocityCockpitLayoutModal: React.FC<VelocityCockpitLayoutModalProps> = ({
  open,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/80 p-2 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Escolher Layout do Cockpit Ao Vivo"
    >
      <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0D1017] text-[var(--ps-text)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <LayoutGrid className="h-5 w-5 shrink-0 text-[#E10600]" />
            <div className="min-w-0">
              <h3 className="font-['Barlow_Condensed'] text-lg font-black tracking-wide text-white uppercase sm:text-xl">
                Layouts do Cockpit Ao Vivo (10 + Customizado)
              </h3>
              <p className="truncate text-[11px] text-slate-400">
                Toque em qualquer modelo para trocar na hora · Zero rolagem na pista.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar seletor de layouts"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-[#151A25] text-slate-200 hover:border-white/35"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4">
          <VelocityCockpitLayoutEditor onSelectClose={onClose} />
        </div>
      </div>
    </div>
  );
};
