import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Download,
  Film,
  Gauge,
  Loader2,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Square,
  Unlock,
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
  sessionRuns?: VelocityRun[];
  sessionOptimal?: OptimalStageSummary;
}

interface LoadedVideoMeta {
  source: 'gopro' | 'gallery';
  filename: string;
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

function formatVideoClockSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00.0';
  const mins = Math.floor(sec / 60);
  const rem = sec - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
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
    lapLabel: string;
    maxGaugeSpeed: number;
    showGForce: boolean;
  }
) {
  const { sample, miniMapPts, sampleIndex, lapLabel, maxGaugeSpeed, showGForce } = params;
  const s = w / 1280;

  ctx.save();

  // 1. TOP-LEFT: Traçado Transparente (Sem Caixa de Fundo)
  if (miniMapPts.length >= 2) {
    const mapX = 24 * s;
    const mapY = 20 * s;
    const mapW = 128 * s;
    const mapH = 92 * s;
    const sx = mapW / 120;
    const sy = mapH / 92;

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.lineWidth = 4.2 * s;
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

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.lineWidth = 2 * s;
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
      ctx.fillStyle = 'rgba(255, 42, 42, 0.4)';
      ctx.beginPath();
      ctx.arc(cx, cy, 7.5 * s, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FF2A2A';
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.6 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, 4.2 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 2. TOP-RIGHT: Cronômetro limpo apenas da volta selecionada
  const timerW = 186 * s;
  const timerH = 48 * s;
  const timerX = w - timerW - 24 * s;
  const timerY = 20 * s;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.roundRect(timerX, timerY, timerW, timerH, 10 * s);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(226, 232, 240, 0.8)';
  ctx.font = `700 ${Math.round(10 * s)}px monospace`;
  ctx.fillText(lapLabel, timerX + timerW - 14 * s, timerY + 16 * s);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${Math.round(22 * s)}px monospace`;
  ctx.fillText(
    formatStageDuration(sample.stageElapsedMs),
    timerX + timerW - 14 * s,
    timerY + 39 * s
  );

  // 3. BOTTOM-CENTER: Velocímetro Compacto + Alvo Força G Opcional (Estilo GoPro)
  const baseCenterY = h - 78 * s;
  const speedCenterX = showGForce ? w / 2 + 56 * s : w / 2;
  const gCenterX = w / 2 - 68 * s;

  if (showGForce) {
    const gR = 39 * s;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.arc(gCenterX, baseCenterY, gR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    ctx.arc(gCenterX, baseCenterY, gR * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(gCenterX - gR + 4 * s, baseCenterY);
    ctx.lineTo(gCenterX + gR - 4 * s, baseCenterY);
    ctx.moveTo(gCenterX, baseCenterY - gR + 4 * s);
    ctx.lineTo(gCenterX, baseCenterY + gR - 4 * s);
    ctx.stroke();

    const latG = Math.max(-1.2, Math.min(1.2, sample.accelLatG ?? 0));
    const longG = Math.max(-1.2, Math.min(1.2, sample.accelLongG ?? 0));
    const totalG = Math.hypot(sample.accelLatG ?? 0, sample.accelLongG ?? 0);
    const dotX = gCenterX + (latG / 1.2) * (gR - 7 * s);
    const dotY = baseCenterY - (longG / 1.2) * (gR - 7 * s);

    ctx.fillStyle = 'rgba(255, 42, 42, 0.35)';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 7 * s, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FF2A2A';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3.8 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `800 ${Math.round(11 * s)}px monospace`;
    ctx.fillText(`${totalG.toFixed(2)} G`, gCenterX, baseCenterY + gR + 14 * s);
  }

  const spdR = 52 * s;
  const gaugeCy = baseCenterY - 2 * s;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.54)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.26)';
  ctx.lineWidth = 1.8 * s;
  ctx.beginPath();
  ctx.arc(speedCenterX, gaugeCy, spdR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const startAng = (135 * Math.PI) / 180;
  const endAng = (405 * Math.PI) / 180;
  const sweep = endAng - startAng;

  const majorStep = maxGaugeSpeed >= 220 ? 40 : 20;
  const minorStep = majorStep / 2;
  for (let v = 0; v <= maxGaugeSpeed; v += minorStep) {
    const frac = v / maxGaugeSpeed;
    const ang = startAng + frac * sweep;
    const isMajor = v % majorStep === 0;
    const rOuter = spdR - 5 * s;
    const rInner = rOuter - (isMajor ? 7 * s : 3.5 * s);
    ctx.strokeStyle = v >= maxGaugeSpeed * 0.8 ? '#FF2A2A' : 'rgba(226, 232, 240, 0.85)';
    ctx.lineWidth = isMajor ? 1.6 * s : 1 * s;
    ctx.beginPath();
    ctx.moveTo(speedCenterX + Math.cos(ang) * rInner, gaugeCy + Math.sin(ang) * rInner);
    ctx.lineTo(speedCenterX + Math.cos(ang) * rOuter, gaugeCy + Math.sin(ang) * rOuter);
    ctx.stroke();

    if (isMajor) {
      const rTxt = spdR - 17 * s;
      ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.font = `700 ${Math.round(7.5 * s)}px monospace`;
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
  ctx.lineWidth = 2.4 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(speedCenterX, gaugeCy);
  ctx.lineTo(
    speedCenterX + Math.cos(needleAng) * (spdR - 10 * s),
    gaugeCy + Math.sin(needleAng) * (spdR - 10 * s)
  );
  ctx.stroke();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.beginPath();
  ctx.arc(speedCenterX, gaugeCy + 11 * s, 19 * s, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${Math.round(20 * s)}px monospace`;
  ctx.fillText(String(Math.round(sample.speedKmh || 0)), speedCenterX, gaugeCy + 15 * s);
  ctx.fillStyle = '#94A3B8';
  ctx.font = `700 ${Math.round(7.5 * s)}px monospace`;
  ctx.fillText('KM/H', speedCenterX, gaugeCy + 25 * s);

  ctx.restore();
}

export const VideoHudOverlayPanel: React.FC<VideoHudOverlayPanelProps> = React.memo(({
  lap1,
  lap2 = null,
  lap3 = null,
  lap1Samples,
  lap2Samples = [],
  lap3Samples = [],
}) => {
  const goproFleet = useGoProFleet();
  const hasPairedGoPro =
    goproFleet.cameras.length > 0 || goproFleet.savedDevices.length > 0;
  const connectedGoPro = goproFleet.cameras.find((c) => c.connected && !c.sleeping) ?? null;

  const [selectedLapSlot, setSelectedLapSlot] = useState<'v1' | 'v2' | 'v3'>('v1');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadedVideoMeta, setLoadedVideoMeta] = useState<LoadedVideoMeta | null>(null);

  // HUD clean options
  const [showGForceHud, setShowGForceHud] = useState(true);

  // 2-Step Manual Sync State (Video <-> Telemetry)
  const [syncLocked, setSyncLocked] = useState(false);
  const [lockedSyncOffsetMs, setLockedSyncOffsetMs] = useState(0);
  const [manualTelemetryMs, setManualTelemetryMs] = useState(0);
  const [telemetryPlaying, setTelemetryPlaying] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoCurrentSec, setVideoCurrentSec] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const [activeElapsedMs, setActiveElapsedMs] = useState(0);

  // Export state
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
  const exportAbortRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const goproThumbsRef = useRef<Record<string, string>>({});
  goproThumbsRef.current = goproThumbs;

  const activeLap = useMemo(() => {
    if (selectedLapSlot === 'v2' && lap2) return lap2;
    if (selectedLapSlot === 'v3' && lap3) return lap3;
    return lap1;
  }, [selectedLapSlot, lap1, lap2, lap3]);

  const activeLapLabel =
    selectedLapSlot === 'v2' ? 'VOLTA 2' : selectedLapSlot === 'v3' ? 'VOLTA 3' : 'VOLTA 1';

  const activeLapSamples = useMemo(() => {
    if (selectedLapSlot === 'v2' && lap2 && lap2Samples.length > 0) return lap2Samples;
    if (selectedLapSlot === 'v3' && lap3 && lap3Samples.length > 0) return lap3Samples;
    return lap1Samples;
  }, [selectedLapSlot, lap1Samples, lap2, lap2Samples, lap3, lap3Samples]);

  const lapTotalMs = useMemo(() => {
    if (activeLapSamples.length > 0) {
      const last = activeLapSamples[activeLapSamples.length - 1].stageElapsedMs;
      if (last > 0) return last;
    }
    return Math.max(1000, activeLap?.totalMs ?? 10000);
  }, [activeLapSamples, activeLap]);

  useEffect(() => {
    if (selectedLapSlot === 'v2' && !lap2) setSelectedLapSlot('v1');
    if (selectedLapSlot === 'v3' && !lap3) setSelectedLapSlot('v1');
  }, [selectedLapSlot, lap2, lap3]);

  // Reset manual telemetry & sync lock when switching laps
  useEffect(() => {
    setSyncLocked(false);
    setTelemetryPlaying(false);
    setManualTelemetryMs(0);
    setActiveElapsedMs(0);
  }, [activeLap?.id]);

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

  const maxGaugeSpeed = useMemo(
    () => getSpeedometerMax(activeLapSamples),
    [activeLapSamples]
  );

  const miniMap = useMemo(
    () => normalizeTrackPoints(activeLapSamples, 120, 92, 10),
    [activeLapSamples]
  );

  // Independent Telemetry Playback loop when unlocked
  useEffect(() => {
    if (syncLocked || !telemetryPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dt = Math.max(0, Math.min(120, now - lastTs));
      lastTs = now;
      setManualTelemetryMs((prev) => {
        const next = prev + dt;
        if (next >= lapTotalMs) {
          setTelemetryPlaying(false);
          return lapTotalMs;
        }
        return next;
      });
      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [syncLocked, telemetryPlaying, lapTotalMs]);

  // Video playback & time listener
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoUrl) {
      setVideoPlaying(false);
      setVideoCurrentSec(0);
      setVideoDurationSec(0);
      return;
    }

    let rafId = 0;

    const syncFromVideo = () => {
      const curSec = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
      const durSec = Number.isFinite(vid.duration) ? vid.duration : 0;
      setVideoCurrentSec(curSec);
      if (durSec > 0) setVideoDurationSec(durSec);
      if (syncLocked) {
        setActiveElapsedMs(Math.max(0, Math.min(lapTotalMs, curSec * 1000 + lockedSyncOffsetMs)));
      }
    };

    const tick = () => {
      syncFromVideo();
      if (!vid.paused && !vid.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      setVideoPlaying(true);
      rafId = window.requestAnimationFrame(tick);
    };
    const onPauseOrEnd = () => {
      setVideoPlaying(false);
      window.cancelAnimationFrame(rafId);
      syncFromVideo();
    };

    vid.addEventListener('play', onPlay);
    vid.addEventListener('pause', onPauseOrEnd);
    vid.addEventListener('ended', onPauseOrEnd);
    vid.addEventListener('timeupdate', syncFromVideo);
    vid.addEventListener('seeked', syncFromVideo);
    syncFromVideo();

    return () => {
      window.cancelAnimationFrame(rafId);
      vid.removeEventListener('play', onPlay);
      vid.removeEventListener('pause', onPauseOrEnd);
      vid.removeEventListener('ended', onPauseOrEnd);
      vid.removeEventListener('timeupdate', syncFromVideo);
      vid.removeEventListener('seeked', syncFromVideo);
    };
  }, [videoUrl, syncLocked, lockedSyncOffsetMs, lapTotalMs]);

  // Keep activeElapsedMs aligned when unlocked
  useEffect(() => {
    if (!syncLocked) {
      setActiveElapsedMs(Math.max(0, Math.min(lapTotalMs, manualTelemetryMs)));
    }
  }, [syncLocked, manualTelemetryMs, lapTotalMs]);

  const effectiveElapsedMs = syncLocked ? activeElapsedMs : manualTelemetryMs;

  const activeSampleData = useMemo(() => {
    if (activeLapSamples.length === 0) return { sample: null, idx: 0 };
    const clampedMs = Math.max(0, Math.min(lapTotalMs, effectiveElapsedMs));
    const sample = interpolateSampleAtElapsedMs(activeLapSamples, clampedMs);
    let closestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < activeLapSamples.length; i += 1) {
      const d = Math.abs(activeLapSamples[i].stageElapsedMs - clampedMs);
      if (d < bestDiff) {
        bestDiff = d;
        closestIdx = i;
      }
    }
    return { sample: sample ?? activeLapSamples[closestIdx], idx: closestIdx };
  }, [activeLapSamples, effectiveElapsedMs, lapTotalMs]);

  const activeSample = activeSampleData.sample;
  const activeMapPt = miniMap.pts[activeSampleData.idx] ?? miniMap.pts[0] ?? null;

  const toggleVideoPlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused || vid.ended) {
      void vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  };

  const stepVideoSeconds = (deltaSec: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 999999;
    const nextSec = Math.max(0, Math.min(dur, (vid.currentTime || 0) + deltaSec));
    vid.currentTime = nextSec;
    setVideoCurrentSec(nextSec);
  };

  const stepTelemetryMs = (deltaMs: number) => {
    if (syncLocked) {
      setLockedSyncOffsetMs((prev) => prev + deltaMs);
      return;
    }
    setManualTelemetryMs((prev) => Math.max(0, Math.min(lapTotalMs, prev + deltaMs)));
  };

  const handleLockSyncHere = () => {
    const vid = videoRef.current;
    if (vid && !vid.paused) vid.pause();
    setTelemetryPlaying(false);
    const curVidSec = vid && Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    const offset = Math.round(manualTelemetryMs - curVidSec * 1000);
    setLockedSyncOffsetMs(offset);
    setSyncLocked(true);
    setActiveElapsedMs(Math.max(0, Math.min(lapTotalMs, curVidSec * 1000 + offset)));
  };

  const handleUnlockSync = () => {
    const vid = videoRef.current;
    if (vid && !vid.paused) vid.pause();
    setTelemetryPlaying(false);
    const curVidSec = vid && Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    const curTelemetry = Math.max(0, Math.min(lapTotalMs, curVidSec * 1000 + lockedSyncOffsetMs));
    setManualTelemetryMs(curTelemetry);
    setSyncLocked(false);
  };

  const loadGoProListAndThumbs = useCallback(async () => {
    setGoproMediaLoading(true);
    setGoproMediaError(null);
    try {
      const items = await fetchGoProMediaList();
      setGoproMediaList(items);
      if (items.length === 0) {
        setGoproMediaError('Nenhum vídeo MP4 encontrado no cartão SD da GoPro.');
      } else {
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
      setSyncLocked(false);
      setTelemetryPlaying(false);
      setManualTelemetryMs(0);
      setVideoUrl(downloaded.url);
      setLoadedVideoMeta({
        source: 'gopro',
        filename: item.filename,
      });
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
    if (Number.isFinite(vid.duration) && vid.duration > 0) {
      setVideoDurationSec(vid.duration);
    }
    setVideoCurrentSec(vid.currentTime || 0);
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
      const activeOffsetMs = syncLocked
        ? lockedSyncOffsetMs
        : Math.round(manualTelemetryMs - (vid.currentTime || 0) * 1000);
      const startAtSec = syncLocked
        ? Math.max(0, Math.min(vid.duration || Infinity, -activeOffsetMs / 1000))
        : vid.currentTime || 0;

      vid.currentTime = Number.isFinite(vid.duration)
        ? Math.max(0, Math.min(vid.duration, startAtSec))
        : 0;
      await vid.play().catch(() => {});

      const drawLoop = () => {
        if (exportAbortRef.current || vid.ended || vid.paused) {
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        ctx.fillStyle = '#050608';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

        const elapsedMs = Math.max(0, Math.min(lapTotalMs, vid.currentTime * 1000 + activeOffsetMs));
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
          lapLabel: activeLapLabel,
          maxGaugeSpeed,
          showGForce: showGForceHud,
        });
        window.requestAnimationFrame(drawLoop);
      };
      window.requestAnimationFrame(drawLoop);
    } else {
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
          lapLabel: activeLapLabel,
          maxGaugeSpeed,
          showGForce: showGForceHud,
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
      {/* Header + Lap Selector */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
              Vídeo &amp; Overlay HUD
            </h3>
            {syncLocked && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-extrabold text-[var(--ps-emerald)]">
                <Lock className="h-3 w-3 shrink-0" />
                <span>SINCRONIA TRAVADA</span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--ps-muted)] tabular-nums">
            Exibindo{' '}
            <strong className="text-[var(--ps-text)]">{activeLapLabel}</strong> (
            {formatStageDuration(activeLap?.totalMs)})
            {loadedVideoMeta ? ` · ${loadedVideoMeta.filename}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowGForceHud((v) => !v)}
            aria-pressed={showGForceHud}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-bold transition-colors ${
              showGForceHud
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                : 'border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)]'
            }`}
          >
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            <span>Força G: {showGForceHud ? 'ON' : 'OFF'}</span>
          </button>

          {(lap2 || lap3) && (
            <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5 font-mono text-[11px] tabular-nums">
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
              setSyncLocked(false);
              setTelemetryPlaying(false);
              setManualTelemetryMs(0);
              setVideoCurrentSec(0);
              setVideoDurationSec(0);
              setLoadedVideoMeta({
                source: 'gallery',
                filename: file.name,
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

      {/* 16:9 Video + Proportional GoPro Quik Style HUD */}
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
              Selecione um vídeo da galeria ou da GoPro para alinhar com a telemetria abaixo.
            </p>
          </div>
        )}

        {activeSample && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5 sm:p-3.5">
            {/* TOP ROW: Left Transparent Track Line + Right Single Selected Lap Stopwatch */}
            <div className="flex items-start justify-between gap-2">
              <div className="shrink-0">
                <svg
                  viewBox="0 0 120 92"
                  className="h-11 w-14 sm:h-16 sm:w-20 drop-shadow-[0_1px_3px_rgba(0,0,0,0.85)]"
                  aria-label="Traçado da pista"
                >
                  {miniMap.polyline && (
                    <>
                      <polyline
                        fill="none"
                        stroke="rgba(0,0,0,0.68)"
                        strokeWidth="3.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        points={miniMap.polyline}
                      />
                      <polyline
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth="1.7"
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
                        r="5.5"
                        fill="rgba(255, 42, 42, 0.42)"
                      />
                      <circle
                        cx={activeMapPt.x}
                        cy={activeMapPt.y}
                        r="3.2"
                        fill="#FF2A2A"
                        stroke="#FFFFFF"
                        strokeWidth="1.3"
                      />
                    </g>
                  )}
                </svg>
              </div>

              <div className="rounded-lg border border-white/15 bg-black/45 px-2.5 py-1 text-right font-mono tabular-nums backdrop-blur-xs">
                <p className="text-[8px] sm:text-[9px] font-bold tracking-wider text-zinc-300 uppercase leading-none">
                  {activeLapLabel}
                </p>
                <p className="mt-0.5 text-xs sm:text-base font-black text-white leading-tight drop-shadow">
                  {formatStageDuration(activeSample.stageElapsedMs)}
                </p>
              </div>
            </div>

            {/* BOTTOM-CENTER: Proportional GoPro-Style Compact Speedometer + Optional G-Force */}
            <div className="mb-3 sm:mb-6 flex items-end justify-center gap-3 sm:gap-4">
              {showGForceHud && (
                <div className="flex flex-col items-center">
                  <div className="relative h-12 w-12 sm:h-16 sm:w-16 rounded-full border border-white/25 bg-black/50 backdrop-blur-xs">
                    <div className="absolute inset-2.5 sm:inset-3.5 rounded-full border border-white/18" />
                    <div className="absolute inset-x-1 top-1/2 h-px bg-white/20" />
                    <div className="absolute inset-y-1 left-1/2 w-px bg-white/20" />
                    <div
                      className="absolute h-2 w-2 sm:h-2.5 sm:w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[#FF2A2A] shadow-[0_0_6px_rgba(255,42,42,0.9)] transition-all duration-75"
                      style={{
                        left: `${50 + (gX / 1.2) * 38}%`,
                        top: `${50 - (gY / 1.2) * 38}%`,
                      }}
                    />
                  </div>
                  <span className="mt-0.5 rounded bg-black/45 px-1 py-0.5 font-mono text-[8px] sm:text-[10px] font-black text-white tabular-nums">
                    {totalG.toFixed(2)} G
                  </span>
                </div>
              )}

              <div className="relative h-16 w-16 sm:h-22 sm:w-22 rounded-full border border-white/30 bg-black/55 backdrop-blur-xs">
                <svg viewBox="0 0 140 140" className="h-full w-full">
                  {gaugeTicks.map((t) => {
                    const rOuter = 62;
                    const rInner = t.isMajor ? 53 : 57;
                    const x1 = 70 + Math.cos(t.angRad) * rInner;
                    const y1 = 70 + Math.sin(t.angRad) * rInner;
                    const x2 = 70 + Math.cos(t.angRad) * rOuter;
                    const y2 = 70 + Math.sin(t.angRad) * rOuter;
                    const tx = 70 + Math.cos(t.angRad) * 41;
                    const ty = 70 + Math.sin(t.angRad) * 41;
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
                  <circle cx="70" cy="70" r="4.5" fill="#FF2A2A" stroke="#FFFFFF" strokeWidth="1.4" />

                  <circle cx="70" cy="96" r="22" fill="rgba(0,0,0,0.75)" />
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

      {/* 2-Step Intuitive Manual Sync Controls (Video <-> Telemetry) */}
      <div className="space-y-3 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-3 font-mono text-xs tabular-nums">
        {!syncLocked ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-bold text-[var(--ps-text)]">
                Passo 1 · Alinhe Vídeo e Telemetria separadamente
              </span>
              <span className="text-[10px] text-[var(--ps-muted)]">
                Pause o vídeo na largada e posicione o ponto no mapa
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {/* Controle Independente: VÍDEO */}
              <div className="space-y-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                    Vídeo
                  </span>
                  <span className="text-[11px] font-bold text-[var(--ps-muted)]">
                    {formatVideoClockSec(videoCurrentSec)} / {formatVideoClockSec(videoDurationSec)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!videoUrl}
                    onClick={toggleVideoPlay}
                    className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-[11px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)] disabled:opacity-40"
                  >
                    {videoPlaying ? (
                      <>
                        <Pause className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
                        <span>Pausar</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                        <span>Play</span>
                      </>
                    )}
                  </button>

                  {[-0.5, -0.1, 0.1, 0.5].map((secDelta) => (
                    <button
                      key={`vid-${secDelta}`}
                      type="button"
                      disabled={!videoUrl}
                      onClick={() => stepVideoSeconds(secDelta)}
                      className="min-h-[38px] flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-1.5 text-[10px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)] disabled:opacity-40"
                    >
                      {secDelta > 0 ? `+${secDelta.toFixed(1)}s` : `${secDelta.toFixed(1)}s`}
                    </button>
                  ))}
                </div>

                <input
                  type="range"
                  aria-label="Linha do tempo do vídeo"
                  disabled={!videoUrl || videoDurationSec <= 0}
                  min={0}
                  max={Math.max(1, videoDurationSec)}
                  step={0.05}
                  value={Math.min(videoCurrentSec, Math.max(1, videoDurationSec))}
                  onChange={(e) => {
                    const nextSec = Number(e.target.value);
                    if (videoRef.current) videoRef.current.currentTime = nextSec;
                    setVideoCurrentSec(nextSec);
                  }}
                  className="w-full accent-[var(--ps-accent)] disabled:opacity-40"
                />
              </div>

              {/* Controle Independente: TELEMETRIA */}
              <div className="space-y-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-extrabold tracking-wide text-[var(--ps-emerald)] uppercase">
                    Telemetria ({activeLapLabel})
                  </span>
                  <span className="text-[11px] font-bold text-[var(--ps-text)]">
                    {formatStageDuration(manualTelemetryMs)} / {formatStageDuration(lapTotalMs)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={activeLapSamples.length < 2}
                    onClick={() => setTelemetryPlaying((p) => !p)}
                    className="inline-flex min-h-[38px] items-center gap-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-[11px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-emerald)] disabled:opacity-40"
                  >
                    {telemetryPlaying ? (
                      <>
                        <Pause className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
                        <span>Pausar</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                        <span>Play</span>
                      </>
                    )}
                  </button>

                  {[-500, -100, 100, 500].map((msDelta) => (
                    <button
                      key={`tel-${msDelta}`}
                      type="button"
                      disabled={activeLapSamples.length < 2}
                      onClick={() => stepTelemetryMs(msDelta)}
                      className="min-h-[38px] flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-1.5 text-[10px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-emerald)] disabled:opacity-40"
                    >
                      {msDelta > 0
                        ? `+${(msDelta / 1000).toFixed(1)}s`
                        : `${(msDelta / 1000).toFixed(1)}s`}
                    </button>
                  ))}
                </div>

                <input
                  type="range"
                  aria-label="Linha do tempo da telemetria"
                  disabled={activeLapSamples.length < 2}
                  min={0}
                  max={lapTotalMs}
                  step={50}
                  value={Math.min(manualTelemetryMs, lapTotalMs)}
                  onChange={(e) => {
                    setTelemetryPlaying(false);
                    setManualTelemetryMs(Number(e.target.value));
                  }}
                  className="w-full accent-[var(--ps-emerald)] disabled:opacity-40"
                />
              </div>
            </div>

            {/* Passo 2: Botão Travar Sincronia Aqui */}
            <button
              type="button"
              disabled={!videoUrl || activeLapSamples.length < 2}
              onClick={handleLockSyncHere}
              className="pitstop-btn-red flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold uppercase tracking-wide disabled:opacity-40"
            >
              <Lock className="h-4 w-4 shrink-0" />
              <span>Travar Sincronia Aqui</span>
            </button>
          </>
        ) : (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 shrink-0 text-[var(--ps-emerald)]" />
                <div>
                  <p className="text-xs font-extrabold text-[var(--ps-emerald)]">
                    Sincronia Travada · Vídeo e Telemetria juntos
                  </p>
                  <p className="text-[10px] text-[var(--ps-muted)]">
                    Dê Play no vídeo para reproduzir e exportar com o HUD alinhado.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleUnlockSync}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 text-[11px] font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                <Unlock className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
                <span>Destravar / Ajustar</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                disabled={!videoUrl}
                onClick={toggleVideoPlay}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3.5 text-xs font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                {videoPlaying ? (
                  <>
                    <Pause className="h-4 w-4 text-[var(--ps-amber)]" />
                    <span>Pausar Vídeo</span>
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 text-[var(--ps-emerald)]" />
                    <span>Reproduzir Juntos</span>
                  </>
                )}
              </button>

              <div className="flex items-center gap-1">
                <span className="mr-1 text-[10px] text-[var(--ps-muted)]">Microajuste:</span>
                {[-500, -100, 100, 500].map((msDelta) => (
                  <button
                    key={`locked-${msDelta}`}
                    type="button"
                    onClick={() => stepTelemetryMs(msDelta)}
                    className="min-h-[36px] rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 text-[10px] font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-emerald)]"
                  >
                    {msDelta > 0
                      ? `+${(msDelta / 1000).toFixed(1)}s`
                      : `${(msDelta / 1000).toFixed(1)}s`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {(exportStatus || exportedBlobUrl) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ps-border)] pt-2 text-[11px]">
            <span className="font-bold text-[var(--ps-emerald)]">
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
});
