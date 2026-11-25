import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CalendarClock,
  Check,
  Copy,
  Crown,
  Eye,
  EyeOff,
  Infinity as InfinityIcon,
  LogOut,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  authenticateUnifiedAdmin,
  deleteDispositivoRecord,
  type DeviceLicenseStatus,
  type DispositivoRecord,
  fetchAllDispositivos,
  getOrCreateDeviceIdentitySync,
  isLicenseExpired,
  logoutAdminSession,
  updateDispositivoRecord,
  useAdminLicenseSession,
} from '../services/deviceLicenseService';
import {
  ENABLE_SUBSCRIPTION_GATE,
  getEffectiveUserPlan,
  loginUserAccount,
  logoutUserAccount,
  registerUserAccount,
  useAuthSession,
} from '../utils/authSubscription';

interface AccountSubscriptionPanelProps {
  deviceLicense?: DeviceLicenseStatus;
  onRecheckDeviceLicense?: () => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateTimePtBr(iso: string | null | undefined): string {
  if (!iso) return '--';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--';
  return new Date(ms).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExpirationLabel(expiresAt: string | null | undefined): string {
  if (!expiresAt) return 'Vitalício';
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 'Vitalício';
  const dateStr = new Date(ms).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeStr = new Date(ms).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return ms < Date.now() ? `Expirou em ${dateStr} ${timeStr}` : `Válido até ${dateStr} ${timeStr}`;
}

function addDaysFromBase(currentExpiresAt: string | null | undefined, days: number): string {
  const now = Date.now();
  const parsed = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
  const baseMs = Number.isFinite(parsed) && parsed > now ? parsed : now;
  return new Date(baseMs + days * DAY_MS).toISOString();
}

function isDeviceInTrial24h(d: DispositivoRecord): boolean {
  if (d.allowed === false || !d.expires_at) return false;
  const expMs = Date.parse(d.expires_at);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const name = (d.pilot_name ?? '').toLowerCase();
  return name.includes('teste 24h') || expMs - Date.now() <= 26 * 60 * 60 * 1000;
}

export const AccountSubscriptionPanel: React.FC<AccountSubscriptionPanelProps> = ({
  deviceLicense,
  onRecheckDeviceLicense,
}) => {
  const adminSession = useAdminLicenseSession();
  const { user, isPro, isAdmin: isBackendAdmin, syncing, refresh } = useAuthSession();
  const currentIdentity = useMemo(
    () => deviceLicense?.identity ?? getOrCreateDeviceIdentitySync(),
    [deviceLicense]
  );

  const isUnifiedAdmin = Boolean(adminSession) || (ENABLE_SUBSCRIPTION_GATE && isBackendAdmin);

  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  // Supabase dispositivos admin state
  const [devices, setDevices] = useState<DispositivoRecord[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [panelFeedback, setPanelFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const loadDevices = useCallback(async () => {
    if (!isUnifiedAdmin) return;
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const list = await fetchAllDispositivos();
      setDevices(list);
      setEditingNames((prev) => {
        const next: Record<string, string> = {};
        for (const item of list) {
          next[item.device_id] = prev[item.device_id] ?? item.pilot_name ?? '';
        }
        return next;
      });
    } catch (err) {
      setDevicesError(
        err instanceof Error ? err.message : 'Não foi possível carregar os dispositivos do Supabase.'
      );
    } finally {
      setDevicesLoading(false);
    }
  }, [isUnifiedAdmin]);

  useEffect(() => {
    if (isUnifiedAdmin) {
      void loadDevices();
    }
  }, [isUnifiedAdmin, loadDevices]);

  const handleCopyCurrentId = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(currentIdentity.deviceId);
      }
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);
    setSubmitting(true);
    try {
      if (authTab === 'login') {
        const unifiedAdmin = authenticateUnifiedAdmin(identifier, password);
        if (unifiedAdmin) {
          setPassword('');
          setAuthSuccess('Sessão de Administrador autenticada! Uso irrestrito liberado.');
          onRecheckDeviceLicense?.();
          return;
        }
      }

      if (!ENABLE_SUBSCRIPTION_GATE) {
        setAuthError('Usuário ou senha inválidos.');
        return;
      }

      if (authTab === 'register') {
        const res = await registerUserAccount({ name, email: identifier, password });
        setAuthSuccess(
          res.user.role === 'admin'
            ? 'Conta Admin Master criada com Plano PRO ativo!'
            : 'Conta criada com sucesso!'
        );
      } else {
        const res = await loginUserAccount({ email: identifier, password });
        setAuthSuccess(
          getEffectiveUserPlan(res.user) === 'pro'
            ? 'Login realizado · Assinatura PRO sincronizada.'
            : 'Login realizado com sucesso.'
        );
      }
      setPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Usuário ou senha inválidos.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogoutAll = () => {
    logoutAdminSession();
    if (user) {
      logoutUserAccount();
    }
    setDevices([]);
    setAuthSuccess(null);
    setAuthError(null);
    setPanelFeedback(null);
    onRecheckDeviceLicense?.();
  };

  const handleUpdateDevice = async (
    deviceId: string,
    patch: Partial<Pick<DispositivoRecord, 'pilot_name' | 'allowed' | 'expires_at'>>,
    successMsg: string
  ) => {
    setBusyDeviceId(deviceId);
    setPanelFeedback(null);
    try {
      const updated = await updateDispositivoRecord(deviceId, patch);
      setDevices((prev) =>
        prev.map((d) => (d.device_id === deviceId ? { ...d, ...updated } : d))
      );
      if ('pilot_name' in updated) {
        setEditingNames((prev) => ({
          ...prev,
          [deviceId]: updated.pilot_name ?? '',
        }));
      }
      if (deviceId === currentIdentity.deviceId) {
        onRecheckDeviceLicense?.();
      }
      setPanelFeedback({ ok: true, msg: successMsg });
    } catch (err) {
      setPanelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Falha ao atualizar dispositivo.',
      });
    } finally {
      setBusyDeviceId(null);
    }
  };

  const handleDeleteDevice = async (deviceId: string) => {
    setBusyDeviceId(deviceId);
    setPanelFeedback(null);
    try {
      await deleteDispositivoRecord(deviceId);
      setDevices((prev) => prev.filter((d) => d.device_id !== deviceId));
      setConfirmDeleteId(null);
      if (deviceId === currentIdentity.deviceId) {
        onRecheckDeviceLicense?.();
      }
      setPanelFeedback({ ok: true, msg: `Dispositivo ${deviceId} removido.` });
    } catch (err) {
      setPanelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Erro ao excluir dispositivo.',
      });
    } finally {
      setBusyDeviceId(null);
    }
  };

  const summary = useMemo(() => {
    let active = 0;
    let trial = 0;
    let blockedOrExpired = 0;

    for (const d of devices) {
      const expired = isLicenseExpired(d.expires_at);
      if (d.allowed === false || expired) {
        blockedOrExpired += 1;
      } else {
        active += 1;
        if (isDeviceInTrial24h(d)) {
          trial += 1;
        }
      }
    }

    return {
      total: devices.length,
      active,
      trial,
      blockedOrExpired,
    };
  }, [devices]);

  const filteredDevices = useMemo(() => {
    const q = deviceSearch.trim().toLowerCase();
    const sorted = [...devices].sort((a, b) => {
      if (a.device_id === currentIdentity.deviceId) return -1;
      if (b.device_id === currentIdentity.deviceId) return 1;
      return 0;
    });
    if (!q) return sorted;
    return sorted.filter((d) => {
      const pName = (d.pilot_name ?? '').toLowerCase();
      const dId = d.device_id.toLowerCase();
      const model = (d.device_model ?? '').toLowerCase();
      return pName.includes(q) || dId.includes(q) || model.includes(q);
    });
  }, [devices, deviceSearch, currentIdentity.deviceId]);

  const currentLicenseStatusLabel = useMemo(() => {
    if (isUnifiedAdmin || deviceLicense?.isAdminBypass) {
      return 'Liberado · Acesso Irrestrito (Admin)';
    }
    if (!deviceLicense) return 'Teste / Ativo';
    if (deviceLicense.status === 'blocked') {
      return deviceLicense.reason === 'expired' ? 'Período Expirado' : 'Bloqueado';
    }
    if (!deviceLicense.expiresAt) return 'Licença Vitalícia';
    const ms = Date.parse(deviceLicense.expiresAt);
    if (Number.isFinite(ms)) {
      const remainingH = Math.max(0, Math.ceil((ms - Date.now()) / (60 * 60 * 1000)));
      if (remainingH <= 26) {
        return `Teste 24h Ativo (${remainingH}h restantes)`;
      }
    }
    return formatExpirationLabel(deviceLicense.expiresAt);
  }, [deviceLicense, isUnifiedAdmin]);

  return (
    <div className="space-y-3.5">
      {/* CARD DE CONTA / LOGIN UNIFICADO */}
      {isUnifiedAdmin ? (
        <section className="rounded-xl border border-cyan-500/45 bg-[var(--ps-surface)] p-4 sm:p-5 space-y-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-['Barlow_Condensed'] text-2xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                  {adminSession?.username ?? user?.name ?? 'marlonzill'}
                </h2>
                <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/45 bg-cyan-500/15 px-2 py-0.5 font-mono text-[10px] font-black text-cyan-300 uppercase">
                  <ShieldCheck className="h-3 w-3" />
                  <span>ADMIN MASTER</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-black text-[var(--ps-emerald)] uppercase">
                  <Crown className="h-3 w-3" />
                  <span>USO IRRESTRITO</span>
                </span>
              </div>
              <p className="font-mono text-xs text-[var(--ps-muted)]">
                Aparelho atual:{' '}
                <strong className="text-[var(--ps-amber)] tabular-nums">
                  {currentIdentity.deviceId}
                </strong>{' '}
                · {currentIdentity.deviceModel}
              </p>
            </div>

            <button
              type="button"
              onClick={handleLogoutAll}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-red-500/45 bg-red-500/12 px-3.5 text-xs font-extrabold text-red-300 transition hover:bg-red-500/20"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sair da Conta</span>
            </button>
          </div>

          {authSuccess && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-2 text-xs font-semibold text-emerald-300">
              {authSuccess}
            </div>
          )}
        </section>
      ) : ENABLE_SUBSCRIPTION_GATE && user ? (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-['Barlow_Condensed'] text-2xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                  {user.name}
                </h2>
                <span
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-black uppercase ${
                    isPro
                      ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-400'
                      : 'border border-[var(--ps-border)] bg-zinc-700/40 text-[var(--ps-muted)]'
                  }`}
                >
                  <Crown className="h-3 w-3" />
                  <span>{isPro ? 'PLANO PRO ATIVO' : 'PLANO FREE'}</span>
                </span>
              </div>
              <p className="font-mono text-xs text-[var(--ps-muted)]">{user.email}</p>
            </div>

            <div className="flex items-center gap-2">
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
                onClick={handleLogoutAll}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-muted)] hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)]"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sair da Conta</span>
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-['Barlow_Condensed'] text-xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                Conta &amp; Assinatura PitStop
              </h2>
              <p className="text-xs text-[var(--ps-muted)]">
                Entre com sua conta para gerenciar seu acesso e assinatura.
              </p>
            </div>

            {ENABLE_SUBSCRIPTION_GATE && (
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
            )}
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-3">
            {ENABLE_SUBSCRIPTION_GATE && authTab === 'register' && (
              <label className="block space-y-1">
                <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                  Nome Completo / Equipe
                </span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Piloto / Carro 42"
                  className="min-h-[44px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-sm font-semibold text-[var(--ps-text)] focus:border-[var(--ps-accent)] focus:outline-none"
                />
              </label>
            )}

            <label className="block space-y-1">
              <span className="text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
                Usuário / E-mail
              </span>
              <input
                type="text"
                required
                autoComplete="username"
                autoCapitalize="none"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Usuário ou e-mail"
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
                  autoComplete={authTab === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite sua senha"
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
              className="pitstop-btn-red flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold tracking-wider uppercase disabled:opacity-60"
            >
              {submitting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <UserCheck className="h-4 w-4" />
              )}
              <span>
                {submitting
                  ? 'Conectando...'
                  : ENABLE_SUBSCRIPTION_GATE && authTab === 'register'
                    ? 'Criar Conta'
                    : 'Entrar'}
              </span>
            </button>
          </form>
        </section>
      )}

      {/* STATUS DA LICENÇA DESTE APARELHO */}
      <section className="rounded-xl border border-[var(--ps-border)] bg-[var(--ps-surface)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-[var(--ps-accent)]" />
            <h3 className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
              Licença deste Aparelho
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleCopyCurrentId()}
              className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-accent)]"
            >
              {copiedId ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[var(--ps-emerald)]" />
                  <span className="text-[var(--ps-emerald)]">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copiar ID</span>
                </>
              )}
            </button>
            {onRecheckDeviceLicense && (
              <button
                type="button"
                onClick={onRecheckDeviceLicense}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-xs font-bold text-[var(--ps-text)] hover:border-[var(--ps-emerald)]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Verificar</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 font-mono text-[11px] sm:grid-cols-3">
          <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
            <p className="text-[10px] text-[var(--ps-muted)] uppercase">ID do Aparelho</p>
            <p className="mt-0.5 text-sm font-black tracking-wider text-[var(--ps-amber)] tabular-nums select-all">
              {currentIdentity.deviceId}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
            <p className="text-[10px] text-[var(--ps-muted)] uppercase">Aparelho / Versão</p>
            <p className="mt-0.5 truncate font-bold text-[var(--ps-text)]">
              {currentIdentity.deviceModel} · {currentIdentity.appVersion}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
            <p className="text-[10px] text-[var(--ps-muted)] uppercase">Situação</p>
            <p
              className={`mt-0.5 font-extrabold ${
                isUnifiedAdmin || deviceLicense?.status !== 'blocked'
                  ? 'text-[var(--ps-emerald)]'
                  : 'text-[#FF2A2A]'
              }`}
            >
              {currentLicenseStatusLabel}
            </p>
          </div>
        </div>
      </section>

      {/* PAINEL COMPLETO DE GERENCIAMENTO DE DISPOSITIVOS & LICENÇAS (ADMIN SUPABASE) */}
      {isUnifiedAdmin && (
        <section className="rounded-xl border border-cyan-500/40 bg-[var(--ps-surface)] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-cyan-400" />
              <div>
                <h3 className="font-['Barlow_Condensed'] text-xl font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                  Gerenciamento de Dispositivos &amp; Licenças
                </h3>
                <p className="text-[11px] text-[var(--ps-muted)]">
                  Controle direto da tabela <code className="font-mono text-cyan-300">dispositivos</code> (Supabase) com ações de 1 toque.
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={devicesLoading}
              onClick={() => void loadDevices()}
              className="pitstop-btn-metal inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${devicesLoading ? 'animate-spin' : ''}`} />
              <span>Atualizar Lista</span>
            </button>
          </div>

          {/* Resumo no topo */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
              <p className="font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
                Total
              </p>
              <p className="mt-0.5 font-mono text-xl font-black text-[var(--ps-text)] tabular-nums">
                {summary.total}
              </p>
            </div>
            <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2">
              <p className="font-mono text-[10px] font-bold text-emerald-300 uppercase">
                Ativos
              </p>
              <p className="mt-0.5 font-mono text-xl font-black text-emerald-400 tabular-nums">
                {summary.active}
              </p>
            </div>
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2">
              <p className="font-mono text-[10px] font-bold text-amber-300 uppercase">
                Em Teste (24h)
              </p>
              <p className="mt-0.5 font-mono text-xl font-black text-[var(--ps-amber)] tabular-nums">
                {summary.trial}
              </p>
            </div>
            <div className="rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2">
              <p className="font-mono text-[10px] font-bold text-red-300 uppercase">
                Expirados / Bloq.
              </p>
              <p className="mt-0.5 font-mono text-xl font-black text-[#FF2A2A] tabular-nums">
                {summary.blockedOrExpired}
              </p>
            </div>
          </div>

          {/* Busca */}
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--ps-muted)]" />
            <input
              type="text"
              value={deviceSearch}
              onChange={(e) => setDeviceSearch(e.target.value)}
              placeholder="Buscar por nome do piloto, ID (PS-...) ou modelo do aparelho..."
              className="min-h-[42px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] pr-3 pl-9 text-xs font-semibold text-[var(--ps-text)] focus:border-cyan-400 focus:outline-none"
            />
          </div>

          {panelFeedback && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                panelFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300'
                  : 'border-red-500/45 bg-red-950/40 text-red-200'
              }`}
            >
              {panelFeedback.msg}
            </div>
          )}

          {devicesError && (
            <div className="rounded-lg border border-red-500/45 bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {devicesError}
            </div>
          )}

          {devicesLoading && devices.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--ps-muted)]">
              Carregando dispositivos cadastrados...
            </div>
          ) : filteredDevices.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--ps-muted)]">
              Nenhum dispositivo encontrado.
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredDevices.map((d) => {
                const isCurrent = d.device_id === currentIdentity.deviceId;
                const expired = isLicenseExpired(d.expires_at);
                const blocked = d.allowed === false;
                const inTrial = isDeviceInTrial24h(d);
                const busy = busyDeviceId === d.device_id;
                const draftName = editingNames[d.device_id] ?? d.pilot_name ?? '';
                const nameDirty = draftName.trim() !== (d.pilot_name ?? '').trim();

                let statusBadge = (
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-black text-emerald-300 uppercase">
                    <Check className="h-3 w-3" />
                    <span>{d.expires_at ? 'ATIVO' : 'VITALÍCIO'}</span>
                  </span>
                );
                if (blocked) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 rounded border border-red-500/45 bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] font-black text-red-300 uppercase">
                      <Ban className="h-3 w-3" />
                      <span>BLOQUEADO</span>
                    </span>
                  );
                } else if (expired) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 rounded border border-red-500/45 bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] font-black text-red-300 uppercase">
                      <ShieldAlert className="h-3 w-3" />
                      <span>EXPIRADO</span>
                    </span>
                  );
                } else if (inTrial) {
                  statusBadge = (
                    <span className="inline-flex items-center gap-1 rounded border border-amber-500/45 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-black text-[var(--ps-amber)] uppercase">
                      <CalendarClock className="h-3 w-3" />
                      <span>TESTE 24H</span>
                    </span>
                  );
                }

                return (
                  <div
                    key={d.device_id}
                    className={`rounded-xl border p-3.5 space-y-3 ${
                      isCurrent
                        ? 'border-cyan-400/60 bg-cyan-950/15'
                        : 'border-[var(--ps-border)] bg-[var(--ps-card-deep)]'
                    }`}
                  >
                    {/* Cabeçalho do dispositivo + Badges */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-black tracking-wider text-[var(--ps-amber)] tabular-nums select-all">
                          {d.device_id}
                        </span>
                        {statusBadge}
                        {isCurrent && (
                          <span className="inline-flex items-center rounded border border-cyan-400/50 bg-cyan-500/20 px-1.5 py-0.5 font-mono text-[10px] font-black text-cyan-200 uppercase">
                            Este Aparelho
                          </span>
                        )}
                      </div>

                      <span className="font-mono text-[10px] text-[var(--ps-muted)] tabular-nums">
                        Último acesso: {formatDateTimePtBr(d.last_seen_at)}
                      </span>
                    </div>

                    {/* Nome editável do piloto */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex flex-1 items-center gap-1.5">
                        <input
                          type="text"
                          value={draftName}
                          onChange={(e) =>
                            setEditingNames((prev) => ({
                              ...prev,
                              [d.device_id]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleUpdateDevice(
                                d.device_id,
                                { pilot_name: draftName.trim() || 'Piloto Sem Nome' },
                                `Nome atualizado para ${draftName.trim() || 'Piloto Sem Nome'}.`
                              );
                            }
                          }}
                          placeholder="Nome do piloto / equipe"
                          className="min-h-[38px] flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-3 text-xs font-bold text-[var(--ps-text)] focus:border-cyan-400 focus:outline-none"
                        />
                        <button
                          type="button"
                          disabled={busy || !nameDirty}
                          onClick={() =>
                            void handleUpdateDevice(
                              d.device_id,
                              { pilot_name: draftName.trim() || 'Piloto Sem Nome' },
                              `Nome atualizado para ${draftName.trim() || 'Piloto Sem Nome'}.`
                            )
                          }
                          className={`inline-flex min-h-[38px] shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-extrabold transition ${
                            nameDirty
                              ? 'bg-cyan-500/25 border border-cyan-400/60 text-cyan-200 hover:bg-cyan-500/35'
                              : 'border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] opacity-60'
                          }`}
                        >
                          <Save className="h-3.5 w-3.5" />
                          <span>Salvar</span>
                        </button>
                      </div>
                    </div>

                    {/* Metadados + validade */}
                    <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[var(--ps-muted)]">
                      <span className="truncate">
                        {d.device_model || 'Modelo desconhecido'}
                        {d.app_version ? ` · ${d.app_version}` : ''}
                      </span>
                      <span
                        className={`font-bold tabular-nums ${
                          blocked || expired ? 'text-red-300' : 'text-[var(--ps-text)]'
                        }`}
                      >
                        {blocked ? 'Acesso bloqueado' : formatExpirationLabel(d.expires_at)}
                      </span>
                    </div>

                    {/* Ações de 1 toque */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void handleUpdateDevice(
                            d.device_id,
                            { allowed: true, expires_at: null },
                            `${d.device_id} liberado com acesso Vitalício.`
                          )
                        }
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-amber-500/45 bg-amber-500/15 px-2.5 text-[11px] font-extrabold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                      >
                        <InfinityIcon className="h-3.5 w-3.5" />
                        <span>Vitalício</span>
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void handleUpdateDevice(
                            d.device_id,
                            { allowed: true, expires_at: addDaysFromBase(d.expires_at, 1) },
                            `+1 dia adicionado para ${d.device_id}.`
                          )
                        }
                        className="inline-flex min-h-[34px] items-center rounded-md border border-emerald-500/45 bg-emerald-500/15 px-2.5 text-[11px] font-extrabold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 tabular-nums"
                      >
                        +1 Dia
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void handleUpdateDevice(
                            d.device_id,
                            { allowed: true, expires_at: addDaysFromBase(d.expires_at, 30) },
                            `+30 dias adicionados para ${d.device_id}.`
                          )
                        }
                        className="inline-flex min-h-[34px] items-center rounded-md border border-emerald-500/45 bg-emerald-500/15 px-2.5 text-[11px] font-extrabold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 tabular-nums"
                      >
                        +30 Dias
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void handleUpdateDevice(
                            d.device_id,
                            { allowed: true, expires_at: addDaysFromBase(d.expires_at, 365) },
                            `+1 ano adicionado para ${d.device_id}.`
                          )
                        }
                        className="inline-flex min-h-[34px] items-center rounded-md border border-cyan-500/45 bg-cyan-500/15 px-2.5 text-[11px] font-extrabold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50 tabular-nums"
                      >
                        +1 Ano
                      </button>

                      <button
                        type="button"
                        disabled={busy || blocked}
                        onClick={() =>
                          void handleUpdateDevice(
                            d.device_id,
                            { allowed: false },
                            `Dispositivo ${d.device_id} bloqueado.`
                          )
                        }
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-red-500/45 bg-red-500/15 px-2.5 text-[11px] font-extrabold text-red-200 hover:bg-red-500/25 disabled:opacity-45"
                      >
                        <Ban className="h-3.5 w-3.5" />
                        <span>Bloquear</span>
                      </button>

                      {confirmDeleteId === d.device_id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleDeleteDevice(d.device_id)}
                            className="inline-flex min-h-[34px] items-center gap-1 rounded-md bg-red-600 px-2.5 text-[11px] font-black text-white hover:bg-red-500 disabled:opacity-50"
                          >
                            <span>Confirmar Exclusão</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                            className="inline-flex min-h-[34px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2 text-[11px] font-bold text-[var(--ps-muted)]"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(d.device_id)}
                          className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2.5 text-[11px] font-bold text-[var(--ps-muted)] hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Excluir</span>
                        </button>
                      )}
                    </div>
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
