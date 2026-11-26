import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
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
  type GeoWaypoint,
  type TrapKind,
  type VelocitySample,
  type VelocityTrap,
} from '../utils/velocityEngine';

export interface MapPolylineLayer {
  id: string;
  name: string;
  description?: string;
  color: string;
  trace: VelocitySample[];
  active?: boolean;
}

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
  traceColor?: string;
  multiTraces?: MapPolylineLayer[];
  waypoints?: GeoWaypoint[];
  guideTrace?: VelocitySample[];
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
  onRequestCenterPos?: () => Promise<{ lat: number; lon: number } | null> | void;
  topLeftOverlay?: React.ReactNode;
  fullscreenTopOverlay?: React.ReactNode;
  fullscreenOverlay?: React.ReactNode;
  fullscreenOverlayFullWidth?: boolean;
  onFullscreenToggle?: () => void;
  forceFullscreen?: boolean;
  isExternalFullscreen?: boolean;
  hideBuiltInTopControls?: boolean;
  zoomControlsBottomClass?: string;
  fullscreenZoomBottomClass?: string;
  requireLongPressForTraps?: boolean;
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
  selected: boolean,
  unlocked = false
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
  el.style.cursor = unlocked ? 'grabbing' : 'pointer';
  el.style.userSelect = 'none';
  el.style.touchAction = 'none';
  el.style.position = 'relative';
  el.style.borderRadius = '9999px';
  if (unlocked) {
    el.style.boxShadow = '0 0 0 3px #10B981, 0 0 18px rgba(16, 185, 129, 0.85)';
    el.style.background = 'rgba(16, 185, 129, 0.18)';
  }

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
  _headingDeg: number | null,
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

  const dot = document.createElement('div');
  dot.style.width = '14px';
  dot.style.height = '14px';
  dot.style.borderRadius = '9999px';
  dot.style.backgroundColor = fillColor;
  dot.style.border = `2.5px solid ${strokeColor}`;
  dot.style.boxShadow = '0 1px 4px rgba(0,0,0,0.85)';

  el.appendChild(dot);

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
  traceColor,
  multiTraces,
  waypoints,
  guideTrace,
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
  onRequestCenterPos,
  topLeftOverlay,
  fullscreenTopOverlay,
  fullscreenOverlay,
  fullscreenOverlayFullWidth = false,
  onFullscreenToggle,
  forceFullscreen,
  isExternalFullscreen,
  hideBuiltInTopControls = false,
  zoomControlsBottomClass,
  fullscreenZoomBottomClass,
  requireLongPressForTraps = false,
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
  const waypointLayerRef = useRef<L.LayerGroup | null>(null);
  const carLayerRef = useRef<L.LayerGroup | null>(null);
  const liveMarkerMapRef = useRef<
    Map<
      string,
      {
        marker: L.Marker;
        pinEl: HTMLDivElement;
        updateGateLines: (lat: number, lon: number) => void;
      }
    >
  >(new Map());
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
  const selectedTrapIdRef = useRef(selectedTrapId);
  selectedTrapIdRef.current = selectedTrapId;
  const requireLongPressRef = useRef(requireLongPressForTraps);
  requireLongPressRef.current = requireLongPressForTraps;
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
  const [unlockedTrapId, setUnlockedTrapId] = useState<string | null>(null);
  const unlockedTrapIdRef = useRef<string | null>(null);
  unlockedTrapIdRef.current = unlockedTrapId;
  const unlockTimerRef = useRef<number | null>(null);
  const [holdRing, setHoldRing] = useState<{ x: number; y: number } | null>(null);
  const [pulseRing, setPulseRing] = useState<{
    x: number;
    y: number;
    label: string;
    key: number;
  } | null>(null);
  const pulseClearTimerRef = useRef<number | null>(null);

  const triggerLongPressFeedback = (x: number, y: number, label: string) => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(35);
      } catch {
        // Ignore vibration block
      }
    }
    if (pulseClearTimerRef.current !== null) {
      window.clearTimeout(pulseClearTimerRef.current);
    }
    setPulseRing({ x, y, label, key: Date.now() });
    pulseClearTimerRef.current = window.setTimeout(() => {
      setPulseRing(null);
      pulseClearTimerRef.current = null;
    }, 850);
  };

  const triggerFeedbackRef = useRef(triggerLongPressFeedback);
  triggerFeedbackRef.current = triggerLongPressFeedback;

  const armUnlockedTrapTimeout = (trapId: string) => {
    setUnlockedTrapId(trapId);
    if (unlockTimerRef.current !== null) {
      window.clearTimeout(unlockTimerRef.current);
    }
    unlockTimerRef.current = window.setTimeout(() => {
      setUnlockedTrapId(null);
      unlockTimerRef.current = null;
    }, 8000);
  };
  const armUnlockRef = useRef(armUnlockedTrapTimeout);
  armUnlockRef.current = armUnlockedTrapTimeout;

  const effectiveHeadingUp = headingUp !== undefined ? headingUp : internalHeadingUp;
  const rotationDeg =
    navigationMode && effectiveHeadingUp && typeof navHeadingDeg === 'number'
      ? -navHeadingDeg
      : 0;

  const effectiveStyleIndex =
    mapStyleIndex !== undefined ? mapStyleIndex % MAP_STYLES.length : styleIndex;
  const currentStyle = MAP_STYLES[effectiveStyleIndex];
  const externalFs = Boolean(isExternalFullscreen);
  const effectiveFullscreen = typeof forceFullscreen === 'boolean' ? forceFullscreen : isFullscreen;

  // Inicializa Leaflet em Modo Satélite
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const TRANSPARENT_TILE_DATA_URL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    const map = L.map(el, {
      center: currentPos ? [currentPos.lat, currentPos.lon] : ERECHIM_LATLON,
      zoom: currentPos ? 17 : 15,
      minZoom: 3,
      maxZoom: 21,
      zoomControl: false,
      attributionControl: false,
    });

    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 21,
        maxNativeZoom: 18,
        errorTileUrl: TRANSPARENT_TILE_DATA_URL,
      }
    );
    const labels = L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 21,
        maxNativeZoom: 18,
        errorTileUrl: TRANSPARENT_TILE_DATA_URL,
      }
    );
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 21,
      maxNativeZoom: 19,
      errorTileUrl: TRANSPARENT_TILE_DATA_URL,
    });

    satellite.addTo(map);
    baseLayersRef.current = { satellite, labels, streets };

    const routeLayer = L.layerGroup().addTo(map);
    const speedBadgesLayer = L.layerGroup().addTo(map);
    const scrubberLayer = L.layerGroup().addTo(map);
    const gatesLayer = L.layerGroup().addTo(map);
    const waypointLayer = L.layerGroup().addTo(map);
    const carLayer = L.layerGroup().addTo(map);
    routeLayerRef.current = routeLayer;
    speedBadgesLayerRef.current = speedBadgesLayer;
    scrubberLayerRef.current = scrubberLayer;
    gatesLayerRef.current = gatesLayer;
    waypointLayerRef.current = waypointLayer;
    carLayerRef.current = carLayer;

    map.on('click', (e: L.LeafletMouseEvent) => {
      if (!requireLongPressRef.current && placementKindRef.current && onMapClickRef.current) {
        onMapClickRef.current(e.latlng.lat, e.latlng.lng);
      }
    });

    // Long press (~400ms) no mapa para posicionar ou mover o marco selecionado sem interferir em toques rápidos/arrasto
    const activeMapPointers = new Set<number>();
    let mapHoldPointerId: number | null = null;
    let mapHoldStartX = 0;
    let mapHoldStartY = 0;
    let mapRingShowTimer: number | null = null;
    let mapLongPressTimer: number | null = null;

    const clearMapLongPress = () => {
      if (mapRingShowTimer !== null) {
        window.clearTimeout(mapRingShowTimer);
        mapRingShowTimer = null;
      }
      if (mapLongPressTimer !== null) {
        window.clearTimeout(mapLongPressTimer);
        mapLongPressTimer = null;
      }
      mapHoldPointerId = null;
      setHoldRing(null);
    };

    const onMapPointerDown = (ev: PointerEvent) => {
      activeMapPointers.add(ev.pointerId);
      if (activeMapPointers.size > 1) {
        clearMapLongPress();
        return;
      }
      if (!requireLongPressRef.current) return;
      if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      const target = ev.target as HTMLElement | null;
      if (
        target?.closest(
          'button, input, a, .leaflet-control, .pitstop-marco-divicon, .pitstop-waypoint-divicon'
        )
      ) {
        return;
      }
      const canPlace = Boolean(placementKindRef.current && onMapClickRef.current);
      const canMoveSelected = Boolean(selectedTrapIdRef.current && onDragTrapEndRef.current);
      if (!canPlace && !canMoveSelected) return;

      clearMapLongPress();
      mapHoldPointerId = ev.pointerId;
      mapHoldStartX = ev.clientX;
      mapHoldStartY = ev.clientY;
      const rect = el.getBoundingClientRect();
      const relX = ev.clientX - rect.left;
      const relY = ev.clientY - rect.top;

      mapRingShowTimer = window.setTimeout(() => {
        if (mapHoldPointerId === ev.pointerId) {
          setHoldRing({ x: relX, y: relY });
        }
      }, 100);

      mapLongPressTimer = window.setTimeout(() => {
        if (mapHoldPointerId !== ev.pointerId || activeMapPointers.size > 1) return;
        clearMapLongPress();
        const ll = map.containerPointToLatLng([relX, relY]);
        if (placementKindRef.current && onMapClickRef.current) {
          triggerFeedbackRef.current(relX, relY, 'Marco posicionado!');
          onMapClickRef.current(ll.lat, ll.lng);
        } else if (selectedTrapIdRef.current && onDragTrapEndRef.current) {
          triggerFeedbackRef.current(relX, relY, 'Marco movido!');
          onDragTrapEndRef.current(selectedTrapIdRef.current, ll.lat, ll.lng);
        }
      }, 400);
    };

    const onMapPointerMove = (ev: PointerEvent) => {
      if (mapHoldPointerId !== ev.pointerId) return;
      if (Math.hypot(ev.clientX - mapHoldStartX, ev.clientY - mapHoldStartY) > 10) {
        clearMapLongPress();
      }
    };

    const onMapPointerUpOrCancel = (ev: PointerEvent) => {
      activeMapPointers.delete(ev.pointerId);
      if (mapHoldPointerId === ev.pointerId) {
        clearMapLongPress();
      }
    };

    const onMapContextMenu = (ev: MouseEvent) => {
      if (requireLongPressRef.current) {
        ev.preventDefault();
      }
    };

    el.addEventListener('pointerdown', onMapPointerDown);
    el.addEventListener('pointermove', onMapPointerMove);
    el.addEventListener('pointerup', onMapPointerUpOrCancel);
    el.addEventListener('pointercancel', onMapPointerUpOrCancel);
    el.addEventListener('contextmenu', onMapContextMenu);

    map.on('moveend', () => {
      const c = map.getCenter();
      onCenterChangeRef.current?.(c.lat, c.lng);
    });

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    resizeObserver.observe(el);

    const rafId = window.requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
    });
    const settleTimer = window.setTimeout(() => {
      map.invalidateSize({ animate: false });
    }, 150);

    mapRef.current = map;

    return () => {
      clearMapLongPress();
      if (unlockTimerRef.current !== null) window.clearTimeout(unlockTimerRef.current);
      if (pulseClearTimerRef.current !== null) window.clearTimeout(pulseClearTimerRef.current);
      el.removeEventListener('pointerdown', onMapPointerDown);
      el.removeEventListener('pointermove', onMapPointerMove);
      el.removeEventListener('pointerup', onMapPointerUpOrCancel);
      el.removeEventListener('pointercancel', onMapPointerUpOrCancel);
      el.removeEventListener('contextmenu', onMapContextMenu);
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(settleTimer);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      baseLayersRef.current = null;
      routeLayerRef.current = null;
      speedBadgesLayerRef.current = null;
      scrubberLayerRef.current = null;
      gatesLayerRef.current = null;
      waypointLayerRef.current = null;
      carLayerRef.current = null;
      liveMarkerMapRef.current.clear();
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

  // Redimensiona mapa ao alternar tela cheia ou classe de altura do container
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.invalidateSize({ animate: false });
    const t = window.setTimeout(() => map.invalidateSize({ animate: false }), 120);
    return () => window.clearTimeout(t);
  }, [effectiveFullscreen, externalFs, containerClassName]);

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

    const drawGuideTrace = (trace: VelocitySample[]) => {
      if (trace.length < 2) return;
      const latLngs = offsetTraceLatLngs(trace, 0);
      L.polyline(latLngs, {
        color: '#050608',
        weight: 4.5,
        opacity: 0.45,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(routeLayer);
      L.polyline(latLngs, {
        color: '#38BDF8',
        weight: 2.5,
        opacity: 0.85,
        dashArray: '6 5',
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(routeLayer);
    };

    if (guideTrace && guideTrace.length > 1) {
      drawGuideTrace(guideTrace);
    }

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

    // Modo padrão ('none' — Editor de Pista / Mapa Ao Vivo / Multi-Especial)
    if (multiTraces && multiTraces.length > 0) {
      for (const layerItem of multiTraces) {
        if (layerItem.trace.length < 2) continue;
        const latLngs = offsetTraceLatLngs(layerItem.trace, 0);
        const lineWeight = layerItem.active ? 4.2 : 3.2;
        L.polyline(latLngs, {
          color: '#050608',
          weight: lineWeight + 2,
          opacity: 0.6,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
        const poly = L.polyline(latLngs, {
          color: layerItem.color || '#0288D1',
          weight: lineWeight,
          opacity: layerItem.active === false ? 0.85 : 0.98,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
        if (layerItem.name) {
          const popupEl = document.createElement('div');
          popupEl.style.fontFamily = 'sans-serif';
          popupEl.style.fontSize = '12px';
          const titleEl = document.createElement('strong');
          titleEl.textContent = layerItem.name;
          popupEl.appendChild(titleEl);
          if (layerItem.description) {
            const descEl = document.createElement('div');
            descEl.style.fontSize = '11px';
            descEl.style.marginTop = '2px';
            descEl.textContent = layerItem.description;
            popupEl.appendChild(descEl);
          }
          poly.bindPopup(popupEl);
        }
      }
      return;
    }

    if (hasLap3 && thirdTrace) {
      drawSolidTrace(thirdTrace, offsetGhostTrace ? -1.8 : 0, '#38BDF8');
    }
    if (hasLap2 && ghostTrace) {
      drawSolidTrace(ghostTrace, offsetGhostTrace ? 1.8 : 0, '#FF2A2A');
    }
    if (editableTrace.length > 1) {
      drawSolidTrace(editableTrace, 0, traceColor || '#E10600', '#FFFFFF', 0.78);
    }
  }, [editableTrace, traceColor, multiTraces, guideTrace, ghostTrace, thirdTrace, offsetGhostTrace, heatmapMode]);

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
    liveMarkerMapRef.current.clear();

    const cleanupListeners: Array<() => void> = [];

    let splitIdx = 0;
    for (const trap of orderedTraps) {
      if (trap.kind === 'split') splitIdx += 1;
      const isSelected = trap.id === selectedTrapId;
      const isUnlocked = unlockedTrapIdRef.current === trap.id;
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

      const pinEl = createMarcoPinElement(trap, splitIdx, isSelected, isUnlocked);
      const icon = L.divIcon({
        html: pinEl,
        className: 'pitstop-marco-divicon',
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });

      const canDragNow =
        Boolean(onDragTrapEndRef.current) &&
        (!requireLongPressRef.current || isUnlocked);

      const marker = L.marker([trap.lat, trap.lon], {
        icon,
        draggable: canDragNow,
        zIndexOffset: isSelected ? 900 : 500,
      }).addTo(gatesLayer);

      const updateGateLines = (lat: number, lon: number) => {
        const liveGate = buildMarcoGateLineString(lat, lon, trap.bearingDeg, trap.widthM);
        const liveGateLatLngs: [number, number][] = liveGate.geometry.coordinates.map(
          ([lng, latPt]) => [latPt, lng]
        );
        const liveArrow = buildMarcoArrowGeometry(lat, lon, trap.bearingDeg, trap.widthM);
        const liveShaft: [number, number][] = liveArrow.shaftCoords.map(([lng, latPt]) => [
          latPt,
          lng,
        ]);
        const liveHead: [number, number][] = liveArrow.headCoords.map(([lng, latPt]) => [
          latPt,
          lng,
        ]);
        gateCasing.setLatLngs(liveGateLatLngs);
        gateLine.setLatLngs(liveGateLatLngs);
        arrowCasing.setLatLngs(liveShaft);
        arrowShaft.setLatLngs(liveShaft);
        headCasing.setLatLngs(liveHead);
        headLine.setLatLngs(liveHead);
      };

      liveMarkerMapRef.current.set(trap.id, { marker, pinEl, updateGateLines });

      marker.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        onSelectTrapRef.current?.(trap.id);
      });

      // Atualiza linha transversal e seta em tempo real durante o arrasto
      marker.on('drag', () => {
        const pos = marker.getLatLng();
        updateGateLines(pos.lat, pos.lng);
      });

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onSelectTrapRef.current?.(trap.id);
        onDragTrapEndRef.current?.(trap.id, pos.lat, pos.lng);
        if (requireLongPressRef.current) {
          setUnlockedTrapId(null);
        }
      });

      // Proteção Long Press (400ms) para destravar arrasto de marcador existente
      if (requireLongPressRef.current && onDragTrapEndRef.current) {
        let pointerId: number | null = null;
        let startX = 0;
        let startY = 0;
        let showTimer: number | null = null;
        let unlockTimer: number | null = null;
        let slideActive = false;
        let slideMoved = false;

        const clearHold = () => {
          if (showTimer !== null) {
            window.clearTimeout(showTimer);
            showTimer = null;
          }
          if (unlockTimer !== null) {
            window.clearTimeout(unlockTimer);
            unlockTimer = null;
          }
          setHoldRing(null);
        };

        const onPinPointerDown = (ev: PointerEvent) => {
          if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
          if (unlockedTrapIdRef.current === trap.id) {
            armUnlockRef.current(trap.id);
            return;
          }
          clearHold();
          pointerId = ev.pointerId;
          startX = ev.clientX;
          startY = ev.clientY;
          slideActive = false;
          slideMoved = false;

          const cont = containerRef.current;
          const map = mapRef.current;
          if (!cont || !map) return;
          const rect = cont.getBoundingClientRect();
          const relX = ev.clientX - rect.left;
          const relY = ev.clientY - rect.top;

          showTimer = window.setTimeout(() => {
            if (pointerId === ev.pointerId) {
              setHoldRing({ x: relX, y: relY });
            }
          }, 100);

          unlockTimer = window.setTimeout(() => {
            if (pointerId !== ev.pointerId) return;
            clearHold();
            slideActive = true;
            map.dragging.disable();
            triggerFeedbackRef.current(relX, relY, 'Marco destravado — arraste!');
            onSelectTrapRef.current?.(trap.id);
            armUnlockRef.current(trap.id);
          }, 400);
        };

        const onWinPointerMove = (ev: PointerEvent) => {
          if (pointerId !== ev.pointerId) return;
          if (!slideActive) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 10) {
              clearHold();
              pointerId = null;
            }
            return;
          }
          const cont = containerRef.current;
          const map = mapRef.current;
          if (!cont || !map) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
            slideMoved = true;
          }
          const rect = cont.getBoundingClientRect();
          const ll = map.containerPointToLatLng([ev.clientX - rect.left, ev.clientY - rect.top]);
          marker.setLatLng(ll);
          updateGateLines(ll.lat, ll.lng);
        };

        const onWinPointerUp = (ev: PointerEvent) => {
          if (pointerId !== ev.pointerId) return;
          clearHold();
          const map = mapRef.current;
          if (slideActive) {
            map?.dragging.enable();
            if (slideMoved) {
              const pos = marker.getLatLng();
              onDragTrapEndRef.current?.(trap.id, pos.lat, pos.lng);
              setUnlockedTrapId(null);
            }
          }
          slideActive = false;
          slideMoved = false;
          pointerId = null;
        };

        const onPinContextMenu = (ev: MouseEvent) => {
          ev.preventDefault();
        };

        pinEl.addEventListener('pointerdown', onPinPointerDown);
        pinEl.addEventListener('contextmenu', onPinContextMenu);
        window.addEventListener('pointermove', onWinPointerMove);
        window.addEventListener('pointerup', onWinPointerUp);
        window.addEventListener('pointercancel', onWinPointerUp);

        cleanupListeners.push(() => {
          clearHold();
          pinEl.removeEventListener('pointerdown', onPinPointerDown);
          pinEl.removeEventListener('contextmenu', onPinContextMenu);
          window.removeEventListener('pointermove', onWinPointerMove);
          window.removeEventListener('pointerup', onWinPointerUp);
          window.removeEventListener('pointercancel', onWinPointerUp);
        });
      }
    }

    return () => {
      cleanupListeners.forEach((fn) => fn());
    };
  }, [orderedTraps, selectedTrapId, gatesDataKey, requireLongPressForTraps]);

  // Atualiza estado draggable + halo visual sem recriar os marcadores durante o gesto
  useEffect(() => {
    for (const [id, entry] of liveMarkerMapRef.current.entries()) {
      const canDrag =
        Boolean(onDragTrapEndRef.current) &&
        (!requireLongPressForTraps || unlockedTrapId === id);
      if (canDrag) {
        entry.marker.dragging?.enable();
      } else {
        entry.marker.dragging?.disable();
      }
      if (requireLongPressForTraps && unlockedTrapId === id) {
        entry.pinEl.style.cursor = 'grabbing';
        entry.pinEl.style.boxShadow = '0 0 0 3px #10B981, 0 0 18px rgba(16, 185, 129, 0.85)';
        entry.pinEl.style.background = 'rgba(16, 185, 129, 0.2)';
      } else {
        entry.pinEl.style.cursor = requireLongPressForTraps ? 'pointer' : 'grab';
        entry.pinEl.style.boxShadow = '';
        entry.pinEl.style.background = '';
      }
    }
  }, [unlockedTrapId, requireLongPressForTraps, gatesDataKey]);

  // Renderiza Pontos de Interesse / Waypoints (ex: "Parque Serviços") sem criar trilhas vazias
  useEffect(() => {
    const wpLayer = waypointLayerRef.current;
    if (!wpLayer) return;
    wpLayer.clearLayers();
    if (!waypoints || waypoints.length === 0) return;

    for (const wp of waypoints) {
      if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) continue;
      const pinColor = wp.color || '#F59E0B';
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'center';
      wrap.style.transform = 'translate(-50%, -88%)';
      wrap.style.pointerEvents = 'auto';
      wrap.style.cursor = 'pointer';

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', '26');
      svg.setAttribute('height', '26');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.85))';

      const pin = document.createElementNS(svgNS, 'path');
      pin.setAttribute(
        'd',
        'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z'
      );
      pin.setAttribute('fill', pinColor);
      pin.setAttribute('stroke', '#FFFFFF');
      pin.setAttribute('stroke-width', '1.8');
      svg.appendChild(pin);

      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('cx', '12');
      dot.setAttribute('cy', '9');
      dot.setAttribute('r', '2.6');
      dot.setAttribute('fill', '#FFFFFF');
      svg.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = wp.name;
      label.style.marginTop = '1px';
      label.style.background = 'rgba(10, 12, 16, 0.88)';
      label.style.border = `1px solid ${pinColor}`;
      label.style.color = '#FFFFFF';
      label.style.fontFamily = 'sans-serif';
      label.style.fontSize = '10px';
      label.style.fontWeight = '700';
      label.style.lineHeight = '1.15';
      label.style.padding = '2px 6px';
      label.style.borderRadius = '9999px';
      label.style.whiteSpace = 'nowrap';
      label.style.maxWidth = '150px';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.boxShadow = '0 2px 5px rgba(0,0,0,0.75)';

      wrap.appendChild(svg);
      wrap.appendChild(label);

      const icon = L.divIcon({
        html: wrap,
        className: 'pitstop-waypoint-divicon',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });

      const marker = L.marker([wp.lat, wp.lon], {
        icon,
        zIndexOffset: 650,
      }).addTo(wpLayer);

      const popupEl = document.createElement('div');
      popupEl.style.fontFamily = 'sans-serif';
      popupEl.style.fontSize = '12px';
      const titleEl = document.createElement('strong');
      titleEl.textContent = wp.name;
      popupEl.appendChild(titleEl);
      if (wp.description) {
        const descEl = document.createElement('div');
        descEl.style.fontSize = '11px';
        descEl.style.marginTop = '2px';
        descEl.textContent = wp.description;
        popupEl.appendChild(descEl);
      }
      marker.bindPopup(popupEl);
    }
  }, [waypoints]);

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

    const multiPts: [number, number][] = multiTraces
      ? multiTraces.flatMap((mt) => mt.trace.map((s): [number, number] => [s.lat, s.lon]))
      : [];
    const wpPts: [number, number][] = waypoints
      ? waypoints.map((w): [number, number] => [w.lat, w.lon])
      : [];

    const pts: [number, number][] = [
      ...editableTrace.map((s): [number, number] => [s.lat, s.lon]),
      ...multiPts,
      ...wpPts,
      ...(guideTrace ? guideTrace.map((s): [number, number] => [s.lat, s.lon]) : []),
      ...(ghostTrace ? ghostTrace.map((s): [number, number] => [s.lat, s.lon]) : []),
      ...(thirdTrace ? thirdTrace.map((s): [number, number] => [s.lat, s.lon]) : []),
      ...orderedTraps.map((t): [number, number] => [t.lat, t.lon]),
    ];

    const key =
      pts.length > 0
        ? `${trackId}:${editableTrace.length}:${multiTraces?.length ?? 0}:${multiPts.length}:${wpPts.length}:${guideTrace?.length ?? 0}:${ghostTrace?.length ?? 0}:${thirdTrace?.length ?? 0}:${orderedTraps.length}`
        : currentPos
          ? `pos:${trackId}`
          : '';
    if (!force && lastFittedKeyRef.current === key) return;

    if (pts.length >= 2) {
      lastFittedKeyRef.current = key;
      map.invalidateSize({ animate: false });
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
      lastFittedKeyRef.current = key;
      map.invalidateSize({ animate: false });
      map.setView([currentPos.lat, currentPos.lon], 17, { animate: true });
    }
  };

  useEffect(() => {
    if (navigationMode) return;
    fitMapToTrackOrCenter(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    trackId,
    editableTrace.length,
    multiTraces?.length,
    waypoints?.length,
    guideTrace?.length,
    ghostTrace?.length,
    thirdTrace?.length,
    orderedTraps.length,
    navigationMode,
    currentPos?.lat,
    currentPos?.lon,
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

  const centerOnMyPosition = async () => {
    const map = mapRef.current;
    if (!map) return;

    if (currentPos) {
      map.setView([currentPos.lat, currentPos.lon], 17, { animate: true });
    }

    if (onRequestCenterPos) {
      try {
        const fresh = await onRequestCenterPos();
        if (fresh && mapRef.current) {
          mapRef.current.setView([fresh.lat, fresh.lon], 17, { animate: true });
          return;
        }
      } catch {
        // Fallback below
      }
    }

    try {
      if (Capacitor.isNativePlatform()) {
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0,
        });
        mapRef.current?.setView([pos.coords.latitude, pos.coords.longitude], 17, {
          animate: true,
        });
        return;
      }
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            mapRef.current?.setView([pos.coords.latitude, pos.coords.longitude], 17, {
              animate: true,
            });
          },
          () => {
            if (!currentPos && mapRef.current) {
              mapRef.current.setView(ERECHIM_LATLON, 15, { animate: true });
            }
          },
          { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
        );
        return;
      }
    } catch {
      // Fallback below
    }

    if (!currentPos) {
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
        effectiveFullscreen
          ? 'fixed inset-0 z-50 overflow-hidden bg-[var(--ps-bg)]'
          : containerClassName
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
      {navigationMode && !hideBuiltInTopControls && (
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
      {hideBuiltInTopControls ? null : externalFs ? (
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
          {(editableTrace.length > 0 || (multiTraces && multiTraces.length > 0) || (waypoints && waypoints.length > 0) || orderedTraps.length > 0) && (
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
            onClick={() => {
              void centerOnMyPosition();
            }}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 px-2 text-[11px] font-bold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-emerald)]"
            title="Buscar e centralizar na minha posição GPS atual"
          >
            <Navigation className="h-3 w-3 text-[var(--ps-emerald)]" />
            <span>Minha Posição</span>
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
            aria-label={effectiveFullscreen ? 'Sair da tela cheia' : 'Mapa em tela cheia'}
          >
            {effectiveFullscreen ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
        </div>
      )}

      {/* Micro-Overlay superior exclusivo de Tela Cheia (ex: Horário Oficial CH) */}
      {effectiveFullscreen && fullscreenTopOverlay && (
        <div
          className={`pointer-events-none absolute left-2.5 z-[410] ${
            navigationMode ? 'top-12' : 'top-12 sm:top-2.5'
          }`}
        >
          <div className="pointer-events-auto">{fullscreenTopOverlay}</div>
        </div>
      )}

      {/* Feedback visual de Long Press (anel de carregamento + pulso ao destravar/posicionar) */}
      {holdRing && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-[450] -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${holdRing.x}px`, top: `${holdRing.y}px` }}
        >
          <div className="h-14 w-14 rounded-full border-2 border-amber-400/90 bg-amber-400/15 animate-ping" />
        </div>
      )}

      {pulseRing && (
        <div
          key={pulseRing.key}
          aria-hidden="true"
          className="pointer-events-none absolute z-[455] flex flex-col items-center -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${pulseRing.x}px`, top: `${pulseRing.y}px` }}
        >
          <div className="relative flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 rounded-full border-2 border-emerald-400 animate-ping" />
            <span className="h-6 w-6 rounded-full border-2 border-white bg-emerald-500/80 shadow-[0_0_16px_rgba(16,185,129,0.95)]" />
          </div>
          <span className="mt-1 whitespace-nowrap rounded-md border border-emerald-400/60 bg-black/80 px-2 py-0.5 text-[10px] font-bold text-emerald-300 shadow-lg backdrop-blur-sm">
            {pulseRing.label}
          </span>
        </div>
      )}

      {/* Controles de Zoom + / - estilo RaceChrono */}
      <div
        className={`absolute right-2.5 z-[400] flex flex-col overflow-hidden rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 shadow-lg backdrop-blur-xs ${
          effectiveFullscreen && fullscreenZoomBottomClass
            ? fullscreenZoomBottomClass
            : zoomControlsBottomClass ?? (externalFs ? 'bottom-2.5' : 'bottom-14')
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
            effectiveFullscreen && fullscreenOverlay ? 'top-2.5 left-2.5' : 'bottom-3 left-3'
          }`}
        >
          <Plus className="h-4 w-4" />
          <span>Marcar na Mira</span>
        </button>
      )}

      {/* Barra flutuante de criação/edição de Marcos ou HUD exclusiva do modo Tela Cheia */}
      {effectiveFullscreen && fullscreenOverlay && (
        <div
          className={`pointer-events-none absolute inset-x-2.5 bottom-2.5 z-[410] flex justify-center ${
            fullscreenOverlayFullWidth ? '' : 'pr-12 sm:pr-0'
          }`}
        >
          <div className="pointer-events-auto w-full max-w-2xl">
            {fullscreenOverlay}
          </div>
        </div>
      )}
    </div>
  );
};
