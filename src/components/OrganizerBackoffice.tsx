import React, { useEffect, useMemo, useState } from 'react';
import {
  Award,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FolderUp,
  KeyRound,
  Lock,
  LogOut,
  RefreshCw,
  Search,
  Share2,
  ShieldAlert,
  Trash2,
  Trophy,
} from 'lucide-react';
import type { CompetitorResultFile, PassageRecord } from '../types/rally';
import {
  claimOrganizerPasscode,
  clearBaseResults,
  deleteBaseResult,
  fetchBaseResults,
  getOrganizerAuthStatus,
  loginOrganizerPasscode,
  logoutOrganizer,
  publishPublicStandings,
  type OrganizerAuthStatus,
} from '../utils/baseApi';
import { parseRoadbookTxt } from '../utils/rallyParser';
import {
  formatFinalStandingsCsv,
  formatFinalStandingsTxt,
  formatIndividualReportTxt,
  generateDemoResultFiles,
  parseResultTxt,
  summarizeBySection,
  summarizeCompetitorResult,
} from '../utils/resultFormatter';

type DetailFilter = 'all' | 'V' | 'penalized' | 'missed' | 'exempt';

interface OrganizerBackofficeProps {
  results: CompetitorResultFile[];
  onAddResults: (newResults: CompetitorResultFile[]) => void;
  onRemoveResult: (id: string) => void;
  onClearAll: () => void;
}

export const OrganizerBackoffice: React.FC<OrganizerBackofficeProps> = ({
  results,
  onAddResults,
  onRemoveResult,
  onClearAll,
}) => {
  const [missedPenaltyPts, setMissedPenaltyPts] = useState<number>(600);
  const [eventFilter, setEventFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailFilter, setDetailFilter] = useState<DetailFilter>('V');
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [syncingBase, setSyncingBase] = useState(false);
  const [publishingLink, setPublishingLink] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedPortalUrl, setCopiedPortalUrl] = useState(false);
  const [authStatus, setAuthStatus] = useState<OrganizerAuthStatus | null>(null);
  const [authOfflineMode, setAuthOfflineMode] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [passcodeConfirm, setPasscodeConfirm] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [submittingAuth, setSubmittingAuth] = useState(false);

  const portalUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/?apuracao=1` : '/?apuracao=1';

  const handleSyncBase = async () => {
    setSyncingBase(true);
    try {
      const serverResults = await fetchBaseResults();
      if (serverResults.length > 0) {
        onAddResults(serverResults);
        if (!selectedId) {
          setSelectedId(serverResults[0].id);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'UNAUTHORIZED') {
        setAuthStatus((prev) =>
          prev ? { ...prev, authenticated: false } : { configured: true, needsClaim: false, authenticated: false }
        );
      }
    } finally {
      setSyncingBase(false);
    }
  };

  useEffect(() => {
    let active = true;
    const initAuth = async () => {
      setAuthLoading(true);
      try {
        const status = await getOrganizerAuthStatus();
        if (!active) return;
        setAuthStatus(status);
        setAuthOfflineMode(false);
        if (status.authenticated) {
          await handleSyncBase();
        }
      } catch {
        if (!active) return;
        // Static / offline host fallback allows importing local .txt files
        setAuthOfflineMode(true);
      } finally {
        if (active) setAuthLoading(false);
      }
    };
    initAuth();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmitOrganizerAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const trimmed = passcodeInput.trim();
    if (trimmed.length < 6) {
      setAuthError('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    if (authStatus?.needsClaim && trimmed !== passcodeConfirm.trim()) {
      setAuthError('As duas senhas digitadas não coincidem.');
      return;
    }

    setSubmittingAuth(true);
    try {
      if (authStatus?.needsClaim) {
        await claimOrganizerPasscode(trimmed);
      } else {
        await loginOrganizerPasscode(trimmed);
      }
      setPasscodeInput('');
      setPasscodeConfirm('');
      setAuthStatus({ configured: true, needsClaim: false, authenticated: true });
      await handleSyncBase();
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Falha na autenticação da secretaria.'
      );
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleLockBackoffice = () => {
    logoutOrganizer();
    setAuthStatus((prev) =>
      prev ? { ...prev, authenticated: false } : { configured: true, needsClaim: false, authenticated: false }
    );
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const errors: string[] = [];
    const parsed: CompetitorResultFile[] = [];

    for (const file of Array.from(fileList)) {
      try {
        const text = await file.text();
        parsed.push(parseResultTxt(text, file.name));
      } catch (err) {
        errors.push(
          err instanceof Error ? err.message : `Erro ao ler ${file.name}`
        );
      }
    }

    setUploadErrors(errors);
    if (parsed.length > 0) {
      onAddResults(parsed);
      if (!selectedId) {
        setSelectedId(parsed[0].id);
      }
    }
  };

  const handleLoadDemoFiles = async () => {
    setLoadingDemo(true);
    setUploadErrors([]);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}assets/aistudio/rally_escoteiros_merged_66a34567.txt`);
      if (!res.ok) throw new Error('Planilha modelo não encontrada.');
      const roadbookText = await res.text();
      const roadbook = parseRoadbookTxt(roadbookText, 'rally_escoteiros_merged.txt');
      const demoFiles = generateDemoResultFiles(roadbook);
      const parsed = demoFiles.map((f) => parseResultTxt(f.content, f.fileName));
      onAddResults(parsed);
      setSelectedId(parsed[0]?.id ?? null);
    } catch (err) {
      setUploadErrors([
        err instanceof Error ? err.message : 'Erro ao gerar arquivos de demonstração.',
      ]);
    } finally {
      setLoadingDemo(false);
    }
  };

  const availableEvents = useMemo(() => {
    const names = new Set<string>();
    for (const r of results) {
      names.add((r.eventName || 'Prova sem título').trim());
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [results]);

  const eventScopedResults = useMemo(() => {
    if (eventFilter === 'ALL') return results;
    return results.filter(
      (r) => (r.eventName || 'Prova sem título').trim() === eventFilter
    );
  }, [results, eventFilter]);

  useEffect(() => {
    if (eventFilter !== 'ALL' && !availableEvents.includes(eventFilter)) {
      setEventFilter('ALL');
    }
  }, [availableEvents, eventFilter]);

  const rankedSummaries = useMemo(() => {
    const summaries = eventScopedResults.map((r) =>
      summarizeCompetitorResult(r, missedPenaltyPts)
    );
    summaries.sort((a, b) => {
      if (a.finalTotalPoints !== b.finalTotalPoints) {
        return a.finalTotalPoints - b.finalTotalPoints;
      }
      if (a.missedV !== b.missedV) return a.missedV - b.missedV;
      return a.pointsFromV - b.pointsFromV;
    });
    return summaries;
  }, [eventScopedResults, missedPenaltyPts]);

  const filteredSummaries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rankedSummaries;
    return rankedSummaries.filter(
      (s) =>
        s.result.carNumber.toLowerCase().includes(q) ||
        s.result.crewName.toLowerCase().includes(q)
    );
  }, [rankedSummaries, searchQuery]);

  const activeSummary = useMemo(() => {
    if (rankedSummaries.length === 0) return null;
    return (
      rankedSummaries.find((s) => s.result.id === selectedId) ??
      rankedSummaries[0]
    );
  }, [rankedSummaries, selectedId]);

  const activeRank = useMemo(() => {
    if (!activeSummary) return 1;
    return rankedSummaries.indexOf(activeSummary) + 1;
  }, [rankedSummaries, activeSummary]);

  const activeSections = useMemo(() => {
    if (!activeSummary) return [];
    return summarizeBySection(activeSummary.result.passages);
  }, [activeSummary]);

  const filteredPassages = useMemo((): PassageRecord[] => {
    if (!activeSummary) return [];
    const list = activeSummary.result.passages;
    switch (detailFilter) {
      case 'V':
        return list.filter((p) => p.type === 'V');
      case 'penalized':
        return list.filter((p) => p.type === 'V' && p.points > 0);
      case 'missed':
        return list.filter((p) => p.type === 'V' && p.status === 'NAO_PASSOU');
      case 'exempt':
        return list.filter((p) => p.type === 'D' || p.type === 'N' || p.type === '');
      default:
        return list;
    }
  }, [activeSummary, detailFilter]);

  const downloadFile = (content: string, fileName: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handlePublishPublicLink = async () => {
    if (rankedSummaries.length === 0) return;
    setPublishingLink(true);
    setUploadErrors([]);
    try {
      const eventName =
        eventFilter !== 'ALL'
          ? eventFilter
          : rankedSummaries[0]?.result.eventName || 'Classificação PitStop Sports';
      const rows = rankedSummaries.map((s, idx) => ({
        position: idx + 1,
        carNumber: s.result.carNumber,
        crewName: s.result.crewName,
        totalV: s.totalV,
        recordedV: s.recordedV,
        missedV: s.missedV,
        earlySecondsTotal: s.earlySecondsTotal,
        lateSecondsTotal: s.lateSecondsTotal,
        pointsFromV: s.pointsFromV,
        missedPenaltyPoints: s.missedPenaltyPoints,
        finalTotalPoints: s.finalTotalPoints,
      }));
      const res = await publishPublicStandings({
        eventName,
        missedPenaltyPts,
        rows,
        txtReport: formatFinalStandingsTxt(rankedSummaries, missedPenaltyPts),
        csvReport: formatFinalStandingsCsv(rankedSummaries),
      });
      const fullUrl = `${window.location.origin}${res.path}`;
      setPublishedUrl(fullUrl);
    } catch (err) {
      setUploadErrors([
        err instanceof Error ? err.message : 'Erro ao publicar link público.',
      ]);
    } finally {
      setPublishingLink(false);
    }
  };

  const handleCopyPublishedUrl = async () => {
    if (!publishedUrl) return;
    try {
      await navigator.clipboard.writeText(publishedUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleCopyPortalUrl = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopiedPortalUrl(true);
      window.setTimeout(() => setCopiedPortalUrl(false), 2000);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const leader = rankedSummaries[0] ?? null;
  const second = rankedSummaries[1] ?? null;
  const third = rankedSummaries[2] ?? null;

  if (authLoading) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-zinc-800 bg-[#111214] p-8 text-center text-[#C0C4C9] shadow-xl">
        <Lock className="mx-auto h-8 w-8 animate-pulse text-[#E10600]" />
        <p className="mt-3 text-sm font-semibold text-white">
          Verificando acesso à Secretaria de Prova...
        </p>
      </div>
    );
  }

  if (!authOfflineMode && authStatus && !authStatus.authenticated) {
    return (
      <div className="mx-auto max-w-md overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-2xl">
        <div aria-hidden="true" className="pitstop-racing-line h-[8px] w-full" />
        <form onSubmit={handleSubmitOrganizerAuth} className="space-y-4 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#E10600]/40 bg-[#E10600]/15 text-[#E10600]">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-[0.18em] text-[#E10600] uppercase">
                Secretaria de Prova · Acesso Protegido
              </p>
              <h2 className="font-['Barlow_Condensed'] text-2xl font-extrabold text-white">
                {authStatus.needsClaim
                  ? 'Definir Senha de Apuração'
                  : 'Entrar na Apuração Oficial'}
              </h2>
            </div>
          </div>

          <p className="text-xs text-[#B5B5B5]">
            {authStatus.needsClaim
              ? 'Primeiro acesso detectado. Crie uma senha de administrador (mínimo 6 caracteres) para proteger os registros e a publicação de resultados.'
              : 'Informe a senha de organização para consultar os arquivos recebidos, apagar registros ou publicar classificações.'}
          </p>

          <div className="space-y-2.5">
            <div>
              <label
                htmlFor="org-passcode"
                className="block text-[11px] font-semibold text-[#C0C4C9]"
              >
                Senha da Organização
              </label>
              <input
                id="org-passcode"
                type="password"
                autoComplete={authStatus.needsClaim ? 'new-password' : 'current-password'}
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                className="mt-1 w-full min-h-[42px] rounded-xl border border-zinc-700 bg-[#080B0D] px-3 text-sm text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
              />
            </div>

            {authStatus.needsClaim && (
              <div>
                <label
                  htmlFor="org-passcode-confirm"
                  className="block text-[11px] font-semibold text-[#C0C4C9]"
                >
                  Confirmar Senha
                </label>
                <input
                  id="org-passcode-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={passcodeConfirm}
                  onChange={(e) => setPasscodeConfirm(e.target.value)}
                  placeholder="Repita a senha"
                  className="mt-1 w-full min-h-[42px] rounded-xl border border-zinc-700 bg-[#080B0D] px-3 text-sm text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
                />
              </div>
            )}
          </div>

          {authError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              <ShieldAlert className="h-4 w-4 shrink-0 text-[#FF2A2A]" />
              <span>{authError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submittingAuth}
            className="pitstop-btn-red flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl text-sm font-extrabold text-white uppercase"
          >
            <Lock className="h-4 w-4" />
            <span>
              {submittingAuth
                ? 'Validando...'
                : authStatus.needsClaim
                  ? 'Salvar Senha e Entrar'
                  : 'Desbloquear Secretaria'}
            </span>
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Import & Scoring Rule Bar */}
      <section className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] text-[#F4F4F4] shadow-lg">
        <div aria-hidden="true" className="pitstop-racing-line h-[10px] w-full sm:h-[12px]" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 right-0 h-28 w-44 bg-rally-checkered opacity-25 [mask-image:linear-gradient(to_bottom_left,black,transparent)]"
        />

        <div className="relative p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-[#E10600] uppercase">
                PitStop Sports · Secretaria de Prova Web
              </p>
              <h2 className="mt-0.5 font-['Barlow_Condensed'] text-2xl font-bold tracking-wide text-white sm:text-3xl">
                Apuração Oficial — Geral e Individual
              </h2>
              <p className="mt-1 text-sm text-[#B5B5B5]">
                Receba os registros diretamente do coletor ou importe arquivos <span className="font-mono text-xs text-zinc-200">.txt</span>. Menor pontuação vence.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {!authOfflineMode && (
                <button
                  type="button"
                  onClick={handleSyncBase}
                  disabled={syncingBase}
                  className="pitstop-btn-red inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white transition-all whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`h-4 w-4 ${syncingBase ? 'animate-spin' : ''}`} />
                  <span>{syncingBase ? 'Sincronizando...' : 'Atualizar da Base'}</span>
                </button>
              )}

              <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-zinc-700 bg-[#1E1E22] px-4 py-2.5 text-sm font-bold text-white transition-all hover:bg-zinc-800 whitespace-nowrap shrink-0">
                <FolderUp className="h-4 w-4 text-[#C0C4C9]" />
                <span>Importar (.txt)</span>
                <input
                  type="file"
                  multiple
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={(e) => handleFilesSelected(e.target.files)}
                />
              </label>

              <button
                type="button"
                onClick={handleLoadDemoFiles}
                disabled={loadingDemo}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-zinc-700 bg-[#1E1E22] px-4 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-zinc-800 whitespace-nowrap shrink-0"
              >
                <FileText className="h-4 w-4 text-[#C0C4C9]" />
                <span>{loadingDemo ? 'Gerando...' : 'Simular 3 Carros'}</span>
              </button>

              {!authOfflineMode && authStatus?.authenticated && (
                <button
                  type="button"
                  onClick={handleLockBackoffice}
                  title="Bloquear sessão da apuração"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-zinc-700 bg-[#080B0D] px-3 py-2.5 text-xs font-semibold text-[#C0C4C9] hover:text-white whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-4 w-4 text-[#E10600]" />
                  <span>Bloquear</span>
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#080B0D] px-3.5 py-2.5 text-xs">
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-[#B5B5B5] mr-2">Link do Portal de Apuração:</span>
              <span className="font-mono text-zinc-200 break-all">{portalUrl}</span>
            </div>
            <button
              type="button"
              onClick={handleCopyPortalUrl}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 font-semibold text-white hover:bg-zinc-800 whitespace-nowrap shrink-0"
            >
              {copiedPortalUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-[#C0C4C9]" />}
              <span>{copiedPortalUrl ? 'Copiado' : 'Copiar Portal'}</span>
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-4 border-t border-zinc-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              {availableEvents.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[#B5B5B5]">Prova:</span>
                  <select
                    aria-label="Filtrar competição"
                    value={eventFilter}
                    onChange={(e) => {
                      setEventFilter(e.target.value);
                      setPublishedUrl(null);
                    }}
                    className="min-h-[38px] max-w-[240px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-semibold text-white focus:border-[#E10600] focus:outline-none"
                  >
                    <option value="ALL">Todas ({results.length} envios)</option>
                    {availableEvents.map((ev) => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[#B5B5B5]">
                  Penalidade PC &ldquo;V&rdquo; NC:
                </span>
                <div className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
                  {[0, 300, 600, 900].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setMissedPenaltyPts(val)}
                      className={`min-h-[32px] rounded-md px-2.5 font-mono text-xs font-semibold transition-all whitespace-nowrap ${
                        missedPenaltyPts === val
                          ? 'pitstop-btn-red text-white'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {val} pts
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {rankedSummaries.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={publishingLink}
                  onClick={handlePublishPublicLink}
                  className="pitstop-btn-red inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold text-white whitespace-nowrap shrink-0"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span>{publishingLink ? 'Gerando Link...' : 'Gerar Link Público'}</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(
                      formatFinalStandingsTxt(rankedSummaries, missedPenaltyPts),
                      'classificacao_final_pitstop.txt',
                      'text/plain;charset=utf-8'
                    )
                  }
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-[#C0C4C9]" />
                  <span>Ranking (.txt)</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadFile(
                      formatFinalStandingsCsv(rankedSummaries),
                      'classificacao_final_pitstop.csv',
                      'text/csv;charset=utf-8'
                    )
                  }
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-zinc-700 bg-[#1E1E22] px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 whitespace-nowrap shrink-0"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Excel (.csv)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    clearBaseResults().catch(() => {});
                    onClearAll();
                    setSelectedId(null);
                    setPublishedUrl(null);
                  }}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-red-500/35 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-950/60 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Limpar Tudo</span>
                </button>
              </div>
            )}
          </div>

          {publishedUrl && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#E10600]/45 bg-[#E10600]/10 px-4 py-2.5 text-xs">
              <div className="min-w-0 flex-1">
                <span className="font-bold text-[#FF4A43] uppercase mr-2">Resultado Público:</span>
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-white underline break-all"
                >
                  <span>{publishedUrl}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              <button
                type="button"
                onClick={handleCopyPublishedUrl}
                className="pitstop-btn-red inline-flex min-h-[34px] items-center gap-1 rounded-lg px-3 font-bold text-white whitespace-nowrap shrink-0"
              >
                {copiedLink ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copiedLink ? 'Copiado!' : 'Copiar Link'}</span>
              </button>
            </div>
          )}

          {uploadErrors.length > 0 && (
            <div className="mt-4 space-y-1 rounded-xl border border-red-500/40 bg-red-950/50 p-3 text-xs text-red-300">
              {uploadErrors.map((err, i) => (
                <div key={i} className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
                  <span>{err}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Empty State */}
      {rankedSummaries.length === 0 ? (
        <section className="relative overflow-hidden rounded-2xl border border-dashed border-zinc-700 bg-[#111214] px-6 py-14 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-rally-checkered opacity-15"
          />
          <div className="relative">
            <Trophy className="mx-auto h-10 w-10 text-[#E10600]" />
            <h3 className="mt-3 font-['Barlow_Condensed'] text-2xl font-bold text-white">
              Nenhum resultado recebido ainda
            </h3>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-[#B5B5B5]">
              Os envios realizados pelo Coletor aparecem automaticamente aqui ao clicar em &ldquo;Atualizar da Base&rdquo;. Você também pode importar arquivos <span className="font-mono text-xs text-zinc-200">.txt</span> ou simular 3 carros.
            </p>
          </div>
        </section>
      ) : (
        <>
          {/* Destaques - Pódio */}
          {leader && (
            <section className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-[11px] font-bold tracking-[0.2em] text-zinc-400 uppercase">
                  Destaques - Pódio
                </h3>
                <span className="font-mono text-xs text-zinc-500">
                  Menor pontuação vence
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {/* 1º Lugar */}
                <button
                  type="button"
                  onClick={() => setSelectedId(leader.result.id)}
                  className="relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-[#E10600]/45 bg-[#111214] p-4 text-left text-white shadow-lg transition-transform hover:scale-[1.01]"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-0 w-28 bg-rally-checkered opacity-25 [mask-image:linear-gradient(to_left,black,transparent)]"
                  />
                  <div className="relative flex items-center gap-3.5 min-w-0">
                    <div className="pitstop-btn-red flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-['Barlow_Condensed'] text-2xl font-extrabold italic text-white">
                      1º
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-amber-400 uppercase">
                        <Trophy className="h-3.5 w-3.5 shrink-0" />
                        <span>Líder · {leader.recordedV}/{leader.totalV} PCs</span>
                      </div>
                      <div className="font-['Barlow_Condensed'] text-2xl font-extrabold italic leading-tight text-white">
                        Carro #{leader.result.carNumber}
                      </div>
                      <div className="truncate text-xs text-zinc-400">
                        {leader.result.crewName}
                      </div>
                    </div>
                  </div>
                  <div className="relative shrink-0 text-right">
                    <div className="font-mono text-2xl font-bold text-white tabular-nums">
                      {leader.finalTotalPoints}
                    </div>
                    <div className="text-[10px] font-semibold tracking-wide text-amber-400 uppercase">
                      pts perdidos
                    </div>
                  </div>
                </button>

                {/* 2º Lugar */}
                {second && (
                  <button
                    type="button"
                    onClick={() => setSelectedId(second.result.id)}
                    className="relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#111214] p-4 text-left text-white shadow-lg transition-colors hover:border-[#E10600]/50"
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-rally-checkered opacity-20 [mask-image:linear-gradient(to_left,black,transparent)]"
                    />
                    <div className="relative flex items-center gap-3.5 min-w-0">
                      <div className="pitstop-btn-metal flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-['Barlow_Condensed'] text-2xl font-extrabold italic text-white">
                        2º
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-[#C0C4C9] uppercase">
                          <Award className="h-3.5 w-3.5 shrink-0" />
                          <span>{second.recordedV}/{second.totalV} PCs V</span>
                        </div>
                        <div className="font-['Barlow_Condensed'] text-2xl font-extrabold italic leading-tight text-white">
                          Carro #{second.result.carNumber}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {second.result.crewName}
                        </div>
                      </div>
                    </div>
                    <div className="relative shrink-0 text-right">
                      <div className="font-mono text-2xl font-bold text-zinc-100 tabular-nums">
                        {second.finalTotalPoints}
                      </div>
                      <div className="font-mono text-[11px] font-semibold text-[#C0C4C9] tabular-nums">
                        +{second.finalTotalPoints - leader.finalTotalPoints} pts
                      </div>
                    </div>
                  </button>
                )}

                {/* 3º Lugar */}
                {third && (
                  <button
                    type="button"
                    onClick={() => setSelectedId(third.result.id)}
                    className="relative flex items-center justify-between gap-4 overflow-hidden rounded-2xl border border-zinc-700/80 bg-[#111214] p-4 text-left text-white shadow-lg transition-colors hover:border-amber-500/50"
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-rally-checkered opacity-20 [mask-image:linear-gradient(to_left,black,transparent)]"
                    />
                    <div className="relative flex items-center gap-3.5 min-w-0">
                      <div className="rally-btn-amber flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-['Barlow_Condensed'] text-2xl font-extrabold italic text-zinc-950">
                        3º
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-wider text-amber-400 uppercase">
                          <Award className="h-3.5 w-3.5 shrink-0" />
                          <span>{third.recordedV}/{third.totalV} PCs V</span>
                        </div>
                        <div className="font-['Barlow_Condensed'] text-2xl font-extrabold italic leading-tight text-white">
                          Carro #{third.result.carNumber}
                        </div>
                        <div className="truncate text-xs text-zinc-400">
                          {third.result.crewName}
                        </div>
                      </div>
                    </div>
                    <div className="relative shrink-0 text-right">
                      <div className="font-mono text-2xl font-bold text-zinc-100 tabular-nums">
                        {third.finalTotalPoints}
                      </div>
                      <div className="font-mono text-[11px] font-semibold text-amber-400 tabular-nums">
                        +{third.finalTotalPoints - leader.finalTotalPoints} pts
                      </div>
                    </div>
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Full-width General Leaderboard */}
          <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] text-zinc-100 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
              <div>
                <h3 className="font-['Barlow_Condensed'] text-xl font-bold tracking-wide text-white">
                  Classificação Geral por Pontos ({rankedSummaries.length} competidores)
                </h3>
                <p className="text-xs text-zinc-400">
                  Ordenado do menor para o maior perdedor de pontos · Clique em um carro para ver o boletim individual completo
                </p>
              </div>

              <div className="relative w-full sm:w-60">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filtrar carro ou dupla..."
                  className="w-full min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] pl-9 pr-3 text-xs text-white placeholder:text-zinc-500 focus:border-[#E10600] focus:outline-none"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-[#080B0D] text-xs font-semibold text-zinc-400">
                    <th className="py-3 pl-5 pr-3">Posição</th>
                    <th className="px-3 py-3">Carro / Dupla</th>
                    <th className="px-3 py-3 text-right">PCs V</th>
                    <th className="px-3 py-3 text-right">Adiantado</th>
                    <th className="px-3 py-3 text-right">Atrasado</th>
                    <th className="px-3 py-3 text-right">Pts Trechos V</th>
                    <th className="px-3 py-3 text-right">Penal. NC</th>
                    <th className="px-3 py-3 text-right">Total Pontos</th>
                    <th className="py-3 pl-3 pr-5 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/80">
                  {filteredSummaries.map((s) => {
                    const rank = rankedSummaries.indexOf(s) + 1;
                    const isSelected = activeSummary?.result.id === s.result.id;
                    return (
                      <tr
                        key={s.result.id}
                        onClick={() => setSelectedId(s.result.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-[#E10600]/15' : 'hover:bg-zinc-800/45'
                        }`}
                      >
                        <td className="py-3.5 pl-5 pr-3 font-mono text-sm font-bold text-white tabular-nums">
                          <span className={rank === 1 ? 'text-amber-400' : 'text-zinc-200'}>
                            {rank}º{rank === 1 ? ' (Vencedor)' : ''}
                          </span>
                        </td>
                        <td className="px-3 py-3.5">
                          <div className="font-mono text-sm font-bold text-white">
                            #{s.result.carNumber}
                          </div>
                          <div className="text-xs text-zinc-400 truncate max-w-[200px]">
                            {s.result.crewName}
                          </div>
                          {eventFilter === 'ALL' && s.result.eventName && (
                            <div className="text-[11px] text-zinc-500 truncate max-w-[200px]">
                              {s.result.eventName}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-xs text-zinc-300 tabular-nums">
                          {s.recordedV}/{s.totalV}
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-xs text-amber-400 tabular-nums">
                          -{s.earlySecondsTotal.toFixed(1)}s
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-xs text-zinc-300 tabular-nums">
                          +{s.lateSecondsTotal.toFixed(1)}s
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-xs text-zinc-200 tabular-nums">
                          {s.pointsFromV}
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-xs text-red-400 tabular-nums">
                          {s.missedPenaltyPoints}
                        </td>
                        <td className="px-3 py-3.5 text-right font-mono text-base font-bold text-[#FF2A2A] tabular-nums">
                          {s.finalTotalPoints}
                        </td>
                        <td className="py-3.5 pl-3 pr-5 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadFile(
                                  formatIndividualReportTxt(
                                    s,
                                    rank,
                                    missedPenaltyPts
                                  ),
                                  `boletim_carro_${s.result.carNumber}.txt`,
                                  'text/plain;charset=utf-8'
                                );
                              }}
                              title="Baixar boletim individual (.txt)"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteBaseResult(s.result.id).catch(() => {});
                                onRemoveResult(s.result.id);
                              }}
                              aria-label={`Remover carro ${s.result.carNumber}`}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-950/60 hover:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Detailed Individual Breakdown */}
          {activeSummary && (
            <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-[#111214] text-zinc-100 shadow-lg">
              <div aria-hidden="true" className="pitstop-racing-line h-[4px] w-full" />
              <div className="border-b border-zinc-800 px-5 py-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <h3 className="font-['Barlow_Condensed'] text-2xl font-bold text-white">
                        Boletim Individual Detalhado — Carro #{activeSummary.result.carNumber}
                      </h3>
                      <span className="font-mono text-xs font-bold text-[#FF2A2A]">
                        {activeRank}º Lugar · {activeSummary.finalTotalPoints} pts totais
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      Dupla: {activeSummary.result.crewName} · Largada{' '}
                      {activeSummary.result.startTimeStr} · Raio{' '}
                      {activeSummary.result.detectionRadiusM}m · D e N zerados (0 pts)
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Selecionar competidor"
                      value={activeSummary.result.id}
                      onChange={(e) => setSelectedId(e.target.value)}
                      className="min-h-[38px] rounded-lg border border-zinc-700 bg-[#080B0D] px-3 text-xs font-semibold text-zinc-100 focus:border-[#E10600] focus:outline-none"
                    >
                      {rankedSummaries.map((s, idx) => (
                        <option key={s.result.id} value={s.result.id}>
                          {idx + 1}º · Carro #{s.result.carNumber} ({s.finalTotalPoints} pts)
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() =>
                        downloadFile(
                          formatIndividualReportTxt(
                            activeSummary,
                            activeRank,
                            missedPenaltyPts
                          ),
                          `boletim_carro_${activeSummary.result.carNumber}.txt`,
                          'text/plain;charset=utf-8'
                        )
                      }
                      className="pitstop-btn-red inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold text-white whitespace-nowrap shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Exportar Boletim Individual (.txt)</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 divide-y divide-zinc-800 lg:grid-cols-12 lg:divide-x lg:divide-y-0">
                {/* Left 4 columns: Section Subtotals */}
                <div className="p-5 lg:col-span-4">
                  <h4 className="text-xs font-bold tracking-wider text-zinc-400 uppercase">
                    Resumo por Seção da Planilha
                  </h4>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs font-mono tabular-nums">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-400">
                          <th className="py-2 pr-2">Seção</th>
                          <th className="px-2 py-2">Tip</th>
                          <th className="px-2 py-2 text-right">PCs</th>
                          <th className="py-2 pl-2 text-right">Pontos</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70">
                        {activeSections.map((sec, idx) => {
                          const isExempt = sec.type !== 'V';
                          return (
                            <tr key={`${sec.section ?? 'none'}-${sec.type}-${idx}`}>
                              <td className="py-2 pr-2 font-semibold text-white">
                                {sec.section ?? '-'}
                              </td>
                              <td className="px-2 py-2 text-zinc-300">
                                {sec.type || '-'}
                              </td>
                              <td className="px-2 py-2 text-right text-zinc-400">
                                {sec.recordedCount}/{sec.totalTulipas}
                              </td>
                              <td
                                className={`py-2 pl-2 text-right font-semibold ${
                                  isExempt
                                    ? 'text-zinc-500'
                                    : sec.points > 0
                                      ? 'text-[#FF2A2A]'
                                      : 'text-emerald-400'
                                }`}
                              >
                                {isExempt ? '0 (Isento)' : sec.points}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Right 8 columns: Tulipa-by-Tulipa Passage Log */}
                <div className="p-5 lg:col-span-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h4 className="text-xs font-bold tracking-wider text-zinc-400 uppercase">
                      Passagens Tulipa a Tulipa ({filteredPassages.length} registros)
                    </h4>

                    <div className="flex flex-wrap gap-1 rounded-lg border border-zinc-800 bg-[#080B0D] p-1">
                      {(
                        [
                          ['V', 'Trechos V'],
                          ['penalized', 'Penalizados'],
                          ['missed', 'Não Passou'],
                          ['exempt', 'Isentos (D / N)'],
                          ['all', 'Todos'],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setDetailFilter(key)}
                          className={`min-h-[30px] rounded-md px-2.5 text-xs font-semibold transition-all whitespace-nowrap ${
                            detailFilter === key
                              ? 'pitstop-btn-red text-white'
                              : 'text-zinc-400 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 max-h-[480px] overflow-auto rounded-xl border border-zinc-800 bg-[#080B0D]">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead className="sticky top-0 bg-[#111214] text-zinc-400">
                        <tr className="border-b border-zinc-800">
                          <th className="py-2.5 pl-3 pr-2">Tul</th>
                          <th className="px-2 py-2.5">Sec</th>
                          <th className="px-2 py-2.5">Tip</th>
                          <th className="px-2 py-2.5">Hora Ideal</th>
                          <th className="px-2 py-2.5">Hora Real</th>
                          <th className="px-2 py-2.5 text-right">Dif (s)</th>
                          <th className="px-2 py-2.5 text-right">Dist</th>
                          <th className="py-2.5 pl-2 pr-3 text-right">Pts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/70 font-mono tabular-nums">
                        {filteredPassages.length === 0 ? (
                          <tr>
                            <td
                              colSpan={8}
                              className="px-4 py-8 text-center font-sans text-xs text-zinc-500"
                            >
                              Nenhuma tulipa encontrada neste filtro.
                            </td>
                          </tr>
                        ) : (
                          filteredPassages.map((p) => {
                            const isMissedV = p.type === 'V' && p.status === 'NAO_PASSOU';
                            const isExempt = p.type !== 'V';
                            return (
                              <tr
                                key={p.tulipa}
                                className={isMissedV ? 'bg-red-950/35' : 'hover:bg-zinc-800/35'}
                              >
                                <td className="py-2 pl-3 pr-2 font-semibold text-white">
                                  {p.tulipa}
                                </td>
                                <td className="px-2 py-2 text-zinc-400">
                                  {p.section ?? '-'}
                                </td>
                                <td className="px-2 py-2 font-semibold text-zinc-300">
                                  {p.type || '-'}
                                </td>
                                <td className="px-2 py-2 text-zinc-400">
                                  {p.idealHoraStr || '--'}
                                </td>
                                <td className="px-2 py-2 text-zinc-200">
                                  {p.realHoraStr || '--'}
                                </td>
                                <td
                                  className={`px-2 py-2 text-right ${
                                    isExempt
                                      ? 'text-zinc-500'
                                      : isMissedV
                                        ? 'font-semibold text-red-400'
                                        : p.diffSec !== null && p.diffSec < 0
                                          ? 'text-amber-400'
                                          : 'text-zinc-200'
                                  }`}
                                >
                                  {isMissedV
                                    ? 'NC'
                                    : p.diffSec !== null
                                      ? `${p.diffSec >= 0 ? '+' : ''}${p.diffSec.toFixed(1)}s`
                                      : '--'}
                                </td>
                                <td className="px-2 py-2 text-right text-zinc-400">
                                  {p.minDistanceM !== null
                                    ? `${p.minDistanceM.toFixed(0)}m`
                                    : '--'}
                                </td>
                                <td
                                  className={`py-2 pl-2 pr-3 text-right font-semibold ${
                                    isExempt
                                      ? 'text-zinc-500'
                                      : p.points > 0
                                        ? 'text-[#FF2A2A]'
                                        : 'text-emerald-400'
                                  }`}
                                >
                                  {isExempt ? '0 (Isento)' : p.points}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
};
