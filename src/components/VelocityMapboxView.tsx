import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Compass,
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
  computeSampleGForces,
  extractMapSpeedBadges,
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

interface ReplayVehiclePose {
  lat: number;
  lon: number;
  headingDeg: number | null;
}

type VehicleVariant = 'default' | 'lapA' | 'lapB' | 'lap1' | 'lap2' | 'lap3';

interface VelocityMapboxViewProps {
  trackId: string;
  editableTrace: VelocitySample[];
  ghostTrace?: VelocitySample[];
  thirdTrace?: VelocitySample[];
  offsetGhostTrace?: boolean;
  orderedTraps: VelocityTrap[];
  postEditIdx: number;
  currentPos: { lat: number; lon: number } | null;
  vehicleStyle?: VehicleVariant;
  ghostCar?: ReplayVehiclePose | null;
  thirdCar?: ReplayVehiclePose | null;
  navigationMode?: boolean;
  headingUp?: boolean;
  onToggleHeadingUp?: () => void;
  navHeadingDeg?: number | null;
  heatmapMode?: 'none' | 'laps' | 'speed' | 'accel';
  showSpeedBadges?: boolean;
  containerClassName?: string;
  placementKind?: TrapKind | null;
  selectedTrapId?: string | null;
  onMapClickPlaceTrap?: (lat: number, lon: number) => void;
  onSelectTrap?: (trapId: string) => void;
  onDragTrapEnd?: (trapId: string, lat: number, lon: number) => void;
  onCenterChange?: (lat: number, lon: number) => void;
  topLeftOverlay?: React.ReactNode;
  fullscreenOverlay?: React.ReactNode;
  onFullscreenToggle?: () => void;
  isExternalFullscreen?: boolean;
  mapStyleIndex?: number;
  onCycleMapStyle?: () => void;
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

function createVehicleMarkerElement(
  headingDeg: number | null,
  variant: VehicleVariant = 'default'
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = '18px';
  el.style.height = '18px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.position = 'relative';
  el.style.pointerEvents = 'none';

  const fillColor =
    variant === 'lap1' || variant === 'lapA'
      ? '#10B981'
      : variant === 'lap2'
        ? '#FF2A2A'
        : variant === 'lap3'
          ? '#38BDF8'
          : variant === 'lapB'
            ? '#F59E0B'
            : '#E10600';
  const strokeColor = variant === 'lapB' ? '#111214' : '#FFFFFF';

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.dataset.carArrow = '1';
  svg.style.transform = `rotate(${typeof headingDeg === 'number' ? headingDeg : 0}deg)`;
  svg.style.transformOrigin = '50% 50%';
  svg.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.85))';

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M12 2L20 20L12 16L4 20Z');
  path.setAttribute('fill', fillColor);
  path.setAttribute('stroke', strokeColor);
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);

  el.appendChild(svg);

  return el;
}

function offsetTraceLatLngs(
  samples: VelocitySample[],
  offsetMeters: number
): [number, number][] {
  if (samples.length === 0) return [];
  if (samples.length === 1 || Math.abs(offsetMeters) < 0.01) {
    return samples.map((s) => [s.lat, s.lon]);
  }
  return samples.map((curr, i) => {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    const cosLat = Math.max(0.1, Math.cos((curr.lat * Math.PI) / 180));
    const dx = (next.lon - prev.lon) * 111320 * cosLat;
    const dy = (next.lat - prev.lat) * 110540;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return [curr.lat, curr.lon];
    const nx = dy / len;
    const ny = -dx / len;
    return [
      curr.lat + (ny * offsetMeters) / 110540,
      curr.lon + (nx * offsetMeters) / (111320 * cosLat),
    ];
  });
}

function offsetPointAlongTrace(
  trace: VelocitySample[] | undefined,
  lat: number,
  lon: number,
  offsetMeters: number
): [number, number] {
  if (!trace || trace.length < 2 || Math.abs(offsetMeters) < 0.01) {
    return [lat, lon];
  }
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < trace.length; i += 1) {
    const dLat = trace[i].lat - lat;
    const dLon = trace[i].lon - lon;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestDist) {
      bestDist = d2;
      bestIdx = i;
    }
  }
  const prev = trace[Math.max(0, bestIdx - 1)];
  const next = trace[Math.min(trace.length - 1, bestIdx + 1)];
  const cosLat = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const dx = (next.lon - prev.lon) * 111320 * cosLat;
  const dy = (next.lat - prev.lat) * 110540;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return [lat, lon];
  const nx = dy / len;
  const ny = -dx / len;
  return [
    lat + (ny * offsetMeters) / 110540,
    lon + (nx * offsetMeters) / (111320 * cosLat),
  ];
}

export const VelocityMapboxView: React.FC<VelocityMapboxViewProps> = ({
  trackId,
  editableTrace,
  ghostTrace,
  thirdTrace,
  offsetGhostTrace = false,
  orderedTraps,
  postEditIdx,
  currentPos,
  vehicleStyle = 'default',
  ghostCar = null,
  thirdCar = null,
  navigationMode = false,
  headingUp,
  onToggleHeadingUp,
  navHeadingDeg = null,
  heatmapMode = 'none',
  showSpeedBadges = false,
  containerClassName = 'relative mt-2 h-80 w-full overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[#000000] sm:h-[420px]',
  placementKind = null,
  selectedTrapId = null,
  onMapClickPlaceTrap,
  onSelectTrap,
  onDragTrapEnd,
  onCenterChange,
  topLeftOverlay,
  fullscreenOverlay,
  onFullscreenToggle,
  isExternalFullscreen,
  mapStyleIndex,
  onCycleMapStyle,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayersRef = useRef<{
    satellite: L.TileLayer;
    labels: L.TileLayer;
    streets: L.TileLayer;
  } | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const speedBadgesLayerRef = useRef<L.LayerGroup | null>(null);
  const scrubberLayerRef = useRef<L.LayerGroup | null>(null);
  const gatesLayerRef = useRef<L.LayerGroup | null>(null);
  const carLayerRef = useRef<L.LayerGroup | null>(null);
  const primaryMarkerRef = useRef<{
    marker: L.Marker;
    el: HTMLDivElement;
    variant: string;
  } | null>(null);
  const ghostMarkerRef = useRef<{
    marker: L.Marker;
    el: HTMLDivElement;
  } | null>(null);
  const thirdMarkerRef = useRef<{
    marker: L.Marker;
    el: HTMLDivElement;
  } | null>(null);
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
  const [internalHeadingUp, setInternalHeadingUp] = useState(true);

  const effectiveHeadingUp = headingUp !== undefined ? headingUp : internalHeadingUp;
  const rotationDeg =
    navigationMode && effectiveHeadingUp && typeof navHeadingDeg === 'number'
      ? -navHeadingDeg
      : 0;

  const effectiveStyleIndex =
    mapStyleIndex !== undefined ? mapStyleIndex % MAP_STYLES.length : styleIndex;
  const currentStyle = MAP_STYLES[effectiveStyleIndex];
  const externalFs = Boolean(isExternalFullscreen);

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
    const speedBadgesLayer = L.layerGroup().addTo(map);
    const scrubberLayer = L.layerGroup().addTo(map);
    const gatesLayer = L.layerGroup().addTo(map);
    const carLayer = L.layerGroup().addTo(map);
    routeLayerRef.current = routeLayer;
    speedBadgesLayerRef.current = speedBadgesLayer;
    scrubberLayerRef.current = scrubberLayer;
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
      speedBadgesLayerRef.current = null;
      scrubberLayerRef.current = null;
      gatesLayerRef.current = null;
      carLayerRef.current = null;
      primaryMarkerRef.current = null;
      ghostMarkerRef.current = null;
      thirdMarkerRef.current = null;
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

  // Renderiza traçados paralelos finos (V1 = 0m, V2 = +1.8m, V3 = -1.8m) e modos de camada (Volta / Vel / Acel-Freio)
  useEffect(() => {
    const routeLayer = routeLayerRef.current;
    if (!routeLayer) return;
    routeLayer.clearLayers();

    const hasLap2 = Boolean(ghostTrace && ghostTrace.length > 1);
    const hasLap3 = Boolean(thirdTrace && thirdTrace.length > 1);
    const hasComparison = hasLap2 || hasLap3;
    const strokeWeight = hasComparison ? 2.6 : 3.2;
    const casingWeight = strokeWeight + 1.2;

    const allTraces = [
      ...(editableTrace.length > 1 ? editableTrace : []),
      ...(hasLap2 && ghostTrace ? ghostTrace : []),
      ...(hasLap3 && thirdTrace ? thirdTrace : []),
    ];
    const maxSpd = Math.max(
      60,
      ...allTraces.map((s) => (Number.isFinite(s.speedKmh) ? s.speedKmh : 0))
    );
    const minSpd = Math.min(
      maxSpd - 10,
      ...allTraces.map((s) => (Number.isFinite(s.speedKmh) ? s.speedKmh : maxSpd))
    );

    const drawHeatmapTrace = (
      trace: VelocitySample[],
      offsetM: number,
      mode: 'speed' | 'accel'
    ) => {
      if (trace.length < 2) return;
      const latLngs = offsetTraceLatLngs(trace, offsetM);
      const groups: Array<{ color: string; pts: [number, number][] }> = [];

      for (let i = 1; i < trace.length; i += 1) {
        const prev = trace[i - 1];
        const curr = trace[i];
        let segColor = '#f59e0b';

        if (mode === 'speed') {
          const ratio = Math.max(
            0,
            Math.min(1, (curr.speedKmh - minSpd) / Math.max(15, maxSpd - minSpd))
          );
          segColor = ratio >= 0.66 ? '#10b981' : ratio >= 0.33 ? '#f59e0b' : '#E10600';
        } else {
          const longG =
            typeof curr.accelLongG === 'number'
              ? curr.accelLongG
              : computeSampleGForces(prev, curr).accelLongG;
          segColor = longG > 0.06 ? '#10b981' : longG < -0.06 ? '#E10600' : '#f59e0b';
        }

        const lastGroup = groups[groups.length - 1];
        if (lastGroup && lastGroup.color === segColor) {
          lastGroup.pts.push(latLngs[i]);
        } else {
          groups.push({ color: segColor, pts: [latLngs[i - 1], latLngs[i]] });
        }
      }

      for (const g of groups) {
        L.polyline(g.pts, {
          color: '#050608',
          weight: casingWeight,
          opacity: 0.42,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
        L.polyline(g.pts, {
          color: g.color,
          weight: strokeWeight,
          opacity: 0.96,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
      }
    };

    const drawSolidTrace = (
      trace: VelocitySample[],
      offsetM: number,
      color: string,
      casingColor = '#050608',
      casingOpacity = 0.45
    ) => {
      if (trace.length < 2) return;
      const latLngs = offsetTraceLatLngs(trace, offsetM);
      L.polyline(latLngs, {
        color: casingColor,
        weight: casingWeight,
        opacity: casingOpacity,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(routeLayer);
      L.polyline(latLngs, {
        color,
        weight: strokeWeight,
        opacity: 0.96,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(routeLayer);
    };

    if (heatmapMode === 'laps') {
      if (hasLap3 && thirdTrace) {
        drawSolidTrace(thirdTrace, offsetGhostTrace ? -1.8 : 0, '#38BDF8');
      }
      if (hasLap2 && ghostTrace) {
        drawSolidTrace(ghostTrace, offsetGhostTrace ? 1.8 : 0, '#FF2A2A');
      }
      if (editableTrace.length > 1) {
        drawSolidTrace(editableTrace, 0, '#10B981');
      }
      return;
    }

    if (heatmapMode === 'speed' || heatmapMode === 'accel') {
      if (hasLap3 && thirdTrace) {
        drawHeatmapTrace(thirdTrace, offsetGhostTrace ? -1.8 : 0, heatmapMode);
      }
      if (hasLap2 && ghostTrace) {
        drawHeatmapTrace(ghostTrace, offsetGhostTrace ? 1.8 : 0, heatmapMode);
      }
      if (editableTrace.length > 1) {
        drawHeatmapTrace(editableTrace, 0, heatmapMode);
      }
      return;
    }

    // Modo padrão ('none' — Editor de Pista / Mapa Ao Vivo)
    if (hasLap3 && thirdTrace) {
      drawSolidTrace(thirdTrace, offsetGhostTrace ? -1.8 : 0, '#38BDF8');
    }
    if (hasLap2 && ghostTrace) {
      drawSolidTrace(ghostTrace, offsetGhostTrace ? 1.8 : 0, '#FF2A2A');
    }
    if (editableTrace.length > 1) {
      drawSolidTrace(editableTrace, 0, '#E10600', '#FFFFFF', 0.78);
    }
  }, [editableTrace, ghostTrace, thirdTrace, offsetGhostTrace, heatmapMode]);

  // Etiquetas numéricas flutuantes estilo RaceChrono (Verde = Máxima antes da freada, Vermelho = Ápice da curva)
  useEffect(() => {
    const badgesLayer = speedBadgesLayerRef.current;
    if (!badgesLayer) return;
    badgesLayer.clearLayers();
    if (!showSpeedBadges || editableTrace.length < 6) return;

    const badges = extractMapSpeedBadges(editableTrace);
    for (const b of badges) {
      const isPeak = b.kind === 'peak';
      const el = document.createElement('div');
      el.style.display = 'inline-flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.padding = '1px 5px';
      el.style.borderRadius = '5px';
      el.style.fontFamily = 'monospace';
      el.style.fontSize = '10px';
      el.style.fontWeight = '900';
      el.style.lineHeight = '1.15';
      el.style.whiteSpace = 'nowrap';
      el.style.pointerEvents = 'none';
      el.style.transform = 'translate(-50%, -125%)';
      el.style.boxShadow = '0 2px 5px rgba(0,0,0,0.85)';
      if (isPeak) {
        el.style.background = '#052E16';
        el.style.border = '1.5px solid #10B981';
        el.style.color = '#6EE7B7';
      } else {
        el.style.background = '#3B080A';
        el.style.border = '1.5px solid #FF2A2A';
        el.style.color = '#FCA5A5';
      }
      el.textContent = `${b.speedKmh}`;

      const icon = L.divIcon({
        html: el,
        className: 'pitstop-speed-badge-divicon',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([b.lat, b.lon], {
        icon,
        interactive: false,
        zIndexOffset: 750,
      }).addTo(badgesLayer);
    }
  }, [editableTrace, showSpeedBadges]);

  // Scrubber estático para editor de pista (separado do routeLayer para manter 60fps no Replay)
  useEffect(() => {
    const scrubberLayer = scrubberLayerRef.current;
    if (!scrubberLayer) return;
    scrubberLayer.clearLayers();
    if (vehicleStyle !== 'default' || ghostCar || thirdCar) return;
    const scrubber = editableTrace[postEditIdx];
    if (scrubber) {
      L.circleMarker([scrubber.lat, scrubber.lon], {
        radius: 7,
        color: '#FFFFFF',
        weight: 2.5,
        fillColor: '#38bdf8',
        fillOpacity: 1,
      }).addTo(scrubberLayer);
    }
  }, [editableTrace, postEditIdx, vehicleStyle, ghostCar, thirdCar]);

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

  // Renderiza marcadores persistentes de Alta Taxa (30/60fps) para V1, V2 e V3
  useEffect(() => {
    const carLayer = carLayerRef.current;
    if (!carLayer) return;

    // Carro 1 (Padrão ou Volta 1 Verde Esmeralda)
    if (currentPos) {
      if (
        !primaryMarkerRef.current ||
        primaryMarkerRef.current.variant !== vehicleStyle
      ) {
        if (primaryMarkerRef.current) {
          carLayer.removeLayer(primaryMarkerRef.current.marker);
        }
        const el = createVehicleMarkerElement(navHeadingDeg, vehicleStyle);
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const marker = L.marker([currentPos.lat, currentPos.lon], {
          icon,
          interactive: false,
          zIndexOffset: 1100,
        }).addTo(carLayer);
        primaryMarkerRef.current = { marker, el, variant: vehicleStyle };
      } else {
        primaryMarkerRef.current.marker.setLatLng([currentPos.lat, currentPos.lon]);
        const svg = primaryMarkerRef.current.el.querySelector(
          'svg[data-car-arrow="1"]'
        ) as SVGElement | null;
        if (svg) {
          svg.style.transform = `rotate(${typeof navHeadingDeg === 'number' ? navHeadingDeg : 0}deg)`;
        }
      }
    } else if (primaryMarkerRef.current) {
      carLayer.removeLayer(primaryMarkerRef.current.marker);
      primaryMarkerRef.current = null;
    }

    // Carro 2 (Volta 2 Vermelho)
    if (ghostCar) {
      const [gLat, gLon] = offsetGhostTrace
        ? offsetPointAlongTrace(ghostTrace, ghostCar.lat, ghostCar.lon, 1.8)
        : [ghostCar.lat, ghostCar.lon];

      if (!ghostMarkerRef.current) {
        const el = createVehicleMarkerElement(ghostCar.headingDeg, 'lap2');
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const marker = L.marker([gLat, gLon], {
          icon,
          interactive: false,
          zIndexOffset: 1050,
        }).addTo(carLayer);
        ghostMarkerRef.current = { marker, el };
      } else {
        ghostMarkerRef.current.marker.setLatLng([gLat, gLon]);
        const svg = ghostMarkerRef.current.el.querySelector(
          'svg[data-car-arrow="1"]'
        ) as SVGElement | null;
        if (svg) {
          svg.style.transform = `rotate(${typeof ghostCar.headingDeg === 'number' ? ghostCar.headingDeg : 0}deg)`;
        }
      }
    } else if (ghostMarkerRef.current) {
      carLayer.removeLayer(ghostMarkerRef.current.marker);
      ghostMarkerRef.current = null;
    }

    // Carro 3 (Volta 3 Ciano)
    if (thirdCar) {
      const [tLat, tLon] = offsetGhostTrace
        ? offsetPointAlongTrace(thirdTrace, thirdCar.lat, thirdCar.lon, -1.8)
        : [thirdCar.lat, thirdCar.lon];

      if (!thirdMarkerRef.current) {
        const el = createVehicleMarkerElement(thirdCar.headingDeg, 'lap3');
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        const marker = L.marker([tLat, tLon], {
          icon,
          interactive: false,
          zIndexOffset: 1030,
        }).addTo(carLayer);
        thirdMarkerRef.current = { marker, el };
      } else {
        thirdMarkerRef.current.marker.setLatLng([tLat, tLon]);
        const svg = thirdMarkerRef.current.el.querySelector(
          'svg[data-car-arrow="1"]'
        ) as SVGElement | null;
        if (svg) {
          svg.style.transform = `rotate(${typeof thirdCar.headingDeg === 'number' ? thirdCar.headingDeg : 0}deg)`;
        }
      }
    } else if (thirdMarkerRef.current) {
      carLayer.removeLayer(thirdMarkerRef.current.marker);
      thirdMarkerRef.current = null;
    }
  }, [
    currentPos,
    navHeadingDeg,
    vehicleStyle,
    ghostCar,
    ghostTrace,
    thirdCar,
    thirdTrace,
    offsetGhostTrace,
  ]);

  const fitMapToTrackOrCenter = (force = false) => {
    const map = mapRef.current;
    if (!map) return;

    const pts: [number, number][] = [
      ...editableTrace.map((s): [number, number] => [s.lat, s.lon]),
      ...(ghostTrace ? ghostTrace.map((s): [number, number] => [s.lat, s.lon]) : []),
      ...(thirdTrace ? thirdTrace.map((s): [number, number] => [s.lat, s.lon]) : []),
      ...orderedTraps.map((t): [number, number] => [t.lat, t.lon]),
    ];

    const key = `${trackId}:${editableTrace.length}:${ghostTrace?.length ?? 0}:${thirdTrace?.length ?? 0}:${orderedTraps.length}`;
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
  }, [
    trackId,
    editableTrace.length,
    ghostTrace?.length,
    thirdTrace?.length,
    orderedTraps.length,
    navigationMode,
  ]);

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
    if (onCycleMapStyle) {
      onCycleMapStyle();
      return;
    }
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
        isFullscreen ? 'fixed inset-0 z-50 overflow-hidden bg-[var(--ps-bg)]' : containerClassName
      }
    >
      <div
        ref={containerRef}
        className="h-full w-full transition-transform duration-300 ease-out will-change-transform"
        style={
          rotationDeg !== 0
            ? { transform: `rotate(${rotationDeg}deg) scale(1.42)` }
            : undefined
        }
      />

      {/* Live Heading-Up vs Norte Fixo mode toggle when navigationMode is enabled */}
      {navigationMode && (
        <button
          type="button"
          onClick={() => {
            if (onToggleHeadingUp) onToggleHeadingUp();
            else setInternalHeadingUp((v) => !v);
          }}
          className={`absolute top-2.5 left-2.5 z-[400] inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-extrabold shadow-lg backdrop-blur-xs ${
            effectiveHeadingUp
              ? 'border-[var(--ps-accent)] bg-[var(--ps-surface)]/95 text-[var(--ps-text)]'
              : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/90 text-[var(--ps-muted)]'
          }`}
          title="Alternar entre seguir sentido do veículo (Heading-Up) ou Norte Fixo"
        >
          <Compass className={`h-3.5 w-3.5 ${effectiveHeadingUp ? 'text-[var(--ps-accent)]' : 'text-sky-400'}`} />
          <span>{effectiveHeadingUp ? 'Heading-Up' : 'Norte Fixo'}</span>
        </button>
      )}

      {/* Legenda / Overlay superior esquerdo customizável (ex: Barra única em Tela Cheia) */}
      {!navigationMode && topLeftOverlay && (
        <div
          className={
            externalFs
              ? 'pointer-events-none absolute top-2.5 left-2.5 right-[136px] z-[405]'
              : 'pointer-events-none absolute top-2.5 left-2.5 z-[405] max-w-[65%]'
          }
        >
          {topLeftOverlay}
        </div>
      )}

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
      {externalFs ? (
        onFullscreenToggle ? (
          <div className="absolute top-2.5 right-2.5 z-[410]">
            <button
              type="button"
              onClick={() => onFullscreenToggle()}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/95 px-2.5 text-[11px] font-extrabold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)]"
              aria-label="Sair da tela cheia"
            >
              <Minimize2 className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Sair Tela Cheia</span>
            </button>
          </div>
        ) : null
      ) : (
        <div className="absolute top-2.5 right-2.5 z-[400] flex flex-wrap items-center gap-1.5">
          {(editableTrace.length > 0 || orderedTraps.length > 0) && (
            <button
              type="button"
              onClick={() => fitMapToTrackOrCenter(true)}
              className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 px-2 text-[11px] font-bold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)]"
              title="Enquadrar Pista"
            >
              <LocateFixed className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Rota</span>
            </button>
          )}

          <button
            type="button"
            onClick={centerOnGpsOrErechim}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 px-2 text-[11px] font-bold text-[var(--ps-muted)] shadow-lg backdrop-blur-xs hover:text-[var(--ps-text)]"
            title={currentPos ? 'Centralizar no GPS' : 'Centralizar em Erechim, RS'}
          >
            <Navigation className="h-3 w-3 text-[var(--ps-emerald)]" />
            <span>{currentPos ? 'GPS' : 'Erechim'}</span>
          </button>

          <button
            type="button"
            onClick={cycleMapStyle}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 px-2 text-[11px] font-bold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)]"
            aria-label="Alternar camada do mapa"
          >
            <Layers className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
            <span>{currentStyle.label}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (onFullscreenToggle) {
                onFullscreenToggle();
              } else {
                setIsFullscreen((v) => !v);
              }
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)]"
            aria-label={isFullscreen ? 'Sair da tela cheia' : 'Mapa em tela cheia'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      )}

      {/* Controles de Zoom + / - estilo RaceChrono */}
      <div
        className={`absolute right-2.5 z-[400] flex flex-col overflow-hidden rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 shadow-lg backdrop-blur-xs ${
          externalFs ? 'bottom-2.5' : 'bottom-14'
        }`}
      >
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          className="flex h-9 w-9 items-center justify-center text-[var(--ps-text)] hover:bg-[var(--ps-card)] border-b border-[var(--ps-border)]"
          aria-label="Aumentar zoom"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          className="flex h-9 w-9 items-center justify-center text-[var(--ps-text)] hover:bg-[var(--ps-card)]"
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
          className={`pitstop-btn-red absolute z-[410] inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3.5 text-xs font-extrabold shadow-xl active:scale-95 ${
            isFullscreen && fullscreenOverlay ? 'top-2.5 left-2.5' : 'bottom-3 left-3'
          }`}
        >
          <Plus className="h-4 w-4" />
          <span>Marcar na Mira</span>
        </button>
      )}

      {/* Barra flutuante de criação/edição de Marcos exclusiva do modo Tela Cheia */}
      {isFullscreen && fullscreenOverlay && (
        <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 z-[410] flex justify-center pr-12 sm:pr-0">
          <div className="pointer-events-auto w-full max-w-2xl">
            {fullscreenOverlay}
          </div>
        </div>
      )}
    </div>
  );
};
