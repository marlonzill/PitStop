import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  EyeOff,
  Infinity as InfinityIcon,
  LogOut,
  MapPin,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { AdminSecretLoginModal } from './AdminSecretLoginModal';
import {
  applyGithubReleaseUpdate,
  checkGithubReleaseUpdate,
  deleteDispositivoRecord,
  type DeviceLicenseStatus,
  type DispositivoRecord,
  fetchAllDispositivos,
  getOrCreateDeviceIdentitySync,
  type GithubReleaseCheckResult,
  isLicenseExpired,
  logoutAdminSession,
  performOtaPwaUpdateAndReload,
  updateDispositivoRecord,
  useAdminLicenseSession,
} from '../services/deviceLicenseService';
import {
  deleteCloudTrack,
  fetchAllCloudTracksAdmin,
  isMissingCloudTracksTableError,
  type PistaNuvemRecord,
  PISTAS_NUVEM_SETUP_SQL,
  updateCloudTrackApproval,
} from '../services/cloudTracksService';
import { ENABLE_SUBSCRIPTION_GATE, useAuthSession } from '../utils/authSubscription';

interface AccountSubscriptionPanelProps {
  deviceLicense?: DeviceLicenseStatus;
  checkingDeviceLicense?: boolean;
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

function formatExpirationShortPtBr(expiresAt: string | null | undefined): string {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
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
  checkingDeviceLicense = false,
  onRecheckDeviceLicense,
}) => {
  const adminSession = useAdminLicenseSession();
  const { isAdmin: isBackendAdmin } = useAuthSession();
  const currentIdentity = useMemo(
    () => deviceLicense?.identity ?? getOrCreateDeviceIdentitySync(),
    [deviceLicense]
  );

  const isUnifiedAdmin = Boolean(adminSession) || (ENABLE_SUBSCRIPTION_GATE && isBackendAdmin);

  const [copiedId, setCopiedId] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<number | null>(null);

  // App Version Update check state (GitHub Releases)
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<{
    status: 'latest' | 'available' | 'error';
    remoteInfo?: GithubReleaseCheckResult | null;
    message: string;
  } | null>(null);
  const [updatingApp, setUpdatingApp] = useState(false);

  // Supabase dispositivos & pistas_nuvem admin state
  const [adminTab, setAdminTab] = useState<'devices' | 'tracks'>('devices');
  const [devices, setDevices] = useState<DispositivoRecord[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [panelFeedback, setPanelFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [cloudTracks, setCloudTracks] = useState<PistaNuvemRecord[]>([]);
  const [cloudTracksLoading, setCloudTracksLoading] = useState(false);
  const [cloudTracksError, setCloudTracksError] = useState<string | null>(null);
  const [cloudTracksMissingTable, setCloudTracksMissingTable] = useState(false);
  const [copiedTrackSql, setCopiedTrackSql] = useState(false);
  const [trackSearch, setTrackSearch] = useState('');
  const [busyTrackKey, setBusyTrackKey] = useState<string | null>(null);
  const [confirmDeleteTrackKey, setConfirmDeleteTrackKey] = useState<string | null>(null);

  const handleVersionRowTap = () => {
    tapCountRef.current += 1;
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
    }
    if (tapCountRef.current >= 5) {
      tapCountRef.current = 0;
      tapTimerRef.current = null;
      if (!isUnifiedAdmin) {
        setAdminModalOpen(true);
      }
      return;
    }
    tapTimerRef.current = window.setTimeout(() => {
      tapCountRef.current = 0;
      tapTimerRef.current = null;
    }, 2500);
  };

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
        err instanceof Error ? err.message : 'Não foi possível carregar os dispositivos.'
      );
    } finally {
      setDevicesLoading(false);
    }
  }, [isUnifiedAdmin]);

  const loadCloudTracks = useCallback(async () => {
    if (!isUnifiedAdmin) return;
    setCloudTracksLoading(true);
    setCloudTracksError(null);
    setCloudTracksMissingTable(false);
    try {
      const list = await fetchAllCloudTracksAdmin();
      setCloudTracks(list);
    } catch (err) {
      if (isMissingCloudTracksTableError(err)) {
        setCloudTracksMissingTable(true);
        setCloudTracksError(null);
      } else {
        setCloudTracksError(
          err instanceof Error ? err.message : 'Não foi possível carregar as pistas da nuvem.'
        );
      }
    } finally {
      setCloudTracksLoading(false);
    }
  }, [isUnifiedAdmin]);

  const handleCopyTrackSetupSql = async () => {
    try {
      await navigator.clipboard.writeText(PISTAS_NUVEM_SETUP_SQL);
      setCopiedTrackSql(true);
      window.setTimeout(() => setCopiedTrackSql(false), 2200);
    } catch {
      // ignore clipboard errors
    }
  };

  useEffect(() => {
    if (isUnifiedAdmin) {
      void loadDevices();
      void loadCloudTracks();
    }
  }, [isUnifiedAdmin, loadDevices, loadCloudTracks]);

  const handleCopyCurrentId = async () => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(currentIdentity.deviceId);
      } else {
        const ta = document.createElement('textarea');
        ta.value = currentIdentity.deviceId;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateCheckResult(null);
    try {
      if (Capacitor.isNativePlatform()) {
        const remote = await checkGithubReleaseUpdate();
        if (remote.hasUpdate) {
          setUpdateCheckResult({
            status: 'available',
            remoteInfo: remote,
            message: 'Nova atualização disponível',
          });
        } else {
          setUpdateCheckResult({
            status: 'latest',
            remoteInfo: remote,
            message: 'Seu aplicativo já está atualizado',
          });
        }
        return;
      }

      const ota = await performOtaPwaUpdateAndReload();
      if (!ota.ok) {
        setUpdateCheckResult({
          status: 'error',
          message: ota.error
            ? `Sem conexão para atualizar (${ota.error}).`
            : 'Sem conexão para verificar atualizações.',
        });
        return;
      }

      setUpdatingApp(true);
      setUpdateCheckResult({
        status: 'available',
        message: 'Atualizando para a versão mais recente...',
      });
      window.setTimeout(() => {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set('_upd', String(Date.now()));
          window.location.replace(url.toString());
        } catch {
          window.location.reload();
        }
      }, 650);
    } catch (err) {
      setUpdateCheckResult({
        status: 'error',
        message:
          err instanceof Error
            ? `Erro ao verificar atualizações (${err.message}).`
            : 'Sem conexão para verificar atualizações.',
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleApplyUpdate = async () => {
    setUpdatingApp(true);
    setUpdateCheckResult({
      status: 'available',
      remoteInfo: updateCheckResult?.remoteInfo,
      message: 'Atualizando para a versão mais recente...',
    });
    try {
      await applyGithubReleaseUpdate(updateCheckResult?.remoteInfo?.publishedAt);
    } finally {
      setUpdatingApp(false);
    }
  };

  const handleAdminLogout = () => {
    logoutAdminSession();
    setExpandedDeviceId(null);
    setConfirmDeleteId(null);
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

  const getTrackRowKey = (t: PistaNuvemRecord, idx?: number) =>
    t.id !== undefined && t.id !== null ? String(t.id) : `${t.device_id}::${t.nome}::${idx ?? 0}`;

  const handleToggleTrackApproval = async (track: PistaNuvemRecord, key: string) => {
    setBusyTrackKey(key);
    setPanelFeedback(null);
    try {
      const nextApproved = !track.aprovada;
      const updated = await updateCloudTrackApproval(track, nextApproved);
      setCloudTracks((prev) =>
        prev.map((item, i) => (getTrackRowKey(item, i) === key ? { ...item, ...updated } : item))
      );
      setPanelFeedback({
        ok: true,
        msg: nextApproved
          ? `Pista "${track.nome}" aprovada na biblioteca online.`
          : `Pista "${track.nome}" ocultada da biblioteca online.`,
      });
    } catch (err) {
      setPanelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Falha ao atualizar status da pista.',
      });
    } finally {
      setBusyTrackKey(null);
    }
  };

  const handleDeleteCloudTrack = async (track: PistaNuvemRecord, key: string) => {
    setBusyTrackKey(key);
    setPanelFeedback(null);
    try {
      await deleteCloudTrack(track);
      setCloudTracks((prev) => prev.filter((item, i) => getTrackRowKey(item, i) !== key));
      setConfirmDeleteTrackKey(null);
      setPanelFeedback({
        ok: true,
        msg: `Pista "${track.nome}" removida da nuvem.`,
      });
    } catch (err) {
      setPanelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Falha ao excluir pista da nuvem.',
      });
    } finally {
      setBusyTrackKey(null);
    }
  };

  const cloudTrackSummary = useMemo(() => {
    let approved = 0;
    let hidden = 0;
    for (const t of cloudTracks) {
      if (t.aprovada) approved += 1;
      else hidden += 1;
    }
    return { total: cloudTracks.length, approved, hidden };
  }, [cloudTracks]);

  const filteredCloudTracks = useMemo(() => {
    const q = trackSearch.trim().toLowerCase();
    if (!q) return cloudTracks;
    return cloudTracks.filter(
      (t) =>
        t.nome.toLowerCase().includes(q) ||
        t.device_id.toLowerCase().includes(q)
    );
  }, [cloudTracks, trackSearch]);

  const isAllowed = isUnifiedAdmin || deviceLicense?.status !== 'blocked';

  const statusText = useMemo(() => {
    if (isUnifiedAdmin || deviceLicense?.isAdminBypass) {
      return 'Liberado (Admin)';
    }
    if (!deviceLicense || deviceLicense.status !== 'blocked') {
      if (!deviceLicense?.expiresAt) return 'Liberado';
      const ms = Date.parse(deviceLicense.expiresAt);
      if (Number.isFinite(ms)) {
        const remainingH = Math.max(0, Math.ceil((ms - Date.now()) / (60 * 60 * 1000)));
        if (remainingH <= 26) {
          return `Liberado (Teste ${remainingH}h)`;
        }
        return `Liberado · até ${new Date(ms).toLocaleDateString('pt-BR')}`;
      }
      return 'Liberado';
    }
    return deviceLicense.reason === 'expired' ? 'Bloqueado (Expirado)' : 'Bloqueado';
  }, [deviceLicense, isUnifiedAdmin]);

  return (
    <div className="space-y-3">
      {/* CARD DE CREDENCIAL DO APARELHO (Motorsport / Telemetria Pro) */}
      <section className="rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 space-y-3">
        <div className="space-y-1.5">
          <p className="font-mono text-[11px] font-bold tracking-[0.14em] text-[var(--ps-muted)] uppercase leading-none">
            ID do Aparelho
          </p>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Smartphone className="h-4 w-4 shrink-0 text-[var(--ps-muted)]" />
              <span className="font-mono text-[20px] font-extrabold tracking-[0.12em] text-[var(--ps-text)] tabular-nums select-all leading-none">
                {currentIdentity.deviceId}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--ps-text)]">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    isAllowed ? 'bg-emerald-400' : 'bg-red-500'
                  }`}
                />
                <span>{statusText}</span>
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void handleCopyCurrentId()}
                aria-label="Copiar ID do aparelho"
                title="Copiar ID"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] transition-colors hover:border-white/30"
              >
                {copiedId ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
                )}
              </button>

              {onRecheckDeviceLicense && (
                <button
                  type="button"
                  disabled={checkingDeviceLicense}
                  onClick={onRecheckDeviceLicense}
                  aria-label="Sincronizar licença"
                  title="Sincronizar licença"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] transition-colors hover:border-white/30 disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 text-[var(--ps-muted)] ${checkingDeviceLicense ? 'animate-spin' : ''}`}
                  />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Linha inferior: Aparelho e Versão em largura total sem cortar + Buscar Atualização */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-[var(--ps-border)] pt-3">
          <div
            onClick={handleVersionRowTap}
            className="min-w-0 flex-1 cursor-default select-none font-mono"
          >
            <span className="block text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
              Aparelho / Versão
            </span>
            <span className="mt-0.5 block break-words text-[13px] font-semibold text-[var(--ps-text)] leading-snug">
              {currentIdentity.deviceModel} · {currentIdentity.appVersion}
            </span>
          </div>

          <button
            type="button"
            disabled={checkingUpdate || updatingApp}
            onClick={() => void handleCheckForUpdates()}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-transparent px-3 text-xs font-bold text-[var(--ps-text)] transition-colors hover:border-white/35 hover:bg-white/5 disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 text-[var(--ps-muted)] ${
                checkingUpdate || updatingApp ? 'animate-spin' : ''
              }`}
            />
            <span>
              {updatingApp
                ? 'Atualizando...'
                : checkingUpdate
                  ? 'Verificando...'
                  : 'Verificar Atualização'}
            </span>
          </button>
        </div>

        {updateCheckResult && (
          <div
            className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium ${
              updateCheckResult.status === 'available'
                ? 'border-emerald-500/35 bg-[#141619] text-[var(--ps-text)]'
                : updateCheckResult.status === 'error'
                  ? 'border-amber-500/35 bg-[#141619] text-[var(--ps-muted)]'
                  : 'border-[var(--ps-border)] bg-[#141619] text-[var(--ps-text)]'
            }`}
          >
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  updateCheckResult.status === 'available'
                    ? 'bg-emerald-400'
                    : updateCheckResult.status === 'error'
                      ? 'bg-amber-400'
                      : 'bg-zinc-400'
                }`}
              />
              <span>{updateCheckResult.message}</span>
            </span>
            {updateCheckResult.status === 'available' && updateCheckResult.remoteInfo?.hasUpdate && (
              <button
                type="button"
                disabled={updatingApp}
                onClick={() => void handleApplyUpdate()}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-emerald-500/45 bg-emerald-500/15 px-3 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25 whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{updatingApp ? 'Atualizando...' : 'Baixar e Atualizar'}</span>
              </button>
            )}
          </div>
        )}
      </section>

      {/* PAINEL ADMIN SÓBRIO & EXPANSÍVEL (DISPOSITIVOS | PISTAS) */}
      {isUnifiedAdmin && (
        <section className="rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--ps-muted)]" />
              <h3 className="font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase">
                Painel Admin · {adminTab === 'devices' ? 'Dispositivos' : 'Pistas na Nuvem'}
              </h3>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={adminTab === 'devices' ? devicesLoading : cloudTracksLoading}
                onClick={() => {
                  if (adminTab === 'devices') void loadDevices();
                  else void loadCloudTracks();
                }}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-bold text-[var(--ps-text)] hover:border-white/30"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 text-[var(--ps-muted)] ${
                    (adminTab === 'devices' ? devicesLoading : cloudTracksLoading) ? 'animate-spin' : ''
                  }`}
                />
                <span>Atualizar</span>
              </button>

              {adminSession && (
                <button
                  type="button"
                  onClick={handleAdminLogout}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-[var(--ps-border-strong)] bg-[#141619] px-3 text-xs font-bold text-[var(--ps-muted)] hover:border-white/30 hover:text-[var(--ps-text)]"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sair</span>
                </button>
              )}
            </div>
          </div>

          {/* Abas Compactas: Dispositivos | Pistas */}
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--ps-border)] bg-[#141619] p-1 font-mono text-xs tabular-nums">
            <button
              type="button"
              onClick={() => {
                setPanelFeedback(null);
                setAdminTab('devices');
              }}
              className={`min-h-[36px] rounded-md px-3 font-extrabold transition-colors ${
                adminTab === 'devices'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              Dispositivos ({devices.length})
            </button>
            <button
              type="button"
              onClick={() => {
                setPanelFeedback(null);
                setAdminTab('tracks');
                if (cloudTracks.length === 0) void loadCloudTracks();
              }}
              className={`min-h-[36px] rounded-md px-3 font-extrabold transition-colors ${
                adminTab === 'tracks'
                  ? 'bg-[var(--ps-accent)] text-[var(--ps-accent-text)]'
                  : 'text-[var(--ps-muted)] hover:text-[var(--ps-text)]'
              }`}
            >
              Pistas ({cloudTracks.length})
            </button>
          </div>

          {panelFeedback && (
            <div
              className={`rounded-lg border px-3 py-2 text-xs font-medium bg-[#141619] ${
                panelFeedback.ok
                  ? 'border-emerald-500/35 text-emerald-300'
                  : 'border-red-500/35 text-red-300'
              }`}
            >
              {panelFeedback.msg}
            </div>
          )}

          {adminTab === 'tracks' ? (
            <div className="space-y-3">
              {/* Contadores de Pistas */}
              <div className="grid grid-cols-3 gap-1.5 font-mono tabular-nums">
                {[
                  { label: 'Total', value: cloudTrackSummary.total, dotClass: 'bg-zinc-400' },
                  { label: 'Aprovadas', value: cloudTrackSummary.approved, dotClass: 'bg-emerald-400' },
                  { label: 'Ocultas', value: cloudTrackSummary.hidden, dotClass: 'bg-amber-400' },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="flex items-center justify-between rounded-lg border border-[var(--ps-border)] bg-[#141619] px-2.5 py-1.5"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-[var(--ps-muted)] uppercase">
                      <span className={`h-1.5 w-1.5 rounded-full ${stat.dotClass}`} />
                      <span>{stat.label}</span>
                    </span>
                    <span className="text-sm font-black text-[var(--ps-text)] leading-none">
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Busca de Pistas */}
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--ps-muted)]" />
                <input
                  type="text"
                  value={trackSearch}
                  onChange={(e) => setTrackSearch(e.target.value)}
                  placeholder="Buscar nome da pista ou ID do aparelho..."
                  className="min-h-[38px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[#141619] pr-3 pl-9 text-[13px] font-medium text-[var(--ps-text)] focus:border-white/40 focus:outline-none"
                />
              </div>

              {cloudTracksMissingTable && (
                <div className="rounded-xl border border-amber-500/40 bg-[#141619] p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="text-xs font-extrabold text-amber-300 uppercase">
                        Tabela pistas_nuvem não configurada no Supabase
                      </p>
                      <p className="text-[11px] text-[var(--ps-muted)]">
                        Execute o SQL abaixo no SQL Editor do seu projeto Supabase e toque em Atualizar.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopyTrackSetupSql()}
                      className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 text-xs font-extrabold text-amber-200 hover:bg-amber-500/25"
                    >
                      {copiedTrackSql ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedTrackSql ? 'SQL Copiado' : 'Copiar SQL'}</span>
                    </button>
                  </div>
                  <pre className="max-h-40 overflow-auto rounded-lg border border-[var(--ps-border)] bg-black/60 p-2 font-mono text-[10px] leading-relaxed text-zinc-300 select-all">
                    {PISTAS_NUVEM_SETUP_SQL}
                  </pre>
                </div>
              )}

              {cloudTracksError && !cloudTracksMissingTable && (
                <div className="rounded-lg border border-red-500/35 bg-[#141619] px-3 py-2 text-xs text-red-300">
                  {cloudTracksError}
                </div>
              )}

              {cloudTracksLoading && cloudTracks.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--ps-muted)]">
                  Carregando pistas enviadas para a nuvem...
                </div>
              ) : filteredCloudTracks.length === 0 && !cloudTracksMissingTable ? (
                <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-[var(--ps-muted)]">
                  <MapPin className="h-3.5 w-3.5" />
                  <span>Nenhuma pista encontrada em pistas_nuvem.</span>
                </div>
              ) : filteredCloudTracks.length > 0 ? (
                <div className="divide-y divide-[var(--ps-border)] rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] overflow-hidden">
                  {filteredCloudTracks.map((t, idx) => {
                    const rowKey = getTrackRowKey(t, idx);
                    const busy = busyTrackKey === rowKey;
                    const confirming = confirmDeleteTrackKey === rowKey;

                    return (
                      <div
                        key={rowKey}
                        className="flex flex-wrap items-center justify-between gap-2.5 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13px] font-bold text-[var(--ps-text)]">
                              {t.nome}
                            </span>
                            <span className="font-mono text-xs font-extrabold text-[var(--ps-accent)] tabular-nums">
                              {t.distancia.toFixed(2)} km
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] text-[var(--ps-muted)] tabular-nums">
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  t.aprovada ? 'bg-emerald-400' : 'bg-amber-400'
                                }`}
                              />
                              <span className={t.aprovada ? 'text-emerald-300' : 'text-amber-300'}>
                                {t.aprovada ? 'Aprovada' : 'Oculta'}
                              </span>
                            </span>
                            <span>ID {t.device_id || '--'}</span>
                            <span>{t.parciais.length} marcos</span>
                            <span>{formatDateTimePtBr(t.criado_em)}</span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleToggleTrackApproval(t, rowKey)}
                            className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#141619] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-white/35 disabled:opacity-50"
                          >
                            {t.aprovada ? (
                              <>
                                <EyeOff className="h-3.5 w-3.5 text-amber-400" />
                                <span>Ocultar</span>
                              </>
                            ) : (
                              <>
                                <Eye className="h-3.5 w-3.5 text-emerald-400" />
                                <span>Aprovar</span>
                              </>
                            )}
                          </button>

                          {confirming ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleDeleteCloudTrack(t, rowKey)}
                                className="inline-flex min-h-[34px] items-center rounded-md border border-red-500/50 bg-red-600/80 px-2.5 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-50"
                              >
                                Confirmar
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmDeleteTrackKey(null)}
                                className="inline-flex min-h-[34px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2 text-xs font-semibold text-[var(--ps-muted)]"
                              >
                                Não
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDeleteTrackKey(rowKey)}
                              className="inline-flex min-h-[34px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#141619] px-2.5 text-xs font-semibold text-[var(--ps-muted)] hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
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
              ) : null}
            </div>
          ) : (
            <>
              {/* 4 Contadores Minimalistas */}
              <div className="grid grid-cols-4 gap-1.5 font-mono tabular-nums">
                {[
                  { label: 'Total', value: summary.total, dotClass: 'bg-zinc-400' },
                  { label: 'Ativos', value: summary.active, dotClass: 'bg-emerald-400' },
                  { label: '24h', value: summary.trial, dotClass: 'bg-amber-400' },
                  { label: 'Bloq.', value: summary.blockedOrExpired, dotClass: 'bg-red-500' },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="flex flex-col items-center justify-center gap-0.5 rounded-lg border border-[var(--ps-border)] bg-[#141619] px-2 py-1.5 sm:flex-row sm:justify-between sm:px-2.5"
                  >
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide text-[var(--ps-muted)] uppercase">
                      <span className={`h-1.5 w-1.5 rounded-full ${stat.dotClass}`} />
                      <span>{stat.label}</span>
                    </span>
                    <span className="text-sm font-black text-[var(--ps-text)] leading-none">
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

              {/* Busca */}
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--ps-muted)]" />
                <input
                  type="text"
                  value={deviceSearch}
                  onChange={(e) => setDeviceSearch(e.target.value)}
                  placeholder="Buscar piloto, ID de 5 dígitos ou aparelho..."
                  className="min-h-[38px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[#141619] pr-3 pl-9 text-[13px] font-medium text-[var(--ps-text)] focus:border-white/40 focus:outline-none"
                />
              </div>

              {devicesError && (
                <div className="rounded-lg border border-red-500/35 bg-[#141619] px-3 py-2 text-xs text-red-300">
                  {devicesError}
                </div>
              )}

              {devicesLoading && devices.length === 0 ? (
                <div className="py-6 text-center text-xs text-[var(--ps-muted)]">
                  Carregando dispositivos cadastrados...
                </div>
              ) : filteredDevices.length === 0 ? (
                <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-[var(--ps-muted)]">
                  <Users className="h-3.5 w-3.5" />
                  <span>Nenhum dispositivo encontrado.</span>
                </div>
              ) : (
                <div className="divide-y divide-[var(--ps-border)] rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] overflow-hidden">
              {filteredDevices.map((d) => {
                const isCurrent = d.device_id === currentIdentity.deviceId;
                const expired = isLicenseExpired(d.expires_at);
                const blocked = d.allowed === false;
                const inTrial = isDeviceInTrial24h(d);
                const busy = busyDeviceId === d.device_id;
                const isExpanded = expandedDeviceId === d.device_id;
                const draftName = editingNames[d.device_id] ?? d.pilot_name ?? '';
                const nameDirty = draftName.trim() !== (d.pilot_name ?? '').trim();
                const shortExp = formatExpirationShortPtBr(d.expires_at);

                let statusDotClass = 'bg-emerald-400';
                let statusLabel = d.expires_at ? `Ativo · ${shortExp}` : 'Vitalício';
                if (blocked) {
                  statusDotClass = 'bg-red-500';
                  statusLabel = 'Bloqueado';
                } else if (expired) {
                  statusDotClass = 'bg-red-500';
                  statusLabel = shortExp ? `Expirado · ${shortExp}` : 'Expirado';
                } else if (inTrial) {
                  statusDotClass = 'bg-amber-400';
                  statusLabel = shortExp ? `Teste 24h · ${shortExp}` : 'Teste 24h';
                }

                return (
                  <div key={d.device_id} className="transition-colors">
                    {/* Visão Padrão da Linha (Compacta) */}
                    <div className="flex items-center justify-between gap-2.5 px-3 py-2.5">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-black tracking-wider text-[var(--ps-text)] tabular-nums select-all">
                            {d.device_id}
                          </span>
                          <span className="text-[13px] font-semibold text-[var(--ps-text)] break-words">
                            {d.pilot_name?.trim() || 'Piloto Sem Nome'}
                          </span>
                          {isCurrent && (
                            <span className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--ps-muted)] uppercase">
                              Este
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-xs text-[var(--ps-muted)]">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass}`} />
                            <span className={blocked || expired ? 'text-red-300' : 'text-[var(--ps-muted)]'}>
                              {statusLabel}
                            </span>
                          </span>
                          <span className="opacity-75">
                            {d.app_version || '--'}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          setExpandedDeviceId((prev) =>
                            prev === d.device_id ? null : d.device_id
                          );
                        }}
                        className="inline-flex min-h-[34px] shrink-0 items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#141619] px-2.5 text-xs font-bold text-[var(--ps-text)] transition-colors hover:border-white/35"
                      >
                        <span>Gerenciar</span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-[var(--ps-muted)] transition-transform ${
                            isExpanded ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                    </div>

                    {/* Painel Acordeão Expandido */}
                    {isExpanded && (
                      <div className="border-t border-[var(--ps-border)] bg-[#141619] px-3 py-3 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[var(--ps-muted)]">
                          <span>
                            {d.device_model || 'Modelo desconhecido'} · Último acesso:{' '}
                            {formatDateTimePtBr(d.last_seen_at)}
                          </span>
                          <span className={blocked || expired ? 'text-red-300' : 'text-[var(--ps-text)]'}>
                            {blocked ? 'Bloqueado' : formatExpirationLabel(d.expires_at)}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
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
                            className="min-h-[36px] flex-1 rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] px-2.5 text-[13px] font-semibold text-[var(--ps-text)] focus:border-white/40 focus:outline-none"
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
                            className={`inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border px-3 text-xs font-bold transition ${
                              nameDirty
                                ? 'border-white/30 bg-white/10 text-[var(--ps-text)] hover:bg-white/15'
                                : 'border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-muted)] opacity-50'
                            }`}
                          >
                            <Save className="h-3.5 w-3.5" />
                            <span>Salvar</span>
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
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
                            className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-white/35 hover:bg-white/10 disabled:opacity-50"
                          >
                            <InfinityIcon className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
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
                            className="inline-flex min-h-[32px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-white/35 hover:bg-white/10 disabled:opacity-50 tabular-nums"
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
                            className="inline-flex min-h-[32px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-white/35 hover:bg-white/10 disabled:opacity-50 tabular-nums"
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
                            className="inline-flex min-h-[32px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-white/35 hover:bg-white/10 disabled:opacity-50 tabular-nums"
                          >
                            +1 Ano
                          </button>

                          <div className="ml-auto flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handleUpdateDevice(
                                  d.device_id,
                                  { allowed: blocked ? true : false },
                                  blocked
                                    ? `Dispositivo ${d.device_id} desbloqueado.`
                                    : `Dispositivo ${d.device_id} bloqueado.`
                                )
                              }
                              className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-text)] hover:border-red-500/40 hover:text-red-300 disabled:opacity-45"
                            >
                              <Ban className="h-3.5 w-3.5 text-[var(--ps-muted)]" />
                              <span>{blocked ? 'Desbloquear' : 'Bloquear'}</span>
                            </button>

                            {confirmDeleteId === d.device_id ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteDevice(d.device_id)}
                                  className="inline-flex min-h-[32px] items-center rounded-md border border-red-500/50 bg-red-600/80 px-2.5 text-xs font-bold text-white hover:bg-red-600 disabled:opacity-50"
                                >
                                  Confirmar
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="inline-flex min-h-[32px] items-center rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-muted)]"
                                >
                                  Não
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(d.device_id)}
                                className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-[var(--ps-border-strong)] bg-[#1B1E24] px-2.5 text-xs font-semibold text-[var(--ps-muted)] hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>Excluir</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      <AdminSecretLoginModal
        open={adminModalOpen}
        onClose={() => setAdminModalOpen(false)}
        onSuccess={() => {
          setAdminModalOpen(false);
          onRecheckDeviceLicense?.();
        }}
      />
    </div>
  );
};
