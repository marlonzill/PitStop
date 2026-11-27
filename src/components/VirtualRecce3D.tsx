import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Camera,
  Car,
  Check,
  Copy,
  Flag,
  Maximize2,
  Minimize2,
  Mountain,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import type { GeoWaypoint } from '../utils/geoKmlParser';
import {
  computeTrackSlopePctAtRatio,
  fetchTrackRealElevations,
  type ElevationSourceKind,
} from '../utils/elevationService';
import { bearingBetweenDeg, type VelocitySample, type VelocityTrack } from '../utils/velocityEngine';
import {
  buildElevationProfile,
  buildPacenoteLabel,
  formatPacenotesWhatsApp,
  generatePacenotesFromTrace,
  getSampleAltitudeM,
  recalculatePacenoteDistances,
  type PacenoteDirection,
  type PacenoteEntry,
  type PacenoteGrade,
} from '../utils/pacenoteGenerator';
import {
  cancelPacenoteSpeech,
  speakPacenotePtBr,
  startEngineAudio,
  stopEngineAudio,
  updateEngineTelemetry,
} from '../utils/virtualRecceAudio';

// Web Mercator satellite tile helpers + persistent memory texture cache
const satelliteTileTexCache = new Map<string, THREE.Texture>();
const MAX_CACHED_SAT_TILES = 96;
let sharedFallbackTileTexture: THREE.CanvasTexture | null = null;

function getFallbackTerrainTileTexture(): THREE.CanvasTexture {
  if (sharedFallbackTileTexture) return sharedFallbackTileTexture;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#141B18';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 256; g += 32) {
      ctx.beginPath();
      ctx.moveTo(g, 0);
      ctx.lineTo(g, 256);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, g);
      ctx.lineTo(256, g);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedFallbackTileTexture = tex;
  return tex;
}

function lon2tileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

function tile2lon(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tile2lat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function loadArcGisSatelliteTileTexture(
  z: number,
  x: number,
  y: number,
  onLoaded?: (tex: THREE.Texture) => void
): THREE.Texture {
  const maxIdx = Math.pow(2, z);
  const wrappedX = ((x % maxIdx) + maxIdx) % maxIdx;
  const clampedY = Math.max(0, Math.min(maxIdx - 1, y));
  const key = `${z}/${clampedY}/${wrappedX}`;
  const existing = satelliteTileTexCache.get(key);
  if (existing) {
    if (onLoaded) onLoaded(existing);
    return existing;
  }

  const fallback = getFallbackTerrainTileTexture();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return fallback;
  }

  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${clampedY}/${wrappedX}`;
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      if (satelliteTileTexCache.size >= MAX_CACHED_SAT_TILES) {
        const oldestKey = satelliteTileTexCache.keys().next().value;
        if (oldestKey) {
          const oldTex = satelliteTileTexCache.get(oldestKey);
          satelliteTileTexCache.delete(oldestKey);
          oldTex?.dispose();
        }
      }
      satelliteTileTexCache.set(key, tex);
      onLoaded?.(tex);
    },
    undefined,
    () => {
      // Offline / network fallback silently uses grid texture
    }
  );
  return fallback;
}

export type RecceCarId = 'palio46' | 'evo9' | 'impreza' | 'yaris';
export type RecceCameraMode = 'heli' | 'chase' | 'hood' | 'free';

interface RecceCarSpec {
  id: RecceCarId;
  name: string;
  shortName: string;
  subtitle: string;
  primaryHex: string;
  accentHex: string;
  wheelHex: string;
}

const RECCE_CARS: RecceCarSpec[] = [
  {
    id: 'palio46',
    name: 'Fiat Palio #46 (Anderson Graeff / Márlon Zill)',
    shortName: 'Palio #46',
    subtitle: 'Graeff / Zill · N2',
    primaryHex: '#E10600',
    accentHex: '#FFFFFF',
    wheelHex: '#E5E7EB',
  },
  {
    id: 'evo9',
    name: 'Mitsubishi Lancer Evo IX',
    shortName: 'Lancer Evo IX',
    subtitle: '4x4 Turbo · Ralliart',
    primaryHex: '#DC2626',
    accentHex: '#18181B',
    wheelHex: '#27272A',
  },
  {
    id: 'impreza',
    name: 'Subaru Impreza WRC',
    shortName: 'Impreza WRC',
    subtitle: 'Azul WRC · Dourado',
    primaryHex: '#1D4ED8',
    accentHex: '#FACC15',
    wheelHex: '#EAB308',
  },
  {
    id: 'yaris',
    name: 'Toyota GR Yaris Rally1',
    shortName: 'GR Yaris Rally1',
    subtitle: 'Gazoo Racing Hybrid',
    primaryHex: '#F4F4F5',
    accentHex: '#EF233C',
    wheelHex: '#18181B',
  },
];

const CAMERA_MODES: Array<{ id: RecceCameraMode; label: string }> = [
  { id: 'heli', label: 'Helicóptero' },
  { id: 'chase', label: 'Perseguição' },
  { id: 'hood', label: 'Capô' },
  { id: 'free', label: 'Livre 3D' },
];

interface VirtualPoint3D {
  x: number;
  y: number;
  z: number;
  lat: number;
  lon: number;
  distKm: number;
  altitudeM: number;
  headingRad: number;
  grade: PacenoteGrade;
}

function getGradeBadgeClasses(grade: PacenoteGrade | 'R'): string {
  if (grade === 'R') return 'bg-zinc-800 text-zinc-200 border-zinc-600';
  if (grade <= 2) return 'bg-[#EF233C] text-white border-red-300/60';
  if (grade === 3) return 'bg-amber-500 text-zinc-950 border-amber-300/70';
  if (grade === 4) return 'bg-lime-500 text-zinc-950 border-lime-300/70';
  return 'bg-emerald-500 text-zinc-950 border-emerald-300/70';
}

function getGradeThreeColor(grade: PacenoteGrade): THREE.Color {
  if (grade <= 2) return new THREE.Color('#EF233C');
  if (grade === 3) return new THREE.Color('#F59E0B');
  if (grade === 4) return new THREE.Color('#84CC16');
  return new THREE.Color('#10B981');
}

function createProceduralCarCanvasTexture(
  kind: 'hood' | 'side' | 'roof',
  car: RecceCarSpec
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (car.id === 'palio46') {
      ctx.fillStyle = '#D90429';
      ctx.fillRect(0, 0, 512, 256);

      // Diagonal white & black rally stripes
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(0, 175);
      ctx.lineTo(512, 75);
      ctx.lineTo(512, 130);
      ctx.lineTo(0, 225);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#111113';
      ctx.beginPath();
      ctx.moveTo(0, 220);
      ctx.lineTo(512, 128);
      ctx.lineTo(512, 152);
      ctx.lineTo(0, 245);
      ctx.closePath();
      ctx.fill();

      if (kind === 'side' || kind === 'roof' || kind === 'hood') {
        // White number plate + #46
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(182, 42, 148, 128);
        ctx.strokeStyle = '#111113';
        ctx.lineWidth = 8;
        ctx.strokeRect(182, 42, 148, 128);

        ctx.fillStyle = '#111113';
        ctx.font = '900 84px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('46', 256, 108);

        if (kind === 'side') {
          ctx.fillStyle = '#111113';
          ctx.fillRect(18, 12, 476, 26);
          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 17px sans-serif';
          ctx.fillText('A. GRAEFF  /  M. ZILL', 256, 26);
        } else if (kind === 'hood') {
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '900 22px sans-serif';
          ctx.fillText('PITSTOP RALLY', 256, 206);
        }
      }
    } else if (car.id === 'evo9') {
      ctx.fillStyle = '#B91C1C';
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = '#18181B';
      ctx.beginPath();
      ctx.moveTo(0, 180);
      ctx.lineTo(512, 60);
      ctx.lineTo(512, 256);
      ctx.lineTo(0, 256);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#F4F4F5';
      ctx.font = '900 54px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('EVO IX', 256, 118);
    } else if (car.id === 'impreza') {
      ctx.fillStyle = '#1D4ED8';
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = '#FACC15';
      ctx.fillRect(0, 148, 512, 26);
      ctx.fillStyle = '#FACC15';
      ctx.font = '900 66px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('555', 256, 112);
    } else {
      // Toyota GR Yaris Rally1
      ctx.fillStyle = '#F4F4F5';
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = '#EF233C';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(290, 0);
      ctx.lineTo(150, 256);
      ctx.lineTo(0, 256);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111113';
      ctx.beginPath();
      ctx.moveTo(290, 0);
      ctx.lineTo(395, 0);
      ctx.lineTo(255, 256);
      ctx.lineTo(150, 256);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '900 56px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GR', 136, 128);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildCompositeRallyCar(
  carSpec: RecceCarSpec,
  disposables: Array<{ dispose: () => void }>
): { group: THREE.Group; wheels: THREE.Mesh[]; frontWheelPivots: THREE.Group[] } {
  const group = new THREE.Group();
  const wheels: THREE.Mesh[] = [];
  const frontWheelPivots: THREE.Group[] = [];

  const hoodTex = createProceduralCarCanvasTexture('hood', carSpec);
  const sideTex = createProceduralCarCanvasTexture('side', carSpec);
  const roofTex = createProceduralCarCanvasTexture('roof', carSpec);
  disposables.push(hoodTex, sideTex, roofTex);

  const primaryMat = new THREE.MeshStandardMaterial({
    color: carSpec.primaryHex,
    roughness: 0.34,
    metalness: 0.25,
  });
  const sideMat = new THREE.MeshStandardMaterial({
    map: sideTex,
    roughness: 0.32,
    metalness: 0.2,
  });
  const hoodMat = new THREE.MeshStandardMaterial({
    map: hoodTex,
    roughness: 0.32,
    metalness: 0.2,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    map: roofTex,
    roughness: 0.35,
    metalness: 0.18,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: '#0F172A',
    roughness: 0.12,
    metalness: 0.8,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: '#18181B',
    roughness: 0.72,
    metalness: 0.12,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: carSpec.accentHex,
    roughness: 0.38,
    metalness: 0.2,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: '#141416',
    roughness: 0.85,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: carSpec.wheelHex,
    roughness: 0.3,
    metalness: 0.75,
  });
  const headlightMat = new THREE.MeshStandardMaterial({
    color: '#FEF9C3',
    emissive: '#FEF08A',
    emissiveIntensity: 0.8,
  });
  const taillightMat = new THREE.MeshStandardMaterial({
    color: '#EF233C',
    emissive: '#DC2626',
    emissiveIntensity: 0.9,
  });
  disposables.push(
    primaryMat,
    sideMat,
    hoodMat,
    roofMat,
    glassMat,
    trimMat,
    accentMat,
    tireMat,
    rimMat,
    headlightMat,
    taillightMat
  );

  // Dimensions tuned cleanly: width X ~ 2.0m, height Y ~ 1.65m, length Z ~ 4.2m (forward = +Z)
  const isHatch = carSpec.id === 'palio46' || carSpec.id === 'yaris';
  const bodyLen = isHatch ? 4.0 : 4.45;

  const chassisGeo = new THREE.BoxGeometry(2.05, 0.72, bodyLen);
  const chassisMats = [sideMat, sideMat, hoodMat, trimMat, primaryMat, primaryMat];
  const chassis = new THREE.Mesh(chassisGeo, chassisMats);
  chassis.position.set(0, 0.66, 0);
  chassis.castShadow = true;
  group.add(chassis);
  disposables.push(chassisGeo);

  // Cabin
  const cabinLen = isHatch ? 2.25 : 1.95;
  const cabinZ = isHatch ? -0.38 : -0.18;
  const cabinGeo = new THREE.BoxGeometry(1.72, 0.64, cabinLen);
  const cabin = new THREE.Mesh(cabinGeo, [
    glassMat,
    glassMat,
    roofMat,
    trimMat,
    glassMat,
    glassMat,
  ]);
  cabin.position.set(0, 1.32, cabinZ);
  cabin.castShadow = true;
  group.add(cabin);
  disposables.push(cabinGeo);

  // Roof Air Scoop (signature on Palio #46 & rally cars)
  const scoopGeo = new THREE.BoxGeometry(0.38, 0.14, 0.56);
  const scoop = new THREE.Mesh(scoopGeo, carSpec.id === 'palio46' ? accentMat : trimMat);
  scoop.position.set(0, 1.71, cabinZ + 0.35);
  group.add(scoop);
  disposables.push(scoopGeo);

  // Rally Mudflaps (4 corners)
  const flapGeo = new THREE.BoxGeometry(0.32, 0.3, 0.05);
  const flapPositions: Array<[number, number]> = [
    [-0.86, -bodyLen * 0.36 - 0.32],
    [0.86, -bodyLen * 0.36 - 0.32],
    [-0.86, bodyLen * 0.3 - 0.32],
    [0.86, bodyLen * 0.3 - 0.32],
  ];
  for (const [fx, fz] of flapPositions) {
    const flap = new THREE.Mesh(flapGeo, carSpec.id === 'palio46' ? trimMat : accentMat);
    flap.position.set(fx, 0.24, fz);
    group.add(flap);
  }
  disposables.push(flapGeo);

  // Rear Spoiler / Rally Wing
  if (carSpec.id === 'evo9' || carSpec.id === 'impreza' || carSpec.id === 'yaris') {
    const wingBladeGeo = new THREE.BoxGeometry(1.88, 0.08, 0.36);
    const wingStrutGeo = new THREE.BoxGeometry(0.08, 0.38, 0.22);
    const wingY = isHatch ? 1.72 : 1.36;
    const wingZ = -bodyLen * 0.46;
    const wingBlade = new THREE.Mesh(wingBladeGeo, accentMat);
    wingBlade.position.set(0, wingY, wingZ);
    group.add(wingBlade);
    for (const sx of [-0.62, 0.62]) {
      const strut = new THREE.Mesh(wingStrutGeo, trimMat);
      strut.position.set(sx, wingY - 0.18, wingZ);
      group.add(strut);
    }
    disposables.push(wingBladeGeo, wingStrutGeo);
  } else {
    // Palio #46 rally roof-lip spoiler
    const lipGeo = new THREE.BoxGeometry(1.66, 0.1, 0.28);
    const lip = new THREE.Mesh(lipGeo, trimMat);
    lip.position.set(0, 1.66, -bodyLen * 0.45);
    group.add(lip);
    disposables.push(lipGeo);
  }

  // Headlights & Taillights
  const lightGeo = new THREE.BoxGeometry(0.38, 0.16, 0.08);
  for (const lx of [-0.68, 0.68]) {
    const hl = new THREE.Mesh(lightGeo, headlightMat);
    hl.position.set(lx, 0.7, bodyLen * 0.5 + 0.02);
    group.add(hl);

    const tl = new THREE.Mesh(lightGeo, taillightMat);
    tl.position.set(lx, 0.74, -bodyLen * 0.5 - 0.02);
    group.add(tl);
  }
  disposables.push(lightGeo);

  // 4 Rally Wheels + Rims
  const tireGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 18);
  tireGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.34, 10);
  rimGeo.rotateZ(Math.PI / 2);
  disposables.push(tireGeo, rimGeo);

  const wheelCoords: Array<{ x: number; z: number; front: boolean }> = [
    { x: -1.02, z: bodyLen * 0.32, front: true },
    { x: 1.02, z: bodyLen * 0.32, front: true },
    { x: -1.02, z: -bodyLen * 0.33, front: false },
    { x: 1.02, z: -bodyLen * 0.33, front: false },
  ];

  for (const wc of wheelCoords) {
    const wheelMesh = new THREE.Mesh(tireGeo, tireMat);
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    wheelMesh.add(rimMesh);
    wheels.push(wheelMesh);

    if (wc.front) {
      const pivot = new THREE.Group();
      pivot.position.set(wc.x, 0.42, wc.z);
      pivot.add(wheelMesh);
      group.add(pivot);
      frontWheelPivots.push(pivot);
    } else {
      wheelMesh.position.set(wc.x, 0.42, wc.z);
      group.add(wheelMesh);
    }
  }

  return { group, wheels, frontWheelPivots };
}

interface VirtualRecce3DProps {
  track: VelocityTrack | null;
  availableTracks: VelocityTrack[];
  onSelectTrackId?: (trackId: string) => void;
  waypoints?: GeoWaypoint[];
}

export const VirtualRecce3D: React.FC<VirtualRecce3DProps> = ({
  track,
  availableTracks,
  onSelectTrackId,
  waypoints = [],
}) => {
  const [selectedCarId, setSelectedCarId] = useState<RecceCarId>('palio46');
  const [cameraMode, setCameraMode] = useState<RecceCameraMode>('chase');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [simSpeedMult, setSimSpeedMult] = useState<0.5 | 1 | 1.5 | 2>(1);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [engineEnabled, setEngineEnabled] = useState(false);
  const [progressRatio, setProgressRatio] = useState(0);
  const [noteFilter, setNoteFilter] = useState<'all' | 'critical' | 'straights' | 'manual'>('all');
  const [manualNotesByTrack, setManualNotesByTrack] = useState<Record<string, PacenoteEntry[]>>({});
  const [removedIdsByTrack, setRemovedIdsByTrack] = useState<Record<string, string[]>>({});
  const [showAddNoteDrawer, setShowAddNoteDrawer] = useState(false);
  const [draftNoteDir, setDraftNoteDir] = useState<PacenoteDirection>('D');
  const [draftNoteGrade, setDraftNoteGrade] = useState<PacenoteGrade>(2);
  const [draftNoteLong, setDraftNoteLong] = useState(false);
  const [draftNoteTightens, setDraftNoteTightens] = useState(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState(false);
  const [elevatedSamples, setElevatedSamples] = useState<VelocitySample[]>([]);
  const [elevationSource, setElevationSource] = useState<ElevationSourceKind>('synthetic');

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const simSpeedMultRef = useRef(simSpeedMult);
  simSpeedMultRef.current = simSpeedMult;
  const cameraModeRef = useRef<RecceCameraMode>(cameraMode);
  cameraModeRef.current = cameraMode;
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;
  const engineEnabledRef = useRef(engineEnabled);
  engineEnabledRef.current = engineEnabled;
  const lastAnnouncedNoteIdRef = useRef<string>('');
  const setProgressThrottleRef = useRef(0);

  const activeTrack = track ?? availableTracks[0] ?? null;

  const rawBaseSamples: VelocitySample[] = useMemo(() => {
    if (!activeTrack) return [];
    if (activeTrack.baseTrace && activeTrack.baseTrace.length >= 2) {
      return activeTrack.baseTrace;
    }
    if (activeTrack.traps.length >= 2) {
      let accKm = 0;
      return activeTrack.traps.map((t, idx) => {
        if (idx > 0) {
          const prev = activeTrack.traps[idx - 1];
          const dLat = (t.lat - prev.lat) * 111.32;
          const dLon = (t.lon - prev.lon) * 111.32 * Math.cos((prev.lat * Math.PI) / 180);
          accKm += Math.hypot(dLat, dLon);
        }
        return {
          lat: t.lat,
          lon: t.lon,
          speedKmh: 0,
          accuracyM: 5,
          headingDeg: t.bearingDeg,
          altitudeM: null,
          timestampMs: activeTrack.createdAtMs + idx * 1000,
          distKm: accKm,
          stageElapsedMs: idx * 1000,
        };
      });
    }
    return [];
  }, [activeTrack]);

  // Fetch real terrain elevations from Open-Meteo (with localStorage cache for offline use)
  useEffect(() => {
    setElevatedSamples(rawBaseSamples);
    setElevationSource('synthetic');
    if (!activeTrack || rawBaseSamples.length < 2) return;
    const ctrl = new AbortController();
    fetchTrackRealElevations(activeTrack.id, rawBaseSamples, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted) {
          setElevatedSamples(res.samples);
          setElevationSource(res.source);
        }
      })
      .catch(() => {
        // Keep rawBaseSamples fallback
      });
    return () => ctrl.abort();
  }, [activeTrack?.id, rawBaseSamples]);

  const baseSamples = elevatedSamples.length >= 2 ? elevatedSamples : rawBaseSamples;

  // Auto + manual merged pacenotes
  const autoNotes = useMemo(() => generatePacenotesFromTrace(baseSamples), [baseSamples]);
  const mergedNotes: PacenoteEntry[] = useMemo(() => {
    const tid = activeTrack?.id ?? 'default';
    const removedSet = new Set(removedIdsByTrack[tid] ?? []);
    const manualList = manualNotesByTrack[tid] ?? [];
    const totalDistM =
      baseSamples.length > 0 ? baseSamples[baseSamples.length - 1].distKm * 1000 : 0;
    const combined = [...autoNotes.filter((n) => !removedSet.has(n.id)), ...manualList];
    return recalculatePacenoteDistances(combined, totalDistM);
  }, [activeTrack?.id, autoNotes, manualNotesByTrack, removedIdsByTrack, baseSamples]);

  const elevationProfile = useMemo(() => buildElevationProfile(baseSamples), [baseSamples]);

  // Local 3D ENU conversion (meters around stage center)
  const sceneCourse = useMemo(() => {
    if (baseSamples.length < 2) {
      return {
        points: [] as VirtualPoint3D[],
        totalDistKm: 0,
        minAlt: 600,
        maxAlt: 650,
        originLat: 0,
        originLon: 0,
        cosLat: 1,
      };
    }

    let sumLat = 0;
    let sumLon = 0;
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    for (const s of baseSamples) {
      sumLat += s.lat;
      sumLon += s.lon;
      const alt = getSampleAltitudeM(s, s.distKm);
      if (alt < minAlt) minAlt = alt;
      if (alt > maxAlt) maxAlt = alt;
    }
    const originLat = sumLat / baseSamples.length;
    const originLon = sumLon / baseSamples.length;
    const cosLat = Math.cos((originLat * Math.PI) / 180);

    // Map each sample to nearest pacenote grade for coloring the 3D ribbon
    const points: VirtualPoint3D[] = baseSamples.map((s, idx) => {
      const x = (s.lon - originLon) * 111320 * cosLat;
      const z = -(s.lat - originLat) * 110540;
      const altitudeM = getSampleAltitudeM(s, s.distKm);
      const y = (altitudeM - minAlt) * 1.15 + 0.35;

      const prev = baseSamples[Math.max(0, idx - 1)];
      const next = baseSamples[Math.min(baseSamples.length - 1, idx + 1)];
      const headingDeg = bearingBetweenDeg(prev.lat, prev.lon, next.lat, next.lon);
      // Convert compass deg (0=N, 90=E) to Three.js rotation around +Y where car faces +Z
      // +X is East, -Z is North => direction vector = (sin(hdg), 0, -cos(hdg))
      const hdgRad = (headingDeg * Math.PI) / 180;

      let grade: PacenoteGrade = 6;
      for (const n of mergedNotes) {
        if (Math.abs(n.distKm - s.distKm) <= 0.045) {
          grade = Math.min(grade, n.grade) as PacenoteGrade;
        }
      }

      return {
        x,
        y,
        z,
        lat: s.lat,
        lon: s.lon,
        distKm: s.distKm,
        altitudeM,
        headingRad: Math.atan2(Math.sin(hdgRad), -Math.cos(hdgRad)),
        grade,
      };
    });

    return {
      points,
      totalDistKm: baseSamples[baseSamples.length - 1].distKm,
      minAlt,
      maxAlt,
      originLat,
      originLon,
      cosLat,
    };
  }, [baseSamples, mergedNotes]);

  const activeCarSpec = useMemo(
    () => RECCE_CARS.find((c) => c.id === selectedCarId) ?? RECCE_CARS[0],
    [selectedCarId]
  );

  // Reset playhead when track switches
  useEffect(() => {
    progressRef.current = 0;
    setProgressRatio(0);
    setIsPlaying(false);
    lastAnnouncedNoteIdRef.current = '';
  }, [activeTrack?.id]);

  // Engine Web Audio lifecycle
  useEffect(() => {
    if (engineEnabled) {
      startEngineAudio();
    } else {
      stopEngineAudio();
    }
    return () => {
      stopEngineAudio();
    };
  }, [engineEnabled]);

  useEffect(() => {
    return () => {
      cancelPacenoteSpeech();
      stopEngineAudio();
    };
  }, []);

  // Derive current telemetry from progressRatio
  const currentDistKm = progressRatio * sceneCourse.totalDistKm;
  const currentDistM = Math.round(currentDistKm * 1000);
  const currentSlopePct = useMemo(
    () => computeTrackSlopePctAtRatio(sceneCourse.points, progressRatio),
    [sceneCourse.points, progressRatio]
  );

  const upcomingNotes = useMemo(() => {
    const ahead = mergedNotes.filter((n) => n.distKm >= currentDistKm - 0.012);
    return {
      next: ahead[0] ?? null,
      after: ahead[1] ?? null,
    };
  }, [mergedNotes, currentDistKm]);

  const currentVirtualSpeedKmh = useMemo(() => {
    const n = upcomingNotes.next;
    const distToTurnM = n ? Math.max(0, n.distM - currentDistM) : 999;
    let targetKmh = 118;
    if (n && distToTurnM < 95) {
      const speedByGrade: Record<PacenoteGrade, number> = {
        1: 36,
        2: 52,
        3: 68,
        4: 86,
        5: 102,
        6: 118,
      };
      targetKmh = speedByGrade[n.grade];
    }
    return Math.round(targetKmh * (simSpeedMult >= 1.5 ? 1.12 : 1));
  }, [upcomingNotes.next, currentDistM, simSpeedMult]);

  useEffect(() => {
    if (engineEnabled) {
      updateEngineTelemetry(currentVirtualSpeedKmh, isPlaying);
    }
  }, [engineEnabled, currentVirtualSpeedKmh, isPlaying]);

  // Speak upcoming pacenote when car gets within ~85m
  useEffect(() => {
    if (!isPlaying || !voiceEnabled || !upcomingNotes.next) return;
    const n = upcomingNotes.next;
    const distToNoteM = n.distM - currentDistM;
    if (distToNoteM <= 85 && distToNoteM >= -10 && lastAnnouncedNoteIdRef.current !== n.id) {
      lastAnnouncedNoteIdRef.current = n.id;
      speakPacenotePtBr(n.label);
    }
  }, [isPlaying, voiceEnabled, upcomingNotes.next, currentDistM]);

  // Main Three.js Scene & Animation Effect
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || sceneCourse.points.length < 2) return;

    let disposed = false;
    const disposables: Array<{ dispose: () => void }> = [];
    const width = Math.max(300, host.clientWidth);
    const height = Math.max(280, host.clientHeight);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0B1018');
    scene.fog = new THREE.FogExp2('#0B1018', 0.00028);

    const camera = new THREE.PerspectiveCamera(54, width / height, 0.5, 12000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.innerHTML = '';
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 8;
    controls.maxDistance = 1800;

    // Lighting (Natural Daylight + Rally Sun over Satellite Terrain)
    const hemiLight = new THREE.HemisphereLight('#E0F2FE', '#334155', 1.35);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight('#FFFBEB', 1.45);
    sunLight.position.set(240, 380, 180);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    scene.add(sunLight);

    // 1. Real Satellite Tile 3D Terrain (ArcGIS World_Imagery draped over real elevation relief)
    const sampleStep = Math.max(1, Math.floor(sceneCourse.points.length / 180));
    const sampledPts = sceneCourse.points.filter((_, idx) => idx % sampleStep === 0);

    const sampleTerrainY = (vx: number, vz: number): number => {
      let nearestY = 0.35;
      let nearestDistSq = Infinity;
      for (let j = 0; j < sampledPts.length; j += 1) {
        const sp = sampledPts[j];
        const dx = vx - sp.x;
        const dz = vz - sp.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearestY = sp.y;
        }
      }
      const distM = Math.sqrt(nearestDistSq);
      const hillBump =
        distM > 18
          ? Math.sin(vx * 0.014) * Math.cos(vz * 0.014) * Math.min(20, (distM - 18) * 0.1)
          : 0;
      return nearestY - 0.38 + hillBump;
    };

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const pt of sceneCourse.points) {
      if (pt.lat < minLat) minLat = pt.lat;
      if (pt.lat > maxLat) maxLat = pt.lat;
      if (pt.lon < minLon) minLon = pt.lon;
      if (pt.lon > maxLon) maxLon = pt.lon;
    }

    const latSpan = Math.max(0.004, maxLat - minLat);
    const lonSpan = Math.max(0.004, maxLon - minLon);

    // Build real Web Mercator satellite tile plane with exact ENU projection & elevation displacement
    const addSatelliteTileLayer = (
      zoom: number,
      padDeg: number,
      yOffset: number,
      maxTiles: number,
      segsPerTile: number
    ) => {
      const txMin = lon2tileX(minLon - padDeg, zoom);
      const txMax = lon2tileX(maxLon + padDeg, zoom);
      const tyMin = lat2tileY(maxLat + padDeg, zoom);
      const tyMax = lat2tileY(minLat - padDeg, zoom);

      const totalCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
      if (totalCount <= 0 || totalCount > maxTiles) return false;

      for (let tx = txMin; tx <= txMax; tx += 1) {
        for (let ty = tyMin; ty <= tyMax; ty += 1) {
          const tileGeo = new THREE.PlaneGeometry(1, 1, segsPerTile, segsPerTile);
          const posAttr = tileGeo.attributes.position as THREE.BufferAttribute;
          const uvAttr = tileGeo.attributes.uv as THREE.BufferAttribute;
          const lonW = tile2lon(tx, zoom);
          const lonE = tile2lon(tx + 1, zoom);

          for (let i = 0; i < posAttr.count; i += 1) {
            const u = uvAttr.getX(i);
            const v = uvAttr.getY(i);
            const lon = lonW + u * (lonE - lonW);
            const lat = tile2lat(ty + (1 - v), zoom);
            const vx = (lon - sceneCourse.originLon) * 111320 * sceneCourse.cosLat;
            const vz = -(lat - sceneCourse.originLat) * 110540;
            const vy = sampleTerrainY(vx, vz) + yOffset;
            posAttr.setXYZ(i, vx, vy, vz);
          }
          tileGeo.computeVertexNormals();
          tileGeo.computeBoundingSphere();

          const mat = new THREE.MeshStandardMaterial({
            map: getFallbackTerrainTileTexture(),
            roughness: 0.92,
            metalness: 0.02,
          });
          const mesh = new THREE.Mesh(tileGeo, mat);
          mesh.receiveShadow = true;
          scene.add(mesh);
          disposables.push(tileGeo, mat);

          loadArcGisSatelliteTileTexture(zoom, tx, ty, (loadedTex) => {
            if (disposed) return;
            mat.map = loadedTex;
            mat.needsUpdate = true;
          });
        }
      }
      return true;
    };

    // Wide regional satellite backdrop (guarantees full horizon even when rotating/zooming)
    const backdropPad = Math.max(0.018, Math.max(latSpan, lonSpan) * 0.9);
    const backdropZoom = Math.max(latSpan, lonSpan) > 0.09 ? 12 : 13;
    addSatelliteTileLayer(backdropZoom, backdropPad, -1.1, 20, 4);

    // High-resolution satellite corridor directly over the rally stage
    const detailPad = Math.max(0.0055, Math.max(latSpan, lonSpan) * 0.22);
    const addedZ16 = addSatelliteTileLayer(16, detailPad, -0.04, 30, 8);
    if (!addedZ16) {
      const addedZ15 = addSatelliteTileLayer(15, detailPad, -0.04, 30, 8);
      if (!addedZ15) {
        addSatelliteTileLayer(14, detailPad * 1.4, -0.04, 30, 8);
      }
    }

    // 2. Severity-Colored 3D Stage Ribbon
    const pts = sceneCourse.points;
    const roadHalfW = 4.1;
    const roadPositions: number[] = [];
    const roadColors: number[] = [];
    const roadIndices: number[] = [];

    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const prev = pts[Math.max(0, i - 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const nx = -tz;
      const nz = tx;

      roadPositions.push(p.x + nx * roadHalfW, p.y, p.z + nz * roadHalfW);
      roadPositions.push(p.x - nx * roadHalfW, p.y, p.z - nz * roadHalfW);

      const c = getGradeThreeColor(p.grade);
      roadColors.push(c.r, c.g, c.b, c.r, c.g, c.b);

      if (i < pts.length - 1) {
        const base = i * 2;
        roadIndices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPositions, 3));
    roadGeo.setAttribute('color', new THREE.Float32BufferAttribute(roadColors, 3));
    roadGeo.setIndex(roadIndices);
    roadGeo.computeVertexNormals();
    const roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);
    disposables.push(roadGeo, roadMat);

    // Center white dashed-style spline line for sharp contrast
    const centerLineGeo = new THREE.BufferGeometry().setFromPoints(
      pts.map((p) => new THREE.Vector3(p.x, p.y + 0.08, p.z))
    );
    const centerLineMat = new THREE.LineBasicMaterial({ color: '#F8FAFC', transparent: true, opacity: 0.72 });
    const centerLine = new THREE.Line(centerLineGeo, centerLineMat);
    scene.add(centerLine);
    disposables.push(centerLineGeo, centerLineMat);

    // Start & Finish Gantry Arches
    const buildGantry = (pt: VirtualPoint3D, hex: string) => {
      const gantry = new THREE.Group();
      const postGeo = new THREE.BoxGeometry(0.45, 5.2, 0.45);
      const topGeo = new THREE.BoxGeometry(10.2, 1.1, 0.55);
      const mat = new THREE.MeshStandardMaterial({
        color: hex,
        emissive: hex,
        emissiveIntensity: 0.35,
      });
      const leftPost = new THREE.Mesh(postGeo, mat);
      leftPost.position.set(-4.8, 2.6, 0);
      const rightPost = new THREE.Mesh(postGeo, mat);
      rightPost.position.set(4.8, 2.6, 0);
      const topBar = new THREE.Mesh(topGeo, mat);
      topBar.position.set(0, 5.1, 0);
      gantry.add(leftPost, rightPost, topBar);
      gantry.position.set(pt.x, pt.y, pt.z);
      gantry.rotation.y = pt.headingRad;
      scene.add(gantry);
      disposables.push(postGeo, topGeo, mat);
    };
    buildGantry(pts[0], '#10B981');
    buildGantry(pts[pts.length - 1], '#EF233C');

    // Pacenote 3D Signposts along track (skip straights so signs highlight curves)
    const postGeo = new THREE.CylinderGeometry(0.1, 0.1, 3.1, 6);
    const signGeo = new THREE.BoxGeometry(1.4, 0.9, 0.16);
    disposables.push(postGeo, signGeo);
    for (const note of mergedNotes) {
      if (note.direction === 'R') continue;
      const idx = Math.min(pts.length - 1, Math.max(0, note.sampleIdx));
      const p = pts[idx];
      if (!p) continue;
      const signMat = new THREE.MeshStandardMaterial({
        color: getGradeThreeColor(note.grade),
        emissive: getGradeThreeColor(note.grade),
        emissiveIntensity: note.isCritical ? 0.45 : 0.15,
      });
      const signPostMat = new THREE.MeshStandardMaterial({ color: '#E2E8F0' });
      const marker = new THREE.Group();
      const pole = new THREE.Mesh(postGeo, signPostMat);
      pole.position.y = 1.55;
      const board = new THREE.Mesh(signGeo, signMat);
      board.position.y = 3.2;
      marker.add(pole, board);
      const offsetSide = note.direction === 'E' ? -5.8 : 5.8;
      marker.position.set(
        p.x + Math.cos(p.headingRad) * offsetSide,
        p.y,
        p.z - Math.sin(p.headingRad) * offsetSide
      );
      marker.rotation.y = p.headingRad;
      scene.add(marker);
      disposables.push(signMat, signPostMat);
    }

    // Rally Support POIs (Parque de Serviços / Apoio)
    if (waypoints.length > 0) {
      const wpPinGeo = new THREE.ConeGeometry(1.6, 4.2, 8);
      wpPinGeo.rotateX(Math.PI);
      const wpMat = new THREE.MeshStandardMaterial({
        color: '#F59E0B',
        emissive: '#D97706',
        emissiveIntensity: 0.4,
      });
      disposables.push(wpPinGeo, wpMat);
      for (const wp of waypoints) {
        const wx = (wp.lon - sceneCourse.originLon) * 111320 * sceneCourse.cosLat;
        const wz = -(wp.lat - sceneCourse.originLat) * 110540;
        const pin = new THREE.Mesh(wpPinGeo, wpMat);
        pin.position.set(wx, pts[0].y + 4.5, wz);
        scene.add(pin);
      }
    }

    // 3. Build Composite 3D Rally Car
    const carBuild = buildCompositeRallyCar(activeCarSpec, disposables);
    scene.add(carBuild.group);

    // Position car initially
    const p0 = pts[0];
    carBuild.group.position.set(p0.x, p0.y + 0.06, p0.z);
    carBuild.group.rotation.y = p0.headingRad;
    camera.position.set(
      p0.x - Math.sin(p0.headingRad) * 18,
      p0.y + 8,
      p0.z - Math.cos(p0.headingRad) * 18
    );
    controls.target.set(p0.x, p0.y + 1.4, p0.z);
    controls.update();

    // Animation loop
    let rafId = 0;
    let lastTime = performance.now();
    const desiredCamPos = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3();

    const animate = (now: number) => {
      rafId = window.requestAnimationFrame(animate);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const totalKm = Math.max(0.05, sceneCourse.totalDistKm);
      if (isPlayingRef.current) {
        // Base virtual recce pace ~ 80 km/h * speed multiplier
        const advanceKm = ((82 * simSpeedMultRef.current) / 3600) * dt;
        let nextRatio = progressRef.current + advanceKm / totalKm;
        if (nextRatio >= 1) {
          nextRatio = 1;
          setIsPlaying(false);
        }
        progressRef.current = nextRatio;
        if (now - setProgressThrottleRef.current > 70) {
          setProgressThrottleRef.current = now;
          setProgressRatio(nextRatio);
        }
      }

      // Interpolate car along track points
      const exactDistKm = progressRef.current * totalKm;
      let segIdx = 0;
      for (let i = 1; i < pts.length; i += 1) {
        if (pts[i].distKm >= exactDistKm) {
          segIdx = i - 1;
          break;
        }
        segIdx = pts.length - 2;
      }
      const a = pts[segIdx];
      const b = pts[Math.min(pts.length - 1, segIdx + 1)];
      const span = Math.max(1e-6, b.distKm - a.distKm);
      const frac = Math.max(0, Math.min(1, (exactDistKm - a.distKm) / span));

      const cxPos = a.x + (b.x - a.x) * frac;
      const cyPos = a.y + (b.y - a.y) * frac;
      const czPos = a.z + (b.z - a.z) * frac;

      // Smooth angle wrap
      let dHeading = b.headingRad - a.headingRad;
      while (dHeading > Math.PI) dHeading -= Math.PI * 2;
      while (dHeading < -Math.PI) dHeading += Math.PI * 2;
      const heading = a.headingRad + dHeading * frac;

      // Pitch from elevation change
      const horizDist = Math.max(0.2, Math.hypot(b.x - a.x, b.z - a.z));
      const pitch = -Math.atan2(b.y - a.y, horizDist);

      carBuild.group.position.set(cxPos, cyPos + 0.05, czPos);
      carBuild.group.rotation.set(pitch * 0.7, heading, dHeading * -0.35);

      if (isPlayingRef.current) {
        for (const w of carBuild.wheels) {
          w.rotation.x += dt * 18 * simSpeedMultRef.current;
        }
      }
      for (const fp of carBuild.frontWheelPivots) {
        fp.rotation.y = Math.max(-0.45, Math.min(0.45, dHeading * 1.6));
      }

      // Camera positioning by selected mode
      const fwdX = Math.sin(heading);
      const fwdZ = Math.cos(heading);

      if (cameraModeRef.current === 'free') {
        controls.enabled = true;
        controls.update();
      } else {
        controls.enabled = false;
        if (cameraModeRef.current === 'chase') {
          // 60° angled satellite chase camera following dynamic heading
          desiredCamPos.set(cxPos - fwdX * 16, cyPos + 20.5, czPos - fwdZ * 16);
          desiredTarget.set(cxPos + fwdX * 12, cyPos + 1.0, czPos + fwdZ * 12);
        } else if (cameraModeRef.current === 'hood') {
          desiredCamPos.set(cxPos + fwdX * 0.4, cyPos + 1.78, czPos + fwdZ * 0.4);
          desiredTarget.set(cxPos + fwdX * 28, cyPos + 1.25, czPos + fwdZ * 28);
        } else {
          // Helicóptero
          desiredCamPos.set(cxPos - fwdX * 32 + 16, cyPos + 46, czPos - fwdZ * 32 + 16);
          desiredTarget.set(cxPos + fwdX * 16, cyPos + 0.8, czPos + fwdZ * 16);
        }
        const lerpAlpha = cameraModeRef.current === 'hood' ? 0.55 : 0.14;
        camera.position.lerp(desiredCamPos, lerpAlpha);
        camera.lookAt(desiredTarget);
        controls.target.copy(desiredTarget);
      }

      renderer.render(scene, camera);
    };

    rafId = window.requestAnimationFrame(animate);

    const handleResize = () => {
      if (!host || disposed) return;
      const w = Math.max(300, host.clientWidth);
      const h = Math.max(240, host.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    const resizeObs = new ResizeObserver(handleResize);
    resizeObs.observe(host);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      resizeObs.disconnect();
      controls.dispose();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      renderer.dispose();
      host.innerHTML = '';
    };
  }, [sceneCourse, activeCarSpec, mergedNotes, waypoints]);

  const handleInsertManualNote = () => {
    if (!activeTrack || baseSamples.length === 0) return;
    const sampleIdx = Math.min(
      baseSamples.length - 1,
      Math.max(0, Math.round(progressRatio * (baseSamples.length - 1)))
    );
    const sample = baseSamples[sampleIdx];
    const nextSample = baseSamples[Math.min(baseSamples.length - 1, sampleIdx + 1)];
    const { code, label } = buildPacenoteLabel({
      direction: draftNoteDir,
      grade: draftNoteGrade,
      isHairpin: draftNoteGrade === 1,
      isLong: draftNoteLong,
      tightens: draftNoteTightens,
      opens: false,
    });
    const entry: PacenoteEntry = {
      id: `pn_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      distKm: sample.distKm,
      distM: Math.round(sample.distKm * 1000),
      lat: sample.lat,
      lon: sample.lon,
      altitudeM: getSampleAltitudeM(sample, sample.distKm),
      direction: draftNoteDir,
      grade: draftNoteGrade,
      code,
      label,
      isHairpin: draftNoteGrade === 1,
      isLong: draftNoteLong,
      tightens: draftNoteTightens,
      opens: false,
      isCritical: draftNoteGrade <= 2,
      isManual: true,
      distToNextM: 0,
      headingDeg: bearingBetweenDeg(sample.lat, sample.lon, nextSample.lat, nextSample.lon),
      sampleIdx,
    };
    setManualNotesByTrack((prev) => ({
      ...prev,
      [activeTrack.id]: [...(prev[activeTrack.id] ?? []), entry],
    }));
    setShowAddNoteDrawer(false);
  };

  const handleDeleteNote = (note: PacenoteEntry) => {
    if (!activeTrack) return;
    if (note.isManual) {
      setManualNotesByTrack((prev) => ({
        ...prev,
        [activeTrack.id]: (prev[activeTrack.id] ?? []).filter((n) => n.id !== note.id),
      }));
    } else {
      setRemovedIdsByTrack((prev) => ({
        ...prev,
        [activeTrack.id]: [...(prev[activeTrack.id] ?? []), note.id],
      }));
    }
  };

  const handleCopyWhatsApp = useCallback(async () => {
    if (!activeTrack) return;
    const text = formatPacenotesWhatsApp(activeTrack.name, mergedNotes);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedWhatsApp(true);
      window.setTimeout(() => setCopiedWhatsApp(false), 2400);
    } catch {
      // Fallback
    }
  }, [activeTrack, mergedNotes]);

  const filteredNotes = useMemo(() => {
    if (noteFilter === 'critical') return mergedNotes.filter((n) => n.isCritical);
    if (noteFilter === 'straights') return mergedNotes.filter((n) => n.direction === 'R');
    if (noteFilter === 'manual') return mergedNotes.filter((n) => n.isManual);
    return mergedNotes;
  }, [mergedNotes, noteFilter]);

  if (!activeTrack || sceneCourse.points.length < 2) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-6 text-center space-y-2">
        <Mountain className="mx-auto h-9 w-9 text-[#EF233C] opacity-85" />
        <p className="text-sm font-extrabold text-[var(--ps-text)]">
          Nenhuma especial carregada para Reconhecimento Virtual 3D
        </p>
        <p className="mx-auto max-w-md text-xs text-[var(--ps-muted)]">
          Importe um arquivo KML/KMZ/GPX na aba <strong>Levantamento &amp; Deslocamento</strong> ou carregue uma pista na Biblioteca para gerar o terreno 3D e o caderno automático de notas.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 text-[var(--ps-text)]">
      {/* Top Bar: Track Picker, Car Selector & Audio Toggles */}
      <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5 sm:p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Flag className="h-4 w-4 shrink-0 text-[#EF233C]" />
            {availableTracks.length > 1 && onSelectTrackId ? (
              <select
                value={activeTrack.id}
                onChange={(e) => onSelectTrackId(e.target.value)}
                aria-label="Selecionar especial 3D"
                className="h-9 min-w-0 max-w-xs flex-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-extrabold text-[var(--ps-text)] focus:border-[#EF233C] focus:outline-none"
              >
                {availableTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.folderName ? `[${t.folderName}] ` : ''}
                    {t.name} ({t.referenceDistanceKm.toFixed(1)} km)
                  </option>
                ))}
              </select>
            ) : (
              <span className="truncate text-xs font-extrabold uppercase">
                {activeTrack.name} · {activeTrack.referenceDistanceKm.toFixed(1)} km
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setVoiceEnabled((v) => {
                  const next = !v;
                  if (!next) cancelPacenoteSpeech();
                  return next;
                });
              }}
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-extrabold transition-colors ${
                voiceEnabled
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-muted)]'
              }`}
            >
              {voiceEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
              <span>Voz</span>
            </button>

            <button
              type="button"
              onClick={() => setEngineEnabled((v) => !v)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-extrabold transition-colors ${
                engineEnabled
                  ? 'border-[#EF233C] bg-[#EF233C]/20 text-white'
                  : 'border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-muted)]'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              <span>Motor</span>
            </button>
          </div>
        </div>

        {/* Car Picker */}
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {RECCE_CARS.map((car) => {
            const active = car.id === selectedCarId;
            return (
              <button
                key={car.id}
                type="button"
                onClick={() => setSelectedCarId(car.id)}
                className={`flex min-h-[44px] items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left transition-all ${
                  active
                    ? 'border-[#EF233C] bg-[#EF233C]/15 text-white shadow-[0_0_16px_rgba(239,35,60,0.2)]'
                    : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/15"
                  style={{ backgroundColor: car.primaryHex }}
                >
                  <Car className="h-3.5 w-3.5 text-white drop-shadow" />
                </span>
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-[11px] font-extrabold text-[var(--ps-text)]">
                    {car.shortName}
                  </p>
                  <p className="truncate text-[9px] font-semibold opacity-75">{car.subtitle}</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 3D Satellite Viewport + Live Pacenote HUD (supports inline & seamless Tela Cheia) */}
      <section
        className={
          isFullscreen
            ? 'fixed inset-0 z-[9990] flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#090B0E]'
            : 'overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[#090B0E] shadow-2xl'
        }
      >
        <div
          className={
            isFullscreen
              ? 'relative flex-1 w-full overflow-hidden'
              : 'relative h-[340px] w-full sm:h-[420px]'
          }
        >
          <div ref={canvasHostRef} className="h-full w-full touch-none" />

          {/* Top-left Camera Modes */}
          <div className="pointer-events-auto absolute top-2.5 left-2.5 z-10 flex max-w-[66%] flex-wrap gap-1 pt-[env(safe-area-inset-top)]">
            {CAMERA_MODES.map((cm) => {
              const active = cm.id === cameraMode;
              return (
                <button
                  key={cm.id}
                  type="button"
                  onClick={() => setCameraMode(cm.id)}
                  className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2 text-[10px] font-extrabold uppercase backdrop-blur-md transition-colors ${
                    active
                      ? 'border-[#EF233C] bg-[#EF233C] text-white'
                      : 'border-white/15 bg-black/65 text-white/80 hover:text-white'
                  }`}
                >
                  <Camera className="h-3 w-3" />
                  <span>{cm.label}</span>
                </button>
              );
            })}
          </div>

          {/* Top-right Telemetry Pill + Tela Cheia Button */}
          <div className="pointer-events-auto absolute top-2.5 right-2.5 z-10 flex items-start gap-1.5 pt-[env(safe-area-inset-top)]">
            <div className="pointer-events-none rounded-xl border border-white/15 bg-black/70 px-2.5 py-1.5 text-right font-mono backdrop-blur-md tabular-nums">
              <p className="text-xs font-black text-white">
                {currentVirtualSpeedKmh} <span className="text-[9px] text-white/65">KM/H</span>
              </p>
              <p className="text-[10px] font-bold text-emerald-400">
                KM {currentDistKm.toFixed(2).replace('.', ',')}
                {currentSlopePct !== 0
                  ? ` · ${currentSlopePct > 0 ? `+${currentSlopePct}%` : `${currentSlopePct}%`}`
                  : ''}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setIsFullscreen((v) => !v)}
              aria-label={isFullscreen ? 'Sair da Tela Cheia' : 'Abrir 3D em Tela Cheia'}
              className="inline-flex h-10 items-center gap-1 rounded-xl border border-white/20 bg-black/75 px-2.5 text-[10px] font-extrabold text-white uppercase backdrop-blur-md hover:border-[#EF233C] active:scale-95"
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5 text-[#EF233C]" />
                  <span>Sair</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5 text-[#EF233C]" />
                  <span>Tela Cheia</span>
                </>
              )}
            </button>
          </div>

          {/* Bottom Floating Pacenote HUD: PRÓXIMA NOTA + DEPOIS */}
          <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 z-10 flex flex-wrap items-end justify-between gap-2">
            <div className="flex max-w-full items-center gap-2 rounded-2xl border border-white/20 bg-black/80 px-3 py-2 backdrop-blur-md shadow-2xl">
              {upcomingNotes.next ? (
                <>
                  <span
                    className={`flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-xl border px-2 font-mono text-sm font-black ${getGradeBadgeClasses(
                      upcomingNotes.next.direction === 'R' ? 'R' : upcomingNotes.next.grade
                    )}`}
                  >
                    {upcomingNotes.next.direction === 'R'
                      ? 'RETA'
                      : `${upcomingNotes.next.direction}${upcomingNotes.next.grade}`}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p className="text-[9px] font-extrabold tracking-wider text-white/65 uppercase">
                      Próxima Nota ·{' '}
                      <span className="font-mono text-amber-300">
                        {Math.max(0, upcomingNotes.next.distM - currentDistM)}m
                      </span>
                    </p>
                    <p className="truncate text-sm font-black text-white sm:text-base">
                      {upcomingNotes.next.label}
                    </p>
                  </div>
                </>
              ) : (
                <div className="leading-tight">
                  <p className="text-[9px] font-extrabold tracking-wider text-emerald-400 uppercase">
                    Reta Final
                  </p>
                  <p className="text-xs font-black text-white">Chegada da Especial</p>
                </div>
              )}
            </div>

            {upcomingNotes.after && (
              <div className="rounded-xl border border-white/15 bg-black/75 px-2.5 py-1.5 backdrop-blur-md">
                <p className="text-[9px] font-extrabold tracking-wider text-white/60 uppercase">
                  Depois (+{upcomingNotes.next?.distToNextM ?? 0}m)
                </p>
                <p className="text-xs font-extrabold text-amber-300">
                  {upcomingNotes.after.code}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Scrubber & Transport Controls */}
        <div
          className={`border-t border-[var(--ps-border)] bg-[var(--ps-card)] p-3 space-y-2.5 ${
            isFullscreen ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : ''
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setIsPlaying((v) => !v)}
              className="pitstop-btn-red inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-4 text-xs font-extrabold uppercase"
            >
              {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
              <span>{isPlaying ? 'Pausar' : 'Simular'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsPlaying(false);
                progressRef.current = 0;
                setProgressRatio(0);
                lastAnnouncedNoteIdRef.current = '';
              }}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-muted)] hover:text-white"
              title="Reiniciar"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>0 km</span>
            </button>

            <div className="inline-flex rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
              {([0.5, 1, 1.5, 2] as const).map((mult) => (
                <button
                  key={mult}
                  type="button"
                  onClick={() => setSimSpeedMult(mult)}
                  className={`min-h-[36px] rounded-lg px-2 font-mono text-[11px] font-extrabold ${
                    simSpeedMult === mult
                      ? 'bg-[#EF233C] text-white'
                      : 'text-[var(--ps-muted)] hover:text-white'
                  }`}
                >
                  {mult}x
                </button>
              ))}
            </div>

            <span className="ml-auto font-mono text-xs font-bold text-[var(--ps-muted)] tabular-nums">
              {currentDistKm.toFixed(2).replace('.', ',')} /{' '}
              {sceneCourse.totalDistKm.toFixed(2).replace('.', ',')} km
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(progressRatio * 1000)}
            onChange={(e) => {
              const r = Number(e.target.value) / 1000;
              progressRef.current = r;
              setProgressRatio(r);
              lastAnnouncedNoteIdRef.current = '';
            }}
            aria-label="Linha do tempo do reconhecimento 3D"
            className="w-full accent-[#EF233C] cursor-pointer"
          />
        </div>
      </section>

      {/* Perfil Altimétrico SVG */}
      {elevationProfile.length >= 2 && (
        <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-extrabold uppercase tracking-wide">
              <Mountain className="h-3.5 w-3.5 text-[#EF233C]" />
              <span>Perfil Altimétrico</span>
              <span className="rounded-md border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-1.5 py-0.5 font-mono text-[9px] font-bold text-[var(--ps-muted)]">
                {elevationSource === 'open-meteo'
                  ? 'Relevo Real'
                  : elevationSource === 'cache'
                    ? 'Cache Real'
                    : elevationSource === 'kml'
                      ? 'KML 3D'
                      : 'Estimado'}
              </span>
            </span>
            <span className="font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
              {Math.round(sceneCourse.minAlt)}m – {Math.round(sceneCourse.maxAlt)}m
              {currentSlopePct !== 0
                ? ` · Inclinação ${currentSlopePct > 0 ? `+${currentSlopePct}%` : `${currentSlopePct}%`}`
                : ''}
            </span>
          </div>
          <svg viewBox="0 0 600 90" className="h-20 w-full overflow-visible">
            {(() => {
              const totalKm = Math.max(0.05, sceneCourse.totalDistKm);
              const altSpan = Math.max(5, sceneCourse.maxAlt - sceneCourse.minAlt);
              const ptsSvg = elevationProfile.map((pt) => {
                const x = (pt.distKm / totalKm) * 600;
                const y = 78 - ((pt.altitudeM - sceneCourse.minAlt) / altSpan) * 64;
                return { x, y };
              });
              const linePath = ptsSvg
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                .join(' ');
              const areaPath = `${linePath} L 600 88 L 0 88 Z`;
              const curX = progressRatio * 600;
              let curY = 45;
              const idxMatch = Math.min(
                ptsSvg.length - 1,
                Math.round(progressRatio * (ptsSvg.length - 1))
              );
              if (ptsSvg[idxMatch]) curY = ptsSvg[idxMatch].y;

              return (
                <>
                  <defs>
                    <linearGradient id="recceAltGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#EF233C" stopOpacity="0.45" />
                      <stop offset="100%" stopColor="#EF233C" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <path d={areaPath} fill="url(#recceAltGrad)" />
                  <path d={linePath} fill="none" stroke="#EF233C" strokeWidth="2.5" />
                  <line
                    x1={curX}
                    y1={4}
                    x2={curX}
                    y2={88}
                    stroke="#FFFFFF"
                    strokeOpacity="0.35"
                    strokeDasharray="3 3"
                  />
                  <circle cx={curX} cy={curY} r="5" fill="#F59E0B" stroke="#FFFFFF" strokeWidth="2" />
                </>
              );
            })()}
          </svg>
        </section>
      )}

      {/* Caderno de Notas Interativo */}
      <section className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
            {(
              [
                ['all', `Todas (${mergedNotes.length})`],
                ['critical', `Críticas 1-2 (${mergedNotes.filter((n) => n.isCritical).length})`],
                ['straights', `Retas (${mergedNotes.filter((n) => n.direction === 'R').length})`],
                ['manual', `Manuais (${mergedNotes.filter((n) => n.isManual).length})`],
              ] as const
            ).map(([fid, label]) => (
              <button
                key={fid}
                type="button"
                onClick={() => setNoteFilter(fid)}
                className={`min-h-[34px] rounded-lg px-2.5 text-[11px] font-extrabold transition-colors ${
                  noteFilter === fid
                    ? 'bg-[#EF233C] text-white'
                    : 'text-[var(--ps-muted)] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowAddNoteDrawer((v) => !v)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold text-white hover:border-[#EF233C]"
            >
              <Plus className="h-3.5 w-3.5 text-[#EF233C]" />
              <span>+ Nota</span>
            </button>

            <button
              type="button"
              onClick={handleCopyWhatsApp}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-extrabold text-emerald-300 hover:bg-emerald-500/25"
            >
              {copiedWhatsApp ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedWhatsApp ? 'Copiado!' : 'Copiar Caderno (WhatsApp)'}</span>
            </button>
          </div>
        </div>

        {showAddNoteDrawer && (
          <div className="rounded-xl border border-[#EF233C]/40 bg-[var(--ps-card-deep)] p-3 space-y-2.5">
            <p className="text-xs font-extrabold text-white">
              Inserir Nota Manual em KM {currentDistKm.toFixed(2).replace('.', ',')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-0.5">
                {(['E', 'D'] as const).map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => setDraftNoteDir(dir)}
                    className={`min-h-[34px] rounded-md px-3 text-xs font-extrabold ${
                      draftNoteDir === dir ? 'bg-[#EF233C] text-white' : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    {dir === 'E' ? 'Esquerda' : 'Direita'}
                  </button>
                ))}
              </div>

              <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-0.5">
                {([1, 2, 3, 4, 5, 6] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setDraftNoteGrade(g)}
                    className={`min-h-[34px] w-8 rounded-md font-mono text-xs font-black ${
                      draftNoteGrade === g ? 'bg-[#EF233C] text-white' : 'text-[var(--ps-muted)]'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>

              <label className="inline-flex items-center gap-1.5 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={draftNoteLong}
                  onChange={(e) => setDraftNoteLong(e.target.checked)}
                  className="accent-[#EF233C]"
                />
                <span>Longa</span>
              </label>

              <label className="inline-flex items-center gap-1.5 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={draftNoteTightens}
                  onChange={(e) => setDraftNoteTightens(e.target.checked)}
                  className="accent-[#EF233C]"
                />
                <span>Fecha</span>
              </label>

              <button
                type="button"
                onClick={handleInsertManualNote}
                className="pitstop-btn-red ml-auto min-h-[36px] rounded-xl px-4 text-xs font-extrabold uppercase"
              >
                Salvar Nota
              </button>
            </div>
          </div>
        )}

        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {filteredNotes.length === 0 ? (
            <p className="py-4 text-center text-xs text-[var(--ps-muted)]">
              Nenhuma nota encontrada neste filtro.
            </p>
          ) : (
            filteredNotes.map((note) => {
              const isNear = Math.abs(note.distKm - currentDistKm) < 0.04;
              return (
                <div
                  key={note.id}
                  onClick={() => {
                    const nextRatio =
                      sceneCourse.totalDistKm > 0
                        ? Math.min(1, Math.max(0, note.distKm / sceneCourse.totalDistKm))
                        : 0;
                    progressRef.current = nextRatio;
                    setProgressRatio(nextRatio);
                  }}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2 transition-colors ${
                    isNear
                      ? 'border-[#EF233C] bg-[#EF233C]/15'
                      : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] hover:border-[var(--ps-border-strong)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={`inline-flex h-8 min-w-[44px] shrink-0 items-center justify-center rounded-lg border px-1.5 font-mono text-xs font-black ${getGradeBadgeClasses(
                        note.direction === 'R' ? 'R' : note.grade
                      )}`}
                    >
                      {note.direction === 'R' ? 'RETA' : `${note.direction}${note.grade}`}
                    </span>
                    <div className="min-w-0 leading-tight">
                      <p className="truncate text-xs font-extrabold text-[var(--ps-text)]">
                        {note.code}
                        {note.isManual && (
                          <span className="ml-1.5 rounded bg-sky-500/20 px-1 py-0.5 text-[9px] text-sky-300">
                            MANUAL
                          </span>
                        )}
                      </p>
                      <p className="font-mono text-[10px] text-[var(--ps-muted)] tabular-nums">
                        KM {note.distKm.toFixed(2).replace('.', ',')} · {Math.round(note.altitudeM)}m
                        {note.distToNextM > 0 ? ` · → ${note.distToNextM}m` : ''}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteNote(note);
                    }}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ps-muted)] hover:bg-red-500/15 hover:text-red-400"
                    aria-label={`Excluir nota ${note.code}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
};
