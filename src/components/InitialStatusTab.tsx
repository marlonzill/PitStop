import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Battery, Satellite, Wifi, WifiOff } from 'lucide-react';
import { APP_VERSION } from '../version';

interface BatteryManagerLike extends EventTarget {
  charging: boolean;
  level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
}

const HOME_HERO_LOGO_PATH =
  'assets/aistudio/gemini-2.5-flash-image_Using_this_exact_PITSTOP_SPORTS_logo_as_reference_keep_the_exact_same_brushed_ch-0_97985c44.jpg';

/**
 * Remove automaticamente a textura de fibra de carbono ao redor do emblema
 * em um <canvas> offscreen, retornando apenas o logotipo PITSTOP SPORTS +
 * cronômetro com fundo 100% transparente e recorte justo (sem halo/círculo).
 */
function extractCleanEmblemDataUrl(img: HTMLImageElement): string | null {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const total = w * h;

  // Amostra as bordas externas (8px) para calibrar o nível base do carbono escuro
  let borderMaxLuma = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= 8 && x < w - 8 && y >= 8 && y < h - 8) continue;
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma <= 18) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma > borderMaxLuma) borderMaxLuma = luma;
      }
    }
  }

  const bgLumaLimit = Math.max(76, Math.min(92, borderMaxLuma + 42));
  const bgChromaLimit = 20;

  const isBgPixel = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const canBeCarbonBg = (p: number): boolean => {
    const idx = p * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC - minC > bgChromaLimit) return false;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return luma <= bgLumaLimit;
  };

  const enqueue = (p: number) => {
    if (visited[p]) return;
    visited[p] = 1;
    if (canBeCarbonBg(p)) {
      isBgPixel[p] = 1;
      queue[tail++] = p;
    }
  };

  // Flood-fill (BFS) partindo das 4 bordas da imagem
  for (let x = 0; x < w; x++) {
    enqueue(x);
    enqueue((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    enqueue(y * w);
    enqueue(y * w + (w - 1));
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) enqueue(p - 1);
    if (x < w - 1) enqueue(p + 1);
    if (y > 0) enqueue(p - w);
    if (y < h - 1) enqueue(p + w);
  }

  // Limpa vãos internos fechados das letras (ex.: O e P à direita do cronômetro)
  const holeVisited = new Uint8Array(total);
  const holeStack: number[] = [];
  const protectX = Math.floor(w * 0.29);
  const minHoleLumaLimit = Math.max(66, bgLumaLimit - 10);

  for (let y = Math.floor(h * 0.34); y < Math.floor(h * 0.65); y++) {
    for (let x = protectX; x < Math.floor(w * 0.84); x++) {
      const p = y * w + x;
      if (isBgPixel[p] || holeVisited[p]) continue;
      const idx = p * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (maxC - minC > 16 || luma > minHoleLumaLimit) continue;

      const comp: number[] = [];
      let qHead = 0;
      holeVisited[p] = 1;
      holeStack.length = 0;
      holeStack.push(p);

      while (qHead < holeStack.length) {
        const cur = holeStack[qHead++];
        comp.push(cur);
        const cx = cur % w;
        const cy = (cur - cx) / w;
        const neighbors = [
          cx > protectX ? cur - 1 : -1,
          cx < w - 1 ? cur + 1 : -1,
          cy > 0 ? cur - w : -1,
          cy < h - 1 ? cur + w : -1,
        ];
        for (const nb of neighbors) {
          if (nb < 0 || isBgPixel[nb] || holeVisited[nb]) continue;
          const nIdx = nb * 4;
          const nr = data[nIdx];
          const ng = data[nIdx + 1];
          const nbVal = data[nIdx + 2];
          const nMax = Math.max(nr, ng, nbVal);
          const nMin = Math.min(nr, ng, nbVal);
          const nLuma = 0.299 * nr + 0.587 * ng + 0.114 * nbVal;
          if (nMax - nMin <= 16 && nLuma <= minHoleLumaLimit) {
            holeVisited[nb] = 1;
            holeStack.push(nb);
          }
        }
      }

      if (comp.length >= 90) {
        for (const cp of comp) {
          isBgPixel[cp] = 1;
        }
      }
    }
  }

  for (let p = 0; p < total; p++) {
    if (isBgPixel[p]) {
      data[p * 4 + 3] = 0;
    }
  }

  // Suavização anti-serrilhado de 1px na borda do recorte + cálculo do bounding box
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (isBgPixel[p]) continue;

      const idx = p * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      const touchesBg =
        isBgPixel[p - 1] ||
        isBgPixel[p + 1] ||
        isBgPixel[p - w] ||
        isBgPixel[p + w];

      if (touchesBg && chroma <= 22 && luma < 105) {
        const alphaRatio = Math.max(0, Math.min(1, (luma - 48) / 57));
        data[idx + 3] = Math.round(alphaRatio * 255);
      }

      if (data[idx + 3] > 14) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return null;

  ctx.putImageData(imageData, 0, 0);

  const pad = Math.max(6, Math.round(Math.min(w, h) * 0.012));
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(w - sx, maxX - minX + 1 + pad * 2);
  const sh = Math.min(h - sy, maxY - minY + 1 + pad * 2);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = sw;
  outCanvas.height = sh;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return null;

  outCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return outCanvas.toDataURL('image/png');
}

export const InitialStatusTab: React.FC = () => {
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [cutoutLogoSrc, setCutoutLogoSrc] = useState<string | null>(null);
  const [cutoutFailed, setCutoutFailed] = useState(false);

  const rawHeroLogoSrc = `${import.meta.env.BASE_URL}${HOME_HERO_LOGO_PATH}`;

  useEffect(() => {
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      try {
        const cleanUrl = extractCleanEmblemDataUrl(img);
        if (cleanUrl) {
          setCutoutLogoSrc(cleanUrl);
        } else {
          setCutoutFailed(true);
        }
      } catch {
        setCutoutFailed(true);
      }
    };
    img.onerror = () => {
      if (active) setCutoutFailed(true);
    };
    img.src = rawHeroLogoSrc;
    return () => {
      active = false;
    };
  }, [rawHeroLogoSrc]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery !== 'function') return;
    let mounted = true;
    nav
      .getBattery()
      .then((bm) => {
        if (!mounted) return;
        setBatteryPct(Math.round(bm.level * 100));
        const onLvl = () => {
          if (mounted) setBatteryPct(Math.round(bm.level * 100));
        };
        bm.addEventListener('levelchange', onLvl);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const probeGps = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const pos = await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 8000,
          });
          if (!mounted) return;
          setGpsActive(true);
          setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
        } else if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (!mounted) return;
              setGpsActive(true);
              setGpsAccuracy(pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null);
            },
            () => {
              if (mounted) setGpsActive(false);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
          );
        }
      } catch {
        if (mounted) setGpsActive(false);
      }
    };
    probeGps();
    return () => {
      mounted = false;
    };
  }, []);

  const displayLogoSrc = cutoutLogoSrc || (cutoutFailed ? rawHeroLogoSrc : null);

  return (
    <div className="pitstop-home-motorsport-bg relative flex h-full w-full flex-1 flex-col items-center justify-between overflow-hidden px-4 py-4 text-center sm:py-6">
      {/* Região Central: Emblema PITSTOP SPORTS centralizado verticalmente na área livre */}
      <div className="flex w-full max-w-3xl flex-1 items-center justify-center text-center">
        <div className="mx-auto flex w-full max-w-[360px] items-center justify-center sm:max-w-[440px]">
          {displayLogoSrc ? (
            <img
              src={displayLogoSrc}
              alt="PitStop Sports"
              className="h-auto w-full select-none object-contain"
              draggable={false}
            />
          ) : (
            <div aria-hidden="true" className="aspect-[2.9/1] w-full" />
          )}
        </div>
      </div>

      {/* Região Inferior: Slogan com linhas laterais + Rodapé discreto */}
      <div className="flex w-full shrink-0 flex-col items-center justify-end gap-4 pb-safe">
        <div className="flex w-full max-w-md items-center justify-center gap-3 px-2">
          <span
            aria-hidden="true"
            className="pitstop-divider-beam h-[2px] max-w-[68px] flex-1 rounded-full"
          />
          <p className="pitstop-slogan-text shrink-0 font-['Barlow_Condensed'] text-xs font-extrabold italic tracking-[0.26em] uppercase sm:text-sm">
            Rotas na medida exata
          </p>
          <span
            aria-hidden="true"
            className="pitstop-divider-beam pitstop-divider-beam-right h-[2px] max-w-[68px] flex-1 rounded-full"
          />
        </div>

        <footer className="flex w-full flex-col items-center justify-center gap-1 text-[11px] text-zinc-400">
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 font-mono text-[11px] tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Satellite
                className={`h-3 w-3 ${
                  gpsActive ? 'text-emerald-400' : 'text-[#E10600]'
                }`}
              />
              <span>
                {gpsActive ? `GPS (±${gpsAccuracy ?? '--'}m)` : 'GPS (aguardando)'}
              </span>
            </span>
            <span aria-hidden="true" className="opacity-40">·</span>
            <span className="inline-flex items-center gap-1">
              <Battery className="h-3 w-3" />
              <span>Bateria {batteryPct !== null ? `${batteryPct}%` : '--'}</span>
            </span>
            <span aria-hidden="true" className="opacity-40">·</span>
            <span className="inline-flex items-center gap-1">
              {isOnline ? (
                <Wifi className="h-3 w-3 text-emerald-400" />
              ) : (
                <WifiOff className="h-3 w-3 text-amber-400" />
              )}
              <span
                className={
                  isOnline
                    ? 'font-semibold text-emerald-400'
                    : 'font-semibold text-amber-400'
                }
              >
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </span>
            <span aria-hidden="true" className="opacity-40">·</span>
            <span className="font-semibold text-zinc-300">{APP_VERSION}</span>
          </div>
          <p className="text-[11px] tracking-wide text-zinc-500">
            Desenvolvido por Márlon Zill · PitStop-Sports
          </p>
        </footer>
      </div>
    </div>
  );
};
