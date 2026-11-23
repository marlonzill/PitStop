import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Crown,
  Eye,
  EyeOff,
  Lock,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
  UserPlus,
  Users,
  WifiOff,
} from 'lucide-react';
import {
  type AuthUser,
  fetchAdminUsersList,
  getEffectiveUserPlan,
  loginUserAccount,
  logoutUserAccount,
  registerUserAccount,
  updateAdminUserSubscription,
  useAuthSession,
} from '../utils/authSubscription';

function formatExpirationLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Vitalício';
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 'Vitalício';
  const dateStr = new Date(ms).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return ms < Date.now() ? `Expirado em ${dateStr}` : `Válido até ${dateStr}`;
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export const AccountSubscriptionPanel: React.FC = () => {
  const { user, isPro, isAdmin, syncing, refresh } = useAuthSession();

  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  // Admin panel state
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminSearch, setAdminSearch] = useState('');
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const loadAdminUsers = useCallback(async () => {
    if (!isAdmin) return;
    setAdminLoading(true);
    setAdminError(null);
    try {
      const list = await fetchAdminUsersList();
      setAdminUsers(list);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Erro ao carregar usuários.');
    } finally {
      setAdminLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (isAdmin) {
      void loadAdminUsers();
    }
  }, [isAdmin, loadAdminUsers]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);
    setSubmitting(true);
    try {
      if (authTab === 'register') {
        const res = await registerUserAccount({ name, email, password });
        setAuthSuccess(
          res.user.role === 'admin'
            ? 'Conta Admin Master criada com Plano PRO ativo!'
            : 'Conta criada com sucesso! Plano FREE ativo offline.'
        );
      } else {
        const res = await loginUserAccount({ email, password });
        setAuthSuccess(
          getEffectiveUserPlan(res.user) === 'pro'
            ? 'Login realizado · Assinatura PRO sincronizada offline.'
            : 'Login realizado com sucesso.'
        );
      }
      setPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Erro de autenticação.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdminPlanChange = async (
    targetUser: AuthUser,
    plan: 'free' | 'pro',
    expiresAt: string | null
  ) => {
    setUpdatingUserId(targetUser.id);
    setAdminError(null);
    try {
      const updated = await updateAdminUserSubscription(targetUser.id, { plan, expiresAt });
      setAdminUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Falha ao atualizar assinatura.');
    } finally {
      setUpdatingUserId(null);
    }
  };

  const filteredUsers = useMemo(() => {
    const q = adminSearch.trim().toLowerCase();
    if (!q) return adminUsers;
    return adminUsers.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  }, [adminUsers, adminSearch]);

  return (
    <div className="space-y-3.5">
      {/* AUTH OR ACTIVE ACCOUNT CARD */}
      {!user ? (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                Acesse ou Crie sua Conta PitStop
              </h2>
              <p className="text-xs text-[var(--ps-muted)]">
                Sua assinatura PRO fica salva localmente para rodar 100% offline no meio da trilha.
              </p>
            </div>

            <div className="inline-flex rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] p-1 text-xs font-bold">
              <button
                type="button"
                onClick={() => {
                  setAuthTab('login');
                  setAuthError(null);
                }}
                className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-md px-3 transition-colors ${
                  authTab === 'login'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                <span>Entrar</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthTab('register');
                  setAuthError(null);
                }}
                className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-md px-3 transition-colors ${
                  authTab === 'register'
                    ? 'pitstop-btn-red'
                    : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
                }`}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Criar Conta</span>
              </button>
            </div>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-3">
            {authTab === 'register' && (
              <label className="block space-y-1">
                <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Nome Completo / Equipe
                </span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Márlon Zill / Carro 42"
                  className="min-h-[44px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-sm font-semibold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                />
              </label>
            )}

            <label className="block space-y-1">
              <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                E-mail
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="piloto@equipe.com.br"
                className="min-h-[44px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-sm font-semibold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                Senha
              </span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete={authTab === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  className="min-h-[44px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] pr-11 pl-3 text-sm font-semibold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1/2 right-2.5 -translate-y-1/2 p-1 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                  aria-label="Mostrar ou ocultar senha"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            {authError && (
              <div className="rounded-lg border border-red-500/45 bg-red-950/40 px-3 py-2 text-xs font-semibold text-red-200">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="pitstop-btn-red flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold tracking-wider uppercase"
            >
              {submitting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : authTab === 'register' ? (
                <UserPlus className="h-4 w-4" />
              ) : (
                <UserCheck className="h-4 w-4" />
              )}
              <span>
                {submitting
                  ? 'Conectando...'
                  : authTab === 'register'
                    ? 'Criar Conta Gratuita'
                    : 'Entrar na Conta'}
              </span>
            </button>
          </form>
        </section>
      ) : (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-['Barlow_Condensed'] text-2xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                  {user.name}
                </h2>
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-black uppercase ${
                    isPro
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : 'bg-zinc-700/40 text-[var(--ps-muted)] border border-[var(--ps-border)]'
                  }`}
                >
                  {isPro ? <Crown className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                  <span>{isPro ? 'PLANO PRO ATIVO' : 'PLANO FREE'}</span>
                </span>
                {isAdmin && (
                  <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/45 bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-black text-cyan-300 uppercase">
                    <ShieldCheck className="h-3 w-3" />
                    <span>ADMIN MASTER</span>
                  </span>
                )}
              </div>
              <p className="font-mono text-xs text-[var(--ps-muted)]">{user.email}</p>
              <p className="font-mono text-[11px] text-[var(--ps-muted)]">
                Status da licença:{' '}
                <strong className={isPro ? 'text-emerald-400' : 'text-[var(--ps-text)]'}>
                  {isAdmin
                    ? 'Acesso Total Vitalício'
                    : isPro
                      ? formatExpirationLabel(user.expiresAt)
                      : 'Gratuito (Básico)'}
                </strong>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={syncing}
                onClick={() => void refresh()}
                className="pitstop-btn-metal inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span>Sincronizar</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  logoutUserAccount();
                  setAuthSuccess(null);
                  setAuthError(null);
                }}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sair</span>
              </button>
            </div>
          </div>

          {authSuccess && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-2 text-xs font-semibold text-emerald-300">
              {authSuccess}
            </div>
          )}

          <div className="flex items-center gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2 text-[11px] text-[var(--ps-muted)]">
            <WifiOff className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>
              Seu plano fica gravado no aparelho. Nas especiais sem internet, tudo que foi liberado funciona 100% offline.
            </span>
          </div>
        </section>
      )}

      {/* COMPARATIVO FREE VS PRO */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div
          className={`rounded-xl border p-4 space-y-2.5 ${
            !isPro
              ? 'border-[var(--ps-border-strong)] bg-[var(--ps-surface)]'
              : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)] opacity-85'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
              Plano FREE
            </span>
            <span className="rounded bg-white/10 px-2 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
              {!isPro ? 'Atual' : 'Base'}
            </span>
          </div>
          <ul className="space-y-1.5 text-xs text-[var(--ps-muted)]">
            {[
              'Calculadora de Tempo e Médias',
              'Odômetro & Velocímetro Básico',
              'Levantamento de Rota Básico',
              '2 Temas Visuais (Original e Solar Dia)',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div
          className={`rounded-xl border p-4 space-y-2.5 ${
            isPro
              ? 'border-emerald-500/50 bg-emerald-950/15'
              : 'border-[var(--ps-accent)]/60 bg-[var(--ps-surface)]'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
              <Crown className="h-4 w-4 text-amber-400" />
              <span>Plano PRO Completo</span>
            </span>
            <span className="rounded bg-[var(--ps-accent)] px-2 py-0.5 font-mono text-[10px] font-black text-[var(--ps-accent-text)] uppercase">
              {isPro ? 'Ativo' : 'PRO'}
            </span>
          </div>
          <ul className="space-y-1.5 text-xs text-[var(--ps-text)]">
            {[
              'Navegação de Regularidade + Planilha T15 & Droid Piloto',
              'Cronômetro SS / Circuito com Parciais e Delta Time',
              'Datalogger 3 Voltas, G-G Circle & Vídeo Overlay HUD',
              'Automação Multi-GoPro BLE & Satcron Ao Vivo',
              'Todos os 10 Temas Visuais Exclusivos',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          {!isPro && (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              Para liberar o Plano PRO na sua conta, solicite a ativação ao administrador informando seu e-mail cadastrado.
            </div>
          )}
        </div>
      </section>

      {/* PAINEL ADMIN INTEGRADO (SÓ VISÍVEL PARA ROLE === 'admin') */}
      {isAdmin && (
        <section className="rounded-xl border border-cyan-500/40 bg-[var(--ps-surface)] p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-cyan-400" />
              <div>
                <h3 className="font-['Barlow_Condensed'] text-xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                  Painel Admin · Gestão de Assinaturas
                </h3>
                <p className="text-[11px] text-[var(--ps-muted)]">
                  Libere ou revogue o acesso PRO de qualquer conta cadastrada com 1 toque.
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={adminLoading}
              onClick={() => void loadAdminUsers()}
              className="pitstop-btn-metal inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${adminLoading ? 'animate-spin' : ''}`} />
              <span>Atualizar Lista ({adminUsers.length})</span>
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--ps-muted)]" />
            <input
              type="text"
              value={adminSearch}
              onChange={(e) => setAdminSearch(e.target.value)}
              placeholder="Buscar piloto por nome ou e-mail..."
              className="min-h-[40px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] pr-3 pl-9 text-xs font-semibold text-[var(--ps-text)] focus:border-cyan-400 focus:outline-none"
            />
          </div>

          {adminError && (
            <div className="rounded-lg border border-red-500/45 bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {adminError}
            </div>
          )}

          {adminLoading && adminUsers.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--ps-muted)]">
              Carregando contas cadastradas...
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="py-6 text-center text-xs text-[var(--ps-muted)]">
              Nenhuma conta encontrada para este filtro.
            </div>
          ) : (
            <div className="divide-y divide-[var(--ps-border)] rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)]">
              {filteredUsers.map((u) => {
                const uEffective = getEffectiveUserPlan(u);
                const busy = updatingUserId === u.id;
                return (
                  <div
                    key={u.id}
                    className="flex flex-col gap-2.5 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-extrabold text-[var(--ps-text)]">
                          {u.name}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-black uppercase ${
                            uEffective === 'pro'
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : 'bg-zinc-700/50 text-[var(--ps-muted)]'
                          }`}
                        >
                          {uEffective === 'pro' ? 'PRO' : 'FREE'}
                        </span>
                        {u.role === 'admin' && (
                          <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 font-mono text-[10px] font-black text-cyan-300 uppercase">
                            ADMIN
                          </span>
                        )}
                      </div>
                      <p className="truncate font-mono text-[11px] text-[var(--ps-muted)]">
                        {u.email}
                      </p>
                      <p className="font-mono text-[10px] text-[var(--ps-muted)]">
                        Validade: {u.role === 'admin' ? 'Vitalício (Master)' : uEffective === 'pro' ? formatExpirationLabel(u.expiresAt) : 'Plano Gratuito'}
                      </p>
                    </div>

                    {u.role !== 'admin' && (
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdminPlanChange(u, 'pro', addDaysIso(30))}
                          className="rounded-md border border-emerald-500/45 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          PRO +30d
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdminPlanChange(u, 'pro', addDaysIso(365))}
                          className="rounded-md border border-cyan-500/45 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-cyan-300 hover:bg-cyan-500/25 disabled:opacity-50"
                        >
                          PRO 1 Ano
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleAdminPlanChange(u, 'pro', null)}
                          className="rounded-md border border-amber-500/45 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
                        >
                          PRO Vitalício
                        </button>
                        {u.plan === 'pro' && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleAdminPlanChange(u, 'free', null)}
                            className="rounded-md border border-red-500/45 bg-red-500/15 px-2.5 py-1.5 text-[11px] font-extrabold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                          >
                            Definir FREE
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
