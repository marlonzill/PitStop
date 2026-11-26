import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Download,
  Film,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import {
  downloadGoProMediaVideoUrl,
  enableGoProWifiAP,
  fetchGoProMediaList,
  fetchGoProMediaThumbnail,
  getGoProDisplayName,
  useGoProFleet,
  type GoProMediaItem,
} from '../utils/goproBle';
import {
  formatStageDuration,
  interpolateSampleAtElapsedMs,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
} from '../utils/velocityEngine';

interface VideoHudOverlayPanelProps {
  lap1: VelocityRun | null;
  lap2?: VelocityRun | null;
  lap3?: VelocityRun | null;
  lap1Samples: VelocitySample[];
  lap2Samples?: VelocitySample[];
  lap3Samples?: VelocitySample[];
  sessionRuns: VelocityRun[];
  sessionOptimal: OptimalStageSummary;
}

interface LoadedVideoMeta {
  source: 'gopro' | 'gallery';
  filename: string;
  /** Exact epoch ms when recording started (from `cre` on GoPro or `lastModified - duration` on gallery). */
  videoStartMs: number | null;
  /** File lastModified ms (used once HTMLVideoElement metadata provides duration). */
  fileLastModifiedMs?: number;
}

interface AutoSyncState {
  active: boolean;
  /** Seconds into the video where Start (L) occurs (positive = Start happens X seconds after video start). */
  startSeekSec: number;
  baseOffsetMs: number;
  sourceLabel: string;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function formatMediaDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Data desconhecida';
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSignedSeconds(sec: number, decimals = 1): string {
  const safe = Math.abs(sec) < 0.05 ? 0 : sec;
  const sign = safe >= 0 ? '+' : '-';
  return `${sign}${Math.abs(safe).toFixed(decimals)}s`;
}

/**
 * Resolve o melhor timestamp de início de gravação comparando o horário de criação do vídeo
 * com a largada da volta (compensando eventual fuso local gravado pela GoPro no campo `cre`).
 */
function resolveAutoSyncOffset(
  videoStartMs: number,
  lap: VelocityRun,
  source: 'gopro' | 'gallery',
  videoDurationSec?: number
): AutoSyncState {
  const lapStartMs = lap.startedAtMs;
  const lapDurationSec = Math.max(10, lap.totalMs / 1000);
  const maxSeekWindow = Number.isFinite(videoDurationSec) && (videoDurationSec ?? 0) > 1
    ? (videoDurationSec as number) + 120
    : 7200;

  let chosenVideoStartMs = videoStartMs;
  let startSeekSec = (lapStartMs - chosenVideoStartMs) / 1000;

  // GoPro firmware frequentemente grava `cre` como relógio local codificado em epoch UTC
  if (source === 'gopro' && Math.abs(startSeekSec) > 1800) {
    const tzShiftMs = new Date().getTimezoneOffset() * 60000;
    const altCandidates = [videoStartMs + tzShiftMs, videoStartMs - tzShiftMs];
    for (const candidateMs of altCandidates) {
      const candidateSeek = (lapStartMs - candidateMs) / 1000;
      if (
        Math.abs(candidateSeek) < Math.abs(startSeekSec) &&
        candidateSeek >= -lapDurationSec - 60 &&
        candidateSeek <= maxSeekWindow
      ) {
        chosenVideoStartMs = candidateMs;
        startSeekSec = candidateSeek;
      }
    }
  }

  const roundedSeekSec = Number(startSeekSec.toFixed(1));
  // targetTelemetryMs = video.currentTime * 1000 + offsetMs => quando currentTime = startSeekSec, targetTelemetryMs = 0
  const baseOffsetMs = -Math.round(roundedSeekSec * 1000);

  return {
    active: true,
    startSeekSec: roundedSeekSec,
    baseOffsetMs,
    sourceLabel: source === 'gopro' ? 'GoPro Wi-Fi (cre)' : 'Galeria (lastModified)',
  };
}

function getSpeedometerMax(samples: VelocitySample[]): number {
  const peak = samples.reduce((m, s) => Math.max(m, s.speedKmh || 0), 0);
  if (peak <= 115) return 140;
  if (peak <= 155) return 180;
  if (peak <= 195) return 220;
  return 260;
}

function normalizeTrackPoints(
  samples: VelocitySample[],
  w: number,
  h: number,
  pad: number
): { pts: Array<{ x: number; y: number }>; polyline: string } {
  if (samples.length < 2) return { pts: [], polyline: '' };
  const avgLat = samples.reduce((sum, s) => sum + s.lat, 0) / samples.length;
  const cosLat = Math.max(0.15, Math.cos((avgLat * Math.PI) / 180));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const projected = samples.map((s) => {
    const x = s.lon * cosLat;
    const y = -s.lat;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    return { x, y };
  });

  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const usableW = Math.max(10, w - pad * 2);
  const usableH = Math.max(10, h - pad * 2);
  const scale = Math.min(usableW / spanX, usableH / spanY);
  const offsetX = pad + (usableW - spanX * scale) / 2;
  const offsetY = pad + (usableH - spanY * scale) / 2;

  const pts = projected.map((p) => ({
    x: offsetX + (p.x - minX) * scale,
    y: offsetY + (p.y - minY) * scale,
  }));

  const polyline = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return { pts, polyline };
}

function drawHudOnCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  params: {
    sample: VelocitySample;
    miniMapPts: Array<{ x: number; y: number }>;
    sampleIndex: number;
    bestMs: number | null;
    prevMs: number | null;
    maxGaugeSpeed: number;
  }
) {
  const { sample, miniMapPts, sampleIndex, bestMs, prevMs, maxGaugeSpeed } = params;
  const s = w / 1280;

  ctx.save();

  // 1. TOP-LEFT: Mini-Mapa do Traçado
  if (miniMapPts.length >= 2) {
    const mapX = 24 * s;
    const mapY = 20 * s;
    const mapW = 168 * s;
    const mapH = 128 * s;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.roundRect(mapX, mapY, mapW, mapH, 12 * s);
    ctx.fill();
    ctx.stroke();

    const sx = mapW / 120;
    const sy = mapH / 92;

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 5 * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    miniMapPts.forEach((p, idx) => {
      const px = mapX + p.x * sx;
      const py = mapY + p.y * sy;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.6 * s;
    ctx.beginPath();
    miniMapPts.forEach((p, idx) => {
      const px = mapX + p.x * sx;
      const py = mapY + p.y * sy;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    const pt = miniMapPts[Math.min(miniMapPts.length - 1, Math.max(0, sampleIndex))];
    if (pt) {
      const cx = mapX + pt.x * sx;
      const cy = mapY + pt.y * sy;
      ctx.fillStyle = 'rgba(255, 42, 42, 0.35)';
      ctx.beginPath();
      ctx.arc(cx, cy, 9 * s, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FF2A2A';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, 5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 2. TOP-CENTER: Painel de Tempos (MELHOR | ANTERIOR | ATUAL)
  const timerBoxW = 460 * s;
  const timerBoxH = 66 * s;
  const timerBoxX = (w - timerBoxW) / 2;
  const timerBoxY = 20 * s;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.52)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.roundRect(timerBoxX, timerBoxY, timerBoxW, timerBoxH, 12 * s);
  ctx.fill();
  ctx.stroke();

  const cols = [
    { label: 'MELHOR', value: formatStageDuration(bestMs), color: '#10B981' },
    { label: 'ANTERIOR', value: formatStageDuration(prevMs), color: '#CBD5E1' },
    { label: 'ATUAL', value: formatStageDuration(sample.stageElapsedMs), color: '#FFFFFF' },
  ];
  cols.forEach((col, i) => {
    const cx = timerBoxX + (timerBoxW / 3) * (i + 0.5);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.font = `700 ${Math.round(11 * s)}px monospace`;
    ctx.fillText(col.label, cx, timerBoxY + 21 * s);

    ctx.fillStyle = col.color;
    ctx.font = `900 ${Math.round(23 * s)}px monospace`;
    ctx.fillText(col.value, cx, timerBoxY + 50 * s);
  });

  // 3. BOTTOM-CENTER: Alvo Força G + Velocímetro Analógico
  const baseCenterY = h - 104 * s;
  const gCenterX = w / 2 - 108 * s;
  const speedCenterX = w / 2 + 88 * s;

  const gR = 64 * s;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(gCenterX, baseCenterY, gR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.arc(gCenterX, baseCenterY, gR * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(gCenterX - gR + 6 * s, baseCenterY);
  ctx.lineTo(gCenterX + gR - 6 * s, baseCenterY);
  ctx.moveTo(gCenterX, baseCenterY - gR + 6 * s);
  ctx.lineTo(gCenterX, baseCenterY + gR - 6 * s);
  ctx.stroke();

  const latG = Math.max(-1.2, Math.min(1.2, sample.accelLatG ?? 0));
  const longG = Math.max(-1.2, Math.min(1.2, sample.accelLongG ?? 0));
  const totalG = Math.hypot(sample.accelLatG ?? 0, sample.accelLongG ?? 0);
  const dotX = gCenterX + (latG / 1.2) * (gR - 10 * s);
  const dotY = baseCenterY - (longG / 1.2) * (gR - 10 * s);

  ctx.fillStyle = 'rgba(255, 42, 42, 0.35)';
  ctx.beginPath();
  ctx.arc(dotX, dotY, 10 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#FF2A2A';
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(dotX, dotY, 5.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${Math.round(14 * s)}px monospace`;
  ctx.fillText(`${totalG.toFixed(2)} G`, gCenterX, baseCenterY + gR + 18 * s);

  const spdR = 82 * s;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.arc(speedCenterX, baseCenterY - 6 * s, spdR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const startAng = (135 * Math.PI) / 180;
  const endAng = (405 * Math.PI) / 180;
  const sweep = endAng - startAng;
  const gaugeCy = baseCenterY - 6 * s;

  const majorStep = maxGaugeSpeed >= 220 ? 40 : 20;
  const minorStep = majorStep / 2;
  for (let v = 0; v <= maxGaugeSpeed; v += minorStep) {
    const frac = v / maxGaugeSpeed;
    const ang = startAng + frac * sweep;
    const isMajor = v % majorStep === 0;
    const rOuter = spdR - 7 * s;
    const rInner = rOuter - (isMajor ? 10 * s : 5 * s);
    ctx.strokeStyle = v >= maxGaugeSpeed * 0.8 ? '#FF2A2A' : '#E2E8F0';
    ctx.lineWidth = isMajor ? 2.2 * s : 1.2 * s;
    ctx.beginPath();
    ctx.moveTo(speedCenterX + Math.cos(ang) * rInner, gaugeCy + Math.sin(ang) * rInner);
    ctx.lineTo(speedCenterX + Math.cos(ang) * rOuter, gaugeCy + Math.sin(ang) * rOuter);
    ctx.stroke();

    if (isMajor) {
      const rTxt = spdR - 25 * s;
      ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.font = `700 ${Math.round(10 * s)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        String(v),
        speedCenterX + Math.cos(ang) * rTxt,
        gaugeCy + Math.sin(ang) * rTxt
      );
    }
  }
  ctx.textBaseline = 'alphabetic';

  const spdClamped = Math.max(0, Math.min(maxGaugeSpeed, sample.speedKmh || 0));
  const needleAng = startAng + (spdClamped / maxGaugeSpeed) * sweep;
  ctx.strokeStyle = '#FF2A2A';
  ctx.lineWidth = 3.5 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(speedCenterX, gaugeCy);
  ctx.lineTo(
    speedCenterX + Math.cos(needleAng) * (spdR - 14 * s),
    gaugeCy + Math.sin(needleAng) * (spdR - 14 * s)
  );
  ctx.stroke();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.beginPath();
  ctx.arc(speedCenterX, gaugeCy + 16 * s, 28 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${Math.round(28 * s)}px monospace`;
  ctx.fillText(String(Math.round(sample.speedKmh || 0)), speedCenterX, gaugeCy + 22 * s);
  ctx.fillStyle = '#94A3B8';
  ctx.font = `700 ${Math.round(9.5 * s)}px monospace`;
  ctx.fillText('KM/H', speedCenterX, gaugeCy + 35 * s);

  ctx.restore();
}

export const VideoHudOverlayPanel: React.FC<VideoHudOverlayPanelProps> = ({
  lap1,
  lap2 = null,
  lap3 = null,
  lap1Samples,
  lap2Samples = [],
  lap3Samples = [],
  sessionRuns,
  sessionOptimal,
}) => {
  const goproFleet = useGoProFleet();
  const hasPairedGoPro =
    goproFleet.cameras.length > 0 || goproFleet.savedDevices.length > 0;
  const connectedGoPro = goproFleet.cameras.find((c) => c.connected && !c.sleeping) ?? null;

  const [selectedLapSlot, setSelectedLapSlot] = useState<'v1' | 'v2' | 'v3'>('v1');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadedVideoMeta, setLoadedVideoMeta] = useState<LoadedVideoMeta | null>(null);
  const [autoSync, setAutoSync] = useState<AutoSyncState | null>(null);
  const [fineOffsetMs, setFineOffsetMs] = useState(0);
  const [previewSampleIdx, setPreviewSampleIdx] = useState(0);
  const [activeElapsedMs, setActiveElapsedMs] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportedBlobUrl, setExportedBlobUrl] = useState<string | null>(null);

  // GoPro Wi-Fi Media Modal states
  const [goproModalOpen, setGoproModalOpen] = useState(false);
  const [goproApStatus, setGoproApStatus] = useState<string | null>(null);
  const [goproApLoading, setGoproApLoading] = useState(false);
  const [goproMediaLoading, setGoproMediaLoading] = useState(false);
  const [goproMediaError, setGoproMediaError] = useState<string | null>(null);
  const [goproMediaList, setGoproMediaList] = useState<GoProMediaItem[]>([]);
  const [goproThumbs, setGoproThumbs] = useState<Record<string, string>>({});
  const [downloadingMediaId, setDownloadingMediaId] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekSecRef = useRef<number | null>(null);
  const exportAbortRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const goproThumbsRef = useRef<Record<string, string>>({});
  goproThumbsRef.current = goproThumbs;

  const activeLap = useMemo(() => {
    if (selectedLapSlot === 'v2' && lap2) return lap2;
    if (selectedLapSlot === 'v3' && lap3) return lap3;
    return lap1;
  }, [selectedLapSlot, lap1, lap2, lap3]);

  const activeLapSamples = useMemo(() => {
    if (selectedLapSlot === 'v2' && lap2 && lap2Samples.length > 0) return lap2Samples;
    if (selectedLapSlot === 'v3' && lap3 && lap3Samples.length > 0) return lap3Samples;
    return lap1Samples;
  }, [selectedLapSlot, lap1Samples, lap2, lap2Samples, lap3, lap3Samples]);

  // Reset slot to V1 if selected V2/V3 becomes unavailable
  useEffect(() => {
    if (selectedLapSlot === 'v2' && !lap2) setSelectedLapSlot('v1');
    if (selectedLapSlot === 'v3' && !lap3) setSelectedLapSlot('v1');
  }, [selectedLapSlot, lap2, lap3]);

  const totalOffsetMs = (autoSync?.baseOffsetMs ?? 0) + fineOffsetMs;
  const effectiveStartSeekSec = -(totalOffsetMs / 1000);

  useEffect(() => {
    return () => {
      if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      if (exportedBlobUrl) URL.revokeObjectURL(exportedBlobUrl);
    };
  }, [exportedBlobUrl]);

  useEffect(() => {
    return () => {
      Object.values(goproThumbsRef.current).forEach((u) => {
        if (u.startsWith('blob:')) URL.revokeObjectURL(u);
      });
    };
  }, []);

  const applyAutoSyncForVideo = useCallback(
    (
      videoStartMs: number,
      lap: VelocityRun | null,
      source: 'gopro' | 'gallery',
      durationSec?: number
    ) => {
      if (!lap) return;
      const computed = resolveAutoSyncOffset(videoStartMs, lap, source, durationSec);
      setAutoSync(computed);
      setFineOffsetMs(0);

      const vid = videoRef.current;
      const targetSeek = Math.max(0, computed.startSeekSec);
      if (vid && Number.isFinite(vid.duration) && vid.duration > 0) {
        const clampedSeek = Math.min(vid.duration, targetSeek);
        vid.currentTime = clampedSeek;
        setActiveElapsedMs(Math.max(0, clampedSeek * 1000 + computed.baseOffsetMs));
        pendingSeekSecRef.current = null;
      } else {
        pendingSeekSecRef.current = targetSeek;
      }
    },
    []
  );

  // Recalcula Auto-Sync automaticamente ao trocar de volta selecionada (V1 / V2 / V3)
  useEffect(() => {
    if (!loadedVideoMeta?.videoStartMs || !activeLap) return;
    const vid = videoRef.current;
    const dur = vid && Number.isFinite(vid.duration) ? vid.duration : undefined;
    applyAutoSyncForVideo(loadedVideoMeta.videoStartMs, activeLap, loadedVideoMeta.source, dur);
  }, [activeLap?.id, loadedVideoMeta?.videoStartMs, loadedVideoMeta?.source, applyAutoSyncForVideo, activeLap]);

  // Previous lap time relative to activeLap
  const previousRun = useMemo(() => {
    if (!activeLap || sessionRuns.length < 2) return null;
    const ordered = [...sessionRuns].sort((a, b) => a.startedAtMs - b.startedAtMs);
    const idx = ordered.findIndex((r) => r.id === activeLap.id);
    if (idx > 0) return ordered[idx - 1];
    const fallback = ordered.find((r) => r.id !== activeLap.id);
    return fallback ?? null;
  }, [activeLap, sessionRuns]);

  const maxGaugeSpeed = useMemo(
    () => getSpeedometerMax(activeLapSamples),
    [activeLapSamples]
  );

  const miniMap = useMemo(
    () => normalizeTrackPoints(activeLapSamples, 120, 92, 10),
    [activeLapSamples]
  );

  // Sync HUD smoothly at 30fps during video playback
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoUrl) return;
    let rafId = 0;
    const tick = () => {
      const targetMs = Math.max(0, vid.currentTime * 1000 + totalOffsetMs);
      setActiveElapsedMs(targetMs);
      if (!vid.paused && !vid.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    const onPlay = () => {
      rafId = window.requestAnimationFrame(tick);
    };
    const onSeekOrUpdate = () => {
      setActiveElapsedMs(Math.max(0, vid.currentTime * 1000 + totalOffsetMs));
    };
    vid.addEventListener('play', onPlay);
    vid.addEventListener('timeupdate', onSeekOrUpdate);
    vid.addEventListener('seeked', onSeekOrUpdate);
    onSeekOrUpdate();
    return () => {
      window.cancelAnimationFrame(rafId);
      vid.removeEventListener('play', onPlay);
      vid.removeEventListener('timeupdate', onSeekOrUpdate);
      vid.removeEventListener('seeked', onSeekOrUpdate);
    };
  }, [videoUrl, totalOffsetMs]);

  const activeSampleData = useMemo(() => {
    if (activeLapSamples.length === 0) return { sample: null, idx: 0 };
    if (!videoUrl) {
      const idx = Math.max(0, Math.min(activeLapSamples.length - 1, previewSampleIdx));
      return { sample: activeLapSamples[idx], idx };
    }
    const sample = interpolateSampleAtElapsedMs(activeLapSamples, activeElapsedMs);
    let closestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < activeLapSamples.length; i += 1) {
      const d = Math.abs(activeLapSamples[i].stageElapsedMs - activeElapsedMs);
      if (d < bestDiff) {
        bestDiff = d;
        closestIdx = i;
      }
    }
    return { sample: sample ?? activeLapSamples[closestIdx], idx: closestIdx };
  }, [activeLapSamples, videoUrl, previewSampleIdx, activeElapsedMs]);

  const activeSample = activeSampleData.sample;
  const activeMapPt = miniMap.pts[activeSampleData.idx] ?? miniMap.pts[0] ?? null;

  const loadGoProListAndThumbs = useCallback(async () => {
    setGoproMediaLoading(true);
    setGoproMediaError(null);
    try {
      const items = await fetchGoProMediaList();
      setGoproMediaList(items);
      if (items.length === 0) {
        setGoproMediaError('Nenhum vídeo MP4 encontrado no cartão SD da GoPro.');
      } else {
        // Carrega miniaturas em paralelo sem bloquear a exibição da lista
        items.slice(0, 12).forEach((item) => {
          void fetchGoProMediaThumbnail(item.thumbUrl).then((src) => {
            if (!src) return;
            setGoproThumbs((prev) => ({ ...prev, [item.id]: src }));
          });
        });
      }
    } catch (err) {
      setGoproMediaError(
        err instanceof Error
          ? `Não foi possível acessar http://10.5.5.9:8080 (${err.message}). Conecte o celular no Wi-Fi da GoPro e tente novamente.`
          : 'Conecte o celular à rede Wi-Fi da GoPro (10.5.5.9) e toque em Atualizar Lista.'
      );
    } finally {
      setGoproMediaLoading(false);
    }
  }, []);

  const handleOpenGoProMediaBrowser = async () => {
    setGoproModalOpen(true);
    setGoproMediaError(null);
    setGoproApStatus(null);

    if (hasPairedGoPro) {
      setGoproApLoading(true);
      const apRes = await enableGoProWifiAP();
      setGoproApLoading(false);
      if (apRes.ok) {
        setGoproApStatus(
          apRes.simulated
            ? `Modo Simulador (${apRes.cameraName}): conecte na GoPro real via Wi-Fi para listar gravações.`
            : `Wi-Fi AP ativado via BLE em "${apRes.cameraName}". Confirme a conexão do celular no Wi-Fi da GoPro.`
        );
      } else if (apRes.error) {
        setGoproApStatus(`Aviso BLE: ${apRes.error}`);
      }
    } else {
      setGoproApStatus(
        'Nenhuma GoPro pareada via BLE. Caso já esteja conectado no Wi-Fi da GoPro, a busca abaixo consultará 10.5.5.9:8080 diretamente.'
      );
    }

    await loadGoProListAndThumbs();
  };

  const handleSelectGoProMediaItem = async (item: GoProMediaItem) => {
    setDownloadingMediaId(item.id);
    setGoproMediaError(null);
    try {
      const downloaded = await downloadGoProMediaVideoUrl(item);
      if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
      setExportedBlobUrl(null);
      setExportStatus(null);
      setVideoUrl(downloaded.url);
      setLoadedVideoMeta({
        source: 'gopro',
        filename: item.filename,
        videoStartMs: item.createdAtMs || null,
      });
      if (item.createdAtMs && activeLap) {
        applyAutoSyncForVideo(item.createdAtMs, activeLap, 'gopro');
      } else {
        setAutoSync(null);
        setFineOffsetMs(0);
      }
      setGoproModalOpen(false);
    } catch (err) {
      setGoproMediaError(
        err instanceof Error
          ? err.message
          : 'Falha ao importar o vídeo da GoPro via Wi-Fi.'
      );
    } finally {
      setDownloadingMediaId(null);
    }
  };

  const handleVideoLoadedMetadata = () => {
    const vid = videoRef.current;
    if (!vid) return;

    if (
      loadedVideoMeta?.source === 'gallery' &&
      loadedVideoMeta.fileLastModifiedMs &&
      Number.isFinite(vid.duration) &&
      vid.duration > 0
    ) {
      const computedStartMs =
        loadedVideoMeta.fileLastModifiedMs - Math.round(vid.duration * 1000);
      setLoadedVideoMeta((prev) =>
        prev ? { ...prev, videoStartMs: computedStartMs } : prev
      );
      if (activeLap) {
        applyAutoSyncForVideo(computedStartMs, activeLap, 'gallery', vid.duration);
        return;
      }
    }

    if (pendingSeekSecRef.current !== null && Number.isFinite(vid.duration) && vid.duration > 0) {
      const clamped = Math.max(0, Math.min(vid.duration, pendingSeekSecRef.current));
      vid.currentTime = clamped;
      setActiveElapsedMs(Math.max(0, clamped * 1000 + totalOffsetMs));
      pendingSeekSecRef.current = null;
    }
  };

  const stopExportEarly = useCallback(() => {
    exportAbortRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      rec.stop();
    }
    const vid = videoRef.current;
    if (vid && !vid.paused) vid.pause();
  }, []);

  const handleExportHudVideo = async () => {
    if (activeLapSamples.length < 2) {
      setExportStatus('Sem amostras GPS suficientes para exportar.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setExportStatus('Seu navegador não suporta exportação de vídeo via MediaRecorder.');
      return;
    }

    const vid = videoRef.current;
    if (videoUrl && !vid) return;

    exportAbortRef.current = false;
    setIsExporting(true);
    setExportStatus('Renderizando vídeo com HUD...');
    if (exportedBlobUrl) {
      URL.revokeObjectURL(exportedBlobUrl);
      setExportedBlobUrl(null);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsExporting(false);
      setExportStatus('Falha ao inicializar canvas de exportação.');
      return;
    }

    const stream = canvas.captureStream(30);

    if (vid && videoUrl) {
      try {
        const vidWithStream = vid as HTMLVideoElement & {
          captureStream?: () => MediaStream;
        };
        const vStream = vidWithStream.captureStream?.();
        vStream?.getAudioTracks().forEach((track) => stream.addTrack(track));
      } catch {
        // Proceed with video-only track
      }
    }

    const mimeCandidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType =
      mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_500_000 })
      : new MediaRecorder(stream);
    recorderRef.current = recorder;

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };

    const donePromise = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        setExportedBlobUrl(url);
        setIsExporting(false);
        setExportStatus('Vídeo com HUD pronto! Baixando arquivo...');
        const a = document.createElement('a');
        a.href = url;
        a.download = `pitstop-hud-volta-${activeLap?.runNumber ?? 1}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        resolve();
      };
    });

    recorder.start(250);

    if (vid && videoUrl) {
      const startAt = autoSync ? Math.max(0, effectiveStartSeekSec) : 0;
      vid.currentTime = Number.isFinite(vid.duration) ? Math.min(vid.duration, startAt) : 0;
      await vid.play().catch(() => {});

      const drawLoop = () => {
        if (exportAbortRef.current || vid.ended || vid.paused) {
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        ctx.fillStyle = '#050608';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

        const elapsedMs = Math.max(0, vid.currentTime * 1000 + totalOffsetMs);
        const s =
          interpolateSampleAtElapsedMs(activeLapSamples, elapsedMs) ?? activeLapSamples[0];
        let cIdx = 0;
        let bDiff = Infinity;
        for (let i = 0; i < activeLapSamples.length; i += 1) {
          const d = Math.abs(activeLapSamples[i].stageElapsedMs - elapsedMs);
          if (d < bDiff) {
            bDiff = d;
            cIdx = i;
          }
        }
        drawHudOnCanvas(ctx, canvas.width, canvas.height, {
          sample: s,
          miniMapPts: miniMap.pts,
          sampleIndex: cIdx,
          bestMs: sessionOptimal.bestRunTotalMs,
          prevMs: previousRun?.totalMs ?? null,
          maxGaugeSpeed,
        });
        window.requestAnimationFrame(drawLoop);
      };
      window.requestAnimationFrame(drawLoop);
    } else {
      const lapTotalMs = activeLapSamples[activeLapSamples.length - 1].stageElapsedMs || 10000;
      const exportDurMs = Math.min(18000, Math.max(4000, lapTotalMs));
      const startWall = performance.now();

      const drawTelemetryOnly = () => {
        const wallElapsed = performance.now() - startWall;
        if (exportAbortRef.current || wallElapsed >= exportDurMs) {
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        const simElapsed = (wallElapsed / exportDurMs) * lapTotalMs;
        const s =
          interpolateSampleAtElapsedMs(activeLapSamples, simElapsed) ?? activeLapSamples[0];
        let cIdx = 0;
        let bDiff = Infinity;
        for (let i = 0; i < activeLapSamples.length; i += 1) {
          const d = Math.abs(activeLapSamples[i].stageElapsedMs - simElapsed);
          if (d < bDiff) {
            bDiff = d;
            cIdx = i;
          }
        }
        ctx.fillStyle = '#07090E';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawHudOnCanvas(ctx, canvas.width, canvas.height, {
          sample: s,
          miniMapPts: miniMap.pts,
          sampleIndex: cIdx,
          bestMs: sessionOptimal.bestRunTotalMs,
          prevMs: previousRun?.totalMs ?? null,
          maxGaugeSpeed,
        });
        window.requestAnimationFrame(drawTelemetryOnly);
      };
      window.requestAnimationFrame(drawTelemetryOnly);
    }

    await donePromise;
  };

  // Analog Speedometer geometry in SVG (viewBox 0 0 140 140)
  const spdVal = activeSample ? Math.round(activeSample.speedKmh || 0) : 0;
  const spdFrac = Math.max(0, Math.min(1, spdVal / maxGaugeSpeed));
  const needleAngleDeg = 135 + spdFrac * 270;
  const majorStep = maxGaugeSpeed >= 220 ? 40 : 20;
  const gaugeTicks = useMemo(() => {
    const arr: Array<{ v: number; angRad: number; isMajor: boolean }> = [];
    const step = majorStep / 2;
    for (let v = 0; v <= maxGaugeSpeed; v += step) {
      const angDeg = 135 + (v / maxGaugeSpeed) * 270;
      arr.push({ v, angRad: (angDeg * Math.PI) / 180, isMajor: v % majorStep === 0 });
    }
    return arr;
  }, [maxGaugeSpeed, majorStep]);

  const gX = Math.max(-1.2, Math.min(1.2, activeSample?.accelLatG ?? 0));
  const gY = Math.max(-1.2, Math.min(1.2, activeSample?.accelLongG ?? 0));
  const totalG = activeSample
    ? Math.hypot(activeSample.accelLatG ?? 0, activeSample.accelLongG ?? 0)
    : 0;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 text-[var(--ps-text)]">
      {/* Header + Import & Export Actions */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
              Vídeo &amp; Overlay HUD
            </h3>
            {autoSync?.active && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-extrabold text-[var(--ps-emerald)] tabular-nums">
                <Sparkles className="h-3 w-3 shrink-0" />
                <span>
                  AUTO-SYNC ATIVO ({formatSignedSeconds(effectiveStartSeekSec)})
                </span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--ps-muted)] tabular-nums">
            Sincronizado com{' '}
            <strong className="text-[var(--ps-text)]">
              {selectedLapSlot.toUpperCase()} #{activeLap?.runNumber ?? '-'}
            </strong>{' '}
            ({formatStageDuration(activeLap?.totalMs)})
            {loadedVideoMeta ? ` · ${loadedVideoMeta.filename}` : ''}.
          </p>
        </div>

        {/* V1 / V2 / V3 quick switcher when comparison laps are active */}
        {(lap2 || lap3) && (
          <div className="inline-flex self-start rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5 font-mono text-[11px] tabular-nums">
            <button
              type="button"
              onClick={() => setSelectedLapSlot('v1')}
              className={`rounded-md px-2.5 py-1 font-extrabold transition-colors ${
                selectedLapSlot === 'v1'
                  ? 'bg-emerald-600 text-white'
                  : 'text-[var(--ps-emerald)] hover:bg-[var(--ps-card)]'
              }`}
            >
              VOLTA 1
            </button>
            {lap2 && (
              <button
                type="button"
                onClick={() => setSelectedLapSlot('v2')}
                className={`rounded-md px-2.5 py-1 font-extrabold transition-colors ${
                  selectedLapSlot === 'v2'
                    ? 'bg-red-600 text-white'
                    : 'text-[var(--ps-danger)] hover:bg-[var(--ps-card)]'
                }`}
              >
                VOLTA 2
              </button>
            )}
            {lap3 && (
              <button
                type="button"
                onClick={() => setSelectedLapSlot('v3')}
                className={`rounded-md px-2.5 py-1 font-extrabold transition-colors ${
                  selectedLapSlot === 'v3'
                    ? 'bg-sky-600 text-white'
                    : 'text-sky-500 hover:bg-[var(--ps-card)]'
                }`}
              >
                VOLTA 3
              </button>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons Row: Gallery + Buscar Vídeo da GoPro + Export */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="inline-flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)]">
          <Upload className="h-3.5 w-3.5 shrink-0 text-[var(--ps-accent)]" />
          <span className="truncate">
            {videoUrl ? 'Trocar Vídeo da Galeria' : 'Selecionar Vídeo da Galeria'}
          </span>
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
              setVideoUrl(URL.createObjectURL(file));
              setExportedBlobUrl(null);
              setExportStatus(null);
              setAutoSync(null);
              setFineOffsetMs(0);
              pendingSeekSecRef.current = null;
              setLoadedVideoMeta({
                source: 'gallery',
                filename: file.name,
                videoStartMs: null,
                fileLastModifiedMs: file.lastModified,
              });
            }}
          />
        </label>

        <button
          type="button"
          onClick={() => {
            void handleOpenGoProMediaBrowser();
          }}
          className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-sky-500/50 bg-sky-500/10 px-3 text-xs font-extrabold text-[var(--ps-text)] hover:border-sky-400 hover:bg-sky-500/20"
        >
          <Camera className="h-3.5 w-3.5 shrink-0 text-sky-400" />
          <span className="truncate">BUSCAR VÍDEO DA GOPRO</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-black uppercase ${
              connectedGoPro
                ? 'bg-emerald-500/20 text-[var(--ps-emerald)]'
                : hasPairedGoPro
                ? 'bg-amber-500/20 text-[var(--ps-amber)]'
                : 'bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
            }`}
          >
            {connectedGoPro ? 'Pareada' : hasPairedGoPro ? 'Salva' : 'Wi-Fi'}
          </span>
        </button>

        {isExporting ? (
          <button
            type="button"
            onClick={stopExportEarly}
            className="pitstop-btn-red inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-extrabold"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <Square className="h-3 w-3 fill-current" />
            <span>Parar e Salvar</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              void handleExportHudVideo();
            }}
            disabled={activeLapSamples.length < 2}
            className="pitstop-btn-red inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-extrabold disabled:opacity-40"
          >
            <Video className="h-3.5 w-3.5 shrink-0" />
            <span>Exportar Vídeo com HUD</span>
          </button>
        )}
      </div>

      {/* 16:9 Responsive Video + RaceChrono Pro HUD */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[#050608]">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            onLoadedMetadata={handleVideoLoadedMetadata}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center p-4 text-center">
            <Film className="h-8 w-8 text-zinc-600" />
            <p className="mt-2 max-w-sm text-xs text-zinc-400">
              Selecione um vídeo da galeria ou busque direto da GoPro para sincronizar o Overlay HUD.
            </p>
          </div>
        )}

        {activeSample && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2 sm:p-3">
            {/* TOP ROW: Left Mini-Map + Center 3-Column Timers */}
            <div className="flex items-start justify-between gap-2">
              <div className="rounded-lg border border-white/20 bg-black/50 p-1 backdrop-blur-xs shadow-lg">
                <svg
                  viewBox="0 0 120 92"
                  className="h-12 w-16 sm:h-20 sm:w-28"
                  aria-label="Mini-mapa do traçado"
                >
                  {miniMap.polyline && (
                    <>
                      <polyline
                        fill="none"
                        stroke="rgba(0,0,0,0.85)"
                        strokeWidth="4.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={miniMap.polyline}
                      />
                      <polyline
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={miniMap.polyline}
                      />
                    </>
                  )}
                  {activeMapPt && (
                    <g>
                      <circle
                        cx={activeMapPt.x}
                        cy={activeMapPt.y}
                        r="6.5"
                        fill="rgba(255, 42, 42, 0.45)"
                        className="animate-pulse"
                      />
                      <circle
                        cx={activeMapPt.x}
                        cy={activeMapPt.y}
                        r="3.8"
                        fill="#FF2A2A"
                        stroke="#FFFFFF"
                        strokeWidth="1.5"
                      />
                    </g>
                  )}
                </svg>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-5 rounded-lg border border-white/20 bg-black/55 px-2.5 py-1 sm:px-4 sm:py-1.5 backdrop-blur-xs shadow-lg font-mono tabular-nums text-center">
                <div>
                  <p className="text-[8px] sm:text-[10px] font-bold tracking-wider text-zinc-300 uppercase">
                    MELHOR
                  </p>
                  <p className="text-[11px] sm:text-base font-black text-[#10B981] leading-tight drop-shadow">
                    {formatStageDuration(sessionOptimal.bestRunTotalMs)}
                  </p>
                </div>
                <div>
                  <p className="text-[8px] sm:text-[10px] font-bold tracking-wider text-zinc-300 uppercase">
                    ANTERIOR
                  </p>
                  <p className="text-[11px] sm:text-base font-black text-zinc-200 leading-tight drop-shadow">
                    {formatStageDuration(previousRun?.totalMs ?? null)}
                  </p>
                </div>
                <div>
                  <p className="text-[8px] sm:text-[10px] font-bold tracking-wider text-zinc-300 uppercase">
                    ATUAL
                  </p>
                  <p className="text-[11px] sm:text-base font-black text-white leading-tight drop-shadow">
                    {formatStageDuration(activeSample.stageElapsedMs)}
                  </p>
                </div>
              </div>

              <div className="hidden sm:block sm:w-28" aria-hidden="true" />
            </div>

            {/* BOTTOM-CENTER: Alvo Força G + Velocímetro Analógico Redondo */}
            <div className="mb-4 sm:mb-7 flex items-end justify-center gap-4 sm:gap-7">
              <div className="flex flex-col items-center">
                <div className="relative h-16 w-16 sm:h-24 sm:w-24 rounded-full border-2 border-white/30 bg-black/65 backdrop-blur-xs shadow-xl">
                  <div className="absolute inset-3 sm:inset-5 rounded-full border border-white/20" />
                  <div className="absolute inset-x-1.5 top-1/2 h-px bg-white/25" />
                  <div className="absolute inset-y-1.5 left-1/2 w-px bg-white/25" />
                  <div
                    className="absolute h-2.5 w-2.5 sm:h-3 sm:w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[#FF2A2A] shadow-[0_0_8px_rgba(255,42,42,0.9)] transition-all duration-75"
                    style={{
                      left: `${50 + (gX / 1.2) * 40}%`,
                      top: `${50 - (gY / 1.2) * 40}%`,
                    }}
                  />
                </div>
                <span className="mt-1 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[9px] sm:text-[11px] font-black text-white tabular-nums shadow">
                  {totalG.toFixed(2)} G
                </span>
              </div>

              <div className="relative h-22 w-22 sm:h-32 sm:w-32 rounded-full border-2 border-white/30 bg-black/70 backdrop-blur-xs shadow-xl">
                <svg viewBox="0 0 140 140" className="h-full w-full">
                  {gaugeTicks.map((t) => {
                    const rOuter = 62;
                    const rInner = t.isMajor ? 53 : 57;
                    const x1 = 70 + Math.cos(t.angRad) * rInner;
                    const y1 = 70 + Math.sin(t.angRad) * rInner;
                    const x2 = 70 + Math.cos(t.angRad) * rOuter;
                    const y2 = 70 + Math.sin(t.angRad) * rOuter;
                    const tx = 70 + Math.cos(t.angRad) * 42;
                    const ty = 70 + Math.sin(t.angRad) * 42;
                    const isRedZone = t.v >= maxGaugeSpeed * 0.8;
                    return (
                      <g key={t.v}>
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke={isRedZone ? '#FF2A2A' : '#E2E8F0'}
                          strokeWidth={t.isMajor ? 2.2 : 1.2}
                        />
                        {t.isMajor && (
                          <text
                            x={tx}
                            y={ty}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill="#CBD5E1"
                            fontSize="8.5"
                            fontFamily="monospace"
                            fontWeight="700"
                          >
                            {t.v}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  <g transform={`rotate(${needleAngleDeg} 70 70)`}>
                    <line
                      x1="70"
                      y1="70"
                      x2="122"
                      y2="70"
                      stroke="#FF2A2A"
                      strokeWidth="3.2"
                      strokeLinecap="round"
                    />
                  </g>
                  <circle cx="70" cy="70" r="5" fill="#FF2A2A" stroke="#FFFFFF" strokeWidth="1.5" />

                  <circle cx="70" cy="96" r="22" fill="rgba(0,0,0,0.78)" />
                  <text
                    x="70"
                    y="98"
                    textAnchor="middle"
                    fill="#FFFFFF"
                    fontSize="22"
                    fontFamily="monospace"
                    fontWeight="900"
                  >
                    {spdVal}
                  </text>
                  <text
                    x="70"
                    y="110"
                    textAnchor="middle"
                    fill="#94A3B8"
                    fontSize="7.5"
                    fontFamily="monospace"
                    fontWeight="700"
                  >
                    KM/H
                  </text>
                </svg>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controles de Sincronia Vídeo vs GPS + Ajuste Fino */}
      <div className="space-y-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 font-mono text-xs tabular-nums">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[var(--ps-muted)]">
              Largada no Vídeo:{' '}
              <strong className="text-[var(--ps-amber)]">
                {formatSignedSeconds(effectiveStartSeekSec)}
              </strong>
            </span>
            {autoSync?.active && (
              <span className="text-[10px] text-[var(--ps-emerald)] font-bold">
                [{autoSync.sourceLabel}]
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {[-500, -100, 100, 500].map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setFineOffsetMs((v) => v + step)}
                className="min-h-[32px] rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 py-1 text-[10px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                {step > 0 ? `+${(step / 1000).toFixed(1)}s` : `${(step / 1000).toFixed(1)}s`}
              </button>
            ))}
            {autoSync?.active && videoRef.current && (
              <button
                type="button"
                onClick={() => {
                  setFineOffsetMs(0);
                  const vid = videoRef.current;
                  if (vid) {
                    const seek = Math.max(0, Math.min(vid.duration || Infinity, autoSync.startSeekSec));
                    vid.currentTime = seek;
                  }
                }}
                className="inline-flex min-h-[32px] items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-[var(--ps-emerald)]"
                title="Voltar para o frame exato calculado pelo Auto-Sync"
              >
                <RotateCcw className="h-3 w-3" />
                <span>Largada</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setAutoSync(null);
                setFineOffsetMs(0);
              }}
              className="min-h-[32px] rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 py-1 text-[10px] font-bold text-[var(--ps-muted)]"
            >
              0
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-[var(--ps-muted)]">
            <span>
              Ajuste fino manual (-10s a +10s{autoSync?.active ? ' sobre Auto-Sync' : ''})
            </span>
            <span>{formatSignedSeconds(fineOffsetMs / 1000, 2)}</span>
          </div>
          <input
            type="range"
            aria-label="Ajuste fino de sincronia entre vídeo e GPS"
            min={-10000}
            max={10000}
            step={50}
            value={Math.max(-10000, Math.min(10000, fineOffsetMs))}
            onChange={(e) => setFineOffsetMs(Number(e.target.value))}
            className="w-full accent-[var(--ps-accent)]"
          />
        </div>

        {!videoUrl && activeLapSamples.length > 1 && (
          <div className="space-y-1 border-t border-[var(--ps-border)] pt-2">
            <span className="text-[10px] text-[var(--ps-muted)]">
              Pré-visualização da volta no HUD
            </span>
            <input
              type="range"
              aria-label="Linha do tempo de pré-visualização do HUD"
              min={0}
              max={activeLapSamples.length - 1}
              value={previewSampleIdx}
              onChange={(e) => setPreviewSampleIdx(Number(e.target.value))}
              className="w-full accent-[var(--ps-emerald)]"
            />
          </div>
        )}

        {(exportStatus || exportedBlobUrl) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ps-border)] pt-2 text-[11px]">
            <span className="text-[var(--ps-emerald)] font-bold">
              {exportStatus || 'Exportação concluída!'}
            </span>
            {exportedBlobUrl && (
              <a
                href={exportedBlobUrl}
                download={`pitstop-hud-volta-${activeLap?.runNumber ?? 1}.webm`}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ps-emerald)] bg-emerald-500/15 px-2.5 py-1 font-extrabold text-[var(--ps-emerald)] hover:bg-emerald-500/25"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Baixar Vídeo (.webm)</span>
              </a>
            )}
          </div>
        )}
      </div>

      {/* Modal: Buscador de Mídia da GoPro (Wi-Fi AP BLE 0x17 + HTTP 10.5.5.9:8080/gp/gpMediaList) */}
      {goproModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-2 backdrop-blur-xs sm:items-center sm:p-4">
          <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[var(--ps-border)] px-4 py-3">
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-sky-400" />
                <div>
                  <h4 className="font-['Barlow_Condensed'] text-lg font-extrabold uppercase tracking-wide">
                    Mídia da GoPro via Wi-Fi
                  </h4>
                  <p className="text-[11px] text-[var(--ps-muted)]">
                    {connectedGoPro
                      ? `Câmera BLE: ${getGoProDisplayName(connectedGoPro)}`
                      : 'Consulta direta em http://10.5.5.9:8080/gp/gpMediaList'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGoproModalOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                aria-label="Fechar buscador da GoPro"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 overflow-y-auto p-4">
              {/* Passo 1: Status Wi-Fi AP via BLE */}
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <p className="font-extrabold text-[var(--ps-text)] flex items-center gap-1.5">
                      {goproApLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                      )}
                      <span>1. Ponto de Acesso Wi-Fi da GoPro</span>
                    </p>
                    <p className="text-[11px] text-[var(--ps-muted)] leading-snug">
                      {goproApStatus ||
                        'Ative o Wi-Fi da câmera (via BLE) e conecte este aparelho na rede Wi-Fi da GoPro.'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  {hasPairedGoPro && (
                    <button
                      type="button"
                      disabled={goproApLoading}
                      onClick={async () => {
                        setGoproApLoading(true);
                        const res = await enableGoProWifiAP();
                        setGoproApLoading(false);
                        setGoproApStatus(
                          res.ok
                            ? `Wi-Fi AP ativado via BLE em "${res.cameraName}". Conecte na rede Wi-Fi da GoPro.`
                            : res.error || 'Falha ao ativar Wi-Fi AP via BLE.'
                        );
                      }}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 text-[11px] font-bold text-[var(--ps-text)] hover:border-sky-400 disabled:opacity-50"
                    >
                      <Wifi className="h-3.5 w-3.5 text-sky-400" />
                      <span>Ativar Wi-Fi via BLE</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={goproMediaLoading}
                    onClick={() => {
                      void loadGoProListAndThumbs();
                    }}
                    className="pitstop-btn-red inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-[11px] font-extrabold disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${goproMediaLoading ? 'animate-spin' : ''}`}
                    />
                    <span>{goproMediaLoading ? 'Buscando...' : 'Atualizar Lista'}</span>
                  </button>
                </div>
              </div>

              {goproMediaError && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-[var(--ps-amber)]">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{goproMediaError}</span>
                </div>
              )}

              {/* Lista de Vídeos MP4 */}
              {goproMediaLoading && goproMediaList.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-xs text-[var(--ps-muted)]">
                  <Loader2 className="h-6 w-6 animate-spin text-sky-400" />
                  <span className="mt-2">Consultando cartão SD em 10.5.5.9:8080...</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {goproMediaList.map((item) => {
                    const thumbSrc = goproThumbs[item.id];
                    const isDownloading = downloadingMediaId === item.id;
                    const nearActiveLap =
                      Boolean(activeLap && item.createdAtMs > 0) &&
                      Math.abs((activeLap?.startedAtMs ?? 0) - item.createdAtMs) <= 30 * 60 * 1000;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={Boolean(downloadingMediaId)}
                        onClick={() => {
                          void handleSelectGoProMediaItem(item);
                        }}
                        className="flex w-full items-center gap-3 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 text-left transition-colors hover:border-sky-400 disabled:opacity-60"
                      >
                        <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-[var(--ps-border)] bg-black">
                          {thumbSrc ? (
                            <img
                              src={thumbSrc}
                              alt={item.filename}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-zinc-600">
                              <Film className="h-5 w-5" />
                            </div>
                          )}
                          {isDownloading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                              <Loader2 className="h-5 w-5 animate-spin text-sky-400" />
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-xs font-extrabold text-[var(--ps-text)]">
                              {item.filename}
                            </span>
                            {nearActiveLap && (
                              <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] font-black text-[var(--ps-emerald)] uppercase">
                                Volta Match
                              </span>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                            <span>{formatMediaDate(item.createdAtMs)}</span>
                            <span>{formatFileSize(item.sizeBytes)}</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
