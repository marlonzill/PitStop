import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  Filter,
  RefreshCw,
  SearchX,
  Trophy,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { CockpitSelect } from './CockpitSelect';
import {
  DEFAULT_SATCRON_URL,
  fetchSatcronStagesClient,
  resolveSafeSatcronUrl,
  type SatcronStagesResponse,
  type SatcronStandingRow,
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
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<'auto' | 'table' | 'iframe'>('auto');
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [iframeLoaded, setIframeLoaded] = useState<boolean>(false);
  const [loadingData, setLoadingData] = useState<boolean>(false);
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

  const fetchMetadata = useCallback(
    async (targetUrl: string, modOverride?: string, ssOverride?: string) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      setLoadingData(true);
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
        // Embedded iframe handles live SPA rendering fallback directly
      } finally {
        setLoadingData(false);
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
    try {
      const url = new URL(activeSourceHref);
      if (selectedCategory !== 'ALL') {
        url.searchParams.set('cat', selectedCategory);
      }
      if (reloadNonce) {
        url.searchParams.set('_t', String(reloadNonce));
      }
      return url.toString();
    } catch {
      return activeSourceHref;
    }
  }, [activeSourceHref, reloadNonce, selectedCategory]);

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
    const detected =
      data?.stageIds && data.stageIds.length > 0
        ? data.stageIds
        : ['1', '2', '3', '4', '5', '6'];
    return Array.from(new Set(['G', ...detected, selectedSs]));
  }, [data?.stageIds, selectedSs]);

  // Unique categories automatically extracted from standings, parsed HTML tables, and Satcron metadata
  const categoryOptions = useMemo(() => {
    const descMap = new Map<string, string>();
    if (Array.isArray(data?.categories)) {
      for (const c of data.categories) {
        const key = (c.cat || '').trim();
        if (!key) continue;
        descMap.set(key.toLowerCase(), c.desc && c.desc.trim() !== key ? `${key} — ${c.desc.trim()}` : key);
      }
    }

    const seen = new Map<string, { value: string; label: string }>();
    const addCategory = (rawVal: string | undefined) => {
      const val = (rawVal || '').trim();
      if (!val || val === '-' || val === '--') return;
      const lower = val.toLowerCase();
      if (!seen.has(lower)) {
        seen.set(lower, {
          value: val,
          label: descMap.get(lower) || val,
        });
      }
    };

    if (Array.isArray(data?.standings)) {
      for (const row of data.standings) {
        addCategory(row.category);
      }
    }

    if (Array.isArray(data?.tables)) {
      for (const tbl of data.tables) {
        const catIdx = tbl.headers.findIndex((h) => /^cat/i.test(h.trim()));
        if (catIdx >= 0) {
          for (const row of tbl.rows) {
            addCategory(row[catIdx]);
          }
        }
      }
    }

    if (Array.isArray(data?.categories)) {
      for (const c of data.categories) {
        addCategory(c.cat);
      }
    }

    return Array.from(seen.values());
  }, [data?.standings, data?.tables, data?.categories]);

  // Reset selected category if the newly loaded race/modality doesn't contain it
  useEffect(() => {
    if (
      selectedCategory !== 'ALL' &&
      categoryOptions.length > 0 &&
      !categoryOptions.some((c) => c.value.toLowerCase() === selectedCategory.toLowerCase())
    ) {
      setSelectedCategory('ALL');
    }
  }, [categoryOptions, selectedCategory]);

  const filteredStandings: SatcronStandingRow[] = useMemo(() => {
    const all = data?.standings ?? [];
    if (selectedCategory === 'ALL') return all;
    const target = selectedCategory.trim().toLowerCase();
    return all.filter((row) => (row.category || '').trim().toLowerCase() === target);
  }, [data?.standings, selectedCategory]);

  const primaryParsedTable = useMemo(() => {
    if (!data?.tables || data.tables.length === 0) return null;
    const tbl = data.tables[0];
    const catIdx = tbl.headers.findIndex((h) => /^cat/i.test(h.trim()));
    if (selectedCategory === 'ALL' || catIdx < 0) return tbl;
    const target = selectedCategory.trim().toLowerCase();
    return {
      headers: tbl.headers,
      rows: tbl.rows.filter((r) => (r[catIdx] || '').trim().toLowerCase() === target),
    };
  }, [data?.tables, selectedCategory]);

  const hasParsedRows =
    (data?.standings?.length ?? 0) > 0 || (primaryParsedTable?.rows.length ?? 0) > 0;
  const effectiveViewMode =
    viewMode === 'auto' ? (hasParsedRows ? 'table' : 'iframe') : viewMode;

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
              {data?.eventTitle ? data.eventTitle : 'Cronometragem Satcron Ao Vivo'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-[10px] font-bold ${
                isOnline
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-[var(--ps-emerald)]'
                  : 'border-amber-500/40 bg-amber-500/15 text-[var(--ps-amber)]'
              }`}
            >
              {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span>{isOnline ? 'Online' : 'Offline'}</span>
            </span>

            <a
              href={activeSourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--ps-accent)]/60 bg-[var(--ps-accent-soft)] px-3 text-[11px] font-extrabold text-[var(--ps-text)] transition-all active:scale-[0.98] hover:bg-[var(--ps-accent)] hover:text-[var(--ps-accent-text)] whitespace-nowrap"
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
          className="flex flex-col gap-2.5 sm:flex-row"
        >
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://satcron.com/stages/?race=novaitalia26&mod=1&ss=G"
            aria-label="Link da prova no Satcron"
            className="min-h-[48px] min-w-0 flex-1 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 font-mono text-xs text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
          />
          <button
            type="submit"
            className="pitstop-btn-red inline-flex min-h-[48px] items-center justify-center gap-1.5 rounded-xl px-5 text-xs font-extrabold uppercase sm:shrink-0"
          >
            <RefreshCw className={`h-4 w-4 ${(loadingData || (!iframeLoaded && effectiveViewMode === 'iframe')) && isOnline ? 'animate-spin' : ''}`} />
            <span>Atualizar</span>
          </button>
        </form>

        {/* Modality & Stage Selectors */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="ps-label block">Modalidade</span>
            <CockpitSelect
              ariaLabel="Selecionar modalidade Satcron"
              value={selectedMod}
              options={modalityOptions.map((m) => ({
                value: m.id,
                label: m.name,
              }))}
              onChange={(nextMod) => {
                setSelectedMod(nextMod);
                setSelectedCategory('ALL');
                triggerIframeReload(urlInput, nextMod, selectedSs);
              }}
            />
          </div>

          <div className="space-y-1">
            <span className="ps-label block">Especial / Acumulado</span>
            <CockpitSelect
              ariaLabel="Selecionar especial ou acumulado geral"
              value={selectedSs}
              options={stageChoices.map((stId) => ({
                value: stId,
                label: stId === 'G' ? 'Acumulado Geral (G)' : `Especial SS${stId}`,
              }))}
              onChange={(nextSs) => {
                setSelectedSs(nextSs);
                triggerIframeReload(urlInput, selectedMod, nextSs);
              }}
            />
          </div>
        </div>
      </div>

      {invalidUrlError && (
        <div className="rounded-xl border border-amber-500/60 bg-amber-500/15 p-3 text-xs font-semibold text-[var(--ps-amber)]">
          {invalidUrlError}
        </div>
      )}

      {/* Category Filter Bar directly above the live standings/times listing */}
      {isOnline && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Filter className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 font-mono text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                Categoria:
              </span>
              <div className="min-w-0 flex-1 sm:max-w-xs">
                <CockpitSelect
                  compact
                  ariaLabel="Filtrar resultados por categoria"
                  value={selectedCategory}
                  options={[
                    { value: 'ALL', label: 'Todas Categorias' },
                    ...categoryOptions.map((cat) => ({
                      value: cat.value,
                      label: cat.label,
                    })),
                  ]}
                  onChange={(val) => setSelectedCategory(val)}
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasParsedRows && (
              <span className="font-mono text-[11px] font-bold text-[var(--ps-muted)] tabular-nums">
                {data?.standings?.length
                  ? `${filteredStandings.length} comp.`
                  : `${primaryParsedTable?.rows.length ?? 0} reg.`}
              </span>
            )}
            <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${
                  effectiveViewMode === 'table'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                Tabela
              </button>
              <button
                type="button"
                onClick={() => setViewMode('iframe')}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${
                  effectiveViewMode === 'iframe'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                Site Satcron
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Standings Table OR Embedded Official Satcron SPA */}
      {isOnline ? (
        effectiveViewMode === 'table' && hasParsedRows ? (
          <div className="rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ps-border)] pb-2">
              <div className="min-w-0">
                <p className="font-['Barlow_Condensed'] text-base font-extrabold tracking-wide text-[var(--ps-text)] uppercase truncate">
                  {data?.stageTitle || (selectedSs === 'G' ? 'Classificação Geral' : `Especial SS${selectedSs}`)}
                </p>
                {data?.subtitle && (
                  <p className="text-[11px] text-[var(--ps-muted)] truncate">{data.subtitle}</p>
                )}
              </div>
              {selectedCategory !== 'ALL' && (
                <button
                  type="button"
                  onClick={() => setSelectedCategory('ALL')}
                  className="rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 py-1 font-mono text-[10px] font-bold text-[var(--ps-accent)] hover:border-[var(--ps-accent)]"
                >
                  Mostrar Todas
                </button>
              )}
            </div>

            {data?.standings && data.standings.length > 0 ? (
              filteredStandings.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                    <thead>
                      <tr className="border-b border-[var(--ps-border-strong)] text-[10px] text-[var(--ps-muted)] uppercase">
                        <th className="py-2 pr-2">Pos</th>
                        <th className="px-2 py-2">#</th>
                        <th className="px-2 py-2">Dupla / Piloto</th>
                        <th className="px-2 py-2">Cat</th>
                        <th className="px-2 py-2 text-right">SS</th>
                        <th className="px-2 py-2 text-right">Total</th>
                        <th className="py-2 pl-2 text-right">Dif</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ps-border)]">
                      {filteredStandings.map((row, idx) => (
                        <tr
                          key={`${row.carNo}_${row.pos}_${idx}`}
                          className="hover:bg-[var(--ps-card)]"
                        >
                          <td className="py-2 pr-2 font-black text-[var(--ps-accent)]">
                            {selectedCategory === 'ALL' ? row.pos : `${idx + 1}º`}
                          </td>
                          <td className="px-2 py-2 font-bold text-[var(--ps-text)]">
                            {row.carNo}
                          </td>
                          <td className="px-2 py-2 font-sans font-bold text-[var(--ps-text)]">
                            {row.crew}
                          </td>
                          <td className="px-2 py-2 font-bold text-[var(--ps-amber)]">
                            {row.category}
                          </td>
                          <td className="px-2 py-2 text-right font-bold text-[var(--ps-text)]">
                            {row.stageTime}
                          </td>
                          <td className="px-2 py-2 text-right font-black text-[var(--ps-emerald)]">
                            {row.totalTime}
                          </td>
                          <td className="py-2 pl-2 text-right text-[var(--ps-muted)]">
                            {row.diffLeader}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2.5 py-8 text-center">
                  <SearchX className="h-6 w-6 text-[var(--ps-muted)]" />
                  <p className="font-mono text-xs text-[var(--ps-muted)]">
                    Nenhum competidor na categoria <strong className="text-[var(--ps-text)]">{selectedCategory}</strong>.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('ALL')}
                    className="pitstop-btn-metal min-h-[40px] rounded-xl px-4 text-xs font-bold"
                  >
                    Ver Todas as Categorias
                  </button>
                </div>
              )
            ) : primaryParsedTable ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                  {primaryParsedTable.headers.length > 0 && (
                    <thead>
                      <tr className="border-b border-[var(--ps-border-strong)] text-[10px] text-[var(--ps-muted)] uppercase">
                        {primaryParsedTable.headers.map((h, i) => (
                          <th key={i} className="px-2 py-2 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody className="divide-y divide-[var(--ps-border)]">
                    {primaryParsedTable.rows.map((cells, rIdx) => (
                      <tr key={rIdx} className="hover:bg-[var(--ps-card)]">
                        {cells.map((cell, cIdx) => (
                          <td key={cIdx} className="px-2 py-2 text-[var(--ps-text)]">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="relative space-y-1.5">
            {data?.liveStatusMessage && (
              <div className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2 font-mono text-[11px] text-[var(--ps-muted)]">
                {data.liveStatusMessage}
              </div>
            )}
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
        )
      ) : (
        <div className="rounded-2xl border border-amber-500/50 bg-[var(--ps-surface)] p-6 text-center space-y-2.5">
          <WifiOff className="mx-auto h-7 w-7 text-[var(--ps-amber)]" />
          <p className="text-sm font-bold text-[var(--ps-amber)]">
            Sem conexão com a internet
          </p>
          <p className="text-xs text-[var(--ps-muted)]">
            Conecte-se à internet para acompanhar a cronometragem ao vivo do Satcron.
          </p>
        </div>
      )}
    </section>
  );
};
