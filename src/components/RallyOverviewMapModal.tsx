import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Flag, Folder, MapPin, Navigation, X } from 'lucide-react';
import type { GeoWaypoint } from '../utils/geoKmlParser';
import { formatCleanTrackName, type VelocityTrack, type VelocityTrap } from '../utils/velocityEngine';
import { VelocityMapboxView, type MapPolylineLayer } from './VelocityMapboxView';

interface RallyOverviewMapModalProps {
  isOpen: boolean;
  rallyName: string;
  tracks: VelocityTrack[];
  waypoints: GeoWaypoint[];
  activeTrackId?: string | null;
  currentPos?: { lat: number; lon: number } | null;
  onClose: () => void;
  onSelectStage: (track: VelocityTrack) => void;
  onNavigateToStage?: (track: VelocityTrack) => void;
  onNavigateToWaypoint?: (wp: GeoWaypoint) => void;
}

const FALLBACK_STAGE_COLORS = [
  '#0288D1',
  '#F57C00',
  '#10B981',
  '#E10600',
  '#A855F7',
  '#FACC15',
  '#EC4899',
  '#14B8A6',
];

export const RallyOverviewMapModal: React.FC<RallyOverviewMapModalProps> = ({
  isOpen,
  rallyName,
  tracks,
  waypoints,
  activeTrackId,
  currentPos = null,
  onClose,
  onSelectStage,
  onNavigateToStage,
  onNavigateToWaypoint,
}) => {
  const [selectedStageId, setSelectedStageId] = useState<string>(
    () => activeTrackId || tracks[0]?.id || ''
  );
  const [selectedWp, setSelectedWp] = useState<GeoWaypoint | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedWp(null);
    if (activeTrackId && tracks.some((t) => t.id === activeTrackId)) {
      setSelectedStageId(activeTrackId);
    } else if (tracks[0]) {
      setSelectedStageId(tracks[0].id);
    }
  }, [isOpen, activeTrackId, tracks]);

  const multiTraces: MapPolylineLayer[] = useMemo(() => {
    return tracks
      .filter((tr) => tr.baseTrace && tr.baseTrace.length >= 2)
      .map((tr, idx) => ({
        id: tr.id,
        name: formatCleanTrackName(tr.name),
        description: `${tr.referenceDistanceKm.toFixed(1).replace('.', ',')} km`,
        color: tr.color || FALLBACK_STAGE_COLORS[idx % FALLBACK_STAGE_COLORS.length],
        trace: tr.baseTrace ?? [],
        active: !selectedWp && tr.id === selectedStageId,
      }));
  }, [tracks, selectedStageId, selectedWp]);

  const combinedTraps: VelocityTrap[] = useMemo(() => {
    const list: VelocityTrap[] = [];
    tracks.forEach((tr) => {
      const start = tr.traps.find((t) => t.kind === 'start' || t.kind === 'start_finish');
      const finish = tr.traps.find((t) => t.kind === 'finish');
      if (start) {
        list.push({
          ...start,
          id: `${tr.id}_${start.id}`,
          name: `${formatCleanTrackName(tr.name)} · Largada`,
        });
      }
      if (finish) {
        list.push({
          ...finish,
          id: `${tr.id}_${finish.id}`,
          name: `${formatCleanTrackName(tr.name)} · Chegada`,
        });
      }
    });
    return list;
  }, [tracks]);

  const selectedTrack = useMemo(
    () => tracks.find((t) => t.id === selectedStageId) ?? tracks[0] ?? null,
    [tracks, selectedStageId]
  );

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Mapa da Prova ${rallyName}`}
      className="fixed inset-0 z-[9996] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#0B0B0C] text-white"
    >
      {/* Top Bar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#141416] px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-500/15">
            <Folder className="h-4 w-4 text-amber-400" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="font-mono text-[10px] font-extrabold tracking-widest text-[#EF233C] uppercase">
              Mapa Geral da Prova
            </p>
            <h2 className="truncate font-['Barlow_Condensed'] text-lg font-black tracking-wide text-white uppercase">
              {rallyName} · {tracks.length} {tracks.length === 1 ? 'Especial' : 'Especiais'}
              {waypoints.length > 0 ? ` · ${waypoints.length} ${waypoints.length === 1 ? 'Ponto' : 'Pontos'}` : ''}
            </h2>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar Mapa da Prova"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-white/15 bg-black/50 px-3 text-xs font-extrabold uppercase text-white hover:border-[#EF233C]"
        >
          <X className="h-4 w-4" />
          <span>Fechar</span>
        </button>
      </div>

      {/* Stage & POI Selector Pills */}
      <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/10 bg-[#0F1013] px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tracks.map((tr, idx) => {
          const col = tr.color || FALLBACK_STAGE_COLORS[idx % FALLBACK_STAGE_COLORS.length];
          const isSel = !selectedWp && selectedTrack?.id === tr.id;
          return (
            <button
              key={tr.id}
              type="button"
              onClick={() => {
                setSelectedWp(null);
                setSelectedStageId(tr.id);
              }}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-extrabold transition-all ${
                isSel
                  ? 'border-white bg-white/15 text-white shadow'
                  : 'border-white/10 bg-[#18191E] text-white/75 hover:text-white'
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/60"
                style={{ backgroundColor: col }}
              />
              <span className="max-w-[170px] truncate">{formatCleanTrackName(tr.name)}</span>
              <span className="font-mono text-[10px] text-white/65 tabular-nums">
                {tr.referenceDistanceKm.toFixed(1).replace('.', ',')}km
              </span>
            </button>
          );
        })}

        {waypoints.map((wp) => {
          const isSel = selectedWp?.id === wp.id;
          return (
            <button
              key={wp.id}
              type="button"
              onClick={() => setSelectedWp(wp)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-extrabold transition-all ${
                isSel
                  ? 'border-amber-400 bg-amber-500/20 text-white'
                  : 'border-white/10 bg-[#18191E] text-amber-300/85 hover:text-amber-200'
              }`}
            >
              <MapPin className="h-3.5 w-3.5 shrink-0" style={{ color: wp.color || '#F59E0B' }} />
              <span className="max-w-[150px] truncate">{wp.name}</span>
            </button>
          );
        })}
      </div>

      {/* Interactive Overview Satellite Map */}
      <div className="relative flex-1 overflow-hidden">
        <VelocityMapboxView
          trackId={`rally-overview-${rallyName}-${tracks.length}`}
          editableTrace={selectedTrack?.baseTrace ?? []}
          multiTraces={multiTraces}
          waypoints={waypoints}
          orderedTraps={combinedTraps}
          postEditIdx={0}
          currentPos={currentPos}
          isExternalFullscreen={true}
          zoomControlsBottomClass="bottom-28 sm:bottom-32"
          onSelectMultiTrace={(trackId) => {
            setSelectedWp(null);
            setSelectedStageId(trackId);
          }}
          onSelectWaypoint={(wp) => {
            setSelectedWp(wp);
          }}
          onSelectTrap={(trapId) => {
            const matchedTrack = tracks.find((tr) => trapId.startsWith(`${tr.id}_`));
            if (matchedTrack) {
              setSelectedWp(null);
              setSelectedStageId(matchedTrack.id);
            }
          }}
          containerClassName="relative h-full w-full overflow-hidden bg-black"
        />

        {/* Bottom Selection Card */}
        {(selectedTrack || selectedWp) && (
          <div className="pointer-events-auto absolute inset-x-3 bottom-3 z-[500] mx-auto max-w-xl rounded-2xl border border-white/15 bg-[#141416]/95 p-3 shadow-2xl backdrop-blur-md pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {selectedWp ? (
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/20"
                    style={{ backgroundColor: selectedWp.color || '#F59E0B' }}
                  >
                    <MapPin className="h-4 w-4 text-white" />
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p className="font-mono text-[10px] font-extrabold text-amber-300 uppercase">
                      Ponto de Apoio / POI
                    </p>
                    <p className="truncate text-sm font-black text-white">{selectedWp.name}</p>
                    {selectedWp.description && (
                      <p className="truncate text-[11px] text-white/65">{selectedWp.description}</p>
                    )}
                  </div>
                </div>

                {onNavigateToWaypoint && (
                  <button
                    type="button"
                    onClick={() => onNavigateToWaypoint(selectedWp)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 text-xs font-black text-white uppercase shadow active:scale-95"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <span>Navegar até Ponto</span>
                  </button>
                )}
              </div>
            ) : selectedTrack ? (
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/30"
                    style={{ backgroundColor: selectedTrack.color || '#0288D1' }}
                  >
                    <Flag className="h-4 w-4 text-white" />
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p className="font-mono text-[10px] font-extrabold text-white/60 uppercase">
                      Especial Selecionada no Mapa
                    </p>
                    <p className="truncate text-sm font-black text-white">
                      {formatCleanTrackName(selectedTrack.name)}
                    </p>
                    <p className="font-mono text-[11px] text-emerald-300 tabular-nums">
                      {selectedTrack.referenceDistanceKm.toFixed(2).replace('.', ',')} km ·{' '}
                      {selectedTrack.traps.length} marcos
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {onNavigateToStage && (
                    <button
                      type="button"
                      onClick={() => onNavigateToStage(selectedTrack)}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-sky-400/50 bg-sky-500/20 px-3 text-xs font-extrabold text-sky-200 uppercase hover:bg-sky-500/30 active:scale-95"
                    >
                      <Navigation className="h-3.5 w-3.5" />
                      <span>Ir</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSelectStage(selectedTrack)}
                    className="pitstop-btn-red inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-4 text-xs font-black uppercase active:scale-95"
                  >
                    <Check className="h-4 w-4" />
                    <span>Usar Especial</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
