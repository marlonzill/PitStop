import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  RefreshCw,
  Trophy,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  DEFAULT_SATCRON_URL,
  fetchSatcronStagesClient,
  resolveSafeSatcronUrl,
  type SatcronStagesResponse,
} from '../utils/satcronClient';

const SATCRON_URL_STORAGE_KEY = 'pitstop_satcron_last_url_v1';

function loadSavedSatcronUrl(): string {
  try {
    const raw = localStorage.getItem(SATCRON_URL_STORAGE_KEY);
    if (raw && raw.includes('satcron.com')) return raw;
  } catch {
    // Ignore storage error
  }
  return DEFAULT_SATCRON_URL;
}

function readInitialParam(rawUrl: string, key: 'mod' | 'ss', fallback: string): string {
  try {
    const parsed = resolveSafeSatcronUrl(rawUrl);
    const val = parsed?.searchParams.get(key)?.trim();
    return val || fallback;
  } catch {
    return fallback;
  }
}

export const SatcronLivePanel: React.FC = () => {
  const [urlInput, setUrlInput] = useState<string>(() => loadSavedSatcronUrl());
  const [selectedMod, setSelectedMod] = useState<string>(() =>
    readInitialParam(loadSavedSatcronUrl(), 'mod', '1')
  );
  const [selectedSs, setSelectedSs] = useState<string>(() =>
    readInitialParam(loadSavedSatcronUrl(), 'ss', 'G')
  );
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [iframeLoaded, setIframeLoaded] = useState<boolean>(false);
  const [invalidUrlError, setInvalidUrlError] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [data, setData] = useState<SatcronStagesResponse | null>(null);

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

  // Optional background metadata fetch to enrich modality & stage labels when exposed
  const fetchMetadata = useCallback(
    async (targetUrl: string, modOverride?: string, ssOverride?: string) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const payload = await fetchSatcronStagesClient(
          targetUrl.trim() || DEFAULT_SATCRON_URL,
          modOverride,
          ssOverride
        );
        if (payload.ok) {
          setData(payload);
        }
      } catch {
        // Embedded iframe handles live SPA rendering directly
      }
    },
    []
  );

  useEffect(() => {
    void fetchMetadata(urlInput, selectedMod, selectedSs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSourceHref = useMemo(() => {
    const resolved = resolveSafeSatcronUrl(urlInput, selectedMod, selectedSs);
    return resolved ? resolved.toString() : DEFAULT_SATCRON_URL;
  }, [urlInput, selectedMod, selectedSs]);

  const iframeSrc = useMemo(() => {
    if (!reloadNonce) return activeSourceHref;
    try {
      const url = new URL(activeSourceHref);
      url.searchParams.set('_t', String(reloadNonce));
      return url.toString();
    } catch {
      return activeSourceHref;
    }
  }, [activeSourceHref, reloadNonce]);

  const modalityOptions = useMemo(() => {
    const base =
      data?.modalities && data.modalities.length > 0
        ? data.modalities.map((m) => ({ id: m.id, name: m.name }))
        : [
            { id: '1', name: 'Carros (mod=1)' },
            { id: '2', name: 'UTVs / Motos (mod=2)' },
            { id: '3', name: 'Quadriciclos / Outros (mod=3)' },
          ];
    if (!base.some((m) => m.id === selectedMod)) {
      return [{ id: selectedMod, name: `Modalidade ${selectedMod}` }, ...base];
    }
    return base;
  }, [data?.modalities, selectedMod]);

  const stageChoices = useMemo(() => {
    const detected = data?.stageIds && data.stageIds.length > 0
      ? data.stageIds
      : ['1', '2', '3', '4', '5', '6'];
    const merged = Array.from(new Set(['G', ...detected, selectedSs]));
    return merged;
  }, [data?.stageIds, selectedSs]);

  const triggerIframeReload = (nextUrl: string, nextMod: string, nextSs: string) => {
    const safe = resolveSafeSatcronUrl(nextUrl, nextMod, nextSs);
    if (!safe) {
      setInvalidUrlError('Link inválido. Informe uma URL oficial do satcron.com.');
      return;
    }
    setInvalidUrlError(null);
    setIframeLoaded(false);
    setReloadNonce(Date.now());
    try {
      localStorage.setItem(SATCRON_URL_STORAGE_KEY, safe.toString());
    } catch {
      // Ignore storage error
    }
    void fetchMetadata(nextUrl, nextMod, nextSs);
  };

  return (
    <section className="space-y-3 text-[var(--ps-text)]">
      {/* Link / Event Config Card */}
      <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Trophy className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
            <span className="font-['Barlow_Condensed'] text-base font-extrabold tracking-wide uppercase truncate">
              Cronometragem Satcron Ao Vivo
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-[10px] font-bold ${
                isOnline
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                  : 'border-amber-500/40 bg-amber-500/15 text-amber-400'
              }`}
            >
              {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span>{isOnline ? 'Online' : 'Offline'}</span>
            </span>

            <a
              href={activeSourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-xl border border-[var(--ps-accent)]/60 bg-[var(--ps-accent-soft)] px-2.5 text-[11px] font-extrabold text-[var(--ps-text)] transition-colors hover:bg-[var(--ps-accent)] hover:text-[var(--ps-accent-text)] whitespace-nowrap"
            >
              <ExternalLink className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>Abrir Painel Oficial</span>
            </a>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            triggerIframeReload(urlInput, selectedMod, selectedSs);
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://satcron.com/stages/?race=novaitalia26&mod=1&ss=G"
            aria-label="Link da prova no Satcron"
            className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 font-mono text-xs text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
          />
          <button
            type="submit"
            className="pitstop-btn-red inline-flex h-[40px] items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-extrabold uppercase sm:shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${!iframeLoaded && isOnline ? 'animate-spin' : ''}`} />
            <span>Atualizar</span>
          </button>
        </form>

        {/* Modality & Stage Selectors */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="ps-label block">Modalidade</span>
            <select
              value={selectedMod}
              onChange={(e) => {
                const nextMod = e.target.value;
                setSelectedMod(nextMod);
                triggerIframeReload(urlInput, nextMod, selectedSs);
              }}
              className="min-h-[38px] w-full rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
            >
              {modalityOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="ps-label block">Especial / Acumulado</span>
            <select
              value={selectedSs}
              onChange={(e) => {
                const nextSs = e.target.value;
                setSelectedSs(nextSs);
                triggerIframeReload(urlInput, selectedMod, nextSs);
              }}
              className="min-h-[38px] w-full rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
            >
              {stageChoices.map((stId) => (
                <option key={stId} value={stId}>
                  {stId === 'G' ? 'Acumulado Geral (G)' : `Especial SS${stId}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {invalidUrlError && (
        <div className="rounded-xl border border-amber-500/60 bg-amber-500/15 p-3 text-xs font-semibold text-amber-400">
          {invalidUrlError}
        </div>
      )}

      {/* Embedded Official Live Satcron SPA */}
      {isOnline ? (
        <div className="relative space-y-1.5">
          {!iframeLoaded && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 font-mono text-[11px] text-[var(--ps-muted)]">
              <span className="truncate">Carregando tempos ao vivo do Satcron...</span>
              <span className="truncate max-w-[40%] opacity-75">{activeSourceHref}</span>
            </div>
          )}
          <iframe
            key={iframeSrc}
            title="Painel Oficial Satcron Ao Vivo"
            src={iframeSrc}
            onLoad={() => setIframeLoaded(true)}
            className="w-full h-[65vh] rounded-2xl border border-[var(--ps-border)] bg-white"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-500/50 bg-[var(--ps-surface)] p-5 text-center space-y-2">
          <WifiOff className="mx-auto h-6 w-6 text-amber-400" />
          <p className="text-xs font-bold text-amber-400">
            Sem conexão com a internet no momento.
          </p>
          <p className="text-[11px] text-[var(--ps-muted)]">
            Conecte-se à internet para visualizar os resultados em tempo real do Satcron.
          </p>
        </div>
      )}
    </section>
  );
};
