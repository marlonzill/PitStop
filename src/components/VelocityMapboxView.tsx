import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Compass, Layers, LocateFixed, Maximize2, Minimize2 } from 'lucide-react';
import type { VelocitySample, VelocityTrap } from '../utils/velocityEngine';

const MAPBOX_PUBLIC_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN ?? '').trim();

// Centro padrão em Erechim, RS (-27.6344, -52.2739) com zoom 12
const ERECHIM_CENTER: [number, number] = [-52.2739, -27.6344];

type MapStyleId = 'hybrid' | 'streets' | 'satellite';

interface MapStyleOption {
  id: MapStyleId;
  label: string;
  url: string;
}

// Cicla entre Híbrido (Standard Satellite), Ruas (Standard) e Satélite puro
const MAPBOX_STYLES: MapStyleOption[] = [
  {
    id: 'hybrid',
    label: 'Híbrido',
    url: 'mapbox://styles/mapbox/standard-satellite',
  },
  {
    id: 'streets',
    label: 'Ruas',
    url: 'mapbox://styles/mapbox/standard',
  },
  {
    id: 'satellite',
    label: 'Satélite',
    url: 'mapbox://styles/mapbox/satellite-v9',
  },
];

interface VelocityMapboxViewProps {
  trackId: string;
  editableTrace: VelocitySample[];
  orderedTraps: VelocityTrap[];
  postEditIdx: number;
  currentPos: { lat: number; lon: number } | null;
  navigationMode?: boolean;
  navHeadingDeg?: number | null;
  containerClassName?: string;
}

function buildGateSegment(trap: VelocityTrap): [[number, number], [number, number]] {
  const halfM = Math.max(10, trap.widthM / 2);
  const rad = (trap.bearingDeg * Math.PI) / 180;
  // Vetor perpendicular à direção de avanço
  const px = Math.cos(rad);
  const py = -Math.sin(rad);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((trap.lat * Math.PI) / 180);

  const dLon = (px * halfM) / Math.max(1, mPerDegLon);
  const dLat = (py * halfM) / mPerDegLat;
  return [
    [trap.lon - dLon, trap.lat - dLat],
    [trap.lon + dLon, trap.lat + dLat],
  ];
}

export const VelocityMapboxView: React.FC<VelocityMapboxViewProps> = ({
  trackId,
  editableTrace,
  orderedTraps,
  postEditIdx,
  currentPos,
  navigationMode = false,
  navHeadingDeg = null,
  containerClassName = 'relative mt-2.5 h-72 w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#000000] sm:h-96',
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const defaultMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const lastFittedKeyRef = useRef<string>('');
  const lastNavEaseRef = useRef<number>(0);

  const [styleIndex, setStyleIndex] = useState(0); // Inicia em Híbrido (standard-satellite)
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [webglUnsupported, setWebglUnsupported] = useState(false);
  const tokenMissing = !MAPBOX_PUBLIC_TOKEN;

  const currentStyle = MAPBOX_STYLES[styleIndex];

  // Fallback vetorial caso o dispositivo não suporte WebGL
  const fallbackProjection = useMemo(() => {
    const pts: { lat: number; lon: number }[] = [
      ...editableTrace.map((s) => ({ lat: s.lat, lon: s.lon })),
      ...orderedTraps.map((t) => ({ lat: t.lat, lon: t.lon })),
    ];
    if (currentPos) pts.push(currentPos);
    if (pts.length === 0) return null;

    let minLat = pts[0].lat;
    let maxLat = pts[0].lat;
    let minLon = pts[0].lon;
    let maxLon = pts[0].lon;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    const padLat = Math.max(0.0008, (maxLat - minLat) * 0.14);
    const padLon = Math.max(0.0008, (maxLon - minLon) * 0.14);
    minLat -= padLat;
    maxLat += padLat;
    minLon -= padLon;
    maxLon += padLon;

    const project = (lat: number, lon: number) => ({
      x: ((lon - minLon) / Math.max(1e-6, maxLon - minLon)) * 320 + 20,
      y: (1 - (lat - minLat) / Math.max(1e-6, maxLat - minLat)) * 200 + 20,
    });
    return { project };
  }, [editableTrace, orderedTraps, currentPos]);

  // Monta os GeoJSONs para rota, traps, cursor pós-gravação e posição atual do carro
  const geoJsonData = useMemo(() => {
    const routeFc = {
      type: 'FeatureCollection' as const,
      features:
        editableTrace.length > 1
          ? [
              {
                type: 'Feature' as const,
                properties: {},
                geometry: {
                  type: 'LineString' as const,
                  coordinates: editableTrace.map((s) => [s.lon, s.lat]),
                },
              },
            ]
          : [],
    };

    const gatesFc = {
      type: 'FeatureCollection' as const,
      features: orderedTraps.map((tr) => ({
        type: 'Feature' as const,
        properties: {
          kind: tr.kind,
          name: tr.name,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: buildGateSegment(tr),
        },
      })),
    };

    const trapsPtsFc = {
      type: 'FeatureCollection' as const,
      features: orderedTraps.map((tr) => ({
        type: 'Feature' as const,
        properties: {
          kind: tr.kind,
          label:
            tr.kind === 'start'
              ? 'LARGADA'
              : tr.kind === 'finish'
                ? 'CHEGADA'
                : tr.name,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [tr.lon, tr.lat],
        },
      })),
    };

    const scrubberSample = editableTrace[postEditIdx];
    const scrubberFc = {
      type: 'FeatureCollection' as const,
      features: scrubberSample
        ? [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'Point' as const,
                coordinates: [scrubberSample.lon, scrubberSample.lat],
              },
            },
          ]
        : [],
    };

    const carFc = {
      type: 'FeatureCollection' as const,
      features: currentPos
        ? [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'Point' as const,
                coordinates: [currentPos.lon, currentPos.lat],
              },
            },
          ]
        : [],
    };

    return { routeFc, gatesFc, trapsPtsFc, scrubberFc, carFc };
  }, [editableTrace, orderedTraps, postEditIdx, currentPos]);

  const geoDataRef = useRef(geoJsonData);
  geoDataRef.current = geoJsonData;

  const syncOverlaySourcesAndLayers = (map: mapboxgl.Map) => {
    const data = geoDataRef.current;

    type GeoDataPayload = Parameters<mapboxgl.GeoJSONSource['setData']>[0];
    const upsertSource = (id: string, fc: GeoDataPayload) => {
      const existing = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc);
      } else {
        map.addSource(id, { type: 'geojson', data: fc });
      }
    };

    upsertSource('pitstop-route', data.routeFc);
    upsertSource('pitstop-gates', data.gatesFc);
    upsertSource('pitstop-traps', data.trapsPtsFc);
    upsertSource('pitstop-scrubber', data.scrubberFc);
    upsertSource('pitstop-car', data.carFc);

    if (!map.getLayer('pitstop-route-casing')) {
      map.addLayer({
        id: 'pitstop-route-casing',
        type: 'line',
        source: 'pitstop-route',
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 6,
          'line-opacity': 0.85,
        },
      });
    }
    if (!map.getLayer('pitstop-route-line')) {
      map.addLayer({
        id: 'pitstop-route-line',
        type: 'line',
        source: 'pitstop-route',
        paint: {
          'line-color': '#E10600',
          'line-width': 3.5,
        },
      });
    }
    if (!map.getLayer('pitstop-gates-line')) {
      map.addLayer({
        id: 'pitstop-gates-line',
        type: 'line',
        source: 'pitstop-gates',
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'start',
            '#10b981',
            'finish',
            '#E10600',
            '#f59e0b',
          ],
          'line-width': 5,
        },
      });
    }
    if (!map.getLayer('pitstop-traps-circle')) {
      map.addLayer({
        id: 'pitstop-traps-circle',
        type: 'circle',
        source: 'pitstop-traps',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'match',
            ['get', 'kind'],
            'start',
            '#10b981',
            'finish',
            '#E10600',
            '#f59e0b',
          ],
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 2,
        },
      });
    }
    if (!map.getLayer('pitstop-traps-label')) {
      map.addLayer({
        id: 'pitstop-traps-label',
        type: 'symbol',
        source: 'pitstop-traps',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, -1.3],
          'text-anchor': 'bottom',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': '#080B0D',
          'text-halo-width': 2,
        },
      });
    }
    if (!map.getLayer('pitstop-scrubber-circle')) {
      map.addLayer({
        id: 'pitstop-scrubber-circle',
        type: 'circle',
        source: 'pitstop-scrubber',
        paint: {
          'circle-radius': 7,
          'circle-color': '#38bdf8',
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 2,
        },
      });
    }
    if (!map.getLayer('pitstop-car-circle')) {
      map.addLayer({
        id: 'pitstop-car-circle',
        type: 'circle',
        source: 'pitstop-car',
        paint: {
          'circle-radius': 8,
          'circle-color': '#E10600',
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 2.5,
        },
      });
    }
  };

  // Inicializa o mapa Mapbox GL JS
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!MAPBOX_PUBLIC_TOKEN) return;
    if (!mapboxgl.supported()) {
      setWebglUnsupported(true);
      return;
    }

    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;

    try {
      const map = new mapboxgl.Map({
        container: el,
        style: MAPBOX_STYLES[0].url,
        center: ERECHIM_CENTER,
        zoom: 12,
        attributionControl: false,
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-left');

      // Marcador padrão em Erechim, RS (-27.6344, -52.2739)
      const defaultMarker = new mapboxgl.Marker({ color: '#E10600' })
        .setLngLat(ERECHIM_CENTER)
        .setPopup(
          new mapboxgl.Popup({ offset: 24 }).setText('Erechim, RS (-27.6344, -52.2739)')
        )
        .addTo(map);
      defaultMarkerRef.current = defaultMarker;

      map.on('style.load', () => {
        syncOverlaySourcesAndLayers(map);
      });

      map.on('error', () => {
        // Erros transitórios de rede não devem derrubar o canvas
      });

      mapRef.current = map;

      return () => {
        defaultMarker.remove();
        map.remove();
        mapRef.current = null;
        defaultMarkerRef.current = null;
      };
    } catch {
      setWebglUnsupported(true);
    }
  }, []);

  // Redimensiona mapa ao entrar/sair do modo Tela Cheia
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.resize(), 120);
    return () => window.clearTimeout(t);
  }, [isFullscreen]);

  // Atualiza estilo quando usuário toca no botão flutuante
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(currentStyle.url);
  }, [currentStyle.url]);

  // Atualiza fontes de dados (rota, traps, carro) sempre que houver alteração
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    syncOverlaySourcesAndLayers(map);
  }, [geoJsonData]);

  // Centraliza automaticamente na Especial carregada ou no GPS atual
  const fitMapToTrackOrCenter = (force = false) => {
    const map = mapRef.current;
    if (!map) return;

    const pts: [number, number][] = [
      ...editableTrace.map((s): [number, number] => [s.lon, s.lat]),
      ...orderedTraps.map((t): [number, number] => [t.lon, t.lat]),
    ];

    const key = `${trackId}:${editableTrace.length}:${orderedTraps.length}`;
    if (!force && lastFittedKeyRef.current === key) return;

    if (pts.length >= 2) {
      lastFittedKeyRef.current = key;
      const bounds = new mapboxgl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) bounds.extend(p);
      map.fitBounds(bounds, { padding: 42, maxZoom: 16, duration: 500 });
      defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'none');
      return;
    }

    if (pts.length === 1) {
      lastFittedKeyRef.current = key;
      map.flyTo({ center: pts[0], zoom: 15, duration: 500 });
      defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'none');
      return;
    }

    if (currentPos) {
      lastFittedKeyRef.current = 'pos';
      map.flyTo({ center: [currentPos.lon, currentPos.lat], zoom: 14, duration: 500 });
      defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'none');
    } else {
      defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'block');
    }
  };

  useEffect(() => {
    if (navigationMode) return;
    fitMapToTrackOrCenter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, editableTrace.length, orderedTraps.length, currentPos?.lat, currentPos?.lon, navigationMode]);

  // Câmera 3D tipo Waze (pitch + proa) quando modo de navegação estiver ativo
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!navigationMode) {
      if (map.getPitch() > 2 || Math.abs(map.getBearing()) > 2) {
        map.easeTo({ pitch: 0, bearing: 0, duration: 450 });
      }
      return;
    }

    if (!currentPos) return;
    const now = Date.now();
    if (now - lastNavEaseRef.current < 320) return;
    lastNavEaseRef.current = now;
    defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'none');
    map.easeTo({
      center: [currentPos.lon, currentPos.lat],
      zoom: 17.2,
      pitch: 56,
      bearing: typeof navHeadingDeg === 'number' && Number.isFinite(navHeadingDeg) ? navHeadingDeg : map.getBearing(),
      duration: 380,
      essential: true,
    });
  }, [navigationMode, currentPos, navHeadingDeg]);

  const cycleMapStyle = () => {
    setStyleIndex((prev) => (prev + 1) % MAPBOX_STYLES.length);
  };

  const centerOnErechim = () => {
    const map = mapRef.current;
    if (!map) return;
    defaultMarkerRef.current?.getElement()?.style.setProperty('display', 'block');
    map.flyTo({ center: ERECHIM_CENTER, zoom: 12, pitch: 0, bearing: 0, duration: 600 });
  };

  if (tokenMissing || webglUnsupported) {
    return (
      <div className="mt-2.5 flex items-center justify-center rounded-xl border border-zinc-800 bg-[#000000] p-2">
        {fallbackProjection ? (
          <svg viewBox="0 0 360 240" className="h-64 w-full sm:h-80">
            {editableTrace.length > 1 && (
              <polyline
                fill="none"
                stroke="#E10600"
                strokeWidth="2.5"
                points={editableTrace
                  .map((s) => {
                    const pt = fallbackProjection.project(s.lat, s.lon);
                    return `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
                  })
                  .join(' ')}
              />
            )}
          </svg>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center text-center text-xs text-zinc-500">
            <Compass className="h-8 w-8 text-[#E10600]" />
            <p className="mt-2 max-w-xs">
              {tokenMissing
                ? 'Mapa Mapbox indisponível neste build (variável VITE_MAPBOX_TOKEN não configurada).'
                : 'WebGL indisponível neste dispositivo. Use um arquivo KML/KMZ/GPX ou rode o Simulador para ver a rota.'}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 bg-[#080B0D]'
          : containerClassName
      }
    >
      {/* Container Mapbox em Tela Cheia ou Embutido */}
      <div ref={containerRef} className="h-full w-full" />

      {/* Controles superiores direitos (Centralizar Rota / Erechim / Tela Cheia) */}
      <div className="absolute top-2.5 right-2.5 z-10 flex flex-wrap items-center gap-1.5">
        {(editableTrace.length > 0 || orderedTraps.length > 0) && (
          <button
            type="button"
            onClick={() => fitMapToTrackOrCenter(true)}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D]/90 px-2.5 text-[11px] font-bold text-white shadow-lg backdrop-blur-xs hover:border-[#E10600]"
            title="Enquadrar Especial / Traps"
          >
            <LocateFixed className="h-3.5 w-3.5 text-[#E10600]" />
            <span>Rota</span>
          </button>
        )}

        <button
          type="button"
          onClick={centerOnErechim}
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D]/90 px-2.5 text-[11px] font-bold text-[#C0C4C9] shadow-lg backdrop-blur-xs hover:text-white"
          title="Centralizar em Erechim, RS (-27.6344, -52.2739)"
        >
          <span>Erechim</span>
        </button>

        <button
          type="button"
          onClick={() => setIsFullscreen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D]/90 text-white shadow-lg backdrop-blur-xs hover:border-[#E10600]"
          aria-label={isFullscreen ? 'Sair da tela cheia' : 'Mapa em tela cheia'}
          title={isFullscreen ? 'Sair da tela cheia' : 'Mapa em tela cheia'}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Botão Flutuante (FAB) para alternar Ruas / Satélite / Híbrido */}
      <button
        type="button"
        onClick={cycleMapStyle}
        className="pitstop-btn-red absolute right-3 bottom-3 z-10 inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-xs font-extrabold tracking-wide text-white shadow-2xl transition-transform active:scale-95"
        aria-label="Alternar estilo do mapa Mapbox"
        title="Alternar entre Híbrido, Ruas e Satélite"
      >
        <Layers className="h-4 w-4 shrink-0" />
        <span>Mapa: {currentStyle.label}</span>
      </button>
    </div>
  );
};
