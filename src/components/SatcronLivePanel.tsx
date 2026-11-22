import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  Globe,
  RefreshCw,
  Search,
  Trophy,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  DEFAULT_SATCRON_URL,
  fetchSatcronStagesClient,
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

export const SatcronLivePanel: React.FC = () => {
  const [urlInput, setUrlInput] = useState<string>(() => loadSavedSatcronUrl());
  const [selectedMod, setSelectedMod] = useState<string>('1');
  const [selectedSs, setSelectedSs] = useState<string>('G');
  const [selectedCat, setSelectedCat] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [showOfficialModal, setShowOfficialModal] = useState<boolean>(false);

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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

  const fetchSatcron = useCallback(
    async (targetUrl: string, modOverride?: string, ssOverride?: string) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setErrorMsg('Sem conexão com a internet no momento.');
        return;
      }
      setLoading(true);
      setErrorMsg(null);
      try {
        const payload = await fetchSatcronStagesClient(
          targetUrl.trim() || DEFAULT_SATCRON_URL,
          modOverride,
          ssOverride
        );
        if (!payload.ok) {
          setErrorMsg(payload.error || 'Não foi possível carregar dados do Satcron.');
          return;
        }
        setData(payload);
        if (payload.mod) setSelectedMod(payload.mod);
        if (payload.ss) setSelectedSs(payload.ss);
        if (payload.sourceUrl) {
          try {
            localStorage.setItem(SATCRON_URL_STORAGE_KEY, payload.sourceUrl);
          } catch {
            // Ignore storage error
          }
        }
      } catch {
        setErrorMsg('Não foi possível consultar o Satcron no momento.');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void fetchSatcron(urlInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh || !isOnline) return;
    const id = window.setInterval(() => {
      void fetchSatcron(urlInput, selectedMod, selectedSs);
    }, 20000);
    return () => window.clearInterval(id);
  }, [autoRefresh, isOnline, urlInput, selectedMod, selectedSs, fetchSatcron]);

  const filteredStandings = useMemo(() => {
    const rows = data?.standings ?? [];
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (selectedCat !== 'ALL' && row.category.toUpperCase() !== selectedCat.toUpperCase()) {
        return false;
      }
      if (!q) return true;
      return (
        row.carNo.toLowerCase().includes(q) ||
        row.crew.toLowerCase().includes(q) ||
        row.category.toLowerCase().includes(q)
      );
    });
  }, [data?.standings, selectedCat, searchQuery]);

  const stageChoices = useMemo(() => {
    const list = ['G', ...(data?.stageIds ?? [])];
    return Array.from(new Set(list));
  }, [data?.stageIds]);

  const activeSourceHref = useMemo(() => {
    try {
      const parsed = new URL(urlInput.trim() || DEFAULT_SATCRON_URL);
      if (parsed.hostname === 'satcron.com' || parsed.hostname === 'www.satcron.com') {
        parsed.searchParams.set('mod', selectedMod);
        parsed.searchParams.set('ss', selectedSs);
        return parsed.toString();
      }
    } catch {
      // Fallback below
    }
    return DEFAULT_SATCRON_URL;
  }, [urlInput, selectedMod, selectedSs]);

  return (
    <section className="space-y-3 text-white">
      {/* Link / Event Config Card */}
      <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-[#E10600]" />
            <span className="font-['Barlow_Condensed'] text-base font-extrabold tracking-wide uppercase">
              Cronometragem Satcron Ao Vivo
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${
                isOnline
                  ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-400'
                  : 'border-amber-500/40 bg-amber-950/40 text-amber-300'
              }`}
            >
              {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span>{isOnline ? 'Online' : 'Offline'}</span>
            </span>

            <a
              href={activeSourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 bg-[#080B0D] px-2 text-[10px] font-bold text-[#C0C4C9] hover:border-[#E10600] hover:text-white"
            >
              <ExternalLink className="h-3 w-3" />
              <span>Site</span>
            </a>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void fetchSatcron(urlInput, selectedMod, selectedSs);
          }}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://satcron.com/stages/?race=novaitalia26&mod=1&ss=G"
            aria-label="Link da prova no Satcron"
            className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-3 font-mono text-xs text-white focus:border-[#E10600] focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              disabled={loading}
              className="pitstop-btn-red inline-flex h-[40px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-extrabold text-white uppercase sm:flex-none"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Lendo...' : 'Atualizar'}</span>
            </button>
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`inline-flex h-[40px] items-center rounded-lg border px-2.5 font-mono text-[11px] font-bold ${
                autoRefresh
                  ? 'border-emerald-500/50 bg-emerald-950/35 text-emerald-300'
                  : 'border-zinc-700 bg-[#080B0D] text-zinc-400'
              }`}
              title="Atualização automática a cada 20s"
            >
              Auto 20s
            </button>
          </div>
        </form>

        {/* Modality / Stage / Category Filters */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
            <span>Modalidade</span>
            <select
              value={selectedMod}
              onChange={(e) => {
                const nextMod = e.target.value;
                setSelectedMod(nextMod);
                setSelectedCat('ALL');
                void fetchSatcron(urlInput, nextMod, selectedSs);
              }}
              className="min-h-[38px] w-full rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
            >
              {data?.modalities && data.modalities.length > 0 ? (
                data.modalities.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))
              ) : (
                <option value="1">Carros (mod=1)</option>
              )}
            </select>
          </label>

          <label className="space-y-1 text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
            <span>Especial / Acumulado</span>
            <select
              value={selectedSs}
              onChange={(e) => {
                const nextSs = e.target.value;
                setSelectedSs(nextSs);
                void fetchSatcron(urlInput, selectedMod, nextSs);
              }}
              className="min-h-[38px] w-full rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
            >
              {stageChoices.map((stId) => (
                <option key={stId} value={stId}>
                  {stId === 'G' ? 'Acumulado Geral (G)' : `Especial SS${stId}`}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-[10px] font-bold tracking-wider text-[#B5B5B5] uppercase">
            <span>Categoria</span>
            <select
              value={selectedCat}
              onChange={(e) => setSelectedCat(e.target.value)}
              className="min-h-[38px] w-full rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-white focus:border-[#E10600] focus:outline-none"
            >
              <option value="ALL">Todas as Categorias</option>
              {(data?.categories ?? []).map((c, idx) => (
                <option key={`${c.cat}-${idx}`} value={c.cat}>
                  {c.cat} — {c.desc}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-amber-600/60 bg-amber-950/35 p-3 text-xs font-semibold text-amber-200">
          {errorMsg}
        </div>
      )}

      {/* Event Summary Header */}
      {data && (
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-3 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-wider text-[#E10600] uppercase">
                {data.subtitle || 'ChronoSat / Satcron'}
              </p>
              <h3 className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide uppercase truncate">
                {data.eventTitle}
              </h3>
              <p className="font-mono text-xs text-[#C0C4C9]">{data.stageTitle}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowOfficialModal(true)}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[#E10600]/70 bg-[#1A0D0E] px-3 text-xs font-extrabold text-white hover:bg-[#E10600]"
              >
                <Globe className="h-3.5 w-3.5 text-[#FF4D47]" />
                <span>Abrir Painel Oficial</span>
              </button>
            </div>
          </div>

          {data.categories && data.categories.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              <button
                type="button"
                onClick={() => setSelectedCat('ALL')}
                className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${
                  selectedCat === 'ALL'
                    ? 'border-[#E10600] bg-[#E10600] text-white'
                    : 'border-zinc-800 bg-[#080B0D] text-zinc-400 hover:text-white'
                }`}
              >
                GERAL
              </button>
              {data.categories.slice(0, 14).map((c, idx) => (
                <button
                  key={`${c.cat}-${idx}`}
                  type="button"
                  onClick={() => setSelectedCat(c.cat)}
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${
                    selectedCat === c.cat
                      ? 'border-[#E10600] bg-[#E10600] text-white'
                      : 'border-zinc-800 bg-[#080B0D] text-zinc-400 hover:text-white'
                  }`}
                  title={c.desc}
                >
                  {c.cat}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search Crew / Car Filter */}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar nº do carro, piloto ou navegador..."
          className="min-h-[40px] w-full rounded-xl border border-zinc-800 bg-[#111214] pr-3 pl-9 text-xs text-white focus:border-[#E10600] focus:outline-none"
        />
      </div>

      {/* Parsed Live Standings Table */}
      {filteredStandings.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#111214]">
          <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-zinc-800 bg-[#080B0D] text-[10px] text-[#B5B5B5] uppercase">
                <th className="px-2.5 py-2">Pos</th>
                <th className="px-2 py-2">Nº</th>
                <th className="px-2 py-2 font-sans">Dupla</th>
                <th className="px-2 py-2">Cat</th>
                <th className="px-2 py-2 text-right">SS</th>
                <th className="px-2 py-2 text-right">Acum.</th>
                <th className="px-2.5 py-2 text-right">Dif.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filteredStandings.map((row, idx) => (
                <tr key={`${row.carNo}-${idx}`} className="hover:bg-[#17191D]">
                  <td className="px-2.5 py-2 font-extrabold text-amber-300">{row.pos}</td>
                  <td className="px-2 py-2 font-bold text-white">{row.carNo}</td>
                  <td className="px-2 py-2 font-sans font-semibold text-white">
                    {row.crew}
                  </td>
                  <td className="px-2 py-2 text-zinc-400">{row.category}</td>
                  <td className="px-2 py-2 text-right text-emerald-400">{row.stageTime}</td>
                  <td className="px-2 py-2 text-right font-bold text-white">
                    {row.totalTime}
                  </td>
                  <td className="px-2.5 py-2 text-right text-zinc-400">{row.diffLeader}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data?.tables && data.tables.length > 0 ? (
        <div className="space-y-3">
          {data.tables.map((tbl, tIdx) => (
            <div
              key={tIdx}
              className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#111214]"
            >
              <table className="w-full border-collapse text-left font-mono text-xs tabular-nums">
                {tbl.headers.length > 0 && (
                  <thead>
                    <tr className="border-b border-zinc-800 bg-[#080B0D] text-[10px] text-[#B5B5B5] uppercase">
                      {tbl.headers.map((h, hIdx) => (
                        <th key={hIdx} className="px-2.5 py-2">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody className="divide-y divide-zinc-800/70">
                  {tbl.rows.map((cells, rIdx) => (
                    <tr key={rIdx} className="hover:bg-[#17191D]">
                      {cells.map((c, cIdx) => (
                        <td key={cIdx} className="px-2.5 py-2 text-white">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-[#111214] p-4 text-center space-y-2.5">
          <p className="text-xs font-bold text-amber-300">
            {data?.liveStatusMessage
              ? data.liveStatusMessage
              : 'Prova sem tempos ativos no momento ou encerrada.'}
          </p>
          <p className="text-[11px] text-zinc-400">
            As modalidades, especiais e categorias da prova foram carregadas acima. Para conferir históricos ou resultados oficiais completos no site da cronometragem, toque em{' '}
            <strong className="text-white">Abrir Painel Oficial</strong>.
          </p>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowOfficialModal(true)}
              className="pitstop-btn-red inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 text-xs font-extrabold text-white uppercase"
            >
              <Globe className="h-4 w-4" />
              <span>Abrir Painel Oficial</span>
            </button>
          </div>
        </div>
      )}

      {/* Modal: Embedded Official Satcron Panel inside App */}
      {showOfficialModal && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#050608]">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-[#111214] px-3 py-2">
            <div className="min-w-0">
              <p className="truncate font-['Barlow_Condensed'] text-base font-extrabold tracking-wide text-white uppercase">
                Painel Oficial Satcron · {data?.eventTitle || 'Ao Vivo'}
              </p>
              <p className="truncate font-mono text-[10px] text-zinc-400">{activeSourceHref}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <a
                href={activeSourceHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-700 bg-[#080B0D] px-2.5 text-xs font-bold text-[#C0C4C9] hover:text-white"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Navegador</span>
              </a>
              <button
                type="button"
                onClick={() => setShowOfficialModal(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 bg-[#080B0D] text-white hover:border-[#E10600]"
                aria-label="Fechar Painel Oficial"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <iframe
            title="Painel Oficial Satcron"
            src={activeSourceHref}
            className="flex-1 w-full bg-white"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </section>
  );
};
