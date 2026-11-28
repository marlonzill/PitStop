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
  drawCachedOrUpscaledTileOnCanvas,
  type OfflineTileLayerKind,
} from '../utils/offlineMapsService';
import {
  buildMarcoArrowGeometry,
  buildMarcoGateLineString,
  computeSampleGForces,
  decimateSamplesForDisplay,
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
  compactCarMarkers?: boolean;
  autoFollowCar?: boolean;
  onAutoFollowPausedByUser?: () => void;
  transitRoute?: {
    toLat: number;
    toLon: number;
    label?: string;
    color?: string;
    routeLatLngs?: [number, number][];
  } | null;
  onSelectWaypoint?: (wp: GeoWaypoint) => void;
  onSelectMultiTrace?: (trackId: string) => void;
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
  driving3dMode?: boolean;
  drivingTheme?: 'satellite' | 'dark' | 'light';
  recenterTrigger?: number;
  onUserPanChanged?: (paused: boolean) => void;
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
  variant: VehicleVariant = 'default',
  compact = false
): HTMLDivElement {
  const wrapSize = compact ? 12 : 18;
  const dotSize = compact ? 9 : 14;
  const borderWidth = compact ? 1.5 : 2.5;

  const el = document.createElement('div');
  el.style.width = `${wrapSize}px`;
  el.style.height = `${wrapSize}px`;
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
  dot.style.width = `${dotSize}px`;
  dot.style.height = `${dotSize}px`;
  dot.style.borderRadius = '9999px';
  dot.style.backgroundColor = fillColor;
  dot.style.border = `${borderWidth}px solid ${strokeColor}`;
  dot.style.boxShadow = '0 1px 4px rgba(0,0,0,0.85)';

  el.appendChild(dot);

  return el;
}

function createNavigationArrowCursorElement(headingDeg: number | null): {
  el: HTMLDivElement;
  arrowSvg: SVGSVGElement;
} {
  const el = document.createElement('div');
  el.style.width = '50px';
  el.style.height = '50px';
  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.justifyContent = 'center';
  el.style.position = 'relative';
  el.style.pointerEvents = 'none';

  // Soft cyan/blue navigation halo
  const halo = document.createElement('div');
  halo.style.position = 'absolute';
  halo.style.inset = '2px';
  halo.style.borderRadius = '9999px';
  halo.style.background =
    'radial-gradient(circle, rgba(56,189,248,0.42) 0%, rgba(14,165,233,0.16) 62%, rgba(14,165,233,0) 100%)';
  halo.style.border = '1.5px solid rgba(125,211,252,0.55)';
  el.appendChild(halo);

  // Circular navigation puck
  const puck = document.createElement('div');
  puck.style.width = '34px';
  puck.style.height = '34px';
  puck.style.borderRadius = '9999px';
  puck.style.background = 'linear-gradient(180deg, #0F172A 0%, #020617 100%)';
  puck.style.border = '2.5px solid #FFFFFF';
  puck.style.boxShadow = '0 4px 12px rgba(0,0,0,0.85), 0 0 12px rgba(56,189,248,0.45)';
  puck.style.display = 'flex';
  puck.style.alignItems = 'center';
  puck.style.justifyContent = 'center';
  puck.style.position = 'relative';

  // 3D Extruded Arrowhead pointing North (0 deg) rotated by headingDeg inside map layer
  const svgNS = 'http://www.w3.org/2000/svg';
  const arrowSvg = document.createElementNS(svgNS, 'svg');
  arrowSvg.setAttribute('width', '22');
  arrowSvg.setAttribute('height', '22');
  arrowSvg.setAttribute('viewBox', '0 0 24 24');
  arrowSvg.style.transform = `rotate(${headingDeg ?? 0}deg)`;
  arrowSvg.style.transformOrigin = '50% 50%';
  arrowSvg.style.transition = 'transform 180ms linear';
  arrowSvg.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))';

  const leftWing = document.createElementNS(svgNS, 'polygon');
  leftWing.setAttribute('points', '12,2.5 12,16.5 4.2,20.2');
  leftWing.setAttribute('fill', '#7DD3FC');
  arrowSvg.appendChild(leftWing);

  const rightWing = document.createElementNS(svgNS, 'polygon');
  rightWing.setAttribute('points', '12,2.5 19.8,20.2 12,16.5');
  rightWing.setAttribute('fill', '#0284C7');
  arrowSvg.appendChild(rightWing);

  const outline = document.createElementNS(svgNS, 'polygon');
  outline.setAttribute('points', '12,2.5 19.8,20.2 12,16.5 4.2,20.2');
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', '#FFFFFF');
  outline.setAttribute('stroke-width', '1.4');
  outline.setAttribute('stroke-linejoin', 'round');
  arrowSvg.appendChild(outline);

  puck.appendChild(arrowSvg);
  el.appendChild(puck);
  return { el, arrowSvg };
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

export const VelocityMapboxView: React.FC<VelocityMapboxViewProps> = React.memo(({
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
  compactCarMarkers = false,
  autoFollowCar = false,
  onAutoFollowPausedByUser,
  transitRoute = null,
  onSelectWaypoint,
  onSelectMultiTrace,
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
  driving3dMode = false,
  drivingTheme,
  recenterTrigger = 0,
  onUserPanChanged,
}) => {
  const outerWrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayersRef = useRef<{
    satellite: L.GridLayer;
    labels: L.GridLayer;
    streets: L.GridLayer;
  } | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const transitLayerRef = useRef<L.LayerGroup | null>(null);
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
    arrowSvg?: SVGSVGElement;
    variant: string;
    compact: boolean;
    arrowCursor: boolean;
  } | null>(null);
  const ghostMarkerRef = useRef<{
    marker: L.Marker;
    el: HTMLDivElement;
    compact: boolean;
  } | null>(null);
  const thirdMarkerRef = useRef<{
    marker: L.Marker;
    el: HTMLDivElement;
    compact: boolean;
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
  const onAutoFollowPausedRef = useRef(onAutoFollowPausedByUser);
  onAutoFollowPausedRef.current = onAutoFollowPausedByUser;
  const onSelectWaypointRef = useRef(onSelectWaypoint);
  onSelectWaypointRef.current = onSelectWaypoint;
  const onSelectMultiTraceRef = useRef(onSelectMultiTrace);
  onSelectMultiTraceRef.current = onSelectMultiTrace;

  const [styleIndex, setStyleIndex] = useState(0); // Default: Satélite
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [internalHeadingUp, setInternalHeadingUp] = useState(true);
  const [wrapperSize, setWrapperSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [manualRotationDeg, setManualRotationDeg] = useState(0);
  const [userInteracted, setUserInteracted] = useState(false);
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
  const is3dDrivingActive = Boolean(
    navigationMode && effectiveHeadingUp && (driving3dMode || Boolean(transitRoute)) && !userInteracted
  );
  const is3dDrivingRef = useRef(is3dDrivingActive);
  is3dDrivingRef.current = is3dDrivingActive;
  const autoRotationDeg =
    navigationMode && effectiveHeadingUp && typeof navHeadingDeg === 'number' && !userInteracted
      ? -navHeadingDeg
      : 0;
  const totalRotationDeg =
    userInteracted || Math.abs(manualRotationDeg) > 0.5 ? manualRotationDeg : autoRotationDeg;
  const totalRotationRef = useRef(totalRotationDeg);
  totalRotationRef.current = totalRotationDeg;
  const userInteractedRef = useRef(userInteracted);
  userInteractedRef.current = userInteracted;
  const manualRotationRef = useRef(manualRotationDeg);
  manualRotationRef.current = manualRotationDeg;
  const onUserPanChangedRef = useRef(onUserPanChanged);
  onUserPanChangedRef.current = onUserPanChanged;

  useEffect(() => {
    onUserPanChangedRef.current?.(userInteracted || Math.abs(manualRotationDeg) > 1);
  }, [userInteracted, manualRotationDeg]);

  const clientToMapContainerPoint = (clientX: number, clientY: number): [number, number] | null => {
    const wrapper = outerWrapperRef.current;
    const cont = containerRef.current;
    if (!wrapper || !cont) return null;
    const wRect = wrapper.getBoundingClientRect();
    const cx = wRect.left + wRect.width / 2;
    const cy = wRect.top + wRect.height / 2;
    const vx = clientX - cx;
    const vy = clientY - cy;
    const rad = (-totalRotationRef.current * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lx = cont.clientWidth / 2 + (vx * cos - vy * sin);
    const ly = cont.clientHeight / 2 + (vx * sin + vy * cos);
    return [lx, ly];
  };

  const effectiveStyleIndex =
    mapStyleIndex !== undefined ? mapStyleIndex % MAP_STYLES.length : styleIndex;
  const currentStyle = MAP_STYLES[effectiveStyleIndex];
  const externalFs = Boolean(isExternalFullscreen);
  const effectiveFullscreen = typeof forceFullscreen === 'boolean' ? forceFullscreen : isFullscreen;

  // Oculta o cabeçalho/rodapé principal do app quando o mapa entra em Tela Cheia real
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const shouldHideAppShell = effectiveFullscreen && !externalFs;
    if (shouldHideAppShell) {
      document.body.classList.add('pitstop-map-fullscreen');
    } else {
      document.body.classList.remove('pitstop-map-fullscreen');
    }
    return () => {
      document.body.classList.remove('pitstop-map-fullscreen');
    };
  }, [effectiveFullscreen, externalFs]);

  // Quando o caller reativa autoFollowCar (ex: botão Seguir Carro), retoma seguimento automático
  const prevAutoFollowPropRef = useRef(autoFollowCar);
  useEffect(() => {
    if (autoFollowCar && !prevAutoFollowPropRef.current) {
      setUserInteracted(false);
    }
    prevAutoFollowPropRef.current = autoFollowCar;
  }, [autoFollowCar]);

  // Mede o viewport externo para dimensionar o quadrado rotacionado sem cortar cantos
  useEffect(() => {
    const wrap = outerWrapperRef.current;
    if (!wrap) return;
    const updateSize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w > 0 && h > 0) {
        setWrapperSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [effectiveFullscreen, externalFs, containerClassName]);

  // Inicializa Leaflet em Modo Satélite com suporte multitoque completo (zoom pinça, arraste, rotação 2 dedos)
  useEffect(() => {
    const el = containerRef.current;
    const wrap = outerWrapperRef.current;
    if (!el) return;

    const map = L.map(el, {
      center: currentPos ? [currentPos.lat, currentPos.lon] : ERECHIM_LATLON,
      zoom: currentPos ? 17.5 : 15,
      zoomSnap: 0.5,
      minZoom: 3,
      maxZoom: 21,
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      bounceAtZoomLimits: false,
    });

    const createOfflineCachedLayer = (
      layerKind: OfflineTileLayerKind,
      maxNativeZoom: number
    ): L.GridLayer => {
      const OfflineLayer = L.GridLayer.extend({
        createTile(coords: L.Coords, done: L.DoneCallback) {
          const canvas = document.createElement('canvas');
          const tileSize = this.getTileSize();
          canvas.width = tileSize.x;
          canvas.height = tileSize.y;
          void drawCachedOrUpscaledTileOnCanvas(
            layerKind,
            coords.z,
            coords.x,
            coords.y,
            canvas,
            maxNativeZoom
          )
            .then(() => {
              done(undefined, canvas);
            })
            .catch(() => {
              done(undefined, canvas);
            });
          return canvas;
        },
      });
      return new (OfflineLayer as unknown as new (opts: L.GridLayerOptions) => L.GridLayer)({
        minZoom: 3,
        maxZoom: 21,
        tileSize: 256,
        keepBuffer: 4,
      });
    };

    const satellite = createOfflineCachedLayer('satellite', 18);
    const labels = createOfflineCachedLayer('labels', 18);
    const streets = createOfflineCachedLayer('streets', 19);

    satellite.addTo(map);
    baseLayersRef.current = { satellite, labels, streets };

    const routeLayer = L.layerGroup().addTo(map);
    const transitLayer = L.layerGroup().addTo(map);
    const speedBadgesLayer = L.layerGroup().addTo(map);
    const scrubberLayer = L.layerGroup().addTo(map);
    const gatesLayer = L.layerGroup().addTo(map);
    const waypointLayer = L.layerGroup().addTo(map);
    const carLayer = L.layerGroup().addTo(map);
    routeLayerRef.current = routeLayer;
    transitLayerRef.current = transitLayer;
    speedBadgesLayerRef.current = speedBadgesLayer;
    scrubberLayerRef.current = scrubberLayer;
    gatesLayerRef.current = gatesLayer;
    waypointLayerRef.current = waypointLayer;
    carLayerRef.current = carLayer;

    // Compensa o arraste de 1 dedo quando o mapa estiver rotacionado em qualquer ângulo
    const draggable = (
      map.dragging as unknown as {
        _draggable?: L.Draggable & { _startPos?: L.Point; _newPos?: L.Point };
      }
    )?._draggable;
    if (draggable) {
      draggable.on('predrag', () => {
        const deg = totalRotationRef.current;
        const pitchScaleY = is3dDrivingRef.current ? 1.88 : 1;
        if ((Math.abs(deg) > 0.01 || pitchScaleY !== 1) && draggable._startPos && draggable._newPos) {
          const dx = draggable._newPos.x - draggable._startPos.x;
          const dy = (draggable._newPos.y - draggable._startPos.y) * pitchScaleY;
          const rad = (-deg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          draggable._newPos.x = draggable._startPos.x + (dx * cos - dy * sin);
          draggable._newPos.y = draggable._startPos.y + (dx * sin + dy * cos);
        }
      });
    }

    // Pausa auto-follow quando o piloto arrasta manualmente o mapa
    map.on('dragstart', () => {
      if (!userInteractedRef.current) {
        setUserInteracted(true);
        onAutoFollowPausedRef.current?.();
      }
    });

    // Rotação manual fluida com 2 dedos no container externo
    let twoFingerStartAngle = 0;
    let twoFingerBaseRot = 0;
    let twoFingerActive = false;
    let twoFingerRotUnlocked = false;
    let twoFingerZeroOffset = 0;

    const getTouchAngleDeg = (touches: TouchList) => {
      const t0 = touches[0];
      const t1 = touches[1];
      return (Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX) * 180) / Math.PI;
    };

    const onWrapperTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        twoFingerActive = true;
        twoFingerRotUnlocked = false;
        twoFingerStartAngle = getTouchAngleDeg(e.touches);
        twoFingerBaseRot = totalRotationRef.current;
        twoFingerZeroOffset = 0;
      } else {
        twoFingerActive = false;
      }
    };

    const onWrapperTouchMove = (e: TouchEvent) => {
      if (!twoFingerActive || e.touches.length !== 2) return;
      const curAngle = getTouchAngleDeg(e.touches);
      const rawDelta = ((curAngle - twoFingerStartAngle + 540) % 360) - 180;
      if (!twoFingerRotUnlocked) {
        if (Math.abs(rawDelta) < 6) return;
        twoFingerRotUnlocked = true;
        twoFingerZeroOffset = rawDelta > 0 ? 6 : -6;
      }
      const nextRot = twoFingerBaseRot + (rawDelta - twoFingerZeroOffset);
      if (!userInteractedRef.current) {
        setUserInteracted(true);
        onAutoFollowPausedRef.current?.();
      }
      setManualRotationDeg(nextRot);
    };

    const onWrapperTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        twoFingerActive = false;
        twoFingerRotUnlocked = false;
      }
    };

    if (wrap) {
      wrap.addEventListener('touchstart', onWrapperTouchStart, { passive: true });
      wrap.addEventListener('touchmove', onWrapperTouchMove, { passive: true });
      wrap.addEventListener('touchend', onWrapperTouchEnd, { passive: true });
      wrap.addEventListener('touchcancel', onWrapperTouchEnd, { passive: true });
    }

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
      const wRect = (wrap ?? el).getBoundingClientRect();
      const ringX = ev.clientX - wRect.left;
      const ringY = ev.clientY - wRect.top;
      const localPt = clientToMapContainerPoint(ev.clientX, ev.clientY) ?? [ringX, ringY];

      mapRingShowTimer = window.setTimeout(() => {
        if (mapHoldPointerId === ev.pointerId) {
          setHoldRing({ x: ringX, y: ringY });
        }
      }, 100);

      mapLongPressTimer = window.setTimeout(() => {
        if (mapHoldPointerId !== ev.pointerId || activeMapPointers.size > 1) return;
        clearMapLongPress();
        const ll = map.containerPointToLatLng(localPt);
        if (placementKindRef.current && onMapClickRef.current) {
          triggerFeedbackRef.current(ringX, ringY, 'Marco posicionado!');
          onMapClickRef.current(ll.lat, ll.lng);
        } else if (selectedTrapIdRef.current && onDragTrapEndRef.current) {
          triggerFeedbackRef.current(ringX, ringY, 'Marco movido!');
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
      if (wrap) {
        wrap.removeEventListener('touchstart', onWrapperTouchStart);
        wrap.removeEventListener('touchmove', onWrapperTouchMove);
        wrap.removeEventListener('touchend', onWrapperTouchEnd);
        wrap.removeEventListener('touchcancel', onWrapperTouchEnd);
      }
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
      transitLayerRef.current = null;
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

  // Alterna camada Satélite / Híbrido / Ruas / Escuro / Claro
  useEffect(() => {
    const map = mapRef.current;
    const layers = baseLayersRef.current;
    if (!map || !layers) return;

    if (map.hasLayer(layers.satellite)) map.removeLayer(layers.satellite);
    if (map.hasLayer(layers.labels)) map.removeLayer(layers.labels);
    if (map.hasLayer(layers.streets)) map.removeLayer(layers.streets);

    if (drivingTheme) {
      if (drivingTheme === 'satellite') {
        layers.satellite.addTo(map);
        layers.labels.addTo(map);
      } else {
        layers.streets.addTo(map);
      }
      return;
    }

    if (currentStyle.id === 'satellite') {
      layers.satellite.addTo(map);
    } else if (currentStyle.id === 'hybrid') {
      layers.satellite.addTo(map);
      layers.labels.addTo(map);
    } else {
      layers.streets.addTo(map);
    }
  }, [currentStyle.id, drivingTheme]);

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
      rawTrace: VelocitySample[],
      offsetM: number,
      mode: 'speed' | 'accel'
    ) => {
      const trace = decimateSamplesForDisplay(rawTrace, 850);
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
      rawTrace: VelocitySample[],
      offsetM: number,
      color: string,
      casingColor = '#050608',
      casingOpacity = 0.45
    ) => {
      const trace = decimateSamplesForDisplay(rawTrace, 900);
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

    const drawGuideTrace = (rawTrace: VelocitySample[]) => {
      const trace = decimateSamplesForDisplay(rawTrace, 800);
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
        const decimatedLayerTrace = decimateSamplesForDisplay(layerItem.trace, 650);
        const latLngs = offsetTraceLatLngs(decimatedLayerTrace, 0);
        const lineWeight = layerItem.active ? 5 : 3.2;
        const casingPoly = L.polyline(latLngs, {
          color: layerItem.active ? '#FFFFFF' : '#050608',
          weight: lineWeight + 2.5,
          opacity: layerItem.active ? 0.88 : 0.6,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
        const poly = L.polyline(latLngs, {
          color: layerItem.color || '#0288D1',
          weight: lineWeight,
          opacity: layerItem.active === false ? 0.88 : 0.98,
          lineCap: 'round',
          lineJoin: 'round',
        }).addTo(routeLayer);
        const handlePolyTap = (ev: L.LeafletMouseEvent) => {
          if (onSelectMultiTraceRef.current) {
            L.DomEvent.stopPropagation(ev);
            onSelectMultiTraceRef.current(layerItem.id);
          }
        };
        casingPoly.on('click', handlePolyTap);
        poly.on('click', handlePolyTap);
        if (layerItem.name && !onSelectMultiTraceRef.current) {
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
          const wrap = outerWrapperRef.current;
          const map = mapRef.current;
          if (!cont || !map) return;
          const wRect = (wrap ?? cont).getBoundingClientRect();
          const relX = ev.clientX - wRect.left;
          const relY = ev.clientY - wRect.top;

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
          const localPt = clientToMapContainerPoint(ev.clientX, ev.clientY);
          const rect = cont.getBoundingClientRect();
          const ll = map.containerPointToLatLng(
            localPt ?? [ev.clientX - rect.left, ev.clientY - rect.top]
          );
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

      marker.on('click', () => {
        onSelectWaypointRef.current?.(wp);
      });

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

  // Linha guia de deslocamento GPS -> Destino selecionado (Largada da SS ou Parque Serviços/POI)
  useEffect(() => {
    const transitLayer = transitLayerRef.current;
    if (!transitLayer) return;
    transitLayer.clearLayers();
    if (!transitRoute) return;

    const destLatLng: [number, number] = [transitRoute.toLat, transitRoute.toLon];
    const lineColor = transitRoute.color || '#38BDF8';
    const hasRoadPolyline =
      Array.isArray(transitRoute.routeLatLngs) && transitRoute.routeLatLngs.length >= 2;

    if (hasRoadPolyline) {
      const roadPts = transitRoute.routeLatLngs!;
      L.polyline(roadPts, {
        color: '#050608',
        weight: 8.5,
        opacity: 0.84,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(transitLayer);
      L.polyline(roadPts, {
        color: lineColor,
        weight: 4.5,
        opacity: 0.98,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(transitLayer);
    }

    const beaconWrap = document.createElement('div');
    beaconWrap.style.display = 'flex';
    beaconWrap.style.flexDirection = 'column';
    beaconWrap.style.alignItems = 'center';
    beaconWrap.style.transform = 'translate(-50%, -82%)';
    beaconWrap.style.pointerEvents = 'none';

    const ring = document.createElement('div');
    ring.style.width = '20px';
    ring.style.height = '20px';
    ring.style.borderRadius = '9999px';
    ring.style.background = lineColor;
    ring.style.border = '3px solid #FFFFFF';
    ring.style.boxShadow = `0 0 14px ${lineColor}, 0 2px 8px rgba(0,0,0,0.85)`;
    beaconWrap.appendChild(ring);

    if (transitRoute.label) {
      const lbl = document.createElement('span');
      lbl.textContent = transitRoute.label;
      lbl.style.marginTop = '3px';
      lbl.style.background = 'rgba(7, 10, 14, 0.92)';
      lbl.style.border = `1.5px solid ${lineColor}`;
      lbl.style.color = '#FFFFFF';
      lbl.style.fontFamily = 'monospace';
      lbl.style.fontSize = '10px';
      lbl.style.fontWeight = '800';
      lbl.style.padding = '2px 7px';
      lbl.style.borderRadius = '6px';
      lbl.style.whiteSpace = 'nowrap';
      lbl.style.maxWidth = '180px';
      lbl.style.overflow = 'hidden';
      lbl.style.textOverflow = 'ellipsis';
      beaconWrap.appendChild(lbl);
    }

    const beaconIcon = L.divIcon({
      html: beaconWrap,
      className: 'pitstop-transit-dest-divicon',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker(destLatLng, {
      icon: beaconIcon,
      interactive: false,
      zIndexOffset: 980,
    }).addTo(transitLayer);
  }, [transitRoute]);

  // Renderiza marcadores persistentes de Alta Taxa (30/60fps) para V1, V2 e V3
  useEffect(() => {
    const carLayer = carLayerRef.current;
    if (!carLayer) return;

    const useArrowCursor = Boolean(navigationMode && vehicleStyle === 'default');
    const iconPx = useArrowCursor ? 50 : compactCarMarkers ? 12 : 18;
    const anchorPx = useArrowCursor ? 25 : compactCarMarkers ? 6 : 9;

    // Carro 1 (Seta 3D de Navegação estilo Waze/Maps ou ponto de volta)
    if (currentPos) {
      if (
        !primaryMarkerRef.current ||
        primaryMarkerRef.current.variant !== vehicleStyle ||
        primaryMarkerRef.current.compact !== compactCarMarkers ||
        primaryMarkerRef.current.arrowCursor !== useArrowCursor
      ) {
        if (primaryMarkerRef.current) {
          carLayer.removeLayer(primaryMarkerRef.current.marker);
        }
        let el: HTMLDivElement;
        let arrowSvg: SVGSVGElement | undefined;
        if (useArrowCursor) {
          const created = createNavigationArrowCursorElement(navHeadingDeg);
          el = created.el;
          arrowSvg = created.arrowSvg;
        } else {
          el = createVehicleMarkerElement(navHeadingDeg, vehicleStyle, compactCarMarkers);
        }
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [iconPx, iconPx],
          iconAnchor: [anchorPx, anchorPx],
        });
        const marker = L.marker([currentPos.lat, currentPos.lon], {
          icon,
          interactive: false,
          zIndexOffset: 1100,
        }).addTo(carLayer);
        primaryMarkerRef.current = {
          marker,
          el,
          arrowSvg,
          variant: vehicleStyle,
          compact: compactCarMarkers,
          arrowCursor: useArrowCursor,
        };
      } else {
        primaryMarkerRef.current.marker.setLatLng([currentPos.lat, currentPos.lon]);
        if (primaryMarkerRef.current.arrowSvg) {
          primaryMarkerRef.current.arrowSvg.style.transform = `rotate(${navHeadingDeg ?? 0}deg)`;
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

      if (!ghostMarkerRef.current || ghostMarkerRef.current.compact !== compactCarMarkers) {
        if (ghostMarkerRef.current) {
          carLayer.removeLayer(ghostMarkerRef.current.marker);
        }
        const el = createVehicleMarkerElement(ghostCar.headingDeg, 'lap2', compactCarMarkers);
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [iconPx, iconPx],
          iconAnchor: [anchorPx, anchorPx],
        });
        const marker = L.marker([gLat, gLon], {
          icon,
          interactive: false,
          zIndexOffset: 1050,
        }).addTo(carLayer);
        ghostMarkerRef.current = { marker, el, compact: compactCarMarkers };
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

      if (!thirdMarkerRef.current || thirdMarkerRef.current.compact !== compactCarMarkers) {
        if (thirdMarkerRef.current) {
          carLayer.removeLayer(thirdMarkerRef.current.marker);
        }
        const el = createVehicleMarkerElement(thirdCar.headingDeg, 'lap3', compactCarMarkers);
        const icon = L.divIcon({
          html: el,
          className: 'pitstop-car-divicon',
          iconSize: [iconPx, iconPx],
          iconAnchor: [anchorPx, anchorPx],
        });
        const marker = L.marker([tLat, tLon], {
          icon,
          interactive: false,
          zIndexOffset: 1030,
        }).addTo(carLayer);
        thirdMarkerRef.current = { marker, el, compact: compactCarMarkers };
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
    navigationMode,
    vehicleStyle,
    compactCarMarkers,
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
    if (navigationMode || autoFollowCar || userInteracted) return;
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
    autoFollowCar,
    userInteracted,
    currentPos?.lat,
    currentPos?.lon,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!navigationMode && !autoFollowCar) || userInteracted || !currentPos) return;
    const now = Date.now();
    if (now - lastNavEaseRef.current < 160) return;
    lastNavEaseRef.current = now;
    const curZ = map.getZoom();
    const targetZoom = is3dDrivingActive
      ? curZ >= 17.5 && curZ <= 18.5
        ? curZ
        : 18
      : Math.max(curZ, 17);
    map.setView([currentPos.lat, currentPos.lon], targetZoom, {
      animate: true,
    });
  }, [navigationMode, autoFollowCar, userInteracted, currentPos, is3dDrivingActive]);

  // External recenter trigger (snap back to 3D Heading-Up & close driving zoom)
  useEffect(() => {
    if (recenterTrigger <= 0) return;
    setManualRotationDeg(0);
    setUserInteracted(false);
    if (currentPos && mapRef.current) {
      mapRef.current.setView([currentPos.lat, currentPos.lon], driving3dMode ? 18 : 17.5, {
        animate: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterTrigger]);

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

  const handleRecenterAndNorth = () => {
    setManualRotationDeg(0);
    setUserInteracted(false);
    if ((navigationMode || autoFollowCar) && currentPos && mapRef.current) {
      mapRef.current.setView([currentPos.lat, currentPos.lon], Math.max(mapRef.current.getZoom(), 17), {
        animate: true,
      });
      return;
    }
    if (
      editableTrace.length > 0 ||
      (multiTraces && multiTraces.length > 0) ||
      (waypoints && waypoints.length > 0) ||
      orderedTraps.length > 0
    ) {
      fitMapToTrackOrCenter(true);
    } else {
      void centerOnMyPosition();
    }
  };

  const handlePlaceAtCrosshair = () => {
    const map = mapRef.current;
    if (!map || !onMapClickPlaceTrap) return;
    const c = map.getCenter();
    onMapClickPlaceTrap(c.lat, c.lng);
  };

  const isRotated = Math.abs(totalRotationDeg) > 0.05 || is3dDrivingActive;
  const rotatedSquareSide =
    isRotated && wrapperSize.w > 0 && wrapperSize.h > 0
      ? is3dDrivingActive
        ? Math.min(2600, Math.ceil(Math.max(wrapperSize.w, wrapperSize.h) * 2.9))
        : Math.ceil(Math.hypot(wrapperSize.w, wrapperSize.h)) + 16
      : 0;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const raf = window.requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isRotated, rotatedSquareSide, is3dDrivingActive]);

  const perspectivePx = Math.max(820, Math.round((wrapperSize.h || 760) * 0.96));

  return (
    <div
      ref={outerWrapperRef}
      style={
        is3dDrivingActive
          ? {
              perspective: `${perspectivePx}px`,
              perspectiveOrigin: '50% 68%',
            }
          : undefined
      }
      className={`${
        effectiveFullscreen
          ? 'fixed inset-0 z-[9995] h-[100dvh] w-screen overflow-hidden bg-[var(--ps-bg)]'
          : containerClassName
      } ${drivingTheme === 'dark' ? 'pitstop-leaflet-dark-tiles' : ''}`}
    >
      <div
        ref={containerRef}
        className="will-change-transform"
        style={
          is3dDrivingActive && rotatedSquareSide > 0
            ? {
                position: 'absolute',
                left: '50%',
                top: '68%',
                width: `${rotatedSquareSide}px`,
                height: `${rotatedSquareSide}px`,
                transform: `translate(-50%, -50%) rotateX(58deg) rotate(${totalRotationDeg}deg)`,
                transition: 'transform 260ms ease-out',
              }
            : isRotated && rotatedSquareSide > 0
              ? {
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: `${rotatedSquareSide}px`,
                  height: `${rotatedSquareSide}px`,
                  transform: `translate(-50%, -50%) rotate(${totalRotationDeg}deg)`,
                  transition: userInteracted ? 'none' : 'transform 220ms ease-out',
                }
              : {
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  transform: isRotated ? `rotate(${totalRotationDeg}deg)` : undefined,
                }
        }
      />

      {/* Horizonte atmosférico sutil no topo quando em perspectiva 3D de direção */}
      {is3dDrivingActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[390] h-36 bg-gradient-to-b from-[#07111E] via-[#07111E]/75 to-transparent"
        />
      )}

      {/* Botão flutuante discreto Centralizar / Norte quando usuário move ou rotaciona o mapa manualmente */}
      {!(hideBuiltInTopControls && driving3dMode) &&
        (userInteracted || Math.abs(manualRotationDeg) > 1) && (
          <button
            type="button"
            onClick={handleRecenterAndNorth}
            className={`absolute left-2.5 z-[415] inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 px-2.5 text-[11px] font-extrabold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)] active:scale-95 ${
              effectiveFullscreen && fullscreenOverlay
                ? 'bottom-[calc(94px+env(safe-area-inset-bottom,0px))] sm:bottom-[calc(98px+env(safe-area-inset-bottom,0px))]'
                : effectiveFullscreen
                  ? 'bottom-[max(0.75rem,env(safe-area-inset-bottom))]'
                  : 'bottom-2.5'
            }`}
            title="Voltar para o Norte (0°) e centralizar mapa"
          >
            <Compass
              className="h-3.5 w-3.5 text-[var(--ps-accent)] transition-transform"
              style={{ transform: `rotate(${totalRotationDeg}deg)` }}
            />
            <span>Centralizar / Norte</span>
          </button>
        )}

      {/* BARRA SUPERIOR ÚNICA EM TELA CHEIA (sem duplicação ou colisão) */}
      {effectiveFullscreen && !externalFs && !hideBuiltInTopControls ? (
        <div className="pointer-events-none absolute top-0 inset-x-0 z-[410] flex flex-col gap-1.5 px-2.5 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
              {navigationMode && (
                <button
                  type="button"
                  onClick={() => {
                    if (onToggleHeadingUp) onToggleHeadingUp();
                    else setInternalHeadingUp((v) => !v);
                  }}
                  className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-extrabold shadow-lg backdrop-blur-xs ${
                    effectiveHeadingUp
                      ? 'border-[var(--ps-accent)] bg-[var(--ps-surface)]/95 text-[var(--ps-text)]'
                      : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/90 text-[var(--ps-muted)]'
                  }`}
                  title="Alternar entre seguir sentido do veículo (Heading-Up) ou Norte Fixo"
                >
                  <Compass
                    className={`h-3.5 w-3.5 ${effectiveHeadingUp ? 'text-[var(--ps-accent)]' : 'text-sky-400'}`}
                  />
                  <span>{effectiveHeadingUp ? 'Heading-Up' : 'Norte'}</span>
                </button>
              )}

              {(editableTrace.length > 0 ||
                (multiTraces && multiTraces.length > 0) ||
                (waypoints && waypoints.length > 0) ||
                orderedTraps.length > 0) && (
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
                title="Centralizar na minha posição GPS atual"
              >
                <Navigation className="h-3 w-3 text-[var(--ps-emerald)]" />
                <span>GPS</span>
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
            </div>

            <button
              type="button"
              onClick={() => {
                if (onFullscreenToggle) {
                  onFullscreenToggle();
                } else {
                  setIsFullscreen(false);
                }
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/95 px-2.5 text-[11px] font-extrabold text-[var(--ps-text)] shadow-lg backdrop-blur-xs hover:border-[var(--ps-accent)]"
              aria-label="Sair da tela cheia"
            >
              <Minimize2 className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Sair Tela Cheia</span>
            </button>
          </div>

          {!navigationMode && topLeftOverlay && (
            <div className="pointer-events-none">{topLeftOverlay}</div>
          )}

          {fullscreenTopOverlay && (
            <div className="pointer-events-auto">{fullscreenTopOverlay}</div>
          )}
        </div>
      ) : (
        <>
          {/* Live Heading-Up vs Norte Fixo mode toggle when navigationMode is enabled */}
          {navigationMode && !hideBuiltInTopControls && (
            <button
              type="button"
              onClick={() => {
                if (onToggleHeadingUp) onToggleHeadingUp();
                else setInternalHeadingUp((v) => !v);
              }}
              className={`absolute left-2.5 z-[400] inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-extrabold shadow-lg backdrop-blur-xs ${
                externalFs ? 'top-[max(0.5rem,env(safe-area-inset-top))]' : 'top-2.5'
              } ${
                effectiveHeadingUp
                  ? 'border-[var(--ps-accent)] bg-[var(--ps-surface)]/95 text-[var(--ps-text)]'
                  : 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/90 text-[var(--ps-muted)]'
              }`}
              title="Alternar entre seguir sentido do veículo (Heading-Up) ou Norte Fixo"
            >
              <Compass
                className={`h-3.5 w-3.5 ${effectiveHeadingUp ? 'text-[var(--ps-accent)]' : 'text-sky-400'}`}
              />
              <span>{effectiveHeadingUp ? 'Heading-Up' : 'Norte Fixo'}</span>
            </button>
          )}

          {/* Legenda / Overlay superior esquerdo customizável */}
          {!navigationMode && topLeftOverlay && (
            <div
              className={
                externalFs
                  ? 'pointer-events-none absolute top-[max(0.5rem,env(safe-area-inset-top))] left-2.5 right-[136px] z-[405]'
                  : 'pointer-events-none absolute top-2.5 left-2.5 z-[405] max-w-[65%]'
              }
            >
              {topLeftOverlay}
            </div>
          )}

          {/* Controles superiores direitos */}
          {hideBuiltInTopControls ? null : externalFs ? (
            onFullscreenToggle ? (
              <div className="absolute top-[max(0.5rem,env(safe-area-inset-top))] right-2.5 z-[410]">
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

          {/* Micro-Overlay superior exclusivo quando externalFs ou hideBuiltInTopControls está ativo */}
          {effectiveFullscreen && fullscreenTopOverlay && (
            <div
              className={`pointer-events-none absolute left-2.5 right-2.5 z-[410] ${
                hideBuiltInTopControls
                  ? 'top-[max(0.5rem,env(safe-area-inset-top))]'
                  : 'top-[calc(max(0.5rem,env(safe-area-inset-top))+2.5rem)]'
              }`}
            >
              <div className="pointer-events-auto">{fullscreenTopOverlay}</div>
            </div>
          )}
        </>
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

      {/* Controles de Zoom + / - estilo RaceChrono (ocultos na condução 3D limpa estilo Waze) */}
      {!(hideBuiltInTopControls && driving3dMode) && (
        <div
          className={`absolute right-2.5 z-[400] flex flex-col overflow-hidden rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)]/92 shadow-lg backdrop-blur-xs ${
            effectiveFullscreen && fullscreenZoomBottomClass
              ? fullscreenZoomBottomClass
              : effectiveFullscreen
                ? 'bottom-[max(3.5rem,calc(env(safe-area-inset-bottom,0px)+3rem))]'
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
      )}

      {/* Botão Marcar na Mira quando em modo de marcação */}
      {placementKind && onMapClickPlaceTrap && (
        <button
          type="button"
          onClick={handlePlaceAtCrosshair}
          className={`pitstop-btn-red absolute z-[410] inline-flex min-h-[40px] items-center gap-1.5 rounded-full px-3.5 text-xs font-extrabold shadow-xl active:scale-95 ${
            effectiveFullscreen && fullscreenOverlay
              ? 'top-[calc(max(0.5rem,env(safe-area-inset-top))+2.75rem)] left-2.5'
              : 'bottom-3 left-3'
          }`}
        >
          <Plus className="h-4 w-4" />
          <span>Marcar na Mira</span>
        </button>
      )}

      {/* Barra flutuante de criação/edição de Marcos ou HUD exclusiva do modo Tela Cheia */}
      {effectiveFullscreen && fullscreenOverlay && (
        <div
          className={`pointer-events-none absolute inset-x-2.5 bottom-[max(0.625rem,env(safe-area-inset-bottom))] z-[410] flex justify-center ${
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
});
