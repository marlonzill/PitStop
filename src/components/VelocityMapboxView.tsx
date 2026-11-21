import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Crosshair,
  Layers,
  LocateFixed,
  Maximize2,
  Minimize2,
  Minus,
  Navigation,
  Plus,
} from 'lucide-react';
import {
  buildMarcoArrowGeometry,
  buildMarcoGateLineString,
  type TrapKind,
  type VelocitySample,
  type VelocityTrap,
} from '../utils/velocityEngine';

// Centro padrão em Erechim, RS (-27.6344, -52.2739)
const ERECHIM_LATLON: [number, number] = [-27.6344, -52.2739];

type MapStyleId = 'satellite' | 'hybrid' | 'streets';

interface MapStyleOption {
  id: MapStyleId;
  label: string;
}

const MAP_STYLES: MapStyleOption[] = [
  { id: 'satellite', label: 'Satélite' },
  { id: 'hybrid', label: 'Híbrido' },
  { id: 'streets', label: 'Ruas' },
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
  placementKind?: TrapKind | null;
  selectedTrapId?: string | null;
  onMapClickPlaceTrap?: (lat: number, lon: number) => void;
  onSelectTrap?: (trapId: string) => void;
  onDragTrapEnd?: (trapId: string, lat: number, lon: number) => void;
  onCenterChange?: (lat: number, lon: number) => void;
}

function trapColorByKind(kind: TrapKind): string {
  if (kind === 'start') return '#10b981';
  if (kind === 'start_finish') return '#38bdf8';
  if (kind === 'finish') return '#E10600';
  return '#2563eb';
}

function createMarcoPinElement(
  trap: VelocityTrap,
  splitOrdinal: number,
  selected: boolean
): HTMLDivElement {
  const color = trapColorByKind(trap.kind);
  const badgeText =
    trap.kind === 'start'
      ? 'L'
      : trap.kind === 'start_finish'
        ? 'L/C'
        : trap.kind === 'finish'
          ? 'C'
          : `P${splitOrdinal}`;

  const el = document.createElement('div');
  el.style.width = '48px';
  el.style.height = '48px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.cursor = 'grab';
  el.style.userSelect = 'none';
  el.style.position = 'relative';

  // Unified Arrow + Crossbar glyph centered at the exact pin point
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '46');
  svg.setAttribute('height', '46');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.style.transform = `rotate(${Number(trap.bearingDeg) || 0}deg)`;
  svg.style.transformOrigin = '50% 50%';
  svg.style.display = 'block';
  svg.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.85))';

  // Transversal crossbar line inside icon
  const bar = document.createElementNS(svgNS, 'line');
  bar.setAttribute('x1', '7');
  bar.setAttribute('y1', '24');
  bar.setAttribute('x2', '41');
  bar.setAttribute('y2', '24');
  bar.setAttribute('stroke', selected ? '#FFFFFF' : '#E2E8F0');
  bar.setAttribute('stroke-width', selected ? '4' : '3');
  bar.setAttribute('stroke-linecap', 'round');
  svg.appendChild(bar);

  // Direction arrow shaft & head perpendicular to gate line
  const arrow = document.createElementNS(svgNS, 'path');
  arrow.setAttribute('d', 'M24 4L33 19H27.5V35H20.5V19H15L24 4Z');
  arrow.setAttribute('fill', color);
  arrow.setAttribute('stroke', '#FFFFFF');
  arrow.setAttribute('stroke-width', selected ? '2' : '1.4');
  arrow.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(arrow);

  // Exact Center Pin dot at (24,24)
  const centerDot = document.createElementNS(svgNS, 'circle');
  centerDot.setAttribute('cx', '24');
  centerDot.setAttribute('cy', '24');
  centerDot.setAttribute('r', selected ? '5.5' : '4.5');
  centerDot.setAttribute('fill', '#FFFFFF');
  centerDot.setAttribute('stroke', color);
  centerDot.setAttribute('stroke-width', '2.5');
  svg.appendChild(centerDot);

  const badge = document.createElement('span');
  badge.textContent = badgeText;
  badge.style.position = 'absolute';
  badge.style.bottom = '-4px';
  badge.style.left = '50%';
  badge.style.transform = 'translateX(-50%)';
  badge.style.background = '#080B0D';
  badge.style.border = `1.5px solid ${selected ? '#FFFFFF' : color}`;
  badge.style.color = '#FFFFFF';
  badge.style.fontFamily = 'monospace';
  badge.style.fontSize = '9px';
  badge.style.fontWeight = '800';
  badge.style.lineHeight = '1';
  badge.style.padding = '1px 4px';
  badge.style.borderRadius = '4px';
  badge.style.whiteSpace = 'nowrap';
  badge.style.pointerEvents = 'none';

  el.appendChild(svg);
  el.appendChild(badge);
  return el;
}

function createVehicleMarkerElement(headingDeg: number | null): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = '28px';
  el.style.height = '28px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.style.transform = `rotate(${typeof headingDeg === 'number' ? headingDeg : 0}deg)`;
  svg.style.filter = 'drop-shadow(0 2px 5px rgba(0,0,0,0.9))';

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M12 2L20 20L12 16L4 20Z');
  path.setAttribute('fill', '#E10600');
  path.setAttribute('stroke', '#FFFFFF');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  el.appendChild(svg);
  return el;
}

export const VelocityMapboxView: React.FC<VelocityMapboxViewProps> = ({
  trackId,
  editableTrace,
  orderedTraps,
  postEditIdx,
  currentPos,
  navigationMode = false,
  navHeadingDeg = null,
  containerClassName = 'relative mt-2 h-80 w-full overflow-hidden rounded-xl border border-zinc-800 bg-[#000000] sm:h-[420px]',
  placementKind = null,
  selectedTrapId = null,
  onMapClickPlaceTrap,
  onSelectTrap,
  onDragTrapEnd,
  onCenterChange,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayersRef = useRef<{
    satellite: L.TileLayer;
    labels: L.TileLayer;
    streets: L.TileLayer;
  } | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const gatesLayerRef = useRef<L.LayerGroup | null>(null);
  const carLayerRef = useRef<L.LayerGroup | null>(null);
  const lastFittedKeyRef = useRef<string>('');
  const lastNavEaseRef = useRef<number>(0);

  const placementKindRef = useRef(placementKind);
  placementKindRef.current = placementKind;
  const onMapClickRef = useRef(onMapClickPlaceTrap);
  onMapClickRef.current = onMapClickPlaceTrap;
  const onSelectTrapRef = useRef(onSelectTrap);
  onSelectTrapRef.current = onSelectTrap;
  const onDragTrapEndRef = useRef(onDragTrapEnd);
  onDragTrapEndRef.current = onDragTrapEnd;
  const onCenterChangeRef = useRef(onCenterChange);
  onCenterChangeRef.current = onCenterChange;

  const [styleIndex, setStyleIndex] = useState(0); // Default: Satélite
  const [isFullscreen, setIsFullscreen] = useState(false);

  const currentStyle = MAP_STYLES[styleIndex];

  // Inicializa Leaflet em Modo Satélite
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const map = L.map(el, {
      center: ERECHIM_LATLON,
      zoom: 16,
      minZoom: 3,
      maxZoom: 20,
      zoomControl: false,
      attributionControl: false,
    });

    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 20, maxNativeZoom: 19 }
    );
    const labels = L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 20, maxNativeZoom: 18 }
    );
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      maxNativeZoom: 19,
    });

    satellite.addTo(map);
    baseLayersRef.current = { satellite, labels, streets };

    const routeLayer = L.layerGroup().addTo(map);
    const gatesLayer = L.layerGroup().addTo(map);
    const carLayer = L.layerGroup().addTo(map);
    routeLayerRef.current = routeLayer;
    gatesLayerRef.current = gatesLayer;
    carLayerRef.current = carLayer;

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (placementKindRef.current && onMapClickRef.current) {
        onMapClickRef.current(e.latlng.lat, e.latlng.lng);
      }
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      onCenterChangeRef.current?.(c.lat, c.lng);
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    resizeObserver.observe(el);

    mapRef.current = map;

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      baseLayersRef.current = null;
      routeLayerRef.current = null;
      gatesLayerRef.current = null;
      carLayerRef.current = null;
    };
  }, []);

  // Alterna camada Satélite / Híbrido / Ruas
  useEffect(() => {
    const map = mapRef.current;
    const layers = baseLayersRef.current;
    if (!map || !layers) return;

    if (map.hasLayer(layers.satellite)) map.removeLayer(layers.satellite);
    if (map.hasLayer(layers.labels)) map.removeLayer(layers.labels);
    if (map.hasLayer(layers.streets)) map.removeLayer(layers.streets);

    if (currentStyle.id === 'satellite') {
      layers.satellite.addTo(map);
    } else if (currentStyle.id === 'hybrid') {
      layers.satellite.addTo(map);
      layers.labels.addTo(map);
    } else {
      layers.streets.addTo(map);
    }
  }, [currentStyle.id]);

  // Atualiza cursor quando em modo de marcação
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getContainer().style.cursor = placementKind ? 'crosshair' : '';
  }, [placementKind]);

  // Redimensiona mapa ao alternar tela cheia
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = window.setTimeout(() => map.invalidateSize({ animate: false }), 120);
    return () => window.clearTimeout(t);
  }, [isFullscreen]);

  // Renderiza traçado e ponto scrubber
  useEffect(() => {
    const routeLayer = routeLayerRef.current;
    if (!routeLayer) return;
    routeLayer.clearLayers();

    if (editableTrace.length > 1) {
      const latLngs: [number, number][] = editableTrace.map((s) => [s.lat, s.lon]);
      L.polyline(latLngs, { color: '#FFFFFF', weight: 6, opacity: 0.85 }).addTo(routeLayer);
      L.polyline(latLngs, { color: '#E10600', weight: 3.5, opacity: 0.95 }).addTo(routeLayer);
    }

    const scrubber = editableTrace[postEditIdx];
    if (scrubber) {
      L.circleMarker([scrubber.lat, scrubber.lon], {
        radius: 7,
        color: '#FFFFFF',
        weight: 2,
        fillColor: '#38bdf8',
        fillOpacity: 1,
      }).addTo(routeLayer);
    }
  }, [editableTrace, postEditIdx]);

  // Renderiza cada Marco (@turf/turf linha transversal + seta perpendicular + marcador central no mesmo ponto)
  const gatesDataKey = useMemo(
    () =>
      orderedTraps
        .map(
          (t) =>
            `${t.id}:${t.lat.toFixed(7)},${t.lon.toFixed(7)},${t.bearingDeg},${t.widthM},${t.kind},${t.unidirectional !== false}`
        )
        .join('|'),
    [orderedTraps]
  );

  useEffect(() => {
    const gatesLayer = gatesLayerRef.current;
    if (!gatesLayer) return;
    gatesLayer.clearLayers();

    let splitIdx = 0;
    for (const trap of orderedTraps) {
      if (trap.kind === 'split') splitIdx += 1;
      const isSelected = trap.id === selectedTrapId;
      const color = trapColorByKind(trap.kind);

      const gateGeo = buildMarcoGateLineString(
        trap.lat,
        trap.lon,
        trap.bearingDeg,
        trap.widthM
      );
      const gateLatLngs: [number, number][] = gateGeo.geometry.coordinates.map(
        ([lng, lat]) => [lat, lng]
      );

      const arrowGeo = buildMarcoArrowGeometry(
        trap.lat,
        trap.lon,
        trap.bearingDeg,
        trap.widthM
      );
      const shaftLatLngs: [number, number][] = arrowGeo.shaftCoords.map(([lng, lat]) => [
        lat,
        lng,
      ]);
      const headLatLngs: [number, number][] = arrowGeo.headCoords.map(([lng, lat]) => [
        lat,
        lng,
      ]);

      // Casing escuro + linha transversal do portão (Turf P1 -> P2)
      const gateCasing = L.polyline(gateLatLngs, {
        color: '#000000',
        weight: isSelected ? 8 : 6,
        opacity: 0.78,
        lineCap: 'round',
      }).addTo(gatesLayer);
      const gateLine = L.polyline(gateLatLngs, {
        color: isSelected ? '#FFFFFF' : color,
        weight: isSelected ? 4.5 : 3.5,
        opacity: 0.98,
        lineCap: 'round',
      }).addTo(gatesLayer);

      // Seta perpendicular saindo do centro apontando o sentido da pista
      const arrowCasing = L.polyline(shaftLatLngs, {
        color: '#000000',
        weight: isSelected ? 7 : 5,
        opacity: 0.78,
        lineCap: 'round',
      }).addTo(gatesLayer);
      const arrowShaft = L.polyline(shaftLatLngs, {
        color,
        weight: isSelected ? 4 : 3,
        opacity: 0.98,
        lineCap: 'round',
      }).addTo(gatesLayer);
      const headCasing = L.polyline(headLatLngs, {
        color: '#000000',
        weight: isSelected ? 7 : 5,
        opacity: 0.78,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(gatesLayer);
      const headLine = L.polyline(headLatLngs, {
        color,
        weight: isSelected ? 4 : 3,
        opacity: 0.98,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(gatesLayer);

      const pinEl = createMarcoPinElement(trap, splitIdx, isSelected);
      const icon = L.divIcon({
        html: pinEl,
        className: 'pitstop-marco-divicon',
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });

      const marker = L.marker([trap.lat, trap.lon], {
        icon,
        draggable: Boolean(onDragTrapEndRef.current),
        zIndexOffset: isSelected ? 900 : 500,
      }).addTo(gatesLayer);

      marker.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        onSelectTrapRef.current?.(trap.id);
      });

      // Atualiza linha transversal e seta em tempo real durante o arrasto
      marker.on('drag', () => {
        const pos = marker.getLatLng();
        const liveGate = buildMarcoGateLineString(
          pos.lat,
          pos.lng,
          trap.bearingDeg,
          trap.widthM
        );
        const liveGateLatLngs: [number, number][] = liveGate.geometry.coordinates.map(
          ([lng, lat]) => [lat, lng]
        );
        const liveArrow = buildMarcoArrowGeometry(
          pos.lat,
          pos.lng,
          trap.bearingDeg,
          trap.widthM
        );
        const liveShaft: [number, number][] = liveArrow.shaftCoords.map(([lng, lat]) => [
          lat,
          lng,
        ]);
        const liveHead: [number, number][] = liveArrow.headCoords.map(([lng, lat]) => [
          lat,
          lng,
        ]);
        gateCasing.setLatLngs(liveGateLatLngs);
        gateLine.setLatLngs(liveGateLatLngs);
        arrowCasing.setLatLngs(liveShaft);
        arrowShaft.setLatLngs(liveShaft);
        headCasing.setLatLngs(liveHead);
        headLine.setLatLngs(liveHead);
      });

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onSelectTrapRef.current?.(trap.id);
        onDragTrapEndRef.current?.(trap.id, pos.lat, pos.lng);
      });
    }
  }, [orderedTraps, selectedTrapId, gatesDataKey]);

  // Renderiza marcador de posição atual do veículo
  useEffect(() => {
    const carLayer = carLayerRef.current;
    if (!carLayer) return;
    carLayer.clearLayers();
    if (!currentPos) return;

    const icon = L.divIcon({
      html: createVehicleMarkerElement(navHeadingDeg),
      className: 'pitstop-car-divicon',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    L.marker([currentPos.lat, currentPos.lon], {
      icon,
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(carLayer);
  }, [currentPos, navHeadingDeg]);

  const fitMapToTrackOrCenter = (force = false) => {
    const map = mapRef.current;
    if (!map) return;

    const pts: [number, number][] = [
      ...editableTrace.map((s): [number, number] => [s.lat, s.lon]),
      ...orderedTraps.map((t): [number, number] => [t.lat, t.lon]),
    ];

    const key = `${trackId}:${editableTrace.length}:${orderedTraps.length}`;
    if (!force && lastFittedKeyRef.current === key) return;

    if (pts.length >= 2) {
      lastFittedKeyRef.current = key;
      const bounds = L.latLngBounds(pts);
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17, animate: true });
      return;
    }

    if (pts.length === 1) {
      lastFittedKeyRef.current = key;
      map.setView(pts[0], 17, { animate: true });
      return;
    }

    if (currentPos) {
      lastFittedKeyRef.current = 'pos';
      map.setView([currentPos.lat, currentPos.lon], 16, { animate: true });
    }
  };

  useEffect(() => {
    if (navigationMode) return;
    fitMapToTrackOrCenter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, editableTrace.length, orderedTraps.length, currentPos?.lat, currentPos?.lon, navigationMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !navigationMode || !currentPos) return;
    const now = Date.now();
    if (now - lastNavEaseRef.current < 350) return;
    lastNavEaseRef.current = now;
    map.setView([currentPos.lat, currentPos.lon], Math.max(map.getZoom(), 17), {
      animate: true,
    });
  }, [navigationMode, currentPos]);

  const cycleMapStyle = () => {
    setStyleIndex((prev) => (prev + 1) % MAP_STYLES.length);
  };

  const centerOnGpsOrErechim = () => {
    const map = mapRef.current;
    if (!map) return;
    if (currentPos) {
      map.setView([currentPos.lat, currentPos.lon], 17, { animate: true });
    } else {
      map.setView(ERECHIM_LATLON, 15, { animate: true });
    }
  };

  const handlePlaceAtCrosshair = () => {
    const map = mapRef.current;
    if (!map || !onMapClickPlaceTrap) return;
    const c = map.getCenter();
    onMapClickPlaceTrap(c.lat, c.lng);
  };

  return (
    <div
      className={
        isFullscreen ? 'fixed inset-0 z-50 bg-[#080B0D]' : containerClassName
      }
    >
      <div ref={containerRef} className="h-full w-full" />

      {/* Central Crosshair Mira overlay when placing Marcos interactively */}
      {placementKind && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[400] flex items-center justify-center"
        >
          <Crosshair className="h-9 w-9 text-amber-300 drop-shadow-[0_0_6px_rgba(0,0,0,0.95)]" />
        </div>
      )}

      {/* Controles superiores direitos */}
      <div className="absolute top-2.5 right-2.5 z-[400] flex flex-wrap items-center gap-1.5">
        {(editableTrace.length > 0 || orderedTraps.length > 0) && (
          <button
            type="button"
            onClick={() => fitMapToTrackOrCenter(true)}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D]/90 px-2 text-[11px] font-bold text-white shadow-lg backdrop-blur-xs hover:border-[#E10600]"
            title="Enquadrar Pista"
          >
            <LocateFixed className="h-3.5 w-3.5 text-[#E10600]" />
            <span>Rota</span>
          </button>
        )}

        <button
          type="button"
          onClick={centerOnGpsOrErechim}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D]/90 px-2 text-[11px] font-bold text-[#C0C4C9] shadow-lg backdrop-blur-xs hover:text-white"
          title={currentPos ? 'Centralizar no GPS' : 'Centralizar em Erechim, RS'}
        >
          <Navigation className="h-3 w-3 text-emerald-400" />
          <span>{currentPos ? 'GPS' : 'Erechim'}</span>
        </button>

        <button
          type="button"
          onClick={cycleMapStyle}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D]/90 px-2 text-[11px] font-bold text-white shadow-lg backdrop-blur-xs hover:border-[#E10600]"
          aria-label="Alternar camada do mapa"
        >
          <Layers className="h-3.5 w-3.5 text-amber-300" />
          <span>{currentStyle.label}</span>
        </button>

        <button
          type="button"
          onClick={() => setIsFullscreen((v) => !v)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D]/90 text-white shadow-lg backdrop-blur-xs hover:border-[#E10600]"
          aria-label={isFullscreen ? 'Sair da tela cheia' : 'Mapa em tela cheia'}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Controles de Zoom + / - estilo RaceChrono */}
      <div className="absolute right-2.5 bottom-14 z-[400] flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-[#080B0D]/90 shadow-lg backdrop-blur-xs">
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          className="flex h-9 w-9 items-center justify-center text-white hover:bg-zinc-800 border-b border-zinc-800"
          aria-label="Aumentar zoom"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          className="flex h-9 w-9 items-center justify-center text-white hover:bg-zinc-800"
          aria-label="Diminuir zoom"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>

      {/* Botão Marcar na Mira quando em modo de marcação */}
      {placementKind && onMapClickPlaceTrap && (
        <button
          type="button"
          onClick={handlePlaceAtCrosshair}
          className="pitstop-btn-red absolute bottom-3 left-3 z-[400] inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3.5 text-xs font-extrabold text-white shadow-xl active:scale-95"
        >
          <Plus className="h-4 w-4" />
          <span>Marcar na Mira</span>
        </button>
      )}
    </div>
  );
};
