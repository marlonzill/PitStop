import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Film, Loader2, Square, Upload, Video } from 'lucide-react';
import {
  formatStageDuration,
  interpolateSampleAtElapsedMs,
  type OptimalStageSummary,
  type VelocityRun,
  type VelocitySample,
} from '../utils/velocityEngine';

interface VideoHudOverlayPanelProps {
  lap1: VelocityRun | null;
  lap1Samples: VelocitySample[];
  sessionRuns: VelocityRun[];
  sessionOptimal: OptimalStageSummary;
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
  const s = w / 1280; // scale factor relative to 1280x720

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

    // Scale normalized points (from 120x92 space) into map box
    const sx = mapW / 120;
    const sy = mapH / 92;

    // Dark shadow outline under track
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

    // Crisp white track line
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

    // Current car dot
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

  // 3. BOTTOM-CENTER: Apenas 2 Instrumentos Principais (Alvo Força G + Velocímetro Analógico)
  const baseCenterY = h - 104 * s;
  const gCenterX = w / 2 - 108 * s;
  const speedCenterX = w / 2 + 88 * s;

  // Instrumento 1 (Esquerda): Alvo Circular de Força G
  const gR = 64 * s;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(gCenterX, baseCenterY, gR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Inner 0.5G ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.arc(gCenterX, baseCenterY, gR * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // Crosshair X/Y
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

  // Valor numérico em G abaixo
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `900 ${Math.round(14 * s)}px monospace`;
  ctx.fillText(`${totalG.toFixed(2)} G`, gCenterX, baseCenterY + gR + 18 * s);

  // Instrumento 2 (Centro/Direita): Velocímetro Analógico Redondo
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

  // Graduated tick marks
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

  // Animated Red Needle
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

  // Digital speed center badge
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
  lap1Samples,
  sessionRuns,
  sessionOptimal,
}) => {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoOffsetMs, setVideoOffsetMs] = useState(0);
  const [previewSampleIdx, setPreviewSampleIdx] = useState(0);
  const [activeElapsedMs, setActiveElapsedMs] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportedBlobUrl, setExportedBlobUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const exportAbortRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      if (exportedBlobUrl) URL.revokeObjectURL(exportedBlobUrl);
    };
  }, [exportedBlobUrl]);

  // Previous lap time relative to lap1
  const previousRun = useMemo(() => {
    if (!lap1 || sessionRuns.length < 2) return null;
    const ordered = [...sessionRuns].sort((a, b) => a.startedAtMs - b.startedAtMs);
    const idx = ordered.findIndex((r) => r.id === lap1.id);
    if (idx > 0) return ordered[idx - 1];
    const fallback = ordered.find((r) => r.id !== lap1.id);
    return fallback ?? null;
  }, [lap1, sessionRuns]);

  const maxGaugeSpeed = useMemo(() => getSpeedometerMax(lap1Samples), [lap1Samples]);

  const miniMap = useMemo(
    () => normalizeTrackPoints(lap1Samples, 120, 92, 10),
    [lap1Samples]
  );

  // Sync HUD smoothly at 30fps during video playback
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoUrl) return;
    let rafId = 0;
    const tick = () => {
      const targetMs = Math.max(0, vid.currentTime * 1000 + videoOffsetMs);
      setActiveElapsedMs(targetMs);
      if (!vid.paused && !vid.ended) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    const onPlay = () => {
      rafId = window.requestAnimationFrame(tick);
    };
    const onSeekOrUpdate = () => {
      setActiveElapsedMs(Math.max(0, vid.currentTime * 1000 + videoOffsetMs));
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
  }, [videoUrl, videoOffsetMs]);

  const activeSampleData = useMemo(() => {
    if (lap1Samples.length === 0) return { sample: null, idx: 0 };
    if (!videoUrl) {
      const idx = Math.max(0, Math.min(lap1Samples.length - 1, previewSampleIdx));
      return { sample: lap1Samples[idx], idx };
    }
    const sample = interpolateSampleAtElapsedMs(lap1Samples, activeElapsedMs);
    let closestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < lap1Samples.length; i += 1) {
      const d = Math.abs(lap1Samples[i].stageElapsedMs - activeElapsedMs);
      if (d < bestDiff) {
        bestDiff = d;
        closestIdx = i;
      }
    }
    return { sample: sample ?? lap1Samples[closestIdx], idx: closestIdx };
  }, [lap1Samples, videoUrl, previewSampleIdx, activeElapsedMs]);

  const activeSample = activeSampleData.sample;
  const activeMapPt = miniMap.pts[activeSampleData.idx] ?? miniMap.pts[0] ?? null;

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
    if (lap1Samples.length < 2) {
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

    // Attach video audio track if browser supports captureStream on HTMLMediaElement
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
        a.download = `pitstop-hud-volta-${lap1?.runNumber ?? 1}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        resolve();
      };
    });

    recorder.start(250);

    if (vid && videoUrl) {
      vid.currentTime = 0;
      await vid.play().catch(() => {});

      const drawLoop = () => {
        if (exportAbortRef.current || vid.ended || vid.paused) {
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        ctx.fillStyle = '#050608';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

        const elapsedMs = Math.max(0, vid.currentTime * 1000 + videoOffsetMs);
        const s =
          interpolateSampleAtElapsedMs(lap1Samples, elapsedMs) ?? lap1Samples[0];
        let cIdx = 0;
        let bDiff = Infinity;
        for (let i = 0; i < lap1Samples.length; i += 1) {
          const d = Math.abs(lap1Samples[i].stageElapsedMs - elapsedMs);
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
      // Telemetry-only preview export (15 seconds compressed pass or full lap up to 20s)
      const lapTotalMs = lap1Samples[lap1Samples.length - 1].stageElapsedMs || 10000;
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
          interpolateSampleAtElapsedMs(lap1Samples, simElapsed) ?? lap1Samples[0];
        let cIdx = 0;
        let bDiff = Infinity;
        for (let i = 0; i < lap1Samples.length; i += 1) {
          const d = Math.abs(lap1Samples[i].stageElapsedMs - simElapsed);
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
  const needleAngleDeg = 135 + spdFrac * 270; // 135° (bottom-left) to 405° (bottom-right)
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
      {/* Header + Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-['Barlow_Condensed'] text-lg font-bold uppercase">
            Vídeo &amp; Overlay HUD
          </h3>
          <p className="text-[11px] text-[var(--ps-muted)]">
            Telemetria RaceChrono Pro sincronizada com a Volta 1 #{lap1?.runNumber ?? '-'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-3 text-xs font-extrabold text-[var(--ps-text)] hover:border-[var(--ps-accent)]">
            <Upload className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
            <span>{videoUrl ? 'Trocar Vídeo' : 'Abrir Vídeo MP4/MOV'}</span>
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (videoUrl) URL.revokeObjectURL(videoUrl);
                setVideoUrl(URL.createObjectURL(file));
                setExportedBlobUrl(null);
                setExportStatus(null);
              }}
            />
          </label>

          {isExporting ? (
            <button
              type="button"
              onClick={stopExportEarly}
              className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold"
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
              disabled={lap1Samples.length < 2}
              className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold disabled:opacity-40"
            >
              <Video className="h-3.5 w-3.5" />
              <span>Exportar Vídeo com HUD</span>
            </button>
          )}
        </div>
      </div>

      {/* 16:9 Responsive Video + RaceChrono Pro HUD */}
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--ps-border)] bg-[#050608]">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            playsInline
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center p-4 text-center">
            <Film className="h-8 w-8 text-zinc-600" />
            <p className="mt-2 max-w-sm text-xs text-zinc-400">
              Abra um vídeo da GoPro ou arraste o controle abaixo para pré-visualizar o Overlay HUD.
            </p>
          </div>
        )}

        {activeSample && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2 sm:p-3">
            {/* TOP ROW: Left Mini-Map + Center 3-Column Timers */}
            <div className="flex items-start justify-between gap-2">
              {/* Canto Superior Esquerdo — Mini-Mapa do Traçado */}
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

              {/* Topo Centro — 3 Colunas Limpas (MELHOR | ANTERIOR | ATUAL) */}
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

              {/* Spacer direita para manter painel de tempos centralizado */}
              <div className="hidden sm:block sm:w-28" aria-hidden="true" />
            </div>

            {/* BOTTOM-CENTER: Apenas os 2 Instrumentos Principais (Alvo Força G + Velocímetro Analógico Redondo) */}
            <div className="mb-4 sm:mb-7 flex items-end justify-center gap-4 sm:gap-7">
              {/* Esquerda: Alvo Circular de Força G */}
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

              {/* Centro/Direita: Velocímetro Analógico Redondo (km/h) */}
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

                  {/* Ponteiro Dinâmico */}
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

                  {/* Número Digital Grande no Centro */}
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

      {/* Controles de Sincronia Vídeo vs GPS */}
      <div className="space-y-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-2.5 font-mono text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[var(--ps-muted)]">
            Sincronia Vídeo vs GPS:{' '}
            <strong className="text-[var(--ps-amber)]">
              {videoOffsetMs >= 0 ? `+${videoOffsetMs}` : videoOffsetMs} ms
            </strong>
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {[-2000, -500, 500, 2000].map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setVideoOffsetMs((v) => v + step)}
                className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 py-1 text-[10px] font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
              >
                {step > 0 ? `+${step / 1000}s` : `${step / 1000}s`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setVideoOffsetMs(0)}
              className="rounded border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 py-1 text-[10px] font-bold text-[var(--ps-muted)]"
            >
              0
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-[var(--ps-muted)]">
            <span>Ajuste fino de offset (-10s a +10s)</span>
            <span>{(videoOffsetMs / 1000).toFixed(2)}s</span>
          </div>
          <input
            type="range"
            aria-label="Ajuste fino de sincronia entre vídeo e GPS"
            min={-10000}
            max={10000}
            step={50}
            value={Math.max(-10000, Math.min(10000, videoOffsetMs))}
            onChange={(e) => setVideoOffsetMs(Number(e.target.value))}
            className="w-full accent-[var(--ps-accent)]"
          />
        </div>

        {!videoUrl && lap1Samples.length > 1 && (
          <div className="space-y-1 border-t border-[var(--ps-border)] pt-2">
            <span className="text-[10px] text-[var(--ps-muted)]">
              Pré-visualização da volta no HUD
            </span>
            <input
              type="range"
              aria-label="Linha do tempo de pré-visualização do HUD"
              min={0}
              max={lap1Samples.length - 1}
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
                download={`pitstop-hud-volta-${lap1?.runNumber ?? 1}.webm`}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--ps-emerald)] bg-emerald-500/15 px-2.5 py-1 font-extrabold text-[var(--ps-emerald)] hover:bg-emerald-500/25"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Baixar Vídeo (.webm)</span>
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
