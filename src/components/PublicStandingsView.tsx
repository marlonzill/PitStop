import React, { useEffect, useState } from 'react';
import {
  Award,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  ShieldAlert,
  Trophy,
} from 'lucide-react';
import type { PublishedStandingsSnapshot } from '../types/rally';
import { fetchPublicStandings } from '../utils/baseApi';
import { PitStopLogo } from './PitStopLogo';

interface PublicStandingsViewProps {
  slug: string;
}

export const PublicStandingsView: React.FC<PublicStandingsViewProps> = ({ slug }) => {
  const [snapshot, setSnapshot] = useState<PublishedStandingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchPublicStandings(slug)
      .then((data) => {
        if (active) setSnapshot(data);
      })
      .catch((err) => {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível carregar o resultado oficial.'
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  const downloadText = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-10 text-center text-[var(--ps-muted)]">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-[var(--ps-accent)]" />
        <p className="mt-3 text-sm font-medium">Carregando classificação oficial...</p>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-red-500/50 bg-[var(--ps-surface)] p-8 text-center text-[var(--ps-text)]">
        <ShieldAlert className="mx-auto h-9 w-9 text-[#FF2A2A]" />
        <h2 className="mt-3 font-['Barlow_Condensed'] text-2xl font-bold text-[var(--ps-text)]">
          Resultado não encontrado
        </h2>
        <p className="mt-1.5 text-sm text-[var(--ps-muted)]">
          {error || 'Verifique se o link compartilhado está completo ou peça um novo link à organização PitStop Sports.'}
        </p>
      </div>
    );
  }

  const leader = snapshot.rows[0] ?? null;
  const second = snapshot.rows[1] ?? null;
  const third = snapshot.rows[2] ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <section className="overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-2xl">
        <div aria-hidden="true" className="pitstop-racing-line h-[10px] w-full sm:h-[12px]" />
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-center gap-4">
            <PitStopLogo
              variant="icon"
              className="h-11 w-11 shrink-0 sm:h-12 sm:w-12"
            />
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] text-[var(--ps-accent)] uppercase">
                Classificação Oficial · PitStop-Sports
              </p>
              <h1 className="font-['Barlow_Condensed'] text-2xl font-extrabold italic text-[var(--ps-text)] sm:text-3xl">
                {snapshot.eventName}
              </h1>
              <p className="mt-0.5 text-xs text-[var(--ps-muted)]">
                Publicado em {new Date(snapshot.publishedAtIso || snapshot.createdAt).toLocaleString('pt-BR')} ·{' '}
                {snapshot.rows.length} carros apurados · Penalidade NC: {snapshot.missedPenaltyPts} pts
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {snapshot.txtReport && (
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    snapshot.txtReport,
                    `classificacao_${snapshot.slug}.txt`,
                    'text/plain;charset=utf-8'
                  )
                }
                className="pitstop-btn-metal inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
              >
                <Download className="h-4 w-4 text-[var(--ps-muted)]" />
                <span>Baixar TXT</span>
              </button>
            )}
            {snapshot.csvReport && (
              <button
                type="button"
                onClick={() =>
                  downloadText(
                    snapshot.csvReport,
                    `classificacao_${snapshot.slug}.csv`,
                    'text/csv;charset=utf-8'
                  )
                }
                className="pitstop-btn-metal inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
              >
                <FileSpreadsheet className="h-4 w-4 text-[var(--ps-emerald)]" />
                <span>Planilha CSV</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {leader && (
        <section className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
          {[leader, second, third].map((row, idx) => {
            if (!row) return null;
            return (
              <div
                key={`${row.carNumber}-${row.position}`}
                className={`rounded-2xl border p-4 bg-[var(--ps-surface)] ${
                  idx === 0
                    ? 'border-[var(--ps-accent)]/60'
                    : idx === 1
                      ? 'border-[var(--ps-border-strong)]'
                      : 'border-[var(--ps-border)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-flex h-10 w-10 items-center justify-center rounded-xl font-['Barlow_Condensed'] text-xl font-extrabold italic ${
                      idx === 0
                        ? 'pitstop-btn-red'
                        : idx === 1
                          ? 'pitstop-btn-metal'
                          : 'rally-btn-amber text-zinc-950'
                    }`}
                  >
                    {row.position}º
                  </span>
                  <div className="text-right">
                    <div className="font-mono text-2xl font-extrabold text-[var(--ps-text)] tabular-nums">
                      {row.finalTotalPoints}
                    </div>
                    <div className="text-[10px] font-bold tracking-wider text-[#FF2A2A] uppercase">
                      pontos perdidos
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--ps-muted)]">
                    {idx === 0 ? (
                      <Trophy className="h-3.5 w-3.5 text-[var(--ps-amber)]" />
                    ) : (
                      <Award className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
                    )}
                    <span>Carro #{row.carNumber}</span>
                  </div>
                  <p className="truncate text-sm font-semibold text-[var(--ps-text)]">{row.crewName}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-[var(--ps-muted)]">
                    PCs: {row.recordedV}/{row.totalV} · Adiant: -{row.earlySecondsTotal.toFixed(1)}s · Atras: +{row.lateSecondsTotal.toFixed(1)}s
                  </p>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] shadow-xl">
        <div className="border-b border-[var(--ps-border)] px-5 py-3.5">
          <h2 className="font-['Barlow_Condensed'] text-xl font-bold text-[var(--ps-text)]">
            Tabela Geral de Classificação
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-xs font-semibold text-[var(--ps-muted)]">
                <th className="py-3 pl-5 pr-3">Pos</th>
                <th className="px-3 py-3">Carro / Dupla</th>
                <th className="px-3 py-3 text-right">PCs V</th>
                <th className="px-3 py-3 text-right">Adiant.</th>
                <th className="px-3 py-3 text-right">Atras.</th>
                <th className="px-3 py-3 text-right">Pts V</th>
                <th className="px-3 py-3 text-right">Penal. NC</th>
                <th className="py-3 pl-3 pr-5 text-right">Total Pontos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ps-border)] font-mono tabular-nums">
              {snapshot.rows.map((row) => (
                <tr key={`${row.position}-${row.carNumber}`} className="hover:bg-[var(--ps-card)]">
                  <td className="py-3 pl-5 pr-3 font-bold text-[var(--ps-text)]">
                    {row.position}º
                  </td>
                  <td className="px-3 py-3 font-sans">
                    <div className="font-mono text-sm font-bold text-[var(--ps-text)]">
                      #{row.carNumber}
                    </div>
                    <div className="text-xs text-[var(--ps-muted)]">{row.crewName}</div>
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-[var(--ps-muted)]">
                    {row.recordedV}/{row.totalV}
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-[var(--ps-emerald)]">
                    -{row.earlySecondsTotal.toFixed(1)}s
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-red-400">
                    +{row.lateSecondsTotal.toFixed(1)}s
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-[var(--ps-text)]">
                    {row.pointsFromV ?? Math.max(0, row.finalTotalPoints - row.missedV * snapshot.missedPenaltyPts)}
                  </td>
                  <td className="px-3 py-3 text-right text-xs text-red-400">
                    {row.missedPenaltyPoints ?? row.missedV * snapshot.missedPenaltyPts}
                  </td>
                  <td className="py-3 pl-3 pr-5 text-right text-base font-bold text-[#FF2A2A]">
                    {row.finalTotalPoints}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-[var(--ps-muted)]">
        <a
          href="https://www.instagram.com/pitstop.sports/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-[var(--ps-accent)]"
        >
          <span>Instagram @pitstop.sports</span>
          <ExternalLink className="h-3 w-3" />
        </a>
        <span>·</span>
        <a
          href="https://pitstopere.wixsite.com/news"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-[var(--ps-accent)]"
        >
          <span>Portal PitStop News</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
};
